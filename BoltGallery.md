# BoltGallery plan

Goal: ship a separate project (`BoltGallery/`) that reuses Lightning Shop’s visual language but strips everything down to a public gallery of product names + images, plus a tiny admin to choose which Lightning Shop products to show and in what order. All images come from the Lightning Shop instance; no prices, availability, carts, or checkout.

## High-level approach
- Make `BoltGallery/` a sibling project with its own `client/` (Vite + React + Tailwind v4, same as Lightning Shop) and a slim `server/` (Express + better-sqlite3) that:
  - Proxies/syncs product metadata from the Lightning Shop API (including hidden/unavailable items via the Lightning Shop admin PIN).
  - Stores gallery-specific state: visibility + ordering per product, and gallery settings (title, subtitle, logos, theme tokens, favicon, pin code).
  - Exposes a tiny public API consumed by the gallery frontend.
- Keep the UI feel identical to Lightning Shop: same fonts, radius, shadows, theme selector (Dark Ink / Ember Night / Light Atelier / Auto / Custom), and footer line linking to GitHub.
- Public page: hero title + subtitle, then a responsive grid of cards showing just the name over the artwork image. Optional lightbox later; no detail pages.
- Admin at `/admin`: PIN login, “Products” screen to toggle visibility + reorder, “Settings” screen mirroring the simplified Lightning Shop settings (store name, title/subtitle, logos per theme, favicon, theme choice/tokens).

## Folder layout to create
```
BoltGallery/
  README.md (optional quickstart)
  .env.example
  package.json (workspace scripts to run client/server)
  client/   (Vite React app, Tailwind v4)
  server/   (Express API + SQLite)
```

## Server design (BoltGallery/server)
Tech: Express, better-sqlite3, cookie-session, axios (or node-fetch) + tough-cookie for Lightning Shop admin calls, cors.

### Env (.env.example)
- `PORT=9090` (gallery server port)
- `SESSION_SECRET=...`
- `GALLERY_ADMIN_PIN=1234` (for /admin login)
- `LIGHTNING_SHOP_BASE=http://127.0.0.1:8080` (root of Lightning Shop)
- `LIGHTNING_SHOP_ADMIN_PIN=1234` (used server-to-server to fetch hidden/unavailable products)
- `CORS_ORIGIN=http://localhost:5174` (gallery frontend origin)

### Data model (SQLite)
- `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`  
  Mirrors Lightning Shop fields we need: `storeName`, `titleLine` (subtitle), `heroLine`, `logo`, `logoDark`, `logoLight`, `favicon`, `themeChoice`, `themeTokens`.
- `gallery_products(productId TEXT PRIMARY KEY, visible INTEGER NOT NULL DEFAULT 0, sortOrder INTEGER NOT NULL DEFAULT 0, lastTitle TEXT DEFAULT '', lastImageThumb TEXT DEFAULT '', lastImage TEXT DEFAULT '')`  
  - `visible`: 1 if shown in BoltGallery public grid.  
  - `sortOrder`: manual order (higher first).  
  - `last*` cached from Lightning Shop admin fetch so the gallery can render even if the item is hidden/unavailable there; URLs stay absolute to Lightning Shop.
- Migration helper to ensure tables/columns exist on boot (similar to Lightning Shop db.js pattern).

### Lightning Shop integration
- Build an internal client with a cookie jar:
  - POST `${LIGHTNING_SHOP_BASE}/api/admin/login` with `{pin: LIGHTNING_SHOP_ADMIN_PIN}`; store cookies.
  - GET `${LIGHTNING_SHOP_BASE}/api/admin/products?page=1&pageSize=9999` to retrieve all products (including hidden/unavailable) with `mainImageThumbAbsoluteUrl` + `mainImageAbsoluteUrl`.
  - GET `${LIGHTNING_SHOP_BASE}/api/public-settings` for logos/theme defaults (optional for preview).
- On startup and then on demand (admin refresh button), sync products:
  - Upsert `gallery_products` rows for every Lightning Shop product, preserving existing `visible/sortOrder` if already present.
  - Cache `lastTitle`, `lastImageThumb`, `lastImage` from the Lightning Shop response to avoid duplicating image blobs.

### Public API (served by BoltGallery)
- `GET /api/public/settings` → stored settings + derived theme tokens (same merge logic as Lightning Shop defaults). Include `title`/`subtitle` and logo/favicons.
- `GET /api/public/gallery` → list of visible products ordered by `sortOrder` (then createdAt if needed), each with `{id, title, mainImageThumbUrl, mainImageUrl}` coming from cached Lightning Shop URLs.

