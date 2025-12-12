# Nostrify Plan for Lightning Shop

This document lays out a detailed, end‑to‑end plan to “nostrify” the Lightning Shop backend so it can:

- Speak the same Nostr dialect as **plebeian.market** (kinds, coordinates, content schemas).
- Export its data (shop, products, optionally auctions) as Nostr events.
- Optionally import / mirror Nostr events into its own SQLite database.
- Stay backwards‑compatible with the current app and payments.

It is written as an implementation roadmap, not as a specification you must do all at once. The idea is to enable **incremental rollout** and future cross‑compatibility with Plebeian and other Nostr‑native marketplaces.

---

## Current Implementation Status (synced with code)

- ✅ Foundation & schema
  - PR kinds/constants + coordinate helpers in `server/nostr.js` (`KIND_STALL=30017`, `KIND_PRODUCT=30018`, etc.).
  - `product_nostr_posts` has `coordinates`, `kind`, `rawContent`; migrations wired; d‑tag normalization exists.
  - Settings include `nostrStallDTag`, `nostrCurrency`, `nostrStallCoordinates/LastEvent/LastAck`; defaults to `SATS` and `main`.
- ✅ Stall publishing (DB → Nostr)
  - `publishStall` helper live; admin endpoint `POST /api/admin/nostr/stall/publish`; admin UI “Nostr” tab with preview + publish.
  - Currency forced uppercase `SATS`; shipping array currently empty in stall event.
- ✅ Product teasers
  - Teasers now add `a` tags pointing to product coordinates when available.
- ✅ Product publishing (kind 30018) — optional export
  - Backend helper `publishProduct` in `server/nostr.js` with content hashing/dedup (skips unchanged unless forced).
  - Admin endpoint `POST /api/admin/products/:id/nostr/publish` plus UI buttons in the Nostr tab (thumbnail/status/publish + last event/time/acks).
  - Product event content includes specs (dimensions), gallery/images (defaults to catalog main image), basic shipping rows; validation guards against malformed events.
- ✅ Import (Nostr → DB, one‑shot)
  - `POST /api/admin/nostr/import` pulls 30017/30018 via `fetchStallAndProducts` (uses `querySync`/`list`), downloads images, creates products + `product_images`, records Nostr metadata in `product_nostr_posts`.
  - Store name/description/currency updated from stall content; importer falls back to the latest stall if the requested `d` tag isn’t present.
  - Admin UI “Import from Nostr” button with identifier input (npub/hex/nprofile/nip05).
  - Imported products default to `showDimensions=false`.
- ❗ Import limitations
  - Only kinds 30017/30018 ingested; if multiple stalls exist, latest wins (or matching `stallDTag` when present).
  - Basic validation added for stall/product content; malformed products are skipped. If an imported product coordinate already exists locally, it is skipped (no merge/overwrite strategy).
  - No generic validation schema store (Zod) or deeper conflict resolution.
  - No generic `nostr_events`/`nostr_event_tags` store yet.
- ❗ Not done vs. plan (optional / future)
  - Auctions/bids (30020/1021), public API exposure of coordinates, NIP‑05/profile sync, relay/contact list (NIP‑02), generic event/tag store, conflict policies.

---

## 0. Terminology and Current State

**Lightning Shop (this repo)**

- Canonical data lives in SQLite via `server/db.js`:
  - `products`, `orders`, `settings`, `product_images`, `product_nostr_posts`, `nostr_carts`, `xpub_state`, etc.
- Nostr is already used for:
  - Shop identity and DMs via `server/nostr.js`:
    - Server key loaded from env (`SHOP_NOSTR_NSEC`, `NOSTR_NSEC`, etc.).
    - NIP‑04 DMs (`sendDM`), comment proofs, product teasers (`publishProductTeaser`), Nostr login / comment verification.
  - Some Nostr configuration in `settings` (`nostrNpub`, `nostrRelays`, `nostrCommentsEnabled`, hashtags, etc.).
- There is **no PR‑event (NIP‑33) model** yet: products/stall are not represented as `kind 30xxx` events.

**Plebeian.market (reference design from `plebeian-nostr.md`)**

