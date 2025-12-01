import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { makeId, now } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_DB_FILE = String(process.env.DB_FILE || "").trim();
const DB_PATH = ENV_DB_FILE
  ? (path.isAbsolute(ENV_DB_FILE) ? ENV_DB_FILE : path.resolve(__dirname, ENV_DB_FILE))
  : path.join(__dirname, "shop.db");
const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

export const DEFAULT_TEASER_HASHTAGS = "#shop #lightning #bitcoin";

function hasColumn(table, name) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === name);
}
function addColumnIfMissing(table, colDef) {
  const name = colDef.split(/\s+/)[0];
  if (!hasColumn(table, name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priceSats INTEGER NOT NULL,
  images TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  hidden INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  displayOrder INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  items TEXT NOT NULL,
  subtotalSats INTEGER NOT NULL,
  shippingSats INTEGER NOT NULL,
  totalSats INTEGER NOT NULL,
  paymentMethod TEXT NOT NULL DEFAULT 'lightning',
  name TEXT, surname TEXT, address TEXT, city TEXT, province TEXT, postalCode TEXT, country TEXT,
  contactEmail TEXT, contactTelegram TEXT, contactNostr TEXT, contactPhone TEXT,
  status TEXT NOT NULL,
  paymentHash TEXT,
  paymentRequest TEXT,
  boltzSwapId TEXT DEFAULT '',
  boltzAddress TEXT DEFAULT '',
  boltzExpectedAmountSats INTEGER DEFAULT 0,
  boltzTimeoutBlockHeight INTEGER DEFAULT 0,
  boltzRefundPrivKey TEXT DEFAULT '',
  boltzStatus TEXT DEFAULT '',
  createdAt INTEGER NOT NULL,
  clientId TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_images (
  productId TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data TEXT NOT NULL,
  hash TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(productId, idx),
  FOREIGN KEY(productId) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS product_nostr_posts (
  productId TEXT PRIMARY KEY,
  dTag TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  imageUrl TEXT NOT NULL DEFAULT '',
  topics TEXT NOT NULL DEFAULT '[]',
  relays TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL DEFAULT 'live',
  listingStatus TEXT NOT NULL DEFAULT 'available',
  lastEventId TEXT NOT NULL DEFAULT '',
  lastKind INTEGER NOT NULL DEFAULT 0,
  lastPublishedAt INTEGER NOT NULL DEFAULT 0,
  lastNaddr TEXT NOT NULL DEFAULT '',
  lastAck TEXT NOT NULL DEFAULT '[]',
  teaserContent TEXT NOT NULL DEFAULT '',
  teaserLastEventId TEXT NOT NULL DEFAULT '',
  teaserLastPublishedAt INTEGER NOT NULL DEFAULT 0,
  teaserLastAck TEXT NOT NULL DEFAULT '[]',
  teaserHashtags TEXT NOT NULL DEFAULT '#shop #lightning #bitcoin',
  createdAt INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updatedAt INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY(productId) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS nostr_carts (
  pubkey TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);
`);

// Migrations
addColumnIfMissing("products", "subtitle TEXT DEFAULT ''");
addColumnIfMissing("products", "longDescription TEXT DEFAULT ''");
addColumnIfMissing("products", "mainImageIndex INTEGER DEFAULT 0");
addColumnIfMissing("products", "widthCm INTEGER DEFAULT NULL");
addColumnIfMissing("products", "heightCm INTEGER DEFAULT NULL");
addColumnIfMissing("products", "depthCm INTEGER DEFAULT NULL");
addColumnIfMissing("products", "shippingItalySats INTEGER DEFAULT 0");
addColumnIfMissing("products", "shippingEuropeSats INTEGER DEFAULT 0");
addColumnIfMissing("products", "shippingWorldSats INTEGER DEFAULT 0");
addColumnIfMissing("products", "shippingSurchargeSats INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("products", "shippingZoneOverrides TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("products", "showDimensions INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("products", "imageVersion TEXT DEFAULT ''");
addColumnIfMissing("products", "imageCount INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("products", "hidden INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("products", "displayOrder INTEGER NOT NULL DEFAULT 0");

const zeroDisplayOrder = db.prepare(`SELECT COUNT(*) AS cnt FROM products WHERE displayOrder=0`).get();
if (zeroDisplayOrder?.cnt > 0) {
  const rowsForOrdering = db
    .prepare(`SELECT id FROM products ORDER BY available DESC, createdAt DESC`)
    .all();
  if (rowsForOrdering.length) {
    const baseTs = now();
    const updateDisplayOrder = db.prepare(`UPDATE products SET displayOrder=? WHERE id=?`);
    const seedDisplayOrder = db.transaction((rows) => {
      let offset = rows.length;
      for (const row of rows) {
        updateDisplayOrder.run(baseTs + offset, row.id);
        offset -= 1;
      }
    });
    seedDisplayOrder(rowsForOrdering);
  }
}

addColumnIfMissing("orders", "contactEmail TEXT DEFAULT ''");
addColumnIfMissing("orders", "contactTelegram TEXT DEFAULT ''");
addColumnIfMissing("orders", "contactNostr TEXT DEFAULT ''");
addColumnIfMissing("orders", "contactPhone TEXT DEFAULT ''");
addColumnIfMissing("orders", "city TEXT DEFAULT ''");
addColumnIfMissing("orders", "province TEXT DEFAULT ''");
addColumnIfMissing("orders", "clientId TEXT DEFAULT ''");
addColumnIfMissing("orders", "notes TEXT DEFAULT ''");
addColumnIfMissing("orders", "paymentMethod TEXT NOT NULL DEFAULT 'lightning'");
addColumnIfMissing("orders", "boltzSwapId TEXT DEFAULT ''");
addColumnIfMissing("orders", "boltzAddress TEXT DEFAULT ''");
addColumnIfMissing("orders", "boltzExpectedAmountSats INTEGER DEFAULT 0");
addColumnIfMissing("orders", "boltzTimeoutBlockHeight INTEGER DEFAULT 0");
addColumnIfMissing("orders", "boltzRefundPrivKey TEXT DEFAULT ''");
addColumnIfMissing("orders", "boltzStatus TEXT DEFAULT ''");
// NEW: shipping metadata
addColumnIfMissing("orders", "courier TEXT DEFAULT ''");
addColumnIfMissing("orders", "tracking TEXT DEFAULT ''");

addColumnIfMissing("product_nostr_posts", "teaserContent TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("product_nostr_posts", "teaserLastEventId TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("product_nostr_posts", "teaserLastPublishedAt INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("product_nostr_posts", "teaserLastAck TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("product_nostr_posts", `teaserHashtags TEXT NOT NULL DEFAULT '${DEFAULT_TEASER_HASHTAGS}'`);

db.exec(`
CREATE INDEX IF NOT EXISTS idx_products_available_created ON products(available DESC, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_products_available_order_created ON products(available DESC, displayOrder DESC, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_orders_createdAt ON orders(createdAt DESC);
`);

// settings table remains KV; we ensure defaults below

const sGet = db.prepare(`SELECT value FROM settings WHERE key=?`);
const sSet = db.prepare(`
  INSERT INTO settings(key, value) VALUES(?, ?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`);

if (!sGet.get("storeName")) sSet.run("storeName", "Your Shop Name");
if (!sGet.get("contactNote")) sSet.run("contactNote", "For anything contact me at shop@example.com!");
if (!sGet.get("logo")) sSet.run("logo", "");
if (!sGet.get("logoDark")) sSet.run("logoDark", "");
if (!sGet.get("logoLight")) sSet.run("logoLight", "");
if (!sGet.get("favicon")) sSet.run("favicon", "");

// New defaults / ensure presence
if (!sGet.get("productsHeading")) sSet.run("productsHeading", "Featured Products");
if (!sGet.get("heroLine")) sSet.run("heroLine", "Quality pieces made for you and shipped with care.");
if (!sGet.get("radiusScale")) sSet.run("radiusScale", "3xl");
// About / hero CTA / shipping / commission defaults
if (!sGet.get("aboutTitle")) sSet.run("aboutTitle", "About Us");
if (!sGet.get("aboutBody")) sSet.run("aboutBody", "Use this space to introduce who you are, what you create, and how you work. Update it with your story and what customers can expect.");
if (!sGet.get("aboutImage")) sSet.run("aboutImage", "");
if (!sGet.get("heroCtaLabel")) sSet.run("heroCtaLabel", "Learn more");
if (!sGet.get("heroCtaHref")) sSet.run("heroCtaHref", "/about");
if (!sGet.get("shippingTitle")) sSet.run("shippingTitle", "How shipping works");
if (!sGet.get("shippingBullet1")) sSet.run("shippingBullet1", "Ships worldwide from our base.");
if (!sGet.get("shippingBullet2")) sSet.run("shippingBullet2", "Typical delivery 3–7 business days in region.");
if (!sGet.get("shippingBullet3")) sSet.run("shippingBullet3", "Packed securely with tracking.");
if (!sGet.get("shippingMode")) sSet.run("shippingMode", "simple");
if (!sGet.get("shippingDomesticCountry")) sSet.run("shippingDomesticCountry", "IT");
if (!sGet.get("shippingDomesticPriceSats")) sSet.run("shippingDomesticPriceSats", "0");
if (!sGet.get("shippingContinentPrices")) sSet.run("shippingContinentPrices", JSON.stringify({
  EU: 0, AS: 0, NA: 0, SA: 0, OC: 0, AF: 0, ME: 0
}));
if (!sGet.get("shippingOverrides")) sSet.run("shippingOverrides", "[]");
if (!sGet.get("commissionTitle")) sSet.run("commissionTitle", "Commissions & Contact");
if (!sGet.get("commissionBody")) sSet.run("commissionBody", "Open to custom requests - share your idea and I will reply with options.");
if (!sGet.get("commissionCtaLabel")) sSet.run("commissionCtaLabel", "Write to me");
if (!sGet.get("commissionCtaHref")) sSet.run("commissionCtaHref", "/about");

// ── NEW: Nostr / Lightning address settings (editable in admin) ──
if (!sGet.get("nostrNpub")) sSet.run("nostrNpub", "");
if (!sGet.get("nostrNip05")) sSet.run("nostrNip05", "");
if (!sGet.get("nostrRelays")) sSet.run("nostrRelays", JSON.stringify(["wss://relay.damus.io","wss://nos.lol"]));
if (!sGet.get("lightningAddress")) sSet.run("lightningAddress", "");
if (!sGet.get("nostrCommentsEnabled")) sSet.run("nostrCommentsEnabled", "true");
if (!sGet.get("nostrBlockedPubkeys")) sSet.run("nostrBlockedPubkeys", "[]");
if (!sGet.get("nostrBlockedHashtags")) sSet.run("nostrBlockedHashtags", "[]");

// ── NEW: Theme selector (dark | light | auto) ──
if (!sGet.get("themeChoice")) sSet.run("themeChoice", "dark");
if (!sGet.get("nostrDefaultHashtags")) sSet.run("nostrDefaultHashtags", DEFAULT_TEASER_HASHTAGS);

// ── NEW: Notification templates (DM + Email subject/body per status) ──
const DEFAULT_SUBJECT = `[{{storeName}}] Order {{orderId}}, {{statusLabel}}`;

// DM defaults
if (!sGet.get("notifyDmTemplate_PAID")) sSet.run(
  "notifyDmTemplate_PAID",
  [
    "Thank you for your order {{orderId}}.",
    "Status: {{status}}",
    "🎉 Great news, your payment was received. We’re starting to prepare your order and we’ll send you the tracking number as soon as it ships. 🚚",
    "Total: {{totalSats}} sats"
  ].join("\n")
);
if (!sGet.get("notifyDmTemplate_PREPARATION")) sSet.run(
  "notifyDmTemplate_PREPARATION",
  [
    "Thank you for your order {{orderId}}.",
    "Status: {{status}}",
    "We’re preparing your order. We’ll send the tracking number as soon as it ships.",
    "Total: {{totalSats}} sats"
  ].join("\n")
);
if (!sGet.get("notifyDmTemplate_SHIPPED")) sSet.run(
  "notifyDmTemplate_SHIPPED",
  [
    "Thank you for your order {{orderId}}.",
    "Status: {{status}}",
    "Shipment details:",
    "Courier: {{courier}}",
    "Tracking: {{tracking}}",
    "Total: {{totalSats}} sats"
  ].join("\n")
);

// Email subjects defaults (all statuses share same default unless customized)
if (!sGet.get("notifyEmailSubject_PAID")) sSet.run("notifyEmailSubject_PAID", DEFAULT_SUBJECT);
if (!sGet.get("notifyEmailSubject_PREPARATION")) sSet.run("notifyEmailSubject_PREPARATION", DEFAULT_SUBJECT);
if (!sGet.get("notifyEmailSubject_SHIPPED")) sSet.run("notifyEmailSubject_SHIPPED", DEFAULT_SUBJECT);

// Email bodies defaults
if (!sGet.get("notifyEmailBody_PAID")) sSet.run(
  "notifyEmailBody_PAID",
  [
    "{{storeName}}, Order {{orderId}}",
    "Status: {{statusLabel}}",
    "",
    "🎉 Thank you, we received your payment.",
    "We’re preparing your order and will send tracking as soon as it ships.",
    "",
    "Total: {{totalSats}} sats"
  ].join("\n")
);
if (!sGet.get("notifyEmailBody_PREPARATION")) sSet.run(
  "notifyEmailBody_PREPARATION",
  [
    "{{storeName}}, Order {{orderId}}",
    "Status: {{statusLabel}}",
    "",
    "We’re preparing your order. We’ll send tracking as soon as it ships.",
    "",
    "Total: {{totalSats}} sats"
  ].join("\n")
);
if (!sGet.get("notifyEmailBody_SHIPPED")) sSet.run(
  "notifyEmailBody_SHIPPED",
  [
    "{{storeName}}, Order {{orderId}}",
    "Status: {{statusLabel}}",
    "",
    "Your order has shipped! 🚚",
    "Courier: {{courier}}",
    "Tracking: {{tracking}}",
    "",
    "Total: {{totalSats}} sats"
  ].join("\n")
);

// ✨ Signature default (configured from Admin Dashboard)
if (!sGet.get("smtpSignature")) sSet.run("smtpSignature", "Thanks for your support,\nYour Shop Name");

const EMPTY_IMAGES_JSON = "[]";
const MAX_PRODUCT_IMAGES = 8;
const KEEP_IMAGE_TOKEN_PREFIX = "keep:";

const selectImagesStmt = db.prepare(`SELECT data FROM product_images WHERE productId=? ORDER BY idx ASC`);
const selectImageStmt = db.prepare(`SELECT data, hash FROM product_images WHERE productId=? AND idx=?`);
const deleteImagesStmt = db.prepare(`DELETE FROM product_images WHERE productId=?`);
const insertImageStmt = db.prepare(`INSERT INTO product_images (productId, idx, data, hash) VALUES (?,?,?,?)`);
const selectMainIdxStmt = db.prepare(`SELECT mainImageIndex FROM products WHERE id=?`);
const updateImageMetaStmt = db.prepare(`
  UPDATE products
     SET images=?, imageCount=?, imageVersion=?, mainImageIndex=?
   WHERE id=?
`);
const countImagesStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM product_images WHERE productId=?`);

const replaceImagesTxn = db.transaction((productId, payload, hashes, version) => {
  deleteImagesStmt.run(productId);
  payload.forEach((src, idx) => insertImageStmt.run(productId, idx, src, hashes[idx]));
  const curIdx = selectMainIdxStmt.get(productId);
  const safeIdx = clampImageIndex(curIdx?.mainImageIndex ?? 0, payload.length);
  updateImageMetaStmt.run(EMPTY_IMAGES_JSON, payload.length, version, safeIdx, productId);
});

function clampImageIndex(idx, count) {
  if (!Number.isFinite(idx)) return 0;
  if (count <= 0) return 0;
  const maxIdx = Math.max(0, count - 1);
  return Math.min(Math.max(0, idx | 0), maxIdx);
}

function hashDataUrl(src) {
  return crypto.createHash("sha1").update(src || "").digest("hex");
}

function normalizeImageInputs(images) {
  if (!Array.isArray(images)) return [];
  return images
    .map((src) => (typeof src === "string" ? src.trim() : ""))
    .filter(Boolean)
    .slice(0, MAX_PRODUCT_IMAGES);
}

function imagesAreUnchanged(normalized, currentCount) {
  if (!Array.isArray(normalized)) return false;
  if (normalized.length !== currentCount) return false;
  for (let i = 0; i < normalized.length; i += 1) {
    const entry = normalized[i];
    if (!entry.startsWith(KEEP_IMAGE_TOKEN_PREFIX)) return false;
    const idx = Number.parseInt(entry.slice(KEEP_IMAGE_TOKEN_PREFIX.length), 10);
    if (!Number.isFinite(idx) || idx !== i) return false;
  }
  return true;
}

function prepareImagePayload(images, { preNormalized, resolveExisting } = {}) {
  const list = Array.isArray(preNormalized) ? preNormalized : normalizeImageInputs(images);
  const payload = [];
  for (const entry of list) {
    if (entry.startsWith("data:")) {
      payload.push({ data: entry, hash: hashDataUrl(entry) });
    } else if (entry.startsWith(KEEP_IMAGE_TOKEN_PREFIX) && typeof resolveExisting === "function") {
      const idxToken = entry.slice(KEEP_IMAGE_TOKEN_PREFIX.length);
      const idx = Number.parseInt(idxToken, 10);
      if (!Number.isFinite(idx) || idx < 0) continue;
      const existing = resolveExisting(idx);
      if (existing?.data) {
        payload.push({
          data: existing.data,
          hash: existing.hash || hashDataUrl(existing.data)
        });
      }
    }
  }
  return payload;
}

export const ProductImages = {
  list(productId) {
    const rows = selectImagesStmt.all(productId);
    return rows.map((r) => r.data);
  },
  getRecord(productId, idx) {
    const row = selectImageStmt.get(productId, idx);
    return row ? { data: row.data, hash: row.hash } : null;
  },
  replaceAll(productId, images = []) {
    const payload = [];
    const hashes = [];
    for (const entry of Array.isArray(images) ? images : []) {
      if (!entry) continue;
      if (typeof entry === "string") {
        payload.push(entry);
        hashes.push(hashDataUrl(entry));
      } else if (typeof entry === "object" && typeof entry.data === "string") {
        payload.push(entry.data);
        hashes.push(entry.hash || hashDataUrl(entry.data));
      }
    }
    const versionHash = crypto.createHash("sha1");
    hashes.forEach((h) => versionHash.update(h));
    const version = payload.length ? versionHash.digest("hex") : "";
    replaceImagesTxn(productId, payload, hashes, version);
    return { count: payload.length, version };
  },
  removeAll(productId) {
    replaceImagesTxn(productId, [], [], "");
  }
};

function normalizeNostrRow(row) {
  if (!row) return null;
  return {
    productId: row.productId,
    dTag: row.dTag || "",
    title: row.title || "",
    summary: row.summary || "",
    content: row.content || "",
    imageUrl: row.imageUrl || "",
    topics: sanitizeTopicsFromDb(row.topics),
    relays: sanitizeRelaysFromDb(row.relays),
    mode: row.mode || "live",
    listingStatus: row.listingStatus || "available",
    lastEventId: row.lastEventId || "",
    lastKind: Number(row.lastKind || 0),
    lastPublishedAt: Number(row.lastPublishedAt || 0),
    lastNaddr: row.lastNaddr || "",
    lastAck: sanitizeAckFromDb(row.lastAck),
    teaserHashtags: row.teaserHashtags || DEFAULT_TEASER_HASHTAGS,
    teaserContent: row.teaserContent || "",
    teaserLastEventId: row.teaserLastEventId || "",
    teaserLastPublishedAt: Number(row.teaserLastPublishedAt || 0),
    teaserLastAck: sanitizeAckFromDb(row.teaserLastAck),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0)
  };
}

function sanitizeTopicsFromDb(payload) {
  const arr = safeParseJSON(payload, []);
  if (!Array.isArray(arr)) return [];
  return arr.map((t) => String(t || "").trim()).filter(Boolean);
}

function sanitizeRelaysFromDb(payload) {
  const arr = safeParseJSON(payload, []);
  if (!Array.isArray(arr)) return [];
  return arr.map((r) => String(r || "").trim()).filter(Boolean);
}

function sanitizeAckFromDb(payload) {
  const arr = safeParseJSON(payload, []);
  if (!Array.isArray(arr)) return [];
  return arr.map((entry) => ({
    relay: String(entry?.relay || ""),
    ok: !!entry?.ok,
    error: entry?.error ? String(entry.error) : ""
  }));
}

function normalizeDTag(productId, raw) {
  const fallback = `product:${productId}`;
  const input = String(raw || "").trim();
  if (!input) return fallback;
  const cleaned = input.replace(/\s+/g, "-").replace(/[^A-Za-z0-9:._-]/g, "");
  if (!cleaned) return fallback;
  return cleaned.slice(0, 256);
}

function sanitizeTopicsInput(topics) {
  if (!Array.isArray(topics)) return [];
  return topics
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .slice(0, 16);
}

function sanitizeRelaysInput(relays) {
  if (!Array.isArray(relays)) return [];
  return relays
    .map((r) => String(r || "").trim())
    .filter(Boolean)
    .slice(0, 16);
}

function sanitizeMode(mode) {
  return mode === "draft" ? "draft" : "live";
}

function sanitizeListingStatus(status) {
  return status === "sold" ? "sold" : "available";
}

function sanitizeAckList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((entry) => ({
    relay: String(entry?.relay || ""),
    ok: !!entry?.ok,
    error: entry?.error ? String(entry.error) : ""
  }));
}

function ensureImageUrlWithExt(url, ext = "jpg") {
  const value = String(url || "").trim();
  if (!value) return "";
  if (!value.includes("/image/") && !value.includes("/thumb/")) return value;
  const [base, ...queryParts] = value.split("?");
  if (/\.(jpg|jpeg|png|webp|gif)$/i.test(base)) {
    return queryParts.length ? `${base}?${queryParts.join("?")}` : base;
  }
  const suffixed = `${base}.${ext}`;
  return queryParts.length ? `${suffixed}?${queryParts.join("?")}` : suffixed;
}

function extractMimeFromDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,/i.exec(String(dataUrl || ""));
  return match ? match[1] : "";
}

function extFromMime(mime, fallback = "jpg") {
  const value = String(mime || "").toLowerCase();
  if (value.includes("png")) return "png";
  if (value.includes("webp")) return "webp";
  if (value.includes("gif")) return "gif";
  if (value.includes("avif")) return "avif";
  if (value.includes("jpeg") || value.includes("jpg")) return "jpg";
  return fallback;
}

export const ProductNostrPosts = {
  get(productId) {
    const row = db
      .prepare(`SELECT * FROM product_nostr_posts WHERE productId=?`)
      .get(productId);
    return normalizeNostrRow(row);
  },

  upsert(productId, data = {}) {
    const dTag = normalizeDTag(productId, data.dTag);
    const nowTs = now();
    const title = String(data.title || "").trim().slice(0, 280);
    const summary = String(data.summary || "").trim().slice(0, 560);
    const content = String(data.content || "");
    const imageUrl = String(data.imageUrl || "").trim().slice(0, 1024);
    const topics = sanitizeTopicsInput(data.topics);
    const relays = sanitizeRelaysInput(data.relays);
    const mode = sanitizeMode(data.mode);
    const listingStatus = sanitizeListingStatus(data.listingStatus);
    const existing = this.get(productId);
    const teaserContent =
      data.teaserContent !== undefined
        ? String(data.teaserContent || "")
        : existing?.teaserContent || "";
    const teaserHashtags =
      data.teaserHashtags !== undefined
        ? String(data.teaserHashtags || "").trim()
        : existing?.teaserHashtags || DEFAULT_TEASER_HASHTAGS;

    if (existing) {
      db.prepare(`
        UPDATE product_nostr_posts
           SET dTag=?,
               title=?,
               summary=?,
               content=?,
               imageUrl=?,
               topics=?,
               relays=?,
               mode=?,
               listingStatus=?,
               teaserContent=?,
               teaserHashtags=?,
               updatedAt=?
         WHERE productId=?`)
        .run(
          dTag,
          title,
          summary,
          content,
          imageUrl,
          JSON.stringify(topics),
          JSON.stringify(relays),
          mode,
          listingStatus,
          teaserContent,
          teaserHashtags,
          nowTs,
          productId
        );
    } else {
      db.prepare(`
        INSERT INTO product_nostr_posts
          (productId, dTag, title, summary, content, imageUrl, topics, relays, mode, listingStatus, lastEventId, lastKind, lastPublishedAt, lastAck, lastNaddr, teaserContent, teaserLastEventId, teaserLastPublishedAt, teaserLastAck, teaserHashtags, createdAt, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          productId,
          dTag,
          title,
          summary,
          content,
          imageUrl,
          JSON.stringify(topics),
          JSON.stringify(relays),
          mode,
          listingStatus,
          "",
          0,
          0,
          "[]",
          "",
          teaserContent,
          "",
          0,
          "[]",
          teaserHashtags,
          nowTs,
          nowTs
        );
    }
    return this.get(productId);
  },

  recordPublish(productId, data = {}) {
    const dTag = normalizeDTag(productId, data.dTag);
    const nowTs = now();
    const title = String(data.title || "").trim().slice(0, 280);
    const summary = String(data.summary || "").trim().slice(0, 560);
    const content = String(data.content || "");
    const imageUrl = String(data.imageUrl || "").trim().slice(0, 1024);
    const topics = sanitizeTopicsInput(data.topics);
    const relays = sanitizeRelaysInput(data.relays);
    const mode = sanitizeMode(data.mode);
    const listingStatus = sanitizeListingStatus(data.listingStatus);
    const lastEventId = String(data.lastEventId || "").trim();
    const lastKind = Number(data.lastKind || 0) | 0;
    const publishedAt = Number(data.lastPublishedAt || nowTs);
    const ack = sanitizeAckList(data.lastAck);
    const lastNaddr = String(data.lastNaddr || "").trim();

    const existing = this.get(productId);
    const teaserContent =
      data.teaserContent !== undefined
        ? String(data.teaserContent || "")
        : existing?.teaserContent || "";
    const teaserLastEventId = existing?.teaserLastEventId || "";
    const teaserLastPublishedAt = existing?.teaserLastPublishedAt || 0;
    const teaserLastAck = JSON.stringify(sanitizeAckList(existing?.teaserLastAck || []));
    const teaserHashtags = data.teaserHashtags !== undefined
      ? String(data.teaserHashtags || "").trim()
      : existing?.teaserHashtags || DEFAULT_TEASER_HASHTAGS;

    if (existing) {
      db.prepare(`
        UPDATE product_nostr_posts
           SET dTag=?,
               title=?,
               summary=?,
               content=?,
               imageUrl=?,
               topics=?,
               relays=?,
               mode=?,
               listingStatus=?,
               lastEventId=?,
               lastKind=?,
               lastPublishedAt=?,
               lastAck=?,
               lastNaddr=?,
               teaserContent=?,
               teaserHashtags=?,
               updatedAt=?
         WHERE productId=?`)
        .run(
          dTag,
          title,
          summary,
          content,
          imageUrl,
          JSON.stringify(topics),
          JSON.stringify(relays),
          mode,
          listingStatus,
          lastEventId,
          lastKind,
          publishedAt,
          JSON.stringify(ack),
          lastNaddr,
          teaserContent,
          teaserHashtags,
          nowTs,
          productId
        );
    } else {
      db.prepare(`
        INSERT INTO product_nostr_posts
          (productId, dTag, title, summary, content, imageUrl, topics, relays, mode, listingStatus, lastEventId, lastKind, lastPublishedAt, lastAck, lastNaddr, teaserContent, teaserLastEventId, teaserLastPublishedAt, teaserLastAck, teaserHashtags, createdAt, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          productId,
          dTag,
          title,
          summary,
          content,
          imageUrl,
          JSON.stringify(topics),
          JSON.stringify(relays),
          mode,
          listingStatus,
          lastEventId,
          lastKind,
          publishedAt,
          JSON.stringify(ack),
          lastNaddr,
          teaserContent,
          teaserLastEventId,
          Number(teaserLastPublishedAt || 0),
          teaserLastAck,
          teaserHashtags,
          nowTs,
          nowTs
        );
    }
    return this.get(productId);
  },

  setTeaser(productId, { content, imageUrl, relays, hashtags } = {}) {
    const nowTs = now();
    const teaserContent = String(content || "");
    const sanitizedRelays = relays !== undefined ? sanitizeRelaysInput(relays) : null;
    const sanitizedImage =
      imageUrl !== undefined ? String(imageUrl || "").trim().slice(0, 1024) : null;
    const normalizedImage = sanitizedImage !== null ? ensureImageUrlWithExt(sanitizedImage) : null;
    const normalizedHashtags = hashtags !== undefined ? String(hashtags || "").trim() : null;
    const existing = this.get(productId);
    if (existing) {
      const nextImage = normalizedImage !== null ? normalizedImage : ensureImageUrlWithExt(existing.imageUrl || "");
      const nextRelays = sanitizedRelays !== null ? sanitizedRelays : (existing.relays || []);
      const nextHashtags = normalizedHashtags !== null ? normalizedHashtags : (existing.teaserHashtags || DEFAULT_TEASER_HASHTAGS);
      db.prepare(`
        UPDATE product_nostr_posts
           SET teaserContent=?,
               imageUrl=?,
               relays=?,
               teaserHashtags=?,
               updatedAt=?
         WHERE productId=?`)
        .run(
          teaserContent,
          nextImage,
          JSON.stringify(nextRelays),
          nextHashtags,
          nowTs,
          productId
        );
      return this.get(productId);
    }
    const relaysJson = JSON.stringify(sanitizedRelays ?? []);
    db.prepare(`
      INSERT INTO product_nostr_posts
        (productId, dTag, title, summary, content, imageUrl, topics, relays, mode, listingStatus, lastEventId, lastKind, lastPublishedAt, lastAck, lastNaddr, teaserContent, teaserLastEventId, teaserLastPublishedAt, teaserLastAck, teaserHashtags, createdAt, updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        productId,
        `product:${productId}`,
        "",
        "",
        "",
        normalizedImage ?? "",
        "[]",
        relaysJson,
        "live",
        "available",
        "",
        0,
        0,
        "[]",
        "",
        teaserContent,
        "",
        0,
        "[]",
        normalizedHashtags !== null ? normalizedHashtags : DEFAULT_TEASER_HASHTAGS,
        nowTs,
        nowTs
      );
    return this.get(productId);
  },

  recordTeaserPublish(productId, { content, lastEventId, lastPublishedAt, lastAck } = {}) {
    const nowTs = now();
    const teaserContent = String(content || "");
    const teaserLastEventId = String(lastEventId || "").trim();
    const teaserLastPublishedAt = Number(lastPublishedAt || nowTs);
    const teaserLastAck = JSON.stringify(sanitizeAckList(lastAck));
    const existing = this.get(productId);
    const teaserHashtags = existing?.teaserHashtags || DEFAULT_TEASER_HASHTAGS;
    if (existing) {
      db.prepare(`
        UPDATE product_nostr_posts
           SET teaserContent=?,
               teaserLastEventId=?,
               teaserLastPublishedAt=?,
               teaserLastAck=?,
               teaserHashtags=?,
               updatedAt=?
         WHERE productId=?`)
        .run(
          teaserContent,
          teaserLastEventId,
          teaserLastPublishedAt,
          teaserLastAck,
          teaserHashtags,
          nowTs,
          productId
        );
      return this.get(productId);
    }
    db.prepare(`
      INSERT INTO product_nostr_posts
        (productId, dTag, title, summary, content, imageUrl, topics, relays, mode, listingStatus, lastEventId, lastKind, lastPublishedAt, lastAck, lastNaddr, teaserContent, teaserLastEventId, teaserLastPublishedAt, teaserLastAck, teaserHashtags, createdAt, updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        productId,
        `product:${productId}`,
        "",
        "",
        "",
        "",
        "[]",
        "[]",
        "live",
        "available",
        "",
        0,
        0,
        "[]",
        "",
        teaserContent,
        teaserLastEventId,
        teaserLastPublishedAt,
        teaserLastAck,
        teaserHashtags,
        nowTs,
        nowTs
      );
    return this.get(productId);
  }
};

function migrateInlineProductImages() {
  const rows = db
    .prepare(`SELECT id, images FROM products WHERE images IS NOT NULL AND TRIM(images) <> '' AND images <> '[]'`)
    .all();
  if (!rows.length) return;
  let migrated = 0;
  const clearStmt = db.prepare(`UPDATE products SET images=? WHERE id=?`);
  for (const row of rows) {
    const existing = countImagesStmt.get(row.id);
    if ((existing?.cnt || 0) > 0) {
      clearStmt.run(EMPTY_IMAGES_JSON, row.id);
      continue;
    }
    const parsed = safeParseJSON(row.images, []);
    const payload = prepareImagePayload(parsed);
    if (!payload.length) {
      clearStmt.run(EMPTY_IMAGES_JSON, row.id);
      continue;
    }
    ProductImages.replaceAll(row.id, payload);
    migrated += payload.length;
  }
  if (migrated > 0) {
    console.info(`[db] Migrated ${migrated} inline product images into product_images table.`);
  }
}
migrateInlineProductImages();

export const Products = {
  all({ includeImages = false } = {}) {
    const rows = db
      .prepare(`SELECT * FROM products ORDER BY available DESC, displayOrder DESC, createdAt DESC`)
      .all();
    return rows.map((row) => normalizeProductRow(row, { includeImages }));
  },

  count() {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM products`).get();
    return Number(row?.cnt || 0);
  },

  page({ offset = 0, limit = 24 } = {}) {
    const rows = db
      .prepare(`SELECT * FROM products ORDER BY available DESC, displayOrder DESC, createdAt DESC LIMIT ? OFFSET ?`)
      .all(limit, offset);
    return rows.map((row) => normalizeProductRow(row, { includeImages: false }));
  },

  allFull() {
    return this.all({ includeImages: true });
  },

  allPublic() {
    const rows = db
      .prepare(`SELECT * FROM products ORDER BY available DESC, displayOrder DESC, createdAt DESC`)
      .all();
    return rows
      .map((row) => normalizeProductRow(row))
      .filter((n) => n && !n.hidden)
      .map((n) => {
      const count = Math.max(0, Number(n.imageCount || 0));
      const safeIdx = clampImageIndex(n.mainImageIndex, count);
      const versionTag = n.imageVersion
        ? `?v=${encodeURIComponent(`${n.imageVersion}-${safeIdx}`)}`
        : "";
      let ext = "jpg";
      if (count) {
        const rec = ProductImages.getRecord(n.id, safeIdx);
        if (rec?.data) {
          const mime = extractMimeFromDataUrl(rec.data);
          ext = extFromMime(mime, "jpg");
        }
      }
      const thumbUrl = count ? `/api/products/${n.id}/thumb/${safeIdx}.${ext}${versionTag}` : "";
      const mainUrl = count ? `/api/products/${n.id}/image/${safeIdx}.${ext}${versionTag}` : "";
      const textHash = crypto.createHash("sha1");
      textHash.update(String(n.title || ""));
      textHash.update("\x1f");
      textHash.update(String(n.subtitle || ""));
      textHash.update("\x1f");
      textHash.update(String(n.description || ""));
      textHash.update("\x1f");
      textHash.update(String(n.longDescription || ""));
      const textTag = textHash.digest("hex");
      const overrideTag = Array.isArray(n.shippingZoneOverrides)
        ? n.shippingZoneOverrides.map((ov) => `${ov.id}:${ov.priceSats}`).join(",")
        : "";
      return {
        id: n.id,
        title: n.title,
        subtitle: n.subtitle,
        priceSats: n.priceSats,
        available: n.available,
        hidden: n.hidden,
        createdAt: n.createdAt,
        mainImageIndex: safeIdx,
        mainImageThumbUrl: thumbUrl || null,
        mainImageUrl: mainUrl || null,
        imageCount: count,
        widthCm: n.widthCm,
        heightCm: n.heightCm,
        depthCm: n.depthCm,
        showDimensions: !!n.showDimensions,
        shippingItalySats: n.shippingItalySats,
        shippingEuropeSats: n.shippingEuropeSats,
        shippingWorldSats: n.shippingWorldSats,
        shippingZoneOverrides: Array.isArray(n.shippingZoneOverrides) ? n.shippingZoneOverrides : [],
        cacheTag: [
          n.id,
          n.available ? 1 : 0,
          n.hidden ? 1 : 0,
          n.createdAt || 0,
          n.displayOrder || 0,
          n.priceSats,
          safeIdx,
          n.imageVersion || "",
          textTag,
          n.widthCm ?? "",
          n.heightCm ?? "",
          n.depthCm ?? "",
          n.showDimensions ? "1" : "0",
          overrideTag,
          n.shippingItalySats,
          n.shippingEuropeSats,
          n.shippingWorldSats
        ].join(":")
      };
    });
  },

  get(id, { includeImages = true } = {}) {
    const row = db.prepare(`SELECT * FROM products WHERE id=?`).get(id);
    return row ? normalizeProductRow(row, { includeImages }) : null;
  },

  create({
    title,
    subtitle,
    description,
    longDescription,
    priceSats,
    images,
    mainImageIndex = 0,
    widthCm = null,
    heightCm = null,
    depthCm = null,
    showDimensions = true,
    shippingSurchargeSats = 0,
    shippingItalySats = 0,
    shippingEuropeSats = 0,
    shippingWorldSats = 0,
    shippingZoneOverrides = [],
  }) {
    const normalizedImages = normalizeImageInputs(images);
    const imagePayload = prepareImagePayload(normalizedImages, { preNormalized: normalizedImages });
    const safeMainIdx = clampImageIndex(mainImageIndex, imagePayload.length);
    const id = makeId();
    const createdAt = now();
    const displayOrder = createdAt;
    const normalizedOverrides = normalizeZoneOverridesInput(shippingZoneOverrides);
    db.prepare(
      `INSERT INTO products
       (id, title, description, priceSats, images, available, hidden, createdAt, displayOrder,
        subtitle, longDescription, mainImageIndex, widthCm, heightCm, depthCm, showDimensions,
        shippingSurchargeSats, shippingItalySats, shippingEuropeSats, shippingWorldSats,
        shippingZoneOverrides, imageVersion, imageCount)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      title,
      description ?? "",
      Math.floor(priceSats),
      EMPTY_IMAGES_JSON,
      createdAt,
      displayOrder,
      subtitle ?? "",
      (longDescription ?? description ?? ""),
      safeMainIdx,
      numOrNull(widthCm),
      numOrNull(heightCm),
      numOrNull(depthCm),
      showDimensions ? 1 : 0,
      Math.max(0, shippingSurchargeSats | 0),
      Math.max(0, shippingItalySats | 0),
      Math.max(0, shippingEuropeSats | 0),
      Math.max(0, shippingWorldSats | 0),
      JSON.stringify(normalizedOverrides),
      "",
      0
    );
    ProductImages.replaceAll(id, imagePayload);
    return this.get(id);
  },

  update(id, patch = {}) {
    const cur = this.get(id, { includeImages: false });
    if (!cur) return null;
    const hasImages = Array.isArray(patch.images);
    let normalizedImages = null;
    let imagePayload = null;
    let nextImageCount = cur.imageCount;
    let shouldRewriteImages = false;

    if (hasImages) {
      normalizedImages = normalizeImageInputs(patch.images);
      const unchanged = imagesAreUnchanged(normalizedImages, cur.imageCount);
      shouldRewriteImages = !unchanged;
      if (shouldRewriteImages) {
        imagePayload = prepareImagePayload(normalizedImages, {
          preNormalized: normalizedImages,
          resolveExisting: (idx) => ProductImages.getRecord(id, idx)
        });
        nextImageCount = imagePayload.length;
      }
    }

    const desiredMainIdx = patch.mainImageIndex !== undefined ? patch.mainImageIndex : cur.mainImageIndex;
    const safeMainIdx = clampImageIndex(desiredMainIdx, nextImageCount);

    const normalizedOverrides = patch.shippingZoneOverrides !== undefined
      ? normalizeZoneOverridesInput(patch.shippingZoneOverrides)
      : (Array.isArray(cur.shippingZoneOverrides) ? cur.shippingZoneOverrides : []);

    db.prepare(
      `UPDATE products
         SET title=?, description=?, priceSats=?, images=?, available=?, hidden=?,
             subtitle=?, longDescription=?, mainImageIndex=?,
             widthCm=?, heightCm=?, depthCm=?, showDimensions=?,
             shippingSurchargeSats=?, shippingItalySats=?, shippingEuropeSats=?, shippingWorldSats=?,
             shippingZoneOverrides=?
       WHERE id=?`
    ).run(
      patch.title ?? cur.title,
      (patch.description ?? cur.description ?? ""),
      Math.floor((patch.priceSats ?? cur.priceSats) || 0),
      EMPTY_IMAGES_JSON,
      (patch.available ?? cur.available) ? 1 : 0,
      (patch.hidden ?? cur.hidden) ? 1 : 0,
      patch.subtitle ?? cur.subtitle ?? "",
      (patch.longDescription ?? cur.longDescription ?? cur.description ?? ""),
      safeMainIdx,
      numOrNull(patch.widthCm ?? cur.widthCm),
      numOrNull(patch.heightCm ?? cur.heightCm),
      numOrNull(patch.depthCm ?? cur.depthCm),
      (patch.showDimensions ?? cur.showDimensions) ? 1 : 0,
      Math.max(0, (patch.shippingSurchargeSats ?? cur.shippingSurchargeSats) | 0),
      Math.max(0, (patch.shippingItalySats ?? cur.shippingItalySats) | 0),
      Math.max(0, (patch.shippingEuropeSats ?? cur.shippingEuropeSats) | 0),
      Math.max(0, (patch.shippingWorldSats ?? cur.shippingWorldSats) | 0),
      JSON.stringify(normalizedOverrides),
      id
    );

    if (shouldRewriteImages && imagePayload) {
      ProductImages.replaceAll(id, imagePayload);
    }
    return this.get(id);
  },

  remove(id) {
    ProductImages.removeAll(id);
    db.prepare(`DELETE FROM products WHERE id=?`).run(id);
  },

  markSold(id) {
    db.prepare(`UPDATE products SET available=0 WHERE id=?`).run(id);
  },

  reorder(orderIds = []) {
    if (!Array.isArray(orderIds) || orderIds.length === 0) return 0;

    const allRows = db
      .prepare(`SELECT id FROM products ORDER BY available DESC, displayOrder DESC, createdAt DESC`)
      .all();
    if (!allRows.length) return 0;

    const currentOrder = allRows.map((row) => row.id);
    const validSet = new Set(currentOrder);
    const seen = new Set();
    const deduped = [];

    for (const rawId of orderIds) {
      const id = String(rawId || "").trim();
      if (!id || seen.has(id) || !validSet.has(id)) continue;
      seen.add(id);
      deduped.push(id);
    }

    if (!deduped.length) return 0;

    const remainder = currentOrder.filter((id) => !seen.has(id));
    const finalOrder = deduped.concat(remainder);

    const baseTs = now();
    const updateStmt = db.prepare(`UPDATE products SET displayOrder=? WHERE id=?`);
    const applyOrder = db.transaction((ids) => {
      let offset = ids.length;
      for (const id of ids) {
        updateStmt.run(baseTs + offset, id);
        offset -= 1;
      }
    });
    applyOrder(finalOrder);
    return finalOrder.length;
  },
};

function normalizeProductRow(row, { includeImages = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    priceSats: Number(row.priceSats || 0),
    available: !!row.available,
    hidden: !!row.hidden,
    createdAt: row.createdAt ?? 0,
    displayOrder: Number(row.displayOrder || 0),
    subtitle: row.subtitle || "",
    longDescription: row.longDescription || row.description || "",
    mainImageIndex: Number.isInteger(row.mainImageIndex) ? row.mainImageIndex : 0,
    widthCm: row.widthCm ?? null,
    heightCm: row.heightCm ?? null,
    depthCm: row.depthCm ?? null,
    showDimensions: !!row.showDimensions,
    shippingSurchargeSats: Number(row.shippingSurchargeSats || 0),
    shippingItalySats: Number(row.shippingItalySats || 0),
    shippingEuropeSats: Number(row.shippingEuropeSats || 0),
    shippingWorldSats: Number(row.shippingWorldSats || 0),
    shippingZoneOverrides: parseZoneOverrides(row.shippingZoneOverrides),
    imageCount: Number(row.imageCount || 0),
    imageVersion: row.imageVersion || ""
  };
  if (includeImages) {
    base.images = ProductImages.list(row.id);
    base.imageCount = base.images.length;
  }
  return base;
}

export const Orders = {
  all() {
    this.prunePendingOlderThan(24 * 60 * 60 * 1000);
    return db
      .prepare(`SELECT * FROM orders ORDER BY createdAt DESC`)
      .all()
      .map(normalizeOrderRow);
  },
  get(id) {
    const o = db.prepare(`SELECT * FROM orders WHERE id=?`).get(id);
    return o ? normalizeOrderRow(o) : null;
  },
  byPaymentHash(paymentHash) {
    const o = db.prepare(`SELECT * FROM orders WHERE paymentHash=?`).get(paymentHash);
    return o ? normalizeOrderRow(o) : null;
  },
  bySwapId(swapId) {
    const o = db.prepare(`SELECT * FROM orders WHERE boltzSwapId=?`).get(swapId);
    return o ? normalizeOrderRow(o) : null;
  },
  byClientId(clientId) {
    const rows = db
      .prepare(`SELECT * FROM orders WHERE clientId=? ORDER BY createdAt DESC`)
      .all(clientId);
    return rows.map(normalizeOrderRow);
  },
  create(order) {
    const id = makeId();
    const stmt = db.prepare(`
      INSERT INTO orders (
        id, items, subtotalSats, shippingSats, totalSats,
        paymentMethod,
        name, surname, address, city, province, postalCode, country,
        contactEmail, contactTelegram, contactNostr, contactPhone,
        status, paymentHash, paymentRequest,
        boltzSwapId, boltzAddress, boltzExpectedAmountSats, boltzTimeoutBlockHeight, boltzRefundPrivKey, boltzStatus,
        createdAt, clientId, notes
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `);
    stmt.run(
      id,
      JSON.stringify(order.items || []),
      order.subtotalSats,
      order.shippingSats,
      order.totalSats,
      order.paymentMethod || "lightning",
      order.name,
      order.surname,
      order.address,
      order.city,
      order.province,
      order.postalCode,
      order.country,
      order.contactEmail || "",
      order.contactTelegram || "",
      order.contactNostr || "",
      order.contactPhone || "",
      "PENDING",
      order.paymentHash || null,
      order.paymentRequest || null,
      order.boltzSwapId || "",
      order.boltzAddress || "",
      Math.max(0, Math.floor(Number(order.boltzExpectedAmountSats || 0))),
      Math.max(0, Math.floor(Number(order.boltzTimeoutBlockHeight || 0))),
      order.boltzRefundPrivKey || "",
      order.boltzStatus || "",
      now(),
      order.clientId || "",
      order.notes || ""
    );
    return this.get(id);
  },
  setPaymentInfo(id, { paymentHash, paymentRequest }) {
    db.prepare(`UPDATE orders SET paymentHash=?, paymentRequest=? WHERE id=?`).run(
      paymentHash,
      paymentRequest,
      id
    );
    return this.get(id);
  },
  markPaidByHash(paymentHash) {
    db.prepare(`UPDATE orders SET status='PAID' WHERE paymentHash=?`).run(paymentHash);
    return this.byPaymentHash(paymentHash);
  },
  markPaidBySwapId(boltzSwapId) {
    db.prepare(`UPDATE orders SET status='PAID' WHERE boltzSwapId=?`).run(boltzSwapId);
    return this.bySwapId(boltzSwapId);
  },
  updateBoltzStatus(boltzSwapId, status) {
    if (!boltzSwapId) return null;
    db.prepare(`UPDATE orders SET boltzStatus=? WHERE boltzSwapId=?`).run(status || "", boltzSwapId);
    return this.bySwapId(boltzSwapId);
  },
  setStatus(id, status, extras = {}) {
    const cur = this.get(id);
    if (!cur) return null;
    const courier = (extras.courier !== undefined) ? String(extras.courier || "") : cur.courier || "";
    const tracking = (extras.tracking !== undefined) ? String(extras.tracking || "") : cur.tracking || "";
    db.prepare(`UPDATE orders SET status=?, courier=?, tracking=? WHERE id=?`)
      .run(status, courier, tracking, id);
    return this.get(id);
  },
  remove(id) {
    db.prepare(`DELETE FROM orders WHERE id=?`).run(id);
  },
  prunePendingOlderThan(ms) {
    const cutoff = now() - ms;
    db.prepare(`DELETE FROM orders WHERE status='PENDING' AND createdAt < ?`).run(cutoff);
  },
};

function normalizeOrderRow(o) {
  return {
    ...o,
    items: safeParseJSON(o.items, []),
    courier: o.courier || "",
    city: o.city || "",
    province: o.province || "",
    tracking: o.tracking || "",
    contactPhone: o.contactPhone || "",
    paymentMethod: o.paymentMethod || "lightning",
    boltzSwapId: o.boltzSwapId || "",
    boltzAddress: o.boltzAddress || "",
    boltzExpectedAmountSats: Number(o.boltzExpectedAmountSats || 0),
    boltzTimeoutBlockHeight: Number(o.boltzTimeoutBlockHeight || 0),
    boltzStatus: o.boltzStatus || ""
  };
}

export const NostrCarts = {
  get(pubkey) {
    const key = String(pubkey || "");
    if (!key) return null;
    const row = db.prepare(`SELECT data FROM nostr_carts WHERE pubkey=?`).get(key);
    if (!row || !row.data) return null;
    try {
      return JSON.parse(row.data);
    } catch {
      return null;
    }
  },
  set(pubkey, data) {
    const key = String(pubkey || "");
    if (!key) return false;
    const payload = JSON.stringify(data || {});
    db.prepare(`
      INSERT INTO nostr_carts (pubkey, data, updatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(pubkey) DO UPDATE SET
        data=excluded.data,
        updatedAt=excluded.updatedAt
    `).run(key, payload, now());
    return true;
  },
  clear(pubkey) {
    const key = String(pubkey || "");
    if (!key) return;
    db.prepare(`DELETE FROM nostr_carts WHERE pubkey=?`).run(key);
  }
};

export const Settings = {
  getAll() {
    const rows = db.prepare(`SELECT key, value FROM settings`).all();
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const nostrCommentsEnabled = (() => {
      const raw = String(map.nostrCommentsEnabled ?? "true").toLowerCase();
      return !["false", "0", "off", "no"].includes(raw);
    })();
    return {
      storeName: map.storeName || "Your Shop Name",
      contactNote: map.contactNote || "",
      logo: map.logo || "",
      logoDark: map.logoDark || "",
      logoLight: map.logoLight || "",
      favicon: map.favicon || "",
      productsHeading: map.productsHeading || "Featured Products",
      heroLine: map.heroLine === undefined
        ? "Quality pieces made for you and shipped with care."
        : map.heroLine,
      radiusScale: map.radiusScale || "3xl",
      aboutTitle: map.aboutTitle || "About Us",
      aboutBody: map.aboutBody === undefined
        ? "Use this space to introduce who you are, what you create, and how you work. Update it with your story and what customers can expect."
        : map.aboutBody,
      aboutImage: map.aboutImage || "",
      heroCtaLabel: map.heroCtaLabel || "Learn more",
      heroCtaHref: map.heroCtaHref || "/about",
      shippingTitle: map.shippingTitle || "How shipping works",
      shippingBullet1: map.shippingBullet1 || "",
      shippingBullet2: map.shippingBullet2 || "",
      shippingBullet3: map.shippingBullet3 || "",
      shippingZones: safeParseJSON(map.shippingZones, []),
      shippingMode: map.shippingMode || "simple",
      shippingDomesticCountry: map.shippingDomesticCountry || "IT",
      shippingDomesticPriceSats: Number(map.shippingDomesticPriceSats || 0),
      shippingContinentPrices: safeParseJSON(map.shippingContinentPrices, { EU:0, AS:0, NA:0, SA:0, OC:0, AF:0, ME:0 }),
      shippingOverrides: safeParseJSON(map.shippingOverrides, []),
      commissionTitle: map.commissionTitle || "Commissions & Contact",
      commissionBody: map.commissionBody === undefined
        ? "Open to custom requests - share your idea and I will reply with options."
        : map.commissionBody,
      commissionCtaLabel: map.commissionCtaLabel || "Write to me",
      commissionCtaHref: map.commissionCtaHref || "/about",
      // NEW:
      nostrNpub: map.nostrNpub || "",
      nostrNip05: map.nostrNip05 || "",
      nostrRelays: safeParseJSON(map.nostrRelays, ["wss://relay.damus.io","wss://nos.lol"]),
      lightningAddress: map.lightningAddress || "",
      // NEW: theme
      themeChoice: map.themeChoice || "dark",
      nostrDefaultHashtags: map.nostrDefaultHashtags || DEFAULT_TEASER_HASHTAGS,
      nostrCommentsEnabled,
      nostrBlockedPubkeys: safeParseJSON(map.nostrBlockedPubkeys, []),
      nostrBlockedHashtags: safeParseJSON(map.nostrBlockedHashtags, []),
      // NEW: Notification templates
      notifyDmTemplate_PAID: map.notifyDmTemplate_PAID || "",
      notifyDmTemplate_PREPARATION: map.notifyDmTemplate_PREPARATION || "",
      notifyDmTemplate_SHIPPED: map.notifyDmTemplate_SHIPPED || "",
      notifyEmailSubject_PAID: map.notifyEmailSubject_PAID || "",
      notifyEmailSubject_PREPARATION: map.notifyEmailSubject_PREPARATION || "",
      notifyEmailSubject_SHIPPED: map.notifyEmailSubject_SHIPPED || "",
      notifyEmailBody_PAID: map.notifyEmailBody_PAID || "",
      notifyEmailBody_PREPARATION: map.notifyEmailBody_PREPARATION || "",
      notifyEmailBody_SHIPPED: map.notifyEmailBody_SHIPPED || "",
      // ✨ Signature (admin dashboard)
      smtpSignature: map.smtpSignature === undefined
        ? "Thanks for your support,\nYour Shop Name"
        : map.smtpSignature
    };
  },
  // Public subset (safe for client)
  getPublic() {
    const full = this.getAll();
    let nostrCommentsEnabled = !!full.nostrCommentsEnabled;
    const envRaw = process.env.ENABLE_NOSTR_COMMENTS ?? process.env.VITE_ENABLE_NOSTR_COMMENTS;
    if (envRaw !== undefined) {
      const raw = String(envRaw).toLowerCase();
      nostrCommentsEnabled = !["false", "0", "off", "no"].includes(raw);
    }
    return {
      storeName: full.storeName,
      contactNote: full.contactNote,
      logo: full.logo,
      logoDark: full.logoDark,
      logoLight: full.logoLight,
      favicon: full.favicon,
      productsHeading: full.productsHeading,
      heroLine: full.heroLine,
      radiusScale: full.radiusScale,
      aboutTitle: full.aboutTitle,
      aboutBody: full.aboutBody,
      aboutImage: full.aboutImage,
      heroCtaLabel: full.heroCtaLabel,
      heroCtaHref: full.heroCtaHref,
      shippingTitle: full.shippingTitle,
      shippingBullet1: full.shippingBullet1,
      shippingBullet2: full.shippingBullet2,
      shippingBullet3: full.shippingBullet3,
      shippingZones: full.shippingZones,
      shippingMode: full.shippingMode,
      shippingDomesticCountry: full.shippingDomesticCountry,
      shippingDomesticPriceSats: full.shippingDomesticPriceSats,
      shippingContinentPrices: full.shippingContinentPrices,
      shippingOverrides: full.shippingOverrides,
      commissionTitle: full.commissionTitle,
      commissionBody: full.commissionBody,
      commissionCtaLabel: full.commissionCtaLabel,
      commissionCtaHref: full.commissionCtaHref,
      nostrNpub: full.nostrNpub,
      nostrNip05: full.nostrNip05,
      nostrRelays: full.nostrRelays,
      lightningAddress: full.lightningAddress,
      themeChoice: full.themeChoice,
      nostrDefaultHashtags: full.nostrDefaultHashtags,
      nostrBlockedPubkeys: full.nostrBlockedPubkeys,
      nostrBlockedHashtags: full.nostrBlockedHashtags,
      nostrCommentsEnabled
    };
  },
  setAll({
    storeName, contactNote, logo, logoDark, logoLight, favicon, productsHeading, heroLine, radiusScale,
    aboutTitle, aboutBody, aboutImage, heroCtaLabel, heroCtaHref,
    shippingTitle, shippingBullet1, shippingBullet2, shippingBullet3,
    shippingZones, shippingMode, shippingDomesticCountry, shippingDomesticPriceSats, shippingContinentPrices, shippingOverrides,
    commissionTitle, commissionBody, commissionCtaLabel, commissionCtaHref,
    // NEW:
    nostrNpub, nostrNip05, nostrRelays, lightningAddress,
    // NEW: theme
    themeChoice,
    nostrDefaultHashtags,
    nostrCommentsEnabled,
    nostrBlockedPubkeys,
    nostrBlockedHashtags,
    // NEW: notification templates
    notifyDmTemplate_PAID, notifyDmTemplate_PREPARATION, notifyDmTemplate_SHIPPED,
    notifyEmailSubject_PAID, notifyEmailSubject_PREPARATION, notifyEmailSubject_SHIPPED,
    notifyEmailBody_PAID, notifyEmailBody_PREPARATION, notifyEmailBody_SHIPPED,
    // ✨ Signature (admin)
    smtpSignature
  }) {
    if (storeName !== undefined) sSet.run("storeName", storeName || "");
    if (contactNote !== undefined) sSet.run("contactNote", contactNote || "");
    if (logo !== undefined) sSet.run("logo", logo || "");
    if (logoDark !== undefined) sSet.run("logoDark", logoDark || "");
    if (logoLight !== undefined) sSet.run("logoLight", logoLight || "");
    if (favicon !== undefined) sSet.run("favicon", favicon || "");
    if (productsHeading !== undefined) sSet.run("productsHeading", productsHeading || "");
    if (heroLine !== undefined) sSet.run("heroLine", heroLine || "");
    if (radiusScale !== undefined) sSet.run("radiusScale", radiusScale || "3xl");
    if (aboutTitle !== undefined) sSet.run("aboutTitle", aboutTitle || "");
    if (aboutBody !== undefined) sSet.run("aboutBody", aboutBody || "");
    if (aboutImage !== undefined) sSet.run("aboutImage", aboutImage || "");
    if (heroCtaLabel !== undefined) sSet.run("heroCtaLabel", heroCtaLabel || "");
    if (heroCtaHref !== undefined) sSet.run("heroCtaHref", heroCtaHref || "/about");
    if (shippingTitle !== undefined) sSet.run("shippingTitle", shippingTitle || "");
    if (shippingBullet1 !== undefined) sSet.run("shippingBullet1", shippingBullet1 || "");
    if (shippingBullet2 !== undefined) sSet.run("shippingBullet2", shippingBullet2 || "");
    if (shippingBullet3 !== undefined) sSet.run("shippingBullet3", shippingBullet3 || "");
    if (shippingZones !== undefined) {
      const val = Array.isArray(shippingZones) ? JSON.stringify(shippingZones) : String(shippingZones || "[]");
      sSet.run("shippingZones", val);
    }
    if (shippingMode !== undefined) sSet.run("shippingMode", shippingMode || "simple");
    if (shippingDomesticCountry !== undefined) sSet.run("shippingDomesticCountry", shippingDomesticCountry || "IT");
    if (shippingDomesticPriceSats !== undefined) {
      const val = Math.max(0, Number(shippingDomesticPriceSats || 0));
      sSet.run("shippingDomesticPriceSats", String(val));
    }
    if (shippingContinentPrices !== undefined) {
      const val = Array.isArray(shippingContinentPrices) || typeof shippingContinentPrices === "object"
        ? JSON.stringify(shippingContinentPrices)
        : String(shippingContinentPrices || "{}");
      sSet.run("shippingContinentPrices", val);
    }
    if (shippingOverrides !== undefined) {
      const val = Array.isArray(shippingOverrides) ? JSON.stringify(shippingOverrides) : String(shippingOverrides || "[]");
      sSet.run("shippingOverrides", val);
    }
    if (commissionTitle !== undefined) sSet.run("commissionTitle", commissionTitle || "");
    if (commissionBody !== undefined) sSet.run("commissionBody", commissionBody || "");
    if (commissionCtaLabel !== undefined) sSet.run("commissionCtaLabel", commissionCtaLabel || "");
    if (commissionCtaHref !== undefined) sSet.run("commissionCtaHref", commissionCtaHref || "/about");
    // NEW:
    if (nostrNpub !== undefined) sSet.run("nostrNpub", nostrNpub || "");
    if (nostrNip05 !== undefined) sSet.run("nostrNip05", nostrNip05 || "");
    if (nostrRelays !== undefined) {
      const val = Array.isArray(nostrRelays) ? JSON.stringify(nostrRelays) : String(nostrRelays || "");
      sSet.run("nostrRelays", val);
    }
    if (nostrBlockedPubkeys !== undefined) {
      const val = Array.isArray(nostrBlockedPubkeys) ? JSON.stringify(nostrBlockedPubkeys) : String(nostrBlockedPubkeys || "");
      sSet.run("nostrBlockedPubkeys", val);
    }
    if (nostrBlockedHashtags !== undefined) {
      const val = Array.isArray(nostrBlockedHashtags) ? JSON.stringify(nostrBlockedHashtags) : String(nostrBlockedHashtags || "");
      sSet.run("nostrBlockedHashtags", val);
    }
    if (nostrCommentsEnabled !== undefined) {
      const val = !!nostrCommentsEnabled;
      sSet.run("nostrCommentsEnabled", val ? "true" : "false");
    }
    if (lightningAddress !== undefined) sSet.run("lightningAddress", lightningAddress || "");
    // NEW: theme
    if (themeChoice !== undefined) sSet.run("themeChoice", themeChoice || "dark");
    if (nostrDefaultHashtags !== undefined) sSet.run("nostrDefaultHashtags", nostrDefaultHashtags || DEFAULT_TEASER_HASHTAGS);

    // NEW: notification templates
    if (notifyDmTemplate_PAID !== undefined) sSet.run("notifyDmTemplate_PAID", notifyDmTemplate_PAID || "");
    if (notifyDmTemplate_PREPARATION !== undefined) sSet.run("notifyDmTemplate_PREPARATION", notifyDmTemplate_PREPARATION || "");
    if (notifyDmTemplate_SHIPPED !== undefined) sSet.run("notifyDmTemplate_SHIPPED", notifyDmTemplate_SHIPPED || "");

    if (notifyEmailSubject_PAID !== undefined) sSet.run("notifyEmailSubject_PAID", notifyEmailSubject_PAID || "");
    if (notifyEmailSubject_PREPARATION !== undefined) sSet.run("notifyEmailSubject_PREPARATION", notifyEmailSubject_PREPARATION || "");
    if (notifyEmailSubject_SHIPPED !== undefined) sSet.run("notifyEmailSubject_SHIPPED", notifyEmailSubject_SHIPPED || "");

    if (notifyEmailBody_PAID !== undefined) sSet.run("notifyEmailBody_PAID", notifyEmailBody_PAID || "");
    if (notifyEmailBody_PREPARATION !== undefined) sSet.run("notifyEmailBody_PREPARATION", notifyEmailBody_PREPARATION || "");
    if (notifyEmailBody_SHIPPED !== undefined) sSet.run("notifyEmailBody_SHIPPED", notifyEmailBody_SHIPPED || "");

    // ✨ Signature (admin)
    if (smtpSignature !== undefined) sSet.run("smtpSignature", smtpSignature || "");

    return this.getAll();
  },
};

function safeParseJSON(str, fallback) {
  try {
    const v = typeof str === "string" ? JSON.parse(str) : str;
    return Array.isArray(v) || typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}
function numOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function toBool(v, def = false) {
  if (v === undefined || v === null) return def;
  return String(v).toLowerCase() === "true" || String(v) === "1";
}

function normalizeZoneOverridesInput(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) continue;
    const price = Math.max(0, Number(item?.priceSats || 0));
    result.push({ id, priceSats: price });
    seen.add(id);
  }
  return result;
}

function parseZoneOverrides(raw) {
  if (Array.isArray(raw)) return normalizeZoneOverridesInput(raw);
  const parsed = safeParseJSON(raw, []);
  return normalizeZoneOverridesInput(parsed);
}