### Admin API
- `POST /api/admin/login` `{pin}` → sets session cookie if matches `GALLERY_ADMIN_PIN`.
- `POST /api/admin/logout`
- `GET /api/admin/me` → `{loggedIn: true}`
- `GET /api/admin/products` → full Lightning Shop product list (admin fetch) joined with gallery flags: `{id, title, hidden, available, mainImageThumbAbsoluteUrl, mainImageAbsoluteUrl, visible, sortOrder}`.
- `PUT /api/admin/gallery` `{items: [{productId, visible, sortOrder}]}` → bulk save visibility/order.
- `GET /api/admin/settings` / `PUT /api/admin/settings` → same shape as Lightning Shop for the kept fields (`storeName`, `heroLine`/`titleLine`, `logo`, `logoDark`, `logoLight`, `favicon`, `themeChoice`, `themeTokens`).
- Optional: `POST /api/admin/sync-products` to force-refresh from Lightning Shop.

### Middleware & other notes
- Reuse `makeCors` style: allow credentials, restrict origins via `CORS_ORIGIN`.
- Use `cookie-session` same as Lightning Shop to keep behavior consistent.
- Build `absoluteLsUrl(path)` helper mirroring `absoluteApiUrl` to normalize Lightning Shop image URLs.

## Frontend design (BoltGallery/client)
Tech: Vite + React 19, React Router, Tailwind v4, framer-motion (for subtle entrance), axios client similar to Lightning Shop (`API_BASE` from `VITE_API_URL`).

### Styling & theme
- Copy `src/index.css` theme blocks from Lightning Shop (fonts, radius, ring thickness, Ember/Light overrides, pay-now styles not needed). Remove checkout-specific classes; keep theme tokens + `data-theme` handling.
- Keep typography variables (`--font-display`, `--font-body`) and theme tokens merged in a `SettingsProvider` identical to `client/src/store/settings.jsx` (title, favicon, theme tokens, data-theme on `<html>`).

### Public routes
- `/` only. Layout: header with optional logo + store name/title, subtitle under it, then gallery grid.
- Gallery cards: reuse `ProductCard` structure but strip price/availability; show image with overlayed title, gentle hover gradient, and responsive aspect ratio. Clicking can open a simple lightbox later (not required now).
- Footer: same copy as Lightning Shop (`The code to self-host your store is open sourced here 👉 GitHub (same as lightning shop)`) with the GitHub badge.

### Admin routes (`/admin`)
- `Login` screen identical to Lightning Shop (PIN input).
- `Dashboard` shell (reuse nav style) with two tabs:
  - `Products`: list all Lightning Shop products (including hidden/unavailable). Show thumb + title + badges for hidden/unavailable. Controls: toggle “Show in gallery”, reorder (up/down and “send to top/bottom”), save button. Optional “Refresh from Lightning Shop” to resync.
  - `Settings`: fields matching Lightning Shop logic (store name, title/subtitle line, hero line, logos for dark/light, favicon, theme choice radio, custom theme token inputs). Use same merge/reset behavior for theme tokens.
- No Orders, Nostr, pricing, or shipping sections.

### Data flow in the frontend
- On load, fetch `/api/public/settings` + `/api/public/gallery`.
- Apply theme via `SettingsProvider` (set CSS vars + `data-theme`), update document title + favicon same way as Lightning Shop.
- Admin screens talk only to BoltGallery server; the server talks to Lightning Shop.

## Implementation steps
1) Scaffold `BoltGallery/` with package.json workspaces and install deps (client: react, react-router-dom, framer-motion, tailwindcss@4, axios; server: express, better-sqlite3, cors, cookie-session, axios + tough-cookie).  
2) Build server:
   - init SQLite, tables, migrate helper;
   - Lightning Shop client with PIN login + sync function;
   - public/admin routes above; CORS/session middleware; `npm start`.
3) Build client:
   - copy over `index.css`, `tailwind.config.cjs`, `vite.config.js` from Lightning Shop and trim unused bits;
   - implement `SettingsProvider`, `api.js` helper, and `App` routes (public + lazy-loaded Admin);
   - public gallery page + card component;
   - admin login + dashboard + products + settings components (reuse Lightning Shop patterns and copy/paste with deletions to stay consistent).
4) Wire env/config:
   - `.env.example` at root and `client/.env.example` if needed (`VITE_API_URL=http://localhost:9090/api`);
   - add `LIGHTNING_SHOP_BASE`/`PIN` docs and remind to whitelist the gallery origin in Lightning Shop `CORS_ORIGIN` if calling directly.
5) QA: run Lightning Shop locally, seed a few products, start BoltGallery server/client, verify admin shows hidden items, toggle visibility/order, and ensure the public grid only shows selected items with images coming from Lightning Shop URLs.

## Notes / open points
- If we prefer no server-to-server PIN, we can add a dedicated “gallery products” endpoint to Lightning Shop; current plan avoids changing Lightning Shop by using its admin PIN from env.
- Keep everything ASCII (no new Unicode) and reuse existing design tokens to avoid visual drift.
- Future niceties: lightbox on click, lazy image loading with `loading="lazy"`, optional Masonry layout for art-heavy grids.