- Uses Nostr as canonical data for:
  - Users / profiles (kind 0).
  - Stalls (shops) as PR events (`kind 30017`).
  - Products as PR events (`kind 30018`).
  - Auctions as PR events (`kind 30020`), bids as `kind 1021`.
  - DMs (kind 4), contact lists (kind 3), NIP‑05, NIP‑07, NIP‑19, etc.
- A relational DB mirrors events for querying and adds local metadata:
  - Stalls, products, shipping tables, tags, roles, bans, etc.
- Core concept: **parameterized replaceable events (PR events)** addressed by coordinates:
  - `<kind>:<pubkey>:<d-tag>` (NIP‑33).
  - Helpers like `getEventCoordinates` / `parseCoordinatesString`.

**Goal for Lightning Shop**

- Keep **SQLite as operational/checkout source of truth**; Nostr import/export is optional and owner‑driven.
- Allow stall/products to be published as PR events (30017/30018) for cross‑compatibility, but nothing relies on Nostr for day‑to‑day shop use.
- Allow one‑shot import from Nostr to seed an empty shop; small deltas (e.g., shipping tweaks) can be handled manually in either Lightning Shop or Plebeian.

---

## 1. High‑Level Phases

To keep complexity manageable, split the work into phases:

1. **Foundation & Naming**
   - Decide on event kinds, coordinates, and d‑tag conventions.
   - Ensure the server Nostr identity & relay configuration is solid.
2. **Schema Alignment & DB Prep**
   - Make sure DB structures can express canonical Nostr event content.
   - Add missing columns and normalization to support PR events.
3. **Publishing Pipeline (DB → Nostr)**
   - Export:
     - Shop as a stall (kind 30017).
     - Products as products (kind 30018).
   - Optionally tie teasers (kind 1) to products via `a` tags.
4. **Ingestion Pipeline (Nostr → DB)** *(optional, can be later)*
   - Subscribe to relays, validate events, and upsert stalls/products into the DB.
5. **Integration & UX**
   - Admin UI toggles to publish/sync.
   - Expose helpful metadata (npub, coordinates, event links) to the frontend.
6. **Advanced Features**
   - Auctions/bids (30020/1021).
   - Payments metadata events.
   - NIP‑05-backed identity and verification badges.

Each phase is independently useful and can be shipped separately.

---

## 2. Foundation: Event Kinds, Coordinates, Identity

### 2.1 Adopt PR Kinds and Coordinates

Mirror Plebeian’s kinds and coordinate semantics:

- **Stalls (shops):**
  - `KindStalls = 30017`.
  - Coordinate: `30017:<pubkey>:<stall-d-tag>`.
  - `pubkey` is the shop owner (for Lightning Shop: the server key).
  - `d` tag (stall identifier) is a short, URL‑safe identifier (e.g. `main`, `shop`, `studio`).

- **Products:**
  - `KindProducts = 30018`.
  - Coordinate: `30018:<pubkey>:<product-d-tag>`.
  - `d` tag is a stable product identifier per pubkey (e.g. `painting-01`).

- **(Optional) Auctions / Bids:**
  - Auctions: `KindAuctionProduct = 30020`.
  - Bids: `KindBids = 1021`.
  - Same coordinate logic with `getEventCoordinates`.

**Action items**

- Add a small constants block (in `server/nostr.js` or a new `nostr-constants.js`) for kind numbers and a minimal `parseCoordinatesString` / `getEventCoordinates` port, based on Plebeian’s helpers.
- Decide:
  - One global stall for the entire shop (likely yes), with `d = "main"` or `d = Settings.storeSlug`.
  - Product d‑tag rule, e.g.:
    - `product:<local-id>` (simple mapping), or
    - A slug derived from product title: `slugify(title)`; store it in the DB to keep it stable.

### 2.2 Server Identity and Relays

Lightning Shop already has:

- `getShopKeys()` / `getShopPubkey()` in `nostr.js`.
- Settings keys for default relays (`nostrRelays`, `NOSTR_RELAYS_CSV`).

**Action items**

- Confirm production env will always have **one canonical signing key** for the shop.
- Decide relay policy:
  - Minimal required set (e.g. `wss://relay.damus.io`, `wss://nos.lol`) aligned with Plebeian defaults.
  - Configurable via `settings.nostrRelays` plus env fallback.
- Add a helper `nostrRelays()` (if not already) that:
  - Merges env + settings.
  - Normalizes URLs (like Plebeian `normalizeRelayUrl`).

---

## 3. Schema Alignment & DB Prep

The goal here is **not** to copy Plebeian’s full schema, but to ensure Lightning Shop’s DB can:

- Reconstruct Nostr event content precisely.
- Remember how each record maps to Nostr coordinates.
- Store basic event metadata and teaser info in a structured way.

### 3.1 Shop (Stall) Representation

**Existing data**

- `Settings` in `db.js` holds:
  - `storeName`, `contactNote`, hero text, shipping configuration (`shippingMode`, `shippingZones`, etc.), pictures, theme, and Nostr options (`nostrNpub`, `nostrRelays`, `nostrDefaultHashtags`, etc.).

**Plan**

- Add (or confirm) settings keys for Nostr stall identity:
  - `nostrStallDTag` – string like `"main"` (the `d` tag).
  - `nostrCurrency` – currency code used by Nostr stall (`"USD"`, `"EUR"`, or `"sats"`). If missing, fallback to `"sats"` or a default from `settings`.
  - Optionally `nostrStallImage` (cover image URL) and `nostrStallGeo` (geohash).
- In `product_nostr_posts` or a new table `nostr_shop_state`, track:
  - `stallCoordinates` (`"30017:<pubkey>:<d>"`).
  - `stallLastEventId`, `stallLastPublishedAt`, `stallRelays`, `stallLastAck` (JSON).

### 3.2 Products & Product Nostr Posts

**Existing data**

- `products` table (many product fields).
- `product_images` table for binary image data.
- `product_nostr_posts` table already exists with:
  - `productId`, `dTag`, `title`, `summary`, `content`, `imageUrl`, `topics`, `relays`, `mode`, `listingStatus`, `lastEventId`, `lastKind`, `lastPublishedAt`, `lastAck`, `lastNaddr`, and teaser‑related fields.

**Plan**

1. **Make d‑tags canonical for products**
   - Ensure each product has a stable `d` tag:
     - Either reuse existing `product_nostr_posts.dTag`, or
     - Add a `nostrSlug` / `nostrDTag` column to `products` and keep them in sync.
   - Validation rules:
     - Lowercase, alphanumeric + `-`/`_` only.
     - Unique per pubkey (in practice, unique for this shop).

2. **Store coordinates & kind**
   - Extend `product_nostr_posts` with:
     - `coordinates TEXT NOT NULL DEFAULT ''` (if not already present).
     - `kind INTEGER NOT NULL DEFAULT 30018`.
   - On read/update, compute:
     - `coordinates = "30018:" + getShopPubkey() + ":" + dTag`.

3. **Optionally cache canonical Nostr content**
   - Add `rawContent TEXT NOT NULL DEFAULT ''`:
     - JSON string of the last published/imported 30018 product event content.
   - This helps with:
     - Diffing between DB state and last published Nostr event.
     - Round‑tripping data when importing from Nostr.

### 3.3 Generic Nostr Event / Tag Store (Optional but Future‑proof)

For more advanced use (imports, auctions, tags), consider a generic store:

- `nostr_events` table:
  - `eventId TEXT PRIMARY KEY`,
  - `kind INTEGER`,
  - `pubkey TEXT`,
  - `createdAt INTEGER`,
  - `coordinates TEXT`,
  - `content TEXT`,
  - `sig TEXT`,
  - `sourceRelays TEXT` (JSON array of relay URLs),
  - `entityType TEXT` (e.g. `"product"`, `"stall"`, `"auction"`),
  - `entityId TEXT` (links to `products.id` / stall id).

- `nostr_event_tags` table:
  - `eventId TEXT`,
  - `name TEXT`,
  - `value TEXT`,
  - `extra1 TEXT`,
  - `extra2 TEXT`,
  - primary key on (`eventId`, `name`, `value`, `extra1`).

This is essentially the Plebeian `eventTags` idea, and can be implemented later if/when ingestion and tags become important.

---

## 4. Publishing Pipeline (DB → Nostr)

This phase exposes Lightning Shop’s data as Nostr events without ingesting anything yet.

### 4.1 Stall Publisher (kind 30017)

**Target event structure (aligned with Plebeian)**

- `kind = 30017`.
- `pubkey = getShopPubkey()`.
- `tags`:
  - `['d', nostrStallDTag]`.
  - Optional `['image', <cover-url>]` from `settings.aboutImage` or a dedicated `nostrStallImage`.
  - Optional `['g', <geohash>]` if location is desired later.
- `content` JSON:
  - `id`: coordinates string.
  - `name`: `Settings.storeName`.
  - `description`: from an about field (e.g. `aboutBody`).
  - `currency`: `nostrCurrency` (e.g. `"USD"`, `"EUR"`, `"sats"`).
  - `shipping`: array of simple methods derived from `settings.shippingMode` / `shippingZones`, e.g.:
    - `{ id: "default", name: "Worldwide", cost: "0" }` when flat/free.

**Implementation steps**

1. Add a helper in `nostr.js`, e.g. `buildStallEvent(settings) → { event, coordinates }`:
   - Compute coordinates via `getEventCoordinates`‑style logic.
   - Build tags and content as above.
2. Add `publishStall({ relays })`:
   - Uses `finalizeEvent` with server keys.
   - Publishes to chosen relays (via `Relay.connect` + `publishAndWait`, similar to `publishProductTeaser`).
   - Stores `stallCoordinates`, `stallLastEventId`, `stallLastPublishedAt`, and `lastAck` summary in DB (`Settings` or `nostr_shop_state`).
3. Expose an admin endpoint:
   - `POST /api/admin/nostr/stall/publish`.
   - Requires `requireAdmin`.
   - Returns `eventId`, `coordinates`, `pubkey`, `relays`, `ackSummary`.

### 4.2 Product Publisher (kind 30018)

**Target event structure**

- `kind = 30018`.
- `pubkey = getShopPubkey()`.
- `tags`:
  - `['d', productDTag]`.
  - `['t', <category>]` tags derived from product categories/hashtags.
  - `['a', <parent-coordinates>]` if parent product relationships are needed later (optional).
- `content` JSON example:

```json
{
  "id": "30018:<pubkey>:painting-01",
  "stall_id": "30017:<pubkey>:main",
  "name": "Oil Painting #1",
  "type": "simple",
  "description": "Original oil painting on canvas",
  "images": ["https://shop.example.com/path/to/image.jpg"],
  "currency": "sats",
  "price": 210000,        // in smallest unit chosen for Nostr realm
  "quantity": 1,
  "specs": [["width", "30cm"], ["height", "40cm"]],
  "shipping": [
    { "id": "worldwide", "cost": "0" }
  ]
}
```

**Mapping from current DB**

- `stall_id`:
  - Always set to the stall coordinates from 4.1 (`30017:<pubkey>:<nostrStallDTag>`).
- `name`, `description`:
  - From `products.title`, `products.longDescription || products.description`.
- `images`:
  - For now, derive from `ProductImages` / absolute URLs used in `/api/products/:id/image/...`.
  - Reuse logic from `productMainImageUrl` plus maybe extra gallery images.
- `currency` / `price`:
  - Decide a model:
    - Option A: use `"sats"` plus `price = priceSats`.
    - Option B: use fiat currency from Settings and convert if needed (requires FX logic, more complex).
  - Start with `"sats"` and `price = priceSats`.
- `quantity`:
  - Use `quantityAvailable` when `!isUnique`, else `1` (or 0 when sold out).
- `specs`:
  - Map dimensions (`widthCm`, `heightCm`, `depthCm`) and any other structured fields.
- `shipping`:
  - Derive from `settings.shippingMode` and `shippingZones` + per‑product overrides:
    - At least one method with a single base cost for now (keep it simple).

**Implementation steps**

1. Add `buildProductEvent(product, settings, nostrMeta)` in `nostr.js`:
   - Takes a `product` row, `Settings`, and its `product_nostr_posts` record.
   - Computes d‑tag, coordinates, tags, and JSON content as above.
2. Add `publishProduct({ productId, relays })`:
   - Loads product + `ProductNostrPosts`.
   - Builds event and signs it.
   - Publishes to relays (like the stall publisher).
   - Stores:
     - `lastEventId`, `lastKind`, `lastPublishedAt`, `lastAck`, `lastNaddr` (using npub/naddr as desired),
     - `coordinates`, `teaserHashtags` in `product_nostr_posts`.
3. Admin endpoints:
   - `POST /api/admin/nostr/products/:id/publish`.
   - `POST /api/admin/nostr/products/publish-all` (batch, with pagination or queue).

### 4.3 Tie Teasers (kind 1) to Products via `a` tags

Lightning Shop already has `publishProductTeaser`, which:

- Builds a kind‑1 note with content, image metadata, `t` tags, etc.

Extend it to:

- Accept an optional `coordinates` parameter (`"30018:<pubkey>:<d>"`).
- When present, add:
  - `['a', coordinates]` tag to the event.
- Optionally add a dedicated `['r', <product-url>]` (already used) plus text “Available here 👉 <url>”.

This makes teasers discoverable as “attached to” the canonical product PR event, same as Plebeian’s pattern.

---

## 5. Ingestion Pipeline (Nostr → DB) – Optional / Later

Once publishing works and is stable, you can add a **read side** to mirror Nostr content into the DB. This enables:

- Editing products from a Nostr client / Plebeian UI.
- Mixing external stalls/products into the shop (curation).

### 5.1 Subscription Strategy

- Use `nostr-tools` `SimplePool` (already imported in `nostr.js`).
- Define filters:
  - For your own shop:
    - `kinds: [30017, 30018]`, `authors: [getShopPubkey()]`.
  - For curated external shops:
    - A configurable list of allowed pubkeys and kinds.

Implement a helper, e.g. `fetchNostrCatalog({ relays, kinds, authors })` that:

- Fetches a snapshot of current events from relays (`pool.list`).
- Can be re‑run on demand (manual sync) or periodically by a background job.

### 5.2 Validation and Mapping

Mirror Plebeian’s server‑side logic in simpler form:

- For each fetched event:
  - Verify signature (`verifyEvent` from `nostr-tools/pure`).
  - Use `getEventCoordinates` to compute `coordinates`, `kind`, `pubkey`, `tagD`.
  - Parse `content` JSON.
  - Validate with a simple schema (e.g. Zod) that mirrors Plebeian’s `createStallEventContentSchema` / `createProductEventSchema` (subset is fine).

Then:

- For stalls (30017):
  - Upsert into a `nostr_stalls` table or into a special `Settings`+`nostr_shop_state` if they match your own pubkey.
- For products (30018):
  - Upsert:
    - `products` row (mapped from content).
    - `product_nostr_posts` row (coordinates, d‑tag, rawContent, etc.).
  - Record all tags into `nostr_event_tags` if needed for future filtering (categories, etc.).

### 5.3 Conflict Resolution

Because Lightning Shop currently treats DB as canonical:

- Choose a simple precedence rule:
  - For *your own* shop’s pubkey:
    - Admin panel edits are canonical.
    - Nostr imports are either:
      - “import once” (only for new products), or
      - “can overwrite only when explicitly triggered”.
  - For external pubkeys:
    - Nostr is canonical; DB just mirrors.

Document this policy in this file and enforce it in ingestion code.

---

## 6. API & UI Integration

After publishing and basic ingestion are in place, surface Nostr awareness in the admin and public API.

### 6.1 Admin API / UI

Add minimal admin endpoints:

- `GET /api/admin/nostr/overview`
  - Returns shop pubkey, npub, stall coordinates, recent publish status, and product Nostr status counts.
- `POST /api/admin/nostr/stall/publish`
  - Triggers stall event publish as in 4.1.
- `POST /api/admin/nostr/products/:id/publish`
  - Publish single product.
- `POST /api/admin/nostr/products/publish-all`
  - Batch publish (with safety guards: limit per call, or queue).

Admin UI can:

- Display shop npub (`npubFromHex(getShopPubkey())`).
- Show each product’s coordinates and last published state (OK / out of sync / never published).
- Offer a “Publish to Nostr” / “Sync from Nostr” button next to products.

### 6.2 Public API

Optionally extend public endpoints to expose Nostr metadata:

- `GET /api/public-settings`:
  - Add `nostrShopCoordinates`, `nostrStallDTag`, maybe a list of relays.
- `GET /api/products` / `GET /api/products/:id`:
  - Add `nostrCoordinates`, `nostrDTag`, `nostrLastEventId` fields for each product.

This allows external clients (or Plebeian itself) to find the matching Nostr event easily.

---

## 7. Identity, Profiles, and NIP‑05 (Future Enhancements)

Lightning Shop already:

- Supports Nostr login and comment proofs.
- Sends DMs on order status changes via NIP‑04.

To get closer to Plebeian’s model:

1. **Profile Storage**
   - Add a small `nostr_users` table mirroring Plebeian’s `users`:
     - `id` (pubkey), `name`, `about`, `picture`, `banner`, `nip05`, `website`, `lud16`, etc.
   - When a Nostr user logs in, fetch and validate their kind‑0 profile and upsert it.

2. **NIP‑05 verification**
   - Add a simple verification endpoint that:
     - Fetches NIP‑05 record JSON.
     - Confirms that the claimed pubkey matches.
   - Store verification result and expose an optional “verified” badge in the client.

3. **Relays / Contact list (NIP‑02)**
   - For logged‑in users, optionally track their relays (kind 3, 10002, 10006) for advanced UX.

These are not prerequisites for product/stall PR events, but they align the identity model for potential future cross‑site features.

---

## 8. Security, Performance, and Ops Considerations

- **Publishing safety**
  - Limit publishing concurrency and rate to avoid relay bans and rate limits.
  - Expose relays to admin UI, but pre‑validate their URLs before saving to settings.

- **Key management**
  - Keep server Nostr secret key in environment only (no DB).
  - Consider using `nsec` env with decoding already implemented in `nostr.js`.

- **Fail‑safe behavior**
  - If Nostr publish fails, do not break checkout or admin workflows:
    - Return a clear error to the admin, log details, but keep DB state unchanged.

- **Storage growth**
  - If a generic `nostr_events` store is added, consider pruning:
    - Keep only last N events per entity.
    - Or only PR events and current latest versions.

---

## 9. Incremental Rollout Plan

To make adoption safe, roll out in stages:

1. **Stage 1 – Internal wiring** ✅ done
   - Kind constants, coordinate helpers, d‑tag rules; `product_nostr_posts`/settings extended.

2. **Stage 2 – Stall publishing** ✅ done
   - Stall event builder + publisher; admin endpoint + UI.

3. **Stage 3 – Product publishing** ⚠️ not started
   - Product event builder + publisher; per‑product publish endpoint/controls; teasers with `a` tags.

4. **Stage 4 – Public metadata exposure** ⚠️ not started
   - Expose coordinates and Nostr status in public API responses.

5. **Stage 5 – Optional ingestion** ⚠️ partially done
   - One‑shot “import from Nostr” for stall/products implemented; no dedup/conflict policy; no validation/schema; only kinds 30017/30018.

6. **Stage 6 – Advanced goodies** ⚠️ not started
   - Auctions/bids; NIP‑05/profile sync; relay/contact list (NIP‑02); generic `nostr_events`/`nostr_event_tags`; conflict policies.

At each stage, confirm:

- Tests still pass (`server/tests`).
- Nostr behavior is non‑blocking (failures don’t break checkout).
- Configuration is driven by `.env` and `settings` to allow turning features on/off.

---

## 10. Open Questions / Decisions to Make

Before implementation, consider and document answers to:

1. **Currency model for Nostr products**
   - Use `"sats"` as currency and store `price` as sats?
   - Or adopt a fiat default (e.g. `"EUR"`) and handle conversion?

2. **Single vs multiple stalls**
   - Will Lightning Shop always represent a single shop/stall, or do you envision multi‑stall setups in the same instance?
   - If multi‑stall is possible, stall IDs and mappings must expand accordingly.

3. **Import trust rules**
   - Which pubkeys are allowed to populate the local catalog?
   - Are external stalls/products visible in the UI, or only used for your own items?

4. **Long‑term canonical source**
   - Do you eventually want Nostr to be canonical (DB mirrors), or will the DB remain canonical and Nostr a secondary view?

This plan is written to support either direction, but having clarity will help guide the exact schemas and conflict resolution logic.
