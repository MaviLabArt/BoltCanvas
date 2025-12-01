import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import WebSocket from "ws";
import { createProxyMiddleware } from "http-proxy-middleware";
import { spawn } from "child_process";
import crypto from "crypto";
import sharp from "sharp";
import { verifyEvent } from "nostr-tools/pure";

import { makeCors, sessions, logger, requireAdmin } from "./middleware.js";
import { Products, Orders, Settings, ProductImages, ProductNostrPosts, NostrCarts, DEFAULT_TEASER_HASHTAGS } from "./db.js";
import { isEurope } from "./countries.js";
import { makeId, now } from "./utils.js";

// ⬇️ Provider-agnostic payment API (Blink or LND)
import {
  ensureBtcWalletId,
  createInvoiceSats,
  createOnchainSwapViaBoltz,
  invoiceStatus,
  subscribeInvoiceStatus,
  subscribeBoltzSwapStatus,
  boltzSwapStatus,
  startPaymentWatcher,
  PAYMENT_PROVIDER,
  emitBtcpayStatus
} from "./pay.js";
import * as boltz from "./boltz.js";
import * as btcpay from "./btcpay.js";

// NEW: Nostr helpers
import {
  getShopKeys,
  getShopPubkey,
  npubFromHex,
  fetchProfile,
  relaysFrom,
  resolveToPubkey,
  verifyLoginEvent,
  verifyCommentProof,
  extractProductIdFromTags,
  sendDM,
  publishProductTeaser,
  makeCommentProof,
} from "./nostr.js";

import { sendOrderStatusEmail, label as statusLabel } from "./email.js";
import { verifySvixSignature } from "./svix.js";

const app = express();
const TEST_MODE = process.env.NODE_ENV === "test";

// Trust reverse proxy (needed for secure cookies over HTTPS/CDN/reverse-proxy)
app.set("trust proxy", 1);

const PORT = process.env.PORT || 8080;
const DEV = process.env.NODE_ENV !== "production";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_INDEX_HTML = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '  <meta charset="UTF-8">',
  "  <title>Lightning Shop</title>",
  "</head>",
  '<body class="bg-slate-950 text-white">',
  '  <div id="root"></div>',
  "</body>",
  "</html>"
].join("\n");
let cachedIndexHtml = "";

// In dev, restrict to Vite origin; in prod, reflect request origin (true) to keep cookies working.
const rawCorsOrigin = process.env.CORS_ORIGIN;
const parsedCorsOrigins = rawCorsOrigin
  ? rawCorsOrigin.split(",").map((o) => o.trim()).filter(Boolean)
  : null;
const CORS_ORIGIN = (parsedCorsOrigins && parsedCorsOrigins.length)
  ? parsedCorsOrigins
  : (DEV ? ["http://localhost:5173", "http://127.0.0.1:5173"] : true);

// Blink-specific env (used when PAYMENT_PROVIDER === "blink")
const BLINK_GRAPHQL_URL = process.env.BLINK_GRAPHQL_URL;
const BLINK_WS_URL = process.env.BLINK_WS_URL || "wss://ws.blink.sv/graphql";
const BLINK_API_KEY = process.env.BLINK_API_KEY;
const BLINK_BTC_WALLET_ID = process.env.BLINK_BTC_WALLET_ID || "";

// BTCPay-specific env (used when PAYMENT_PROVIDER === "btcpay")
const BTCPAY_URL = (process.env.BTCPAY_URL || "").replace(/\/+$/, "");
const BTCPAY_API_KEY = process.env.BTCPAY_API_KEY || "";
const BTCPAY_STORE_ID = process.env.BTCPAY_STORE_ID || "";
const BTCPAY_WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET || "";
const BTCPAY_WEBHOOK_PATH = (() => {
  const raw = process.env.BTCPAY_WEBHOOK_PATH || "/api/webhooks/btcpay";
  return raw.startsWith("/") ? raw : `/${raw}`;
})();

// On-chain toggle + thresholds
const ONCHAIN_ENABLED = String(process.env.ONCHAIN_ENABLED || "true").toLowerCase() === "true";
const ONCHAIN_MIN_SATS = Math.max(0, Number(process.env.ONCHAIN_MIN_SATS || 0));
const ONCHAIN_INVOICE_EXPIRES_IN = Math.max(600, Number(process.env.ONCHAIN_INVOICE_EXPIRES_IN || 7200)); // seconds

// Boltz (on-chain → Lightning) defaults
const BOLTZ_REST_URL = (process.env.BOLTZ_REST_URL || "https://api.boltz.exchange").replace(/\/+$/, "");
const BOLTZ_WS_URL = process.env.BOLTZ_WS_URL || "wss://api.boltz.exchange/v2/ws";
const BOLTZ_WEBHOOK_URL = process.env.BOLTZ_WEBHOOK_URL || "";
const BOLTZ_WEBHOOK_SECRET = process.env.BOLTZ_WEBHOOK_SECRET || "";

// Admin/session
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
const SESSION_SECRET = process.env.SESSION_SECRET || "change_me";
const ADMIN_LANG = (() => {
  const raw = String(process.env.ADMIN_LANG || "").toLowerCase();
  return raw === "en" ? "en" : "it";
})();

// Optional webhook toggle (kept for future)
const ENABLE_WEBHOOKS = String(process.env.ENABLE_WEBHOOKS || "false") === "true";
const SVIX_SECRET = process.env.SVIX_SECRET || "";

// —— ntfy configuration ——
const NTFY_URL = (process.env.NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "");
const NTFY_TOPIC = process.env.NTFY_TOPIC || ""; // if empty, notifications are skipped
const NTFY_USER = process.env.NTFY_USER || "";
const NTFY_PASSWORD = process.env.NTFY_PASSWORD || "";
const NTFY_PRIORITY = process.env.NTFY_PRIORITY || "high";
const NTFY_TITLE_PREFIX = process.env.NTFY_TITLE_PREFIX || "";
const COMMENT_EVENT_KIND = 43115;

// A small in-memory guard to avoid duplicate notifies for the same payment
const notifiedHashes = new Set();
const notifiedCommentIds = new Set();

function verifyBtcpaySignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const prefix = "sha256=";
  if (!sigHeader.startsWith(prefix)) return false;
  const provided = sigHeader.slice(prefix.length);
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(rawBody || "", "utf8");
  const expected = hmac.digest("hex");
  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function normalizeShippingZones(zones) {
  const arr = Array.isArray(zones) ? zones : [];
  const result = [];
  let counter = 0;
  for (const z of arr) {
    const rawCountries = Array.isArray(z?.countries)
      ? z.countries
      : String(z?.countries || "").split(/[\s,]+/);
    const countries = rawCountries
      .map((c) => String(c || "").trim().toUpperCase())
      .filter(Boolean);
    const price = Math.max(0, Number(z?.priceSats || 0));
    if (!countries.length && price === 0) continue;
    result.push({
      id: z?.id || `zone-${counter++}`,
      name: z?.name || `Zone ${counter}`,
      countries: countries.length ? countries : ["ALL"],
      priceSats: price
    });
  }
  return result;
}

function resolveZonePriceForProduct(zone, product) {
  if (!zone) return 0;
  const overrides = Array.isArray(product?.shippingZoneOverrides) ? product.shippingZoneOverrides : [];
  const match = overrides.find((ov) => ov.id === zone.id);
  const price = match ? match.priceSats : zone.priceSats;
  return Math.max(0, Number(price || 0));
}

if (PAYMENT_PROVIDER === "blink" && !BLINK_API_KEY) {
  console.warn("[WARN] BLINK_API_KEY is empty. Set it in server/.env (or switch PAYMENT_PROVIDER).");
}
if (PAYMENT_PROVIDER === "btcpay" && (!BTCPAY_API_KEY || !BTCPAY_URL || !BTCPAY_STORE_ID)) {
  console.warn("[WARN] BTCPAY_URL/BTCPAY_API_KEY/BTCPAY_STORE_ID missing. Set them in server/.env.");
}

// ---------------------------------------------------------------------
// Core middleware
// ---------------------------------------------------------------------
app.use(makeCors(CORS_ORIGIN));
app.use(express.json({
  limit: "50mb",
  verify: (req, res, buf) => {
    if (req.originalUrl?.startsWith("/api/webhooks/")) {
      req.rawBody = buf.toString("utf8");
    }
  }
})); // room for several base64 photos
app.use(express.urlencoded({ extended: true, limit: "50mb" })); // harmless; supports form posts
app.use(sessions(SESSION_SECRET));
app.use(logger());

// Ensure a long-lived buyer client id (per browser) for order history
app.use((req, res, next) => {
  if (!req.session.cid) req.session.cid = makeId();
  next();
});

// prune PENDING > 1 day hourly
setInterval(() => {
  try { Orders.prunePendingOlderThan(24 * 60 * 60 * 1000); } catch {}
}, 60 * 60 * 1000);

// ---------------------------------------------------------------------
// ntfy sender (via curl) - message in Italian
// ---------------------------------------------------------------------
function ntfyNotifyPaid(order) {
  try {
    if (!NTFY_TOPIC) return; // not configured, silently skip

  const url = `${NTFY_URL}/${encodeURIComponent(NTFY_TOPIC)}`;
  const titlePrefix = NTFY_TITLE_PREFIX ? `${NTFY_TITLE_PREFIX}, ` : "";
    if (!order) return;

    const langIsEn = String(ADMIN_LANG || "").toLowerCase() === "en";
    const title = langIsEn
      ? `${titlePrefix}Payment received ✅ Order ${order.id}`
      : `${titlePrefix}Pagamento ricevuto ✅ Ordine ${order.id}`;
    const tags = "moneybag,receipt,checkered_flag";

    const fmt = (n) => (Number(n) || 0).toLocaleString("it-IT");
    const when = new Date(order.createdAt || Date.now()).toLocaleString(langIsEn ? "en-US" : "it-IT", { hour12: false });

  const contacts = []
    .concat(order.contactEmail ? [`${langIsEn ? "Email" : "Email"}: ${order.contactEmail}`] : [])
    .concat(order.contactTelegram ? [`Telegram: ${order.contactTelegram}`] : [])
    .concat(order.contactNostr ? [`Nostr: ${order.contactNostr}`] : [])
    .concat(order.contactPhone ? [`${langIsEn ? "Phone" : "Phone"}: ${order.contactPhone}`] : [])
    .join(" • ");

  const addressParts = [
    order.address || "",
    order.city || "",
    order.province || "",
    order.postalCode || "",
    order.country || ""
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean);

  const itemsLines = (order.items || [])
    .map((it) => {
      const qty = Number.isFinite(it.qty) && it.qty > 1 ? ` x${it.qty}` : "";
      return ` • ${it.title}${qty ? qty : ""}, ${fmt(it.priceSats)} sats`;
    })
      .join("\n");

    const hasNotes = String(order?.notes || "").trim().length > 0;

    const bodyLines = langIsEn
      ? [
          `Order: ${order.id}`,
          `Status: ${order.status}`,
          `Total: ${fmt(order.totalSats)} sats`,
          `Subtotal: ${fmt(order.subtotalSats)} • Shipping: ${fmt(order.shippingSats)} sats`,
          ``,
          `Items:`,
          itemsLines || " • (empty)",
          ``,
          `Customer: ${(order.name || "")} ${(order.surname || "")}`.trim(),
          addressParts.length ? `Address: ${addressParts.join(", ")}` : "Address:",
          contacts ? `Contacts: ${contacts}` : `Contacts: (not provided)`,
          hasNotes ? `Customer notes: ${order.notes}` : ``,
          ``,
          `Payment hash: ${order.paymentHash || "-"}`,
          `Order date: ${when}`
        ].join("\n")
      : [
          `Ordine: ${order.id}`,
          `Stato: ${order.status}`,
          `Importo totale: ${fmt(order.totalSats)} sats`,
          `Subtotale: ${fmt(order.subtotalSats)} • Spedizione: ${fmt(order.shippingSats)} sats`,
          ``,
          `Articoli:`,
          itemsLines || " • (vuoto)",
          ``,
          `Cliente: ${(order.name || "")} ${(order.surname || "")}`.trim(),
          addressParts.length ? `Indirizzo: ${addressParts.join(", ")}` : "Indirizzo:",
          contacts ? `Contatti: ${contacts}` : `Contatti: (non indicati)`,
          hasNotes ? `Note cliente: ${order.notes}` : ``,
          ``,
          `Payment hash: ${order.paymentHash || "-"}`,
          `Data ordine: ${when}`,
        ].join("\n");

    const args = [
      "-sS",
      "-X", "POST",
      url,
      "-H", `Title: ${title}`,
      "-H", `Priority: ${NTFY_PRIORITY}`,
      "-H", `Tags: ${tags}`,
      "--data-binary", bodyLines
    ];

    if (NTFY_USER || NTFY_PASSWORD) {
      args.push("-u", `${NTFY_USER}:${NTFY_PASSWORD}`);
    }

    const child = spawn("curl", args, { stdio: "ignore" });
    child.on("error", (err) => console.warn("[ntfy] curl error:", err?.message || err));
    child.on("close", (code) => {
      if (code !== 0) console.warn("[ntfy] curl exited with code", code);
    });
  } catch (e) {
    console.warn("[ntfy] failed to send notification:", e?.message || e);
  }
}

function notifyPaidOnce(order) {
  if (!order) return;
  const hash = order.paymentHash || "";
  if (hash && notifiedHashes.has(hash)) return;
  ntfyNotifyPaid(order);
  if (hash) notifiedHashes.add(hash);
}

function ntfyNotifyComment({ event, product, productId, profile } = {}) {
  try {
    if (!NTFY_TOPIC) return;
    if (!event) return;
    const url = `${NTFY_URL}/${encodeURIComponent(NTFY_TOPIC)}`;
    const titlePrefix = NTFY_TITLE_PREFIX ? `${NTFY_TITLE_PREFIX}, ` : "";
    const title = `${titlePrefix}Nuovo commento Nostr`;
    const tags = "speech_balloon,nostr";
    const when = new Date((event.created_at || Date.now() / 1000) * 1000).toLocaleString("it-IT", { hour12: false });
    const author =
      (profile?.display_name || profile?.name || "").trim() ||
      (profile?.nip05 || "").trim() ||
      npubFromHex(event.pubkey || "");
    const bodyLines = [
      `Prodotto: ${product?.title || productId || "-"}`,
      `Autore: ${author || "-"}`,
      `Data: ${when}`,
      "",
      "Commento:",
      String(event.content || "").slice(0, 800) || "(vuoto)",
      "",
      `Event ID: ${event.id || "-"}`
    ].join("\n");

    const args = [
      "-sS",
      "-X", "POST",
      url,
      "-H", `Title: ${title}`,
      "-H", `Priority: ${NTFY_PRIORITY}`,
      "-H", `Tags: ${tags}`,
      "--data-binary", bodyLines
    ];

    if (NTFY_USER || NTFY_PASSWORD) {
      args.push("-u", `${NTFY_USER}:${NTFY_PASSWORD}`);
    }

    const child = spawn("curl", args, { stdio: "ignore" });
    child.on("error", (err) => console.warn("[ntfy] curl error:", err?.message || err));
    child.on("close", (code) => {
      if (code !== 0) console.warn("[ntfy] curl exited with code", code);
    });
  } catch (e) {
    console.warn("[ntfy] failed to send comment notification:", e?.message || e);
  }
}

// ────────────────────────────────────────────────────────────────────
// Templating helpers for DMs
// ────────────────────────────────────────────────────────────────────
function renderTemplate(tpl, ctx) {
  if (!tpl) return "";
  return String(tpl).replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, k) => (k in ctx ? String(ctx[k]) : ""));
}
const fmtSats = (n) => (Number(n) || 0).toLocaleString("en-US");

function primaryProductTitle(order) {
  if (!order || !Array.isArray(order.items)) return "";
  for (const it of order.items) {
    if (!it) continue;
    const direct = String(it.title || "").trim();
    if (direct) return direct;
    const nested = String(it?.product?.title || "").trim();
    if (nested) return nested;
  }
  return "";
}

function makeNotifyContext(order, status, s) {
  const address = [
    order.address || "",
    order.city || "",
    order.province || "",
    order.postalCode || "",
    order.country || ""
  ]
    .filter(Boolean)
    .join(", ");
  const createdAt = new Date(order.createdAt || Date.now()).toLocaleString();
  return {
    storeName: s.storeName || "Lightning Shop",
    orderId: order.id,
    status: String(status).toUpperCase(),
    statusLabel: statusLabel(status),
    totalSats: fmtSats(order.totalSats),
    subtotalSats: fmtSats(order.subtotalSats),
    shippingSats: fmtSats(order.shippingSats),
    courier: order.courier || "",
    tracking: order.tracking || "",
    customerName: order.name || "",
    address,
    createdAt,
    paymentHash: order.paymentHash || "",
    productTitle: primaryProductTitle(order)
  };
}

function parseRelaysInput(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function ensureAbsoluteFromReq(req, pathOrUrl) {
  const input = String(pathOrUrl || "").trim();
  if (!input) return "";
  if (/^https?:\/\//i.test(input)) return input;
  const host = req.get("host");
  const protocol = req.protocol || "https";
  if (!host) return "";
  const path = input.startsWith("/") ? input : `/${input}`;
  return `${protocol}://${host}${path}`;
}

function sanitizeExternalUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
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

function makeImageVersionQuery(version, idx) {
  const base = String(version || "").trim();
  if (!base) return "";
  const suffix =
    Number.isFinite(idx) && idx >= 0 ? `${base}-${idx}` : base;
  return `?v=${encodeURIComponent(suffix)}`;
}

function guessImageMime(url) {
  const lower = String(url || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "image/jpeg";
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

function clampImageIndex(idx, count) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  const n = Number(idx || 0);
  if (n < 0) return 0;
  if (n >= count) return count - 1;
  return n;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function compactMetaText(input, maxLen = 220) {
  const clean = String(input || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(0, maxLen - 3))}...`;
}

function absoluteUrlFromRequest(req) {
  const host = req.get("host");
  const protocol = req.protocol || "https";
  const rawPath = req.originalUrl || req.url || "/";
  const pathPart = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (!host) return pathPart;
  return `${protocol}://${host}${pathPart}`;
}

function renderIndexWithMeta(baseHtml, meta) {
  const html = baseHtml || FALLBACK_INDEX_HTML;
  const safeTitle = escapeHtml(meta.title || "Lightning Shop");
  const safeDescription = escapeHtml(compactMetaText(meta.description, 220));
  const safeImage = escapeHtml(meta.image || "");
  const safeUrl = escapeHtml(meta.url || "");
  const safeSiteName = escapeHtml(meta.siteName || meta.title || "");
  const safeOgType = escapeHtml(meta.type || "website");

  const tags = [];
  if (safeDescription) tags.push(`<meta name="description" content="${safeDescription}">`);
  tags.push(`<meta property="og:type" content="${safeOgType}">`);
  if (safeSiteName) tags.push(`<meta property="og:site_name" content="${safeSiteName}">`);
  if (meta.title) {
    tags.push(`<meta property="og:title" content="${safeTitle}">`);
    tags.push(`<meta name="twitter:title" content="${safeTitle}">`);
  }
  if (safeDescription) {
    tags.push(`<meta property="og:description" content="${safeDescription}">`);
    tags.push(`<meta name="twitter:description" content="${safeDescription}">`);
  }
  if (safeImage) {
    tags.push(`<meta property="og:image" content="${safeImage}">`);
    tags.push(`<meta property="og:image:secure_url" content="${safeImage}">`);
    tags.push(`<meta name="twitter:image" content="${safeImage}">`);
  }
  if (safeUrl) tags.push(`<meta property="og:url" content="${safeUrl}">`);
  tags.push(`<meta name="twitter:card" content="${safeImage ? "summary_large_image" : "summary"}">`);

  let withTitle = html;
  if (/<title>.*<\/title>/i.test(withTitle)) {
    withTitle = withTitle.replace(/<title>.*?<\/title>/i, `<title>${safeTitle}</title>`);
  } else if (withTitle.includes("<head")) {
    withTitle = withTitle.replace("<head>", `<head>\n  <title>${safeTitle}</title>`);
  } else {
    withTitle = `<title>${safeTitle}</title>\n${withTitle}`;
  }

  const injection = tags.length ? `\n  ${tags.join("\n  ")}\n` : "\n";
  if (withTitle.includes("</head>")) {
    return withTitle.replace("</head>", `${injection}</head>`);
  }
  return `${tags.join("\n")}\n${withTitle}`;
}

function productMainImageUrl(req, product) {
  if (!product) return "";
  const count = Math.max(0, Number(product.imageCount || 0));
  const idx = clampImageIndex(
    Number.isInteger(product.mainImageIndex) ? product.mainImageIndex : 0,
    count || 1
  );
  let dataForMime = "";
  let record = ProductImages.getRecord(product.id, idx);
  if (!record?.data && idx !== 0) {
    record = ProductImages.getRecord(product.id, 0);
  }
  if (!record?.data) return "";
  if (record?.data) {
    dataForMime = record.data;
  }
  const mime = extractMimeFromDataUrl(dataForMime);
  const ext = extFromMime(mime, "jpg");
  const versionTag = makeImageVersionQuery(product.imageVersion, idx);
  const url = `/api/products/${product.id}/image/${idx}.${ext}${versionTag}`;
  return ensureAbsoluteFromReq(req, url);
}

function buildProductMeta(req, product, settings) {
  const siteName = settings?.storeName || "Lightning Shop";
  const title = product?.title ? `${product.title} - ${siteName}` : siteName;
  const description = product?.subtitle || product?.description || product?.longDescription || settings?.heroLine || settings?.contactNote || "";
  return {
    title,
    description,
    image: productMainImageUrl(req, product),
    url: absoluteUrlFromRequest(req),
    type: "product",
    siteName
  };
}

function buildDefaultMeta(req, settings) {
  const siteName = settings?.storeName || "Lightning Shop";
  const description = settings?.heroLine || settings?.contactNote || "A curated selection available for sats.";
  const logo = settings?.logoLight || settings?.logo || settings?.logoDark || "";
  return {
    title: siteName,
    description,
    image: logo ? ensureAbsoluteFromReq(req, logo) : "",
    url: absoluteUrlFromRequest(req),
    type: "website",
    siteName
  };
}

function loadIndexHtml(distDir) {
  const distIndex = path.join(distDir, "index.html");
  try {
    return fs.readFileSync(distIndex, "utf8");
  } catch (err) {
    console.warn(`[WARN] Unable to read ${distIndex}: ${err.message}`);
  }
  const devIndex = path.resolve(__dirname, "../client/index.html");
  try {
    return fs.readFileSync(devIndex, "utf8");
  } catch {}
  return FALLBACK_INDEX_HTML;
}

const CART_STRING_LIMIT = 2048;
const CART_URL_LIMIT = 1024;
const MAX_CART_ITEMS = 24;
const MAX_CART_QTY = 99;

function trimCartString(value, limit = CART_STRING_LIMIT) {
  return String(value || "").slice(0, limit);
}

function sanitizeUrl(value) {
  return trimCartString(value, CART_URL_LIMIT);
}

function sanitizeUrlArray(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const value of raw) {
    const s = sanitizeUrl(value);
    if (!s) continue;
    out.push(s);
    if (out.length >= 5) break;
  }
  return out;
}

function sanitizeShipping(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const bounded = Math.max(0, Math.min(10_000_000, Math.floor(num)));
  return bounded;
}

function maxPurchasableForProduct(product) {
  if (!product || !product.available) return 0;
  if (Number.isFinite(product.maxQuantity)) return Math.max(0, product.maxQuantity);
  if (product.isUnique) return 1;
  const qty = Number(product.quantityAvailable);
  if (Number.isFinite(qty) && qty >= 0) return Math.max(0, qty);
  return MAX_CART_QTY;
}

function sanitizeCartProduct(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = trimCartString(raw.id, 160);
  if (!id) return null;
  const priceRaw = Number(raw.priceSats);
  const priceSats = Number.isFinite(priceRaw) ? Math.max(0, Math.floor(priceRaw)) : 0;
  const product = {
    id,
    title: trimCartString(raw.title || "Product", 256),
    priceSats,
    available: !!raw.available,
    mainImageIndex: Number.isInteger(raw.mainImageIndex) ? raw.mainImageIndex : 0,
    mainImageThumbUrl: sanitizeUrl(raw.mainImageThumbUrl),
    mainImageUrl: sanitizeUrl(raw.mainImageUrl),
    previewImage: sanitizeUrl(raw.previewImage),
    shippingItalySats: sanitizeShipping(raw.shippingItalySats),
    shippingEuropeSats: sanitizeShipping(raw.shippingEuropeSats),
    shippingWorldSats: sanitizeShipping(raw.shippingWorldSats),
    shippingZoneOverrides: sanitizeCartZoneOverrides(raw.shippingZoneOverrides),
    isUnique: raw.isUnique !== undefined ? !!raw.isUnique : true,
    quantityAvailable: (() => {
      const num = Number(raw.quantityAvailable);
      return Number.isFinite(num) && num >= 0 ? Math.floor(num) : null;
    })(),
    __cartVersion: Number.isFinite(Number(raw.__cartVersion))
      ? Number(raw.__cartVersion)
      : 0
  };
  const hasFiniteQty = Number.isFinite(product.quantityAvailable);
  product.available = product.available && (!hasFiniteQty || product.quantityAvailable > 0);
  if (product.available) {
    const maxQty = product.isUnique
      ? 1
      : (product.quantityAvailable === null ? MAX_CART_QTY : Math.max(0, Math.min(MAX_CART_QTY, product.quantityAvailable)));
    product.maxQuantity = maxQty;
  } else {
    product.maxQuantity = 0;
  }
  const thumbUrls = sanitizeUrlArray(raw.thumbUrls);
  if (thumbUrls.length) product.thumbUrls = thumbUrls;
  const imageUrls = sanitizeUrlArray(raw.imageUrls);
  if (imageUrls.length) product.imageUrls = imageUrls;
  if (raw.__needsShippingHydrate) product.__needsShippingHydrate = true;
  return product;
}

function sanitizeCartZoneOverrides(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const result = [];
  for (const entry of list) {
    const id = String(entry?.id || "").trim();
    if (!id || seen.has(id)) continue;
    const price = Math.max(0, Number(entry?.priceSats || 0));
    result.push({ id, priceSats: price });
    seen.add(id);
  }
  return result;
}

function sanitizeCartItemsInput(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const order = [];
  const map = new Map();
  for (const entry of list) {
    const product = sanitizeCartProduct(entry?.product);
    if (!product) continue;
    const alreadySeen = map.has(product.id);
    if (!alreadySeen && order.length >= MAX_CART_ITEMS) {
      continue;
    }
    const qtyRaw = Number(entry?.qty);
    const qty = Number.isFinite(qtyRaw)
      ? Math.max(1, Math.min(MAX_CART_QTY, Math.floor(qtyRaw)))
      : 1;
    map.set(product.id, { product, qty });
    if (!alreadySeen) {
      order.push(product.id);
    }
  }
  return order.map((id) => map.get(id));
}

function makeDefaultTeaserContent(product, { productUrl = "", hashtags = "" } = {}) {
  const lines = [];
  const title = product.title || "";
  const shortLine = product.subtitle || "";
  lines.push(`${title}${shortLine ? `, ${shortLine}` : ""}`);
  lines.push("");
  if (product.longDescription) {
    const firstLine = String(product.longDescription).split("\n").find((l) => l.trim());
    if (firstLine) {
      lines.push(firstLine.trim());
      lines.push("");
    }
  }
  const price = Math.max(0, Number(product.priceSats) || 0);
  if (price > 0) {
    lines.push(`Price: ${price.toLocaleString("en-US")} sats`);
    lines.push("");
  }
  if (productUrl) {
    lines.push(`Available here 👉 ${productUrl}`);
  }
  const ht = String(hashtags || "").trim();
  if (ht) {
    lines.push("");
    lines.push(ht);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeTeaserHashtags(raw, defaultHashtags = DEFAULT_TEASER_HASHTAGS) {
  const legacy = "#art #artstr #painting";
  const cleaned = String(raw || "").trim();
  if (!cleaned) return defaultHashtags;
  if (cleaned === legacy) return defaultHashtags;
  return cleaned;
}

function mapNostrConfigForResponse(product, row, {
  defaultImageUrl = "",
  productUrl = "",
  fallbackRelays = [],
  defaultHashtags = DEFAULT_TEASER_HASHTAGS
} = {}) {
  const relays = Array.isArray(row?.relays) ? row.relays : [];
  const normalizedDefaultImage = ensureImageUrlWithExt(defaultImageUrl);
  const imageUrl = ensureImageUrlWithExt(row?.imageUrl || normalizedDefaultImage || "");
  const teaserLastAck = Array.isArray(row?.teaserLastAck) ? row.teaserLastAck : [];
  const teaserContent = row?.teaserContent || "";
  const hashtags = normalizeTeaserHashtags(row?.teaserHashtags, defaultHashtags);
  const teaserDefaultContent = makeDefaultTeaserContent(product, { productUrl, hashtags });

  return {
    imageUrl,
    defaultImageUrl: normalizedDefaultImage || imageUrl,
    productUrl,
    relays,
    fallbackRelays,
    teaserContent,
    teaserHashtags: hashtags,
    teaserDefaultHashtags: defaultHashtags,
    teaserDefaultContent,
    teaserLastEventId: row?.teaserLastEventId || "",
    teaserLastPublishedAt: row?.teaserLastPublishedAt || 0,
    teaserLastAck,
    lastNaddr: row?.lastNaddr || ""
  };
}

// ────────────────────────────────────────────────────────────────────
// NOSTR: Login/Identity + DM support
// ────────────────────────────────────────────────────────────────────
function nostrRelays() {
  try {
    return relaysFrom(Settings.getAll());
  } catch {
    return ["wss://relay.damus.io", "wss://nos.lol"];
  }
}

/** DM helper (best effort). Uses admin-editable templates if present. */
async function dmOrderUpdate(order, rawStatus) {
  try {
    // Only attempt if server has shop keys
    if (!getShopKeys()) {
      console.info("[nostr] dmOrderUpdate: skip (no server keys)", { orderId: order?.id, status: rawStatus });
      return;
    }
    const ident = String(order?.contactNostr || "").trim();
    if (!ident) {
      console.info("[nostr] dmOrderUpdate: skip (no contactNostr)", { orderId: order?.id, status: rawStatus });
      return;
    }

    const toHex = await resolveToPubkey(ident, { allowNip05: false }).catch((err) => {
      console.error("[nostr] dmOrderUpdate: resolveToPubkey error", { orderId: order?.id, status: rawStatus, error: err?.message || err });
      return null;
    });
    if (!toHex) {
      console.warn("[nostr] dmOrderUpdate: skip (failed to resolve contactNostr)", { orderId: order?.id, status: rawStatus, contactNostr: ident });
      return;
    }

    const s = Settings.getAll();
    const code = String(rawStatus).toUpperCase();
    const ctx = makeNotifyContext(order, code, s);

    // Try template first
    const tplKey = `notifyDmTemplate_${code}`;
    let message = s[tplKey] ? renderTemplate(s[tplKey], ctx) : "";

    // Fallback to legacy-friendly content if template is empty
    if (!message.trim()) {
      const lines = [
        `Thank you for your order ${order.id}.`,
        `Status: ${code}`,
      ];

      if (code === "PAID") {
        lines.push("🎉 Great news, your payment was received. We’re starting to prepare your order and we’ll send you the tracking number as soon as it ships. 🚚");
      }
      if (code === "SHIPPED") {
        lines.push(
          "",
          "Shipment details:",
          `Courier: ${ctx.courier || "-"}`,
          `Tracking: ${ctx.tracking || "-"}`
        );
      }
      lines.push(`Total: ${ctx.totalSats} sats`);
      message = lines.join("\n");
    }

    const relays = nostrRelays();
    console.info("[nostr] dmOrderUpdate: sending DM", {
      orderId: order?.id,
      status: code,
      toPubkey: toHex,
      relays
    });
    await sendDM({ toPubkeyHex: toHex, message, relays });
  } catch (err) {
    console.error("[nostr] dmOrderUpdate: sendDM failed", { orderId: order?.id, status: rawStatus, error: err?.message || err });
  }
}

// ---------------------------------------------------------------------
// Helpers for image endpoints
// ---------------------------------------------------------------------
const THUMB_MAX_SIDE = 480;

// Decode a data URL like: data:image/webp;base64,AAAA...
function decodeDataUrl(src) {
  if (typeof src !== "string" || !src.startsWith("data:")) {
    throw new Error("Not a data URL");
  }
  const m = src.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new Error("Unsupported data URL");
  const mime = m[1] || "application/octet-stream";
  const b64 = m[2] || "";
  const buf = Buffer.from(b64, "base64");
  return { mime, buf };
}

function strongEtag(key) {
  const hash = crypto.createHash("sha1").update(key).digest("hex");
  // Strong ETag (quotes required)
  return `"${hash}"`;
}

function setCacheHeaders(res, etag) {
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("ETag", etag);
}

// Common handler factory
function imageHandler({ thumb }) {
  return async (req, res) => {
    try {
      const id = req.params.id;
      const rawIdx = String(req.params.idx ?? "");
      const idx = Number.parseInt(rawIdx, 10);
      const product = Products.get(id, { includeImages: false });
      if (!product) return res.status(404).json({ error: "Not found" });

      const count = Number(product.imageCount || 0);
      if (!Number.isFinite(idx) || idx < 0 || idx >= count) {
        return res.status(404).json({ error: "Not found" });
      }
      const record = ProductImages.getRecord(id, idx);
      if (!record) return res.status(404).json({ error: "Not found" });
      const src = record.data;

      // ETag before expensive work
      const etag = strongEtag(
        `v2:${thumb ? "thumb" : "full"}:${idx}:${record.hash || src.length}:${product.id}:${product.createdAt || 0}:${product.imageVersion || ""}`
      );
      if (req.headers["if-none-match"] && req.headers["if-none-match"] === etag) {
        setCacheHeaders(res, etag);
        return res.status(304).end();
      }

      const { mime, buf } = decodeDataUrl(src);

      let out = buf;
      if (thumb) {
        // generate resized thumbnail (fit inside THUMB_MAX_SIDE)
        out = await sharp(buf)
          .resize({
            width: THUMB_MAX_SIDE,
            height: THUMB_MAX_SIDE,
            fit: "inside",
            withoutEnlargement: true
          })
          .toBuffer();
      }

      setCacheHeaders(res, etag);
      res.setHeader("Content-Type", mime);
      res.setHeader("Content-Length", out.length);
      res.end(out);
    } catch (e) {
      // If anything goes wrong, avoid leaking internals
      res.status(400).json({ error: "Invalid image" });
    }
  };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------
app.get("/api/health", (req, res) => res.json({ ok: true }));
app.get("/api/public-settings", (req, res) => {
  const nostrShopPubkey = getShopPubkey();
  res.json({ ...Settings.getPublic(), nostrShopPubkey });
});
app.get("/api/payments/config", (req, res) => {
  res.json({
    provider: PAYMENT_PROVIDER,
    onchainEnabled: ONCHAIN_ENABLED,
    onchainMinSats: ONCHAIN_MIN_SATS,
    btcpayModalUrl:
      PAYMENT_PROVIDER === "btcpay" && BTCPAY_URL
        ? `${BTCPAY_URL}/modal/btcpay.js`
        : "",
    boltz: {
      rest: BOLTZ_REST_URL,
      ws: BOLTZ_WS_URL,
      webhookConfigured: !!BOLTZ_WEBHOOK_URL
    }
  });
});

// ✅ Restore full products (keep images array) and add a non-breaking mainImage helper
app.get("/api/products", (req, res) => {
  const list = Products.allPublic() || [];
  const etagKey = list.map((p) => p.cacheTag).join("|");
  const etag = strongEtag(`products:v3:${etagKey}`);
  const alreadyFresh = req.headers["if-none-match"] && req.headers["if-none-match"] === etag;

  res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  res.setHeader("ETag", etag);

  if (alreadyFresh) {
    return res.status(304).end();
  }

  const payload = list.map(({ cacheTag, ...rest }) => {
    const thumb = rest.mainImageThumbUrl ? ensureAbsoluteFromReq(req, rest.mainImageThumbUrl) : rest.mainImageThumbUrl;
    const main = rest.mainImageUrl ? ensureAbsoluteFromReq(req, rest.mainImageUrl) : rest.mainImageUrl;
    return { ...rest, mainImageThumbUrl: thumb, mainImageUrl: main };
  });
  res.json(payload);
});

app.get("/api/products/:id", (req, res) => {
  const p = Products.get(req.params.id);
  if (!p || p.hidden) return res.status(404).json({ error: "Not found" });

  // Add cacheable image URLs while keeping legacy images[]
  const imgs = Array.isArray(p.images) ? p.images : [];
  const imageUrls = imgs.map((data, i) => {
    const mime = extractMimeFromDataUrl(data);
    const ext = extFromMime(mime);
    const versionTag = makeImageVersionQuery(p.imageVersion, i);
    return `/api/products/${p.id}/image/${i}.${ext}${versionTag}`;
  });
  const thumbUrls = imgs.map((data, i) => {
    const mime = extractMimeFromDataUrl(data);
    const ext = extFromMime(mime);
    const versionTag = makeImageVersionQuery(p.imageVersion, i);
    return `/api/products/${p.id}/thumb/${i}.${ext}${versionTag}`;
  });

  const absImageUrls = imageUrls.map((u) => ensureAbsoluteFromReq(req, u));
  const absThumbUrls = thumbUrls.map((u) => ensureAbsoluteFromReq(req, u));
  res.json({ ...p, imageUrls, thumbUrls, absImageUrls, absThumbUrls });
});

// Binary image endpoints (full + thumbnail)
app.get("/api/products/:id/image/:idx", imageHandler({ thumb: false }));
app.get("/api/products/:id/image/:idx.:ext", imageHandler({ thumb: false }));
app.get("/api/products/:id/thumb/:idx", imageHandler({ thumb: true }));
app.get("/api/products/:id/thumb/:idx.:ext", imageHandler({ thumb: true }));

// Buyer order history (per session OR Nostr identity)
app.get("/api/orders/mine", (req, res) => {
  const cid = req.session?.cid || "";
  const npk = req.session?.nostrPubkey || "";
  // If the user is signed in with Nostr, use the nostr-bound clientId,
  // and also include session-bound orders (to avoid losing visibility
  // for orders created pre-login in this session).
  if (npk) {
    const nid = `nostr:${npk}`;
    const a = Orders.byClientId(nid) || [];
    const b = cid ? (Orders.byClientId(cid) || []) : [];
    // merge unique by id, newest first
    const map = new Map();
    for (const o of [...a, ...b]) map.set(o.id, o);
    const merged = Array.from(map.values()).sort(
      (x, y) => Number(y.createdAt || 0) - Number(x.createdAt || 0)
    );
    return res.json(merged);
  }
  // Fallback: session-only
  if (!cid) return res.json([]);
  return res.json(Orders.byClientId(cid));
});

// Persisted cart for Nostr-authenticated shoppers
app.get("/api/cart", (req, res) => {
  const pk = req.session?.nostrPubkey || "";
  if (!pk) {
    return res.status(401).json({ error: "Nostr login required" });
  }
  const stored = NostrCarts.get(pk) || {};
  const items = sanitizeCartItemsInput(Array.isArray(stored.items) ? stored.items : []);
  const updatedAt = Number(stored.updatedAt || 0);
  res.json({ items, updatedAt });
});

app.put("/api/cart", (req, res) => {
  const pk = req.session?.nostrPubkey || "";
  if (!pk) {
    return res.status(401).json({ error: "Nostr login required" });
  }
  const payload = sanitizeCartItemsInput(req.body?.items);
  const data = {
    items: payload,
    updatedAt: now()
  };
  NostrCarts.set(pk, data);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------
app.post("/api/admin/login", (req, res) => {
  const { pin } = req.body || {};
  if (String(pin || "") !== String(ADMIN_PIN)) {
    return res.status(401).json({ ok: false, error: "Invalid PIN" });
  }
  req.session.admin = true;
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => { req.session = null; res.json({ ok: true }); });
app.get("/api/admin/me", (req, res) => res.json({ loggedIn: !!req.session?.admin, lang: ADMIN_LANG }));
app.get("/api/admin/config", (req, res) => res.json({ lang: ADMIN_LANG }));

// ---------------------------------------------------------------------
// Admin: settings / products / orders
// ---------------------------------------------------------------------
app.get("/api/admin/settings", requireAdmin, (req, res) => res.json({ ...Settings.getAll(), nostrShopPubkey: getShopPubkey() }));
app.put("/api/admin/settings", requireAdmin, (req, res) => {
  // Persist all editable settings (incl. Nostr keys / relays / lightning address)
  const {
    storeName,
    contactNote,
    logo,
    logoDark,
    logoLight,
    favicon,
    productsHeading,
    heroLine,
    radiusScale,
    // NEW:
    aboutTitle, aboutBody, aboutImage,
    heroCtaLabel, heroCtaHref,
    shippingTitle, shippingBullet1, shippingBullet2, shippingBullet3,
    shippingZones,
    commissionTitle, commissionBody, commissionCtaLabel, commissionCtaHref,
    // NEW Nostr/LN
    nostrNpub, nostrNip05, nostrRelays, lightningAddress, nostrDefaultHashtags, nostrCommentsEnabled,
    nostrBlockedPubkeys, nostrBlockedHashtags,
    // NEW Theme
    themeChoice,
    themeTokens,
    // NEW Email/IMAP
    smtpEnabled, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass,
    smtpFromName, smtpFromAddress, smtpEnvelopeFrom, smtpReplyTo, smtpSignature, smtpSaveToSent,
    imapHost, imapPort, imapSecure, imapUser, imapPass, imapMailbox,
    // NEW: Notification templates
    notifyDmTemplate_PAID, notifyDmTemplate_PREPARATION, notifyDmTemplate_SHIPPED,
    notifyEmailSubject_PAID, notifyEmailSubject_PREPARATION, notifyEmailSubject_SHIPPED,
    notifyEmailBody_PAID, notifyEmailBody_PREPARATION, notifyEmailBody_SHIPPED
  } = req.body || {};
  res.json(
    Settings.setAll({
      storeName, contactNote, logo, logoDark, logoLight, favicon, productsHeading, heroLine, radiusScale,
      aboutTitle, aboutBody, aboutImage,
      heroCtaLabel, heroCtaHref,
      shippingTitle, shippingBullet1, shippingBullet2, shippingBullet3,
      shippingZones,
      commissionTitle, commissionBody, commissionCtaLabel, commissionCtaHref,
      nostrNpub, nostrNip05, nostrRelays, lightningAddress, nostrDefaultHashtags, nostrCommentsEnabled,
      nostrBlockedPubkeys, nostrBlockedHashtags,
      themeChoice, themeTokens,
      smtpEnabled, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass,
      smtpFromName, smtpFromAddress, smtpEnvelopeFrom, smtpReplyTo, smtpSignature, smtpSaveToSent,
      imapHost, imapPort, imapSecure, imapUser, imapPass, imapMailbox,
      // pass templates through
      notifyDmTemplate_PAID, notifyDmTemplate_PREPARATION, notifyDmTemplate_SHIPPED,
      notifyEmailSubject_PAID, notifyEmailSubject_PREPARATION, notifyEmailSubject_SHIPPED,
      notifyEmailBody_PAID, notifyEmailBody_PREPARATION, notifyEmailBody_SHIPPED
    })
  );
});

// NEW: Admin products list (full objects with images[])
app.get("/api/admin/products", requireAdmin, (req, res) => {
  const pageParam = Number.parseInt(req.query.page, 10);
  const pageSizeParam = Number.parseInt(req.query.pageSize, 10);

  if (!Number.isFinite(pageParam) || !Number.isFinite(pageSizeParam)) {
    return res.json(Products.all({ includeImages: true }));
  }

  const pageSize = Math.min(100, Math.max(1, pageSizeParam));
  const total = Products.count();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, pageParam), totalPages);
  const offset = (page - 1) * pageSize;
  const rows = Products.page({ offset, limit: pageSize });

  const items = rows.map((p) => {
    const count = Math.max(0, Number(p.imageCount || 0));
    const idx = Number.isInteger(p.mainImageIndex) ? p.mainImageIndex : 0;
    const safeIdx = Math.min(Math.max(0, idx | 0), Math.max(0, count - 1));
    const versionTag = makeImageVersionQuery(p.imageVersion, safeIdx);
    const thumbUrl = count ? `/api/products/${p.id}/thumb/${safeIdx}.jpg${versionTag}` : "";
    const mainUrl = count ? `/api/products/${p.id}/image/${safeIdx}.jpg${versionTag}` : "";
    const maxQuantity = (() => {
      if (!p.available) return 0;
      if (p.isUnique) return 1;
      if (Number.isFinite(p.quantityAvailable)) return Math.max(0, p.quantityAvailable);
      return null;
    })();
    return {
      id: p.id,
      title: p.title,
      subtitle: p.subtitle,
      priceSats: p.priceSats,
      isUnique: !!p.isUnique,
      quantityAvailable: p.quantityAvailable,
      maxQuantity,
      available: p.available,
      hidden: p.hidden,
      createdAt: p.createdAt,
      displayOrder: p.displayOrder,
      mainImageIndex: safeIdx,
      mainImageThumbUrl: thumbUrl || null,
      mainImageUrl: mainUrl || null,
      mainImageThumbAbsoluteUrl: thumbUrl ? ensureAbsoluteFromReq(req, thumbUrl) : null,
      mainImageAbsoluteUrl: mainUrl ? ensureAbsoluteFromReq(req, mainUrl) : null,
      imageCount: count,
      imageVersion: p.imageVersion || "",
      widthCm: p.widthCm,
      heightCm: p.heightCm,
      depthCm: p.depthCm,
      shippingItalySats: p.shippingItalySats,
      shippingEuropeSats: p.shippingEuropeSats,
      shippingWorldSats: p.shippingWorldSats,
      showDimensions: p.showDimensions,
      shippingZoneOverrides: Array.isArray(p.shippingZoneOverrides) ? p.shippingZoneOverrides : []
    };
  });

  res.json({
    items,
    page,
    pageSize,
    totalPages,
    total
  });
});

app.get("/api/admin/products/:id", requireAdmin, (req, res) => {
  const product = Products.get(req.params.id);
  if (!product) return res.status(404).json({ error: "Not found" });
  const imgs = Array.isArray(product.images) ? product.images : [];
  const imageUrls = imgs.map((data, i) => {
    const mime = extractMimeFromDataUrl(data);
    const ext = extFromMime(mime);
    const versionTag = makeImageVersionQuery(product.imageVersion, i);
    return `/api/products/${product.id}/image/${i}.${ext}${versionTag}`;
  });
  const thumbUrls = imgs.map((data, i) => {
    const mime = extractMimeFromDataUrl(data);
    const ext = extFromMime(mime);
    const versionTag = makeImageVersionQuery(product.imageVersion, i);
    return `/api/products/${product.id}/thumb/${i}.${ext}${versionTag}`;
  });
  const safeIdx = Math.min(
    Math.max(0, Number(product.mainImageIndex) || 0),
    Math.max(0, imageUrls.length - 1)
  );
  const mainImagePath = imageUrls[safeIdx] || "";
  const defaultImageUrl = ensureAbsoluteFromReq(req, mainImagePath);
  const productUrl = ensureAbsoluteFromReq(req, `/product/${product.id}`);
  const fallbackRelays = nostrRelays();
  const settings = Settings.getAll();
  const defaultHashtags = settings.nostrDefaultHashtags || DEFAULT_TEASER_HASHTAGS;
  const nostrRow = ProductNostrPosts.get(product.id);
  const nostr = mapNostrConfigForResponse(product, nostrRow, {
    defaultImageUrl,
    productUrl,
    fallbackRelays,
    defaultHashtags
  });
  const absImageUrls = imageUrls.map((u) => ensureAbsoluteFromReq(req, u));
  const absThumbUrls = thumbUrls.map((u) => ensureAbsoluteFromReq(req, u));
  res.json({ ...product, imageUrls, thumbUrls, absImageUrls, absThumbUrls, nostr });
});

app.put("/api/admin/products/:id/nostr/teaser", requireAdmin, (req, res) => {
  try {
    const product = Products.get(req.params.id);
    if (!product) return res.status(404).json({ error: "Not found" });

    const body = req.body || {};
    const existing = ProductNostrPosts.get(product.id);
    let processedImage;
    if (body.imageUrl !== undefined) {
      const raw = String(body.imageUrl || "").trim();
      processedImage = raw
        ? sanitizeExternalUrl(raw) || ensureAbsoluteFromReq(req, raw)
        : "";
    }
    const relays =
      body.relays !== undefined ? parseRelaysInput(body.relays) : undefined;

    const settings = Settings.getAll();
    const defaultHashtags = settings.nostrDefaultHashtags || DEFAULT_TEASER_HASHTAGS;

    const payload = {
      content: body.content ?? existing?.teaserContent ?? ""
    };
    if (processedImage !== undefined) payload.imageUrl = processedImage;
    if (relays !== undefined) payload.relays = relays;

    const stored = ProductNostrPosts.setTeaser(product.id, payload);

    const imgs = Array.isArray(product.images) ? product.images : [];
  const imageUrls = imgs.map((data, i) => {
      const mime = extractMimeFromDataUrl(data);
      const ext = extFromMime(mime);
      const versionTag = makeImageVersionQuery(product.imageVersion, i);
      return `/api/products/${product.id}/image/${i}.${ext}${versionTag}`;
    });
    const safeIdx = Math.min(
      Math.max(0, Number(product.mainImageIndex) || 0),
      Math.max(0, imageUrls.length - 1)
    );
    const defaultImageUrl = ensureImageUrlWithExt(ensureAbsoluteFromReq(req, imageUrls[safeIdx] || ""));
    const productUrl = ensureAbsoluteFromReq(req, `/product/${product.id}`);
    const fallbackRelays = nostrRelays();
    const nostr = mapNostrConfigForResponse(product, stored, {
      defaultImageUrl,
      productUrl,
      fallbackRelays,
      defaultHashtags
    });

    res.json({ ok: true, nostr });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.post("/api/admin/products/:id/nostr/teaser/publish", requireAdmin, async (req, res) => {
  try {
    const product = Products.get(req.params.id);
    if (!product) return res.status(404).json({ error: "Not found" });

    const settings = Settings.getAll();
    const defaultHashtags = settings.nostrDefaultHashtags || DEFAULT_TEASER_HASHTAGS;

    const imgs = Array.isArray(product.images) ? product.images : [];
    const imageUrls = imgs.map((_, i) => `/api/products/${product.id}/image/${i}.jpg${makeImageVersionQuery(product.imageVersion, i)}`);
    const safeIdx = Math.min(
      Math.max(0, Number(product.mainImageIndex) || 0),
      Math.max(0, imageUrls.length - 1)
    );
    const defaultImageUrl = ensureAbsoluteFromReq(req, imageUrls[safeIdx] || "");
    const productUrl = ensureAbsoluteFromReq(req, `/product/${product.id}`);
    const fallbackRelays = nostrRelays();

    const body = req.body || {};
    const updatePayload = {};
    if (body.content !== undefined) {
      updatePayload.content = String(body.content || "");
    }
    if (body.imageUrl !== undefined) {
      const raw = String(body.imageUrl || "").trim();
      const abs = raw ? sanitizeExternalUrl(raw) || ensureAbsoluteFromReq(req, raw) : "";
      updatePayload.imageUrl = abs ? ensureImageUrlWithExt(abs) : "";
    }
    if (body.relays !== undefined) {
      updatePayload.relays = parseRelaysInput(body.relays);
    }
    if (Object.keys(updatePayload).length > 0) {
      ProductNostrPosts.setTeaser(product.id, updatePayload);
    }
    const config = ProductNostrPosts.get(product.id);
    const teaserContent = String(config?.teaserContent || "").trim();
    const normalizedImageUrl = ensureImageUrlWithExt(config?.imageUrl || defaultImageUrl);
    const hashtags = normalizeTeaserHashtags(config?.teaserHashtags, defaultHashtags);
    const finalContent = teaserContent || makeDefaultTeaserContent(product, {
      productUrl,
      hashtags
    });

    const finalImageUrl = normalizedImageUrl;
    const chosenImageData = imgs[safeIdx] || "";
    const derivedMime = extractMimeFromDataUrl(chosenImageData) || guessImageMime(finalImageUrl);
    const finalRelays = (Array.isArray(config?.relays) && config.relays.length)
      ? config.relays
      : fallbackRelays;
    if (!finalRelays.length) {
      return res.status(400).json({ error: "No relays configured" });
    }

    const publishResult = await publishProductTeaser({
      content: finalContent,
      relays: finalRelays,
      imageUrl: finalImageUrl,
      imageMime: derivedMime,
      imageAlt: product.title || "",
      imageDim: "",
      productUrl
    });

    const publishedRow = ProductNostrPosts.recordTeaserPublish(product.id, {
      content: finalContent,
      lastEventId: publishResult.event.id,
      lastPublishedAt: publishResult.createdAt * 1000,
      lastAck: publishResult.relayResults
    });

    const nostr = mapNostrConfigForResponse(product, publishedRow, {
      defaultImageUrl,
      productUrl,
      fallbackRelays,
      defaultHashtags
    });

    res.json({
      ok: true,
      eventId: publishResult.event.id,
      kind: 1,
      relays: publishResult.relays,
      relayResults: publishResult.relayResults,
      nostr
    });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// ✅ Admin orders list (sorted newest first)
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  try {
    const list = Orders.all() || [];
    list.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: "Failed to load orders" });
  }
});

// ✅ Admin set order status
app.post("/api/admin/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const status = String(req.body?.status || "").toUpperCase();
    const courier = String(req.body?.courier || "").trim();
    const tracking = String(req.body?.tracking || "").trim();
    const allowed = new Set(["PENDING", "PAID", "PREPARATION", "SHIPPED"]);
    if (!allowed.has(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const existing = Orders.get(id);
    if (!existing) return res.status(404).json({ error: "Not found" });

    if (status === "SHIPPED" && (!courier || !tracking)) {
      return res.status(400).json({ error: "Courier and tracking are required for SHIPPED" });
    }

    const updated = Orders.setStatus(id, status, { courier, tracking });
    if (status === "PAID" && existing?.status !== "PAID" && Array.isArray(updated?.items)) {
      for (const it of updated.items) {
        try { Products.consumeStock(it.productId, it.qty || 1); } catch {}
      }
    }

    // NOSTR DM on status change
    try { await dmOrderUpdate(updated, status); } catch {}

    // Email on status change (if email present and SMTP enabled)
    try { await sendOrderStatusEmail(updated, status); } catch {}

    return res.json(updated);
  } catch (e) {
    return res.status(400).json({ error: String(e?.message || e) });
  }
});

// ✅ Admin delete order (used by client/src/admin/Orders.jsx)
app.delete("/api/admin/orders/:id", requireAdmin, (req, res) => {
  try {
    Orders.remove(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// Products (mutations)
app.post("/api/admin/products", requireAdmin, (req, res) => {
  const {
    title, subtitle, description, longDescription, priceSats, images, mainImageIndex,
    widthCm, heightCm, depthCm,
    shippingSurchargeSats,
    shippingZoneOverrides,
    shippingItalySats, shippingEuropeSats, shippingWorldSats,
    available,
    showDimensions,
    hidden,
    isUnique,
    quantityAvailable
  } = req.body || {};
  if (!title || !priceSats || !images?.length) {
    return res.status(400).json({ error: "title, priceSats, images required" });
  }
  const created = Products.create({
    title,
    subtitle: subtitle || "",
    description: description || "",
    longDescription: longDescription || "",
    priceSats: Math.floor(priceSats),
    images,
    mainImageIndex: Math.max(0, (mainImageIndex|0)),
    widthCm: widthCm ?? null,
    heightCm: heightCm ?? null,
    depthCm: depthCm ?? null,
    shippingSurchargeSats: Math.max(0, shippingSurchargeSats | 0),
    showDimensions: showDimensions !== undefined ? !!showDimensions : true,
    shippingItalySats: Math.max(0, shippingItalySats|0),
    shippingEuropeSats: Math.max(0, shippingEuropeSats|0),
    shippingWorldSats: Math.max(0, shippingWorldSats|0),
    shippingZoneOverrides: Array.isArray(shippingZoneOverrides) ? shippingZoneOverrides : [],
    isUnique: isUnique !== undefined ? !!isUnique : undefined,
    quantityAvailable: quantityAvailable
  });
  if (available === false) Products.update(created.id, { available: false });
  if (hidden === true) Products.update(created.id, { hidden: true });
  res.json(Products.get(created.id));
});
app.put("/api/admin/products/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  const patch = {};
  if (req.body.title !== undefined) patch.title = req.body.title;
  if (req.body.subtitle !== undefined) patch.subtitle = req.body.subtitle || "";
  if (req.body.description !== undefined) patch.description = req.body.description || "";
  if (req.body.longDescription !== undefined) patch.longDescription = req.body.longDescription || "";
  if (req.body.priceSats !== undefined) patch.priceSats = Math.floor(req.body.priceSats || 0);
  if (req.body.images !== undefined) patch.images = req.body.images;
  if (req.body.mainImageIndex !== undefined) patch.mainImageIndex = Math.max(0, (req.body.mainImageIndex | 0));
  if (req.body.widthCm !== undefined) patch.widthCm = req.body.widthCm ?? null;
  if (req.body.heightCm !== undefined) patch.heightCm = req.body.heightCm ?? null;
  if (req.body.depthCm !== undefined) patch.depthCm = req.body.depthCm ?? null;
  if (req.body.shippingSurchargeSats !== undefined) patch.shippingSurchargeSats = Math.max(0, req.body.shippingSurchargeSats | 0);
  if (req.body.shippingItalySats !== undefined) patch.shippingItalySats = Math.max(0, req.body.shippingItalySats | 0);
  if (req.body.shippingEuropeSats !== undefined) patch.shippingEuropeSats = Math.max(0, req.body.shippingEuropeSats | 0);
  if (req.body.shippingWorldSats !== undefined) patch.shippingWorldSats = Math.max(0, req.body.shippingWorldSats | 0);
  if (req.body.shippingZoneOverrides !== undefined) {
    patch.shippingZoneOverrides = Array.isArray(req.body.shippingZoneOverrides) ? req.body.shippingZoneOverrides : [];
  }
  if (req.body.available !== undefined) patch.available = !!req.body.available;
  if (req.body.hidden !== undefined) patch.hidden = !!req.body.hidden;
  if (req.body.showDimensions !== undefined) patch.showDimensions = !!req.body.showDimensions;
  if (req.body.isUnique !== undefined) patch.isUnique = !!req.body.isUnique;
  if (req.body.quantityAvailable !== undefined) patch.quantityAvailable = req.body.quantityAvailable;

  const changed = Products.update(id, patch);
  if (!changed) return res.status(404).json({ error: "Not found" });
  res.json(changed);
});
app.delete("/api/admin/products/:id", requireAdmin, (req, res) => {
  Products.remove(req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/products/reorder", requireAdmin, (req, res) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order : [];
    if (!order.length) {
      return res.status(400).json({ error: "Order array required" });
    }
    const updated = Products.reorder(order);
    res.json({ ok: true, updated });
  } catch (e) {
    console.error("products-reorder error:", e?.message || e);
    res.status(500).json({ error: "Failed to reorder products" });
  }
});

// ---------------------------------------------------------------------
// Checkout: create invoice (sats) with PER-PRODUCT shipping
// ---------------------------------------------------------------------
app.post("/api/checkout/create-invoice", async (req, res) => {
  try {
    const { items } = req.body || {};
    const rawCustomer = req.body?.customer || {};
    const paymentMethod = String(req.body?.paymentMethod || "lightning").toLowerCase() === "onchain"
      ? "onchain"
      : "lightning";
    if (paymentMethod === "onchain") {
      if (!ONCHAIN_ENABLED) {
        return res.status(400).json({ error: "On-chain payments are disabled" });
      }
    }
    const trim = (value, { uppercase = false } = {}) => {
      let out = typeof value === "string" ? value.trim() : String(value || "").trim();
      if (uppercase) out = out.toUpperCase();
      return out;
    };
    const sanitizedCustomer = {
      name: trim(rawCustomer.name || ""),
      surname: trim(rawCustomer.surname || ""),
      address: trim(rawCustomer.address || ""),
      city: trim(rawCustomer.city || ""),
      province: trim(rawCustomer.province || ""),
      postalCode: trim(rawCustomer.postalCode || ""),
      country: trim(rawCustomer.country || "", { uppercase: true }),
      contactEmail: trim(rawCustomer.contactEmail || ""),
      contactTelegram: trim(rawCustomer.contactTelegram || ""),
      contactNostr: trim(rawCustomer.contactNostr || ""),
      contactPhone: trim(rawCustomer.contactPhone || ""),
      notes: typeof rawCustomer.notes === "string" ? rawCustomer.notes : String(rawCustomer.notes || "")
    };

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items" });
    }
    if (!sanitizedCustomer.address) {
      return res.status(400).json({ error: "Shipping address is required" });
    }
    if (!sanitizedCustomer.city) {
      return res.status(400).json({ error: "City is required" });
    }
    if (!sanitizedCustomer.province) {
      return res.status(400).json({ error: "Province/State is required" });
    }
    if (!sanitizedCustomer.country) {
      return res.status(400).json({ error: "Country is required" });
    }
    if (!sanitizedCustomer.contactPhone) {
      return res.status(400).json({ error: "Phone number is required for shipping" });
    }
    const hasContact = [
      sanitizedCustomer.contactEmail,
      sanitizedCustomer.contactTelegram,
      sanitizedCustomer.contactNostr
    ].some((value) => !!value);
    if (!hasContact) {
      return res.status(400).json({ error: "Provide at least one contact method" });
    }

    const country = sanitizedCustomer.country;
    const loaded = items.map(({ productId, qty }) => {
      const p = Products.get(productId, { includeImages: false });
      if (!p || !p.available || p.hidden) throw new Error(`Item not available: ${productId}`);
      const q = Math.max(1, Math.floor(qty || 1));
      const maxAllowed = maxPurchasableForProduct(p);
      if (maxAllowed <= 0) throw new Error(`Item not available: ${productId}`);
      if (q > maxAllowed) throw new Error(`Only ${maxAllowed} available for ${productId}`);
      return {
        productId,
        title: p.title,
        priceSats: p.priceSats,
        qty: q,
        shippingItalySats: p.shippingItalySats || 0,
        shippingEuropeSats: p.shippingEuropeSats || 0,
        shippingWorldSats: p.shippingWorldSats || 0,
        shippingZoneOverrides: Array.isArray(p.shippingZoneOverrides) ? p.shippingZoneOverrides : []
      };
    });

    const subtotal = loaded.reduce((x, it) => x + it.priceSats * Math.max(1, it.qty || 1), 0);
    const settings = Settings.getAll();
    const zones = normalizeShippingZones(settings.shippingZones);
    let shipping = 0;

    if (zones.length > 0) {
      const upperCountry = country || "";
      const direct = zones.find((z) => (z.countries || []).includes(upperCountry));
      const fallback = zones.find((z) => (z.countries || []).some((c) => c === "ALL" || c === "*"));
      const zone = direct || fallback;
      if (!zone) {
        return res.status(400).json({ error: "Shipping not available for this country" });
      }
      shipping = loaded.reduce(
        (x, it) => {
          const perItem = resolveZonePriceForProduct(zone, it);
          const qty = Math.max(1, Number(it.qty) || 1);
          return x + perItem * qty;
        },
        0
      );
    } else {
      shipping = loaded.reduce((x, it) => {
        const qty = Math.max(1, Number(it.qty) || 1);
        if (country === "IT") return x + qty * (it.shippingItalySats || 0);
        if (isEurope(country)) return x + qty * (it.shippingEuropeSats || 0);
        return x + qty * (it.shippingWorldSats || 0);
      }, 0);
    }
    const total = subtotal + shipping;
    if (paymentMethod === "onchain" && ONCHAIN_MIN_SATS > 0 && total < ONCHAIN_MIN_SATS) {
      return res.status(400).json({ error: `Minimum on-chain amount is ${ONCHAIN_MIN_SATS} sats` });
    }

    // Provider-specific wallet resolution (Blink needs it; LND returns a dummy id)
    const walletId = await ensureBtcWalletId(
      PAYMENT_PROVIDER === "blink"
        ? {
            url: BLINK_GRAPHQL_URL,
            apiKey: BLINK_API_KEY,
            explicitWalletId: BLINK_BTC_WALLET_ID || undefined
          }
        : PAYMENT_PROVIDER === "btcpay"
          ? {
              url: BTCPAY_URL,
              apiKey: BTCPAY_API_KEY,
              explicitStoreId: BTCPAY_STORE_ID || undefined
            }
        : {}
    );

    // Memo: "Order <store name> <product name>"
    const { storeName } = Settings.getAll();
    const firstTitle = loaded[0]?.title || "";
    const memo = `Order ${storeName || "Lightning Shop"} ${firstTitle}`.trim();
    const orderRef = memo;

    let inv;
    if (paymentMethod === "onchain") {
      inv = await createOnchainSwapViaBoltz(
        PAYMENT_PROVIDER === "blink"
          ? {
              url: BLINK_GRAPHQL_URL,
              apiKey: BLINK_API_KEY,
              walletId,
              amount: total,
              memo,
              webhookUrl: BOLTZ_WEBHOOK_URL || undefined,
              expiresIn: ONCHAIN_INVOICE_EXPIRES_IN
            }
          : PAYMENT_PROVIDER === "btcpay"
            ? {
                url: BTCPAY_URL,
                apiKey: BTCPAY_API_KEY,
              walletId,
              amount: total,
              memo,
              orderRef,
              expiresIn: ONCHAIN_INVOICE_EXPIRES_IN
            }
          : {
              amount: total,
              memo,
              webhookUrl: BOLTZ_WEBHOOK_URL || undefined,
              expiresIn: ONCHAIN_INVOICE_EXPIRES_IN
            }
      );
    } else {
      // Lightning-only (existing flow)
      inv = await createInvoiceSats(
        PAYMENT_PROVIDER === "blink"
          ? {
              url: BLINK_GRAPHQL_URL,
              apiKey: BLINK_API_KEY,
              walletId,
              amount: total,
              memo
            }
          : PAYMENT_PROVIDER === "btcpay"
            ? {
                url: BTCPAY_URL,
                apiKey: BTCPAY_API_KEY,
              walletId,
              amount: total,
              memo,
              orderRef
            }
          : {
              amount: total,
              memo
            }
      );
    }

    // If signed-in with Nostr, bind orders to nostr:<hex> so they persist across devices
    const clientId =
      (req.session?.nostrPubkey ? `nostr:${req.session.nostrPubkey}` : "") ||
      (req.session?.cid || "");

    const created = Orders.create({
      clientId,
      items: loaded.map(({shippingItalySats,shippingEuropeSats,shippingWorldSats, ...keep}) => keep),
      subtotalSats: subtotal,
      shippingSats: shipping,
      totalSats: total,
      name: sanitizedCustomer.name,
      surname: sanitizedCustomer.surname,
      address: sanitizedCustomer.address,
      city: sanitizedCustomer.city,
      province: sanitizedCustomer.province,
      postalCode: sanitizedCustomer.postalCode,
      country,
      contactEmail: sanitizedCustomer.contactEmail,
      contactTelegram: sanitizedCustomer.contactTelegram,
      contactNostr: sanitizedCustomer.contactNostr,
      contactPhone: sanitizedCustomer.contactPhone,
      paymentHash: inv.paymentHash,
      paymentRequest: inv.paymentRequest,
      paymentMethod,
      boltzSwapId: inv.boltzSwapId || inv.swapId || "",
      boltzAddress: inv.onchainAddress || "",
      boltzExpectedAmountSats: inv.onchainAmountSats || 0,
      boltzTimeoutBlockHeight: inv.timeoutBlockHeight || 0,
      boltzRefundPrivKey: inv.boltzRefundPrivKey || "",
      boltzStatus: inv.boltzStatus || "",
      // persist customer notes
      notes: sanitizedCustomer.notes || ""
    });

    res.json({
      orderId: created.id,
      paymentMethod,
      paymentRequest: inv.paymentRequest,
      paymentHash: inv.paymentHash,
      satoshis: inv.satoshis,
      totalSats: total,
      swapId: inv.boltzSwapId || inv.swapId || "",
      onchainAddress: inv.onchainAddress || "",
      onchainAmountSats: inv.onchainAmountSats || 0,
      onchainBip21: inv.bip21 || "",
      onchainTimeoutBlockHeight: inv.timeoutBlockHeight || 0,
      checkoutLink: inv.checkoutLink || "",
      invoiceId: inv.invoiceId || ""
    });
  } catch (e) {
    console.error("create-invoice error:", e?.message || e);
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// ---------------------------------------------------------------------
// About page: create a simple zap invoice
// ---------------------------------------------------------------------
app.post("/api/zaps/create-invoice", async (req, res) => {
  try {
    const amountRaw = Number(req.body?.amount || 0);
    const sats = Math.max(1, Math.floor(amountRaw));
    if (!Number.isFinite(sats) || sats <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const walletId = await ensureBtcWalletId(
      PAYMENT_PROVIDER === "blink"
        ? {
            url: BLINK_GRAPHQL_URL,
            apiKey: BLINK_API_KEY,
            explicitWalletId: BLINK_BTC_WALLET_ID || undefined
          }
        : PAYMENT_PROVIDER === "btcpay"
          ? {
              url: BTCPAY_URL,
              apiKey: BTCPAY_API_KEY,
              explicitStoreId: BTCPAY_STORE_ID || undefined
            }
        : {}
    );

    const rawNote = String(req.body?.note || "");
    const safeNote = rawNote.replace(/\s+/g, " ").trim().slice(0, 120);
    const { storeName } = Settings.getAll();
    const memoBase = `${storeName || "Lightning Shop"} Zap`;
    const memo = safeNote ? `${memoBase} - ${safeNote}` : memoBase;
    const orderRef = memoBase;

    const invoice = await createInvoiceSats(
      PAYMENT_PROVIDER === "blink"
        ? {
            url: BLINK_GRAPHQL_URL,
            apiKey: BLINK_API_KEY,
            walletId,
            amount: sats,
            memo
          }
        : PAYMENT_PROVIDER === "btcpay"
          ? {
              url: BTCPAY_URL,
              apiKey: BTCPAY_API_KEY,
              walletId,
              amount: sats,
              memo,
              orderRef
            }
          : {
              amount: sats,
              memo
            }
    );

    res.json({
      paymentRequest: invoice?.paymentRequest || "",
      paymentHash: invoice?.paymentHash || "",
      satoshis: invoice?.satoshis ?? sats
    });
  } catch (e) {
    console.error("zap-invoice error:", e?.message || e);
    res.status(500).json({ error: "Failed to create zap invoice" });
  }
});

// ---------------------------------------------------------------------
// Boltz helpers (shared by status + SSE)
// ---------------------------------------------------------------------
const BOLTZ_FINAL_STATUSES = new Set(["PAID", "EXPIRED", "FAILED"]);

async function handleBoltzStatusSideEffects({ swapId, mappedStatus, rawStatus }) {
  if (!swapId) return null;
  const orderBefore = Orders.updateBoltzStatus(swapId, rawStatus || "");
  if (!orderBefore) return null;

  if (mappedStatus === "PAID") {
    const order = Orders.markPaidBySwapId(swapId);
    if (order?.__justPaid && order?.items?.length) {
      for (const it of order.items) Products.consumeStock(it.productId, it.qty || 1);
    }
    notifyPaidOnce(order);
    try { await dmOrderUpdate(order, "PAID"); } catch {}
    try { await sendOrderStatusEmail(order, "PAID"); } catch {}
    return order;
  }

  if (mappedStatus === "EXPIRED") {
    if (orderBefore.status === "PENDING") {
      Orders.remove(orderBefore.id);
    }
    return orderBefore;
  }

  if (mappedStatus === "FAILED") {
    return Orders.setStatus(orderBefore.id, "FAILED");
  }

  return orderBefore;
}

// ---------------------------------------------------------------------
// Invoice status (polling fallback) - cancels order on EXPIRED
// ---------------------------------------------------------------------
app.get("/api/invoices/:hash/status", async (req, res) => {
  try {
    const args =
      PAYMENT_PROVIDER === "blink"
        ? { url: BLINK_GRAPHQL_URL, apiKey: BLINK_API_KEY, paymentHash: req.params.hash }
        : PAYMENT_PROVIDER === "btcpay"
          ? { url: BTCPAY_URL, apiKey: BTCPAY_API_KEY, paymentHash: req.params.hash, walletId: { storeId: BTCPAY_STORE_ID } }
        : { paymentHash: req.params.hash };

    const status = await invoiceStatus(args);

    if (status === "PAID") {
      const order = Orders.markPaidByHash(req.params.hash);
      if (order?.__justPaid && order?.items?.length) {
        for (const it of order.items) Products.consumeStock(it.productId, it.qty || 1);
      }
      notifyPaidOnce(order); // << ntfy
      // NOSTR DM on PAID
      try { await dmOrderUpdate(order, "PAID"); } catch {}
      // Email on PAID
      try { await sendOrderStatusEmail(order, "PAID"); } catch {}
    } else if (status === "EXPIRED") {
      // Cancel (delete) the pending order as soon as the invoice is not valid anymore
      const order = Orders.byPaymentHash(req.params.hash);
      if (order && order.status === "PENDING") {
        Orders.remove(order.id);
      }
    }

    res.json({ status });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------
// On-chain (Boltz) swap status (polling)
// ---------------------------------------------------------------------
app.get("/api/onchain/:swapId/status", async (req, res) => {
  try {
    const swapId = req.params.swapId;
    const order = Orders.bySwapId(swapId);
    if (!order) return res.status(404).json({ error: "Not found" });

    // If order already marked paid, short-circuit
    if (String(order.status || "").toUpperCase() === "PAID") {
      return res.json({
        status: "PAID",
        rawStatus: order.boltzStatus || "invoice.paid",
        onchainAddress: order.boltzAddress || "",
        onchainAmountSats: order.boltzExpectedAmountSats || 0,
        timeoutBlockHeight: order.boltzTimeoutBlockHeight || 0
      });
    }

    if (PAYMENT_PROVIDER === "btcpay") {
      const inv = await btcpay.getInvoice({
        url: BTCPAY_URL,
        apiKey: BTCPAY_API_KEY,
        storeId: BTCPAY_STORE_ID,
        invoiceId: swapId
      });
      const raw = String(inv?.status || "");
      const mapped = (() => {
        const st = raw.toLowerCase();
        if (st === "settled") return "CONFIRMED";
        if (st === "processing") return "MEMPOOL";
        if (st === "expired" || st === "invalid") return "EXPIRED";
        return "PENDING";
      })();

      if (mapped === "CONFIRMED") {
        const updated = Orders.markPaidByHash(order.paymentHash);
        if (updated?.__justPaid && updated?.items?.length) {
          for (const it of updated.items) Products.consumeStock(it.productId, it.qty || 1);
        }
        notifyPaidOnce(updated);
        try { await dmOrderUpdate(updated, "PAID"); } catch {}
        try { await sendOrderStatusEmail(updated, "PAID"); } catch {}
      } else if (mapped === "EXPIRED" && order.status === "PENDING") {
        Orders.remove(order.id);
      }

      return res.json({
        status: mapped,
        rawStatus: raw,
        onchainAddress: order.boltzAddress || "",
        onchainAmountSats: order.boltzExpectedAmountSats || 0,
        timeoutBlockHeight: order.boltzTimeoutBlockHeight || 0
      });
    }

    const { swap, mappedStatus, onchainAddress, onchainAmountSats, timeoutBlockHeight } =
      await boltzSwapStatus({ swapId });

    await handleBoltzStatusSideEffects({
      swapId,
      mappedStatus,
      rawStatus: swap?.status || ""
    });

    res.json({
      status: mappedStatus,
      rawStatus: swap?.status || "",
      onchainAddress: onchainAddress || order.boltzAddress || "",
      onchainAmountSats: onchainAmountSats || order.boltzExpectedAmountSats || 0,
      timeoutBlockHeight: timeoutBlockHeight || order.boltzTimeoutBlockHeight || 0
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------
/* Provider-agnostic WS → SSE bridge for live status in-browser
   Also cancels order on EXPIRED even if UI is open.                  */
// ---------------------------------------------------------------------
app.get("/api/invoices/:hash/stream", async (req, res) => {
  const paymentHash = req.params.hash;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const ping = () => res.write(`: ping\n\n`);
  const hb = setInterval(ping, 20000);

  let unsub = null;
  let closed = false;
  const closeAll = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    try { unsub?.(); } catch {}
    try { res.end(); } catch {}
  };

  unsub = subscribeInvoiceStatus({
    paymentHash,
    onStatus: async (status) => {
      send({ status });

      if (status === "PAID") {
        const order = Orders.markPaidByHash(paymentHash);
        if (order?.__justPaid && order?.items?.length) {
          for (const it of order.items) Products.consumeStock(it.productId, it.qty || 1);
        }
        notifyPaidOnce(order); // << ntfy
        try { await dmOrderUpdate(order, "PAID"); } catch {}
        try { await sendOrderStatusEmail(order, "PAID"); } catch {}
        closeAll();
      }

      if (status === "EXPIRED") {
        // Delete pending order immediately on expiry
        const order = Orders.byPaymentHash(paymentHash);
        if (order && order.status === "PENDING") {
          Orders.remove(order.id);
        }
        closeAll();
      }
    }
  });

  req.on("close", () => closeAll());
});

// ---------------------------------------------------------------------
// On-chain (Boltz) SSE bridge
// ---------------------------------------------------------------------
app.get("/api/onchain/:swapId/stream", async (req, res) => {
  const swapId = req.params.swapId;
  const order = Orders.bySwapId(swapId);
  if (!order) return res.status(404).json({ error: "Not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const ping = () => res.write(`: ping\n\n`);
  const hb = setInterval(ping, 20000);

  let closed = false;
  let unsub = null;
  const closeAll = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    try {
      if (typeof unsub === "function") unsub();
      else if (unsub) clearInterval(unsub);
    } catch {}
    try { res.end(); } catch {}
  };

  const emitAndHandle = async ({ mappedStatus, rawStatus, swapPayload }) => {
    const freshOrder = Orders.bySwapId(swapId) || order;
    const payload = {
      status: mappedStatus,
      rawStatus,
      onchainAddress: swapPayload?.onchainAddress || freshOrder.boltzAddress || "",
      onchainAmountSats: swapPayload?.onchainAmountSats ?? freshOrder.boltzExpectedAmountSats,
      timeoutBlockHeight: swapPayload?.timeoutBlockHeight ?? freshOrder.boltzTimeoutBlockHeight
    };
    send(payload);
    if (PAYMENT_PROVIDER !== "btcpay") {
      await handleBoltzStatusSideEffects({ swapId, mappedStatus, rawStatus });
    } else {
      if (mappedStatus === "CONFIRMED") {
        const updated = Orders.markPaidByHash(freshOrder.paymentHash);
        if (updated?.__justPaid && updated?.items?.length) {
          for (const it of updated.items) Products.consumeStock(it.productId, it.qty || 1);
        }
        notifyPaidOnce(updated);
        try { await dmOrderUpdate(updated, "PAID"); } catch {}
        try { await sendOrderStatusEmail(updated, "PAID"); } catch {}
      }
      if (mappedStatus === "EXPIRED") {
        const pending = Orders.bySwapId(swapId);
        if (pending && pending.status === "PENDING") {
          Orders.remove(pending.id);
        }
      }
    }

    const latest = Orders.bySwapId(swapId) || freshOrder;
    const alreadyPaid = String(latest.status || "").toUpperCase() === "PAID";
    if (PAYMENT_PROVIDER === "btcpay") {
      if (mappedStatus === "CONFIRMED" || mappedStatus === "EXPIRED" || alreadyPaid) {
        if (alreadyPaid && mappedStatus !== "CONFIRMED") {
          send({ ...payload, status: "CONFIRMED", rawStatus: rawStatus || "invoice.paid" });
        }
        closeAll();
      }
    } else {
      if (BOLTZ_FINAL_STATUSES.has(mappedStatus) || alreadyPaid) {
        // Ensure final PAID is sent before closing
        if (alreadyPaid && mappedStatus !== "PAID") {
          send({ ...payload, status: "PAID", rawStatus: rawStatus || "invoice.paid" });
        }
        closeAll();
      }
    }
  };

  try {
    const initialOrder = Orders.bySwapId(swapId);
    if (String(initialOrder?.status || "").toUpperCase() === "PAID") {
      send({
        status: "PAID",
        rawStatus: initialOrder?.boltzStatus || "invoice.paid",
        onchainAddress: initialOrder?.boltzAddress || "",
        onchainAmountSats: initialOrder?.boltzExpectedAmountSats || 0,
        timeoutBlockHeight: initialOrder?.boltzTimeoutBlockHeight || 0
      });
      return closeAll();
    }

    if (PAYMENT_PROVIDER === "btcpay") {
      const inv = await btcpay.getInvoice({
        url: BTCPAY_URL,
        apiKey: BTCPAY_API_KEY,
        storeId: BTCPAY_STORE_ID,
        invoiceId: swapId
      });
      const raw = String(inv?.status || "");
      const mapped = (() => {
        const st = raw.toLowerCase();
        if (st === "settled") return "CONFIRMED";
        if (st === "processing") return "MEMPOOL";
        if (st === "expired" || st === "invalid") return "EXPIRED";
        return "PENDING";
      })();
      await emitAndHandle({
        mappedStatus: mapped,
        rawStatus: raw,
        swapPayload: {
          onchainAddress: order.boltzAddress,
          onchainAmountSats: order.boltzExpectedAmountSats,
          timeoutBlockHeight: order.boltzTimeoutBlockHeight
        }
      });
      if (mapped === "CONFIRMED" || mapped === "EXPIRED") return;
    } else {
      const prime = await boltzSwapStatus({ swapId });
      await emitAndHandle({
        mappedStatus: prime.mappedStatus,
        rawStatus: prime.swap?.status || "",
        swapPayload: {
          onchainAddress: prime.onchainAddress,
          onchainAmountSats: prime.onchainAmountSats,
          timeoutBlockHeight: prime.timeoutBlockHeight
        }
      });
      if (BOLTZ_FINAL_STATUSES.has(prime.mappedStatus)) return;
    }
  } catch {
    // ignore prime failure; SSE will still start
  }

  if (PAYMENT_PROVIDER === "btcpay") {
    // simple polling fallback for BTCPay on-chain status
    unsub = setInterval(async () => {
      try {
        const inv = await btcpay.getInvoice({
          url: BTCPAY_URL,
          apiKey: BTCPAY_API_KEY,
          storeId: BTCPAY_STORE_ID,
          invoiceId: swapId
        });
        const raw = String(inv?.status || "");
        const mapped = (() => {
          const st = raw.toLowerCase();
          if (st === "settled") return "CONFIRMED";
          if (st === "processing") return "MEMPOOL";
          if (st === "expired" || st === "invalid") return "EXPIRED";
          return "PENDING";
        })();
        await emitAndHandle({
          mappedStatus: mapped,
          rawStatus: raw,
          swapPayload: {
            onchainAddress: order.boltzAddress,
            onchainAmountSats: order.boltzExpectedAmountSats,
            timeoutBlockHeight: order.boltzTimeoutBlockHeight
          }
        });
      } catch {
        // ignore and continue
      }
    }, 5000);
  } else {
    unsub = subscribeBoltzSwapStatus({
      swapId,
      onUpdate: async ({ swap, rawStatus, mappedStatus }) => {
        const { onchainAddress, onchainAmountSats, timeoutBlockHeight } = (() => {
          const addr = swap?.lockupAddress || swap?.address || order.boltzAddress || "";
          const amt = Math.max(
            0,
            Math.floor(Number((swap?.expectedAmount ?? swap?.expected ?? order.boltzExpectedAmountSats ?? 0)))
          );
          const timeout = Math.max(
            0,
            Math.floor(Number((swap?.timeoutBlockHeight ?? swap?.lockupTimeoutBlock ?? order.boltzTimeoutBlockHeight ?? 0)))
          );
          return { onchainAddress: addr, onchainAmountSats: amt, timeoutBlockHeight: timeout };
        })();

        await emitAndHandle({
          mappedStatus,
          rawStatus,
          swapPayload: { onchainAddress, onchainAmountSats, timeoutBlockHeight }
        });
      }
    });
  }

  req.on("close", () => closeAll());
});

// ---------------------------------------------------------------------
// Boltz webhook (optional)
// ---------------------------------------------------------------------
app.get("/api/webhooks/boltz", (req, res) => {
  if (!BOLTZ_WEBHOOK_URL) {
    return res.status(503).json({ ok: false, error: "Boltz webhook not configured" });
  }
  return res.json({
    ok: true,
    note: "Send POST from Boltz to this URL with X-Boltz-Secret header",
    configured: true,
    requiresSecret: !!BOLTZ_WEBHOOK_SECRET
  });
});

app.post("/api/webhooks/boltz", async (req, res) => {
  try {
    if (!BOLTZ_WEBHOOK_URL) {
      return res.status(503).json({ error: "Boltz webhook not configured" });
    }
    if (!BOLTZ_WEBHOOK_SECRET) {
      return res.status(503).json({ error: "BOLTZ_WEBHOOK_SECRET not configured" });
    }
    const providedSecret =
      req.headers["x-boltz-secret"] ||
      req.headers["x-webhook-secret"] ||
      req.query?.token ||
      "";
    if (String(providedSecret) !== BOLTZ_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Invalid webhook secret" });
    }
    const payload = req.body || {};
    const data = payload.data || {};
    const swapId = data.id || payload.id || "";
    const rawStatus = data.status || payload.status || "";
    if (!swapId || !rawStatus) {
      return res.status(400).json({ error: "Invalid payload" });
    }
    const mappedStatus = boltz.mapBoltzStatus(rawStatus);
    await handleBoltzStatusSideEffects({ swapId, mappedStatus, rawStatus });
  } catch (e) {
    console.warn("[boltz webhook] error:", e?.message || e);
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------
// BTCPay webhook (Lightning + on-chain)
// ---------------------------------------------------------------------
app.post(BTCPAY_WEBHOOK_PATH, async (req, res) => {
  try {
    if (PAYMENT_PROVIDER !== "btcpay") {
      return res.status(503).json({ error: "PAYMENT_PROVIDER is not btcpay" });
    }
    if (!BTCPAY_WEBHOOK_SECRET) {
      return res.status(503).json({ error: "BTCPAY_WEBHOOK_SECRET not configured" });
    }
    const rawBody = req.rawBody;
    const sig = req.headers?.["btcpay-sig"] || req.headers?.["BTCPay-Sig"];
    if (!rawBody) {
      return res.status(400).json({ error: "Missing raw body" });
    }
    if (!verifyBtcpaySignature(rawBody, sig, BTCPAY_WEBHOOK_SECRET)) {
      return res.status(400).json({ error: "Invalid signature" });
    }

    const evt = req.body || {};
    const type = evt?.type || "";
    const invoiceId = evt?.invoiceId || evt?.data?.invoiceId || "";
    if (!invoiceId) {
      return res.status(400).json({ error: "Missing invoiceId" });
    }

    let mapped = btcpay.statusFromEventType(type);
    if (type === "InvoiceProcessing" && evt?.paymentMethodId === "BTC-CHAIN") mapped = "MEMPOOL";
    if (type === "InvoiceSettled" && evt?.paymentMethodId === "BTC-CHAIN") mapped = "CONFIRMED";

    emitBtcpayStatus(invoiceId, mapped);

    if (mapped === "PAID" || mapped === "CONFIRMED") {
      const order = Orders.markPaidByHash(invoiceId);
      if (order?.__justPaid && order?.items?.length) {
        for (const it of order.items) Products.consumeStock(it.productId, it.qty || 1);
      }
      notifyPaidOnce(order);
      try { await dmOrderUpdate(order, "PAID"); } catch {}
      try { await sendOrderStatusEmail(order, "PAID"); } catch {}
    } else if (mapped === "EXPIRED") {
      const order = Orders.byPaymentHash(invoiceId);
      if (order && order.status === "PENDING") {
        Orders.remove(order.id);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.warn("[btcpay webhook] error:", e?.message || e);
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// ────────────────────────────────────────────────────────────────────
// NOSTR: Login routes (challenge + verify) + me/logout
// ────────────────────────────────────────────────────────────────────
app.get("/api/nostr/login/challenge", (req, res) => {
  const ch = makeId();
  req.session.nostrChallenge = ch;
  res.json({ challenge: ch, domain: req.headers.host || "" });
});

app.post("/api/nostr/login/verify", (req, res) => {
  const { event } = req.body || {};
  const ch = req.session?.nostrChallenge || "";
  if (!ch) return res.status(400).json({ ok: false, error: "Missing challenge" });
  const domain = String(req.headers.host || "").toLowerCase();
  if (!verifyLoginEvent(event, ch, { expectedKind: 27235, expectedDomain: domain })) {
    return res.status(400).json({ ok: false, error: "Invalid signature or challenge" });
  }
  // success: persist pubkey in session
  req.session.nostrPubkey = event.pubkey;
  req.session.nostrChallenge = null;
  res.json({ ok: true, pubkey: event.pubkey });
});

app.get("/api/nostr/me", (req, res) => {
  const pk = req.session?.nostrPubkey || "";
  res.json({ pubkey: pk });
});
app.post("/api/nostr/logout", (req, res) => {
  req.session.nostrPubkey = null;
  res.json({ ok: true });
});

// Issue a short-lived, per-product proof signed with the shop Nostr key.
app.get("/api/nostr/comment-proof", (req, res) => {
  const productId = String(req.query.productId || "").trim();
  if (!productId) return res.status(400).json({ ok: false, error: "Missing productId" });
  const proof = makeCommentProof({ productId });
  if (!proof) return res.status(400).json({ ok: false, error: "Nostr server key not configured" });
  res.json({ ok: true, storePubkey: proof.storePubkey, proof: { sig: proof.sig, ts: proof.ts } });
});

// Optional: receive comment events (after publish) and send an ntfy notification.
app.post("/api/nostr/comment/notify", async (req, res) => {
  try {
    const ev = req.body?.event || {};
    if (!ev || ev.kind !== COMMENT_EVENT_KIND) {
      return res.status(400).json({ ok: false, error: "Invalid kind" });
    }
    if (!verifyEvent(ev)) {
      return res.status(400).json({ ok: false, error: "Invalid signature" });
    }
    const productId = extractProductIdFromTags(ev.tags);
    if (!productId) return res.status(400).json({ ok: false, error: "Missing product id" });

    const proofTag = (Array.isArray(ev.tags) ? ev.tags : []).find((t) => Array.isArray(t) && t[0] === "proof");
    const proofSig = proofTag?.[1];
    const proofTs = proofTag?.[2];
    const storePubkey = getShopPubkey();
    if (!storePubkey) return res.status(400).json({ ok: false, error: "Store pubkey not configured" });
    if (!verifyCommentProof({ sig: proofSig, ts: proofTs, storePubkey, productId })) {
      return res.status(400).json({ ok: false, error: "Invalid proof" });
    }

    const id = String(ev.id || "");
    if (id && notifiedCommentIds.has(id)) {
      return res.json({ ok: true, dedup: true });
    }

    let product = null;
    try { product = Products.get(productId, { includeImages: false }); } catch {}
    let profile = null;
    try {
      const relays = nostrRelays();
      profile = await fetchProfile(ev.pubkey, relays);
    } catch {}
    ntfyNotifyComment({ event: ev, product, productId, profile });
    if (id) notifiedCommentIds.add(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: "Notify failed" });
  }
});

// ---------------------------------------------------------------------
// ✅ NEW: NIP-05 well-known endpoint
// Serves /.well-known/nostr.json using settings (nostrNip05, nostrNpub, relays).
// Sits before the Vite proxy/static so it works in DEV and PROD.
// ---------------------------------------------------------------------
app.get("/.well-known/nostr.json", async (req, res) => {
  try {
    const s = Settings.getAll();

    // Determine the username from settings (before any ?name= query)
    const configuredName = String(s.nostrNip05 || "")
      .split("@")[0]
      .trim()
      .toLowerCase();
    const requestedName = String(req.query.name || "")
      .trim()
      .toLowerCase();
    const name = configuredName || requestedName;

    // Resolve pubkey to raw hex (accepts hex or npub in settings)
    let hex = "";
    const ident = String(s.nostrNpub || "").trim();
    if (ident) {
      try { hex = await resolveToPubkey(ident); } catch {}
    }

    // If not configured, return an empty mapping (valid JSON)
    if (!hex || !name) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=120");
      return res.status(200).json({ names: {} });
    }

    const names = { [name]: hex };
    const relaysArr = nostrRelays();
    const relays = relaysArr?.length ? { [hex]: relaysArr } : undefined;

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");

    const payload = relays ? { names, relays } : { names };
    return res.json(payload);
  } catch {
    return res.status(200).json({ names: {} });
  }
});

// ---------------------------------------------------------------------
// DEV: Reverse-proxy everything except /api/* to Vite (single port)
// ---------------------------------------------------------------------
let spaProxy = null;
if (DEV) {
  const VITE_DEV_SERVER = process.env.VITE_DEV_SERVER || "http://127.0.0.1:5173";
  spaProxy = createProxyMiddleware({
    target: VITE_DEV_SERVER,
    changeOrigin: true,
    ws: true, // proxy HMR websockets
    logLevel: "warn",
  });
  app.use((req, res, next) => {
    if (req.url.startsWith("/api")) return next();
    return spaProxy(req, res, next);
  });
}

// ---------------------------------------------------------------------
// PRODUCTION: serve built client
// ---------------------------------------------------------------------
if (!DEV) {
  const dist = path.resolve(__dirname, "../client/dist");
  cachedIndexHtml = loadIndexHtml(dist);
  app.use(express.static(dist, { index: false }));

  // Serve product pages with OG/Twitter tags for social previews
  app.get("/product/:id", (req, res) => {
    const product = Products.get(req.params.id, { includeImages: false });
    const settings = Settings.getPublic();
    const meta = product && !product.hidden
      ? buildProductMeta(req, product, settings)
      : buildDefaultMeta(req, settings);
    const html = renderIndexWithMeta(cachedIndexHtml, meta);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=900");
    res.status(200).send(html);
  });

  // Serve SPA for all other non-API paths with default metadata
  app.get(/^\/(?!api\/).*/, (req, res) => {
    const meta = buildDefaultMeta(req, Settings.getPublic());
    const html = renderIndexWithMeta(cachedIndexHtml, meta);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=180, stale-while-revalidate=600");
    res.status(200).send(html);
  });
}

// ---------------------------------------------------------------------
// Start server (bind 0.0.0.0 for LAN access) + WS upgrade for HMR
// ---------------------------------------------------------------------
let server = null;
if (!TEST_MODE) {
  server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
  if (spaProxy) server.on("upgrade", spaProxy.upgrade);
}

// ---------------------------------------------------------------------
// 🔌 Always-on payment watcher (Blink or LND)
// Marks orders PAID even if buyers close their browser, and notifies ntfy.
// Also DMs buyer (if Nostr contact present).
// ---------------------------------------------------------------------
if (!TEST_MODE) (function startPaymentUpdatesWatcher() {
  if (PAYMENT_PROVIDER === "blink" && !BLINK_API_KEY) {
    console.warn("[PaymentWatcher] Skipped: BLINK_API_KEY missing while PAYMENT_PROVIDER=blink");
    return;
  }
  if (PAYMENT_PROVIDER === "btcpay" && !BTCPAY_WEBHOOK_SECRET) {
    console.warn("[PaymentWatcher] BTCPAY_WEBHOOK_SECRET missing; configure it so webhooks can mark invoices paid.");
  }
  startPaymentWatcher({
    onPaid: async (hash) => {
      const order = Orders.markPaidByHash(hash);
      if (order?.__justPaid && order?.items?.length) {
        for (const it of order.items) Products.consumeStock(it.productId, it.qty || 1);
      }
      notifyPaidOnce(order);
      try { await dmOrderUpdate(order, "PAID"); } catch {}
      try { await sendOrderStatusEmail(order, "PAID"); } catch {}
    }
  });
})();

// ---------------------------------------------------------------------
// NEW: Background sweeper - keeps PENDING while valid; cancels on EXPIRED
// Runs periodically so orders are cancelled even if the buyer closes the browser
// ---------------------------------------------------------------------
if (!TEST_MODE) (function startPendingInvoiceSweeper() {
  async function sweepPendingInvoices() {
    try {
      const all = Orders.all();
      const pending = Array.isArray(all) ? all.filter(o => o.status === "PENDING" && o.paymentHash) : [];
      for (const o of pending) {
        try {
          if (o.paymentMethod === "onchain" && o.boltzSwapId) {
            try {
              const { swap, mappedStatus } = await boltzSwapStatus({ swapId: o.boltzSwapId });
              await handleBoltzStatusSideEffects({
                swapId: o.boltzSwapId,
                mappedStatus,
                rawStatus: swap?.status || ""
              });
              if (BOLTZ_FINAL_STATUSES.has(mappedStatus)) {
                continue;
              }
            } catch {
              // swallow and fall back to invoice polling
            }
          }

          const args =
            PAYMENT_PROVIDER === "blink"
              ? { url: BLINK_GRAPHQL_URL, apiKey: BLINK_API_KEY, paymentHash: o.paymentHash }
              : PAYMENT_PROVIDER === "btcpay"
                ? { url: BTCPAY_URL, apiKey: BTCPAY_API_KEY, paymentHash: o.paymentHash, walletId: { storeId: BTCPAY_STORE_ID } }
              : { paymentHash: o.paymentHash };

          const st = await invoiceStatus(args);

          if (st === "PAID") {
            const order = Orders.markPaidByHash(o.paymentHash);
            if (order?.__justPaid && order?.items?.length) {
              for (const it of order.items) Products.consumeStock(it.productId, it.qty || 1);
            }
            notifyPaidOnce(order);
            try { await dmOrderUpdate(order, "PAID"); } catch {}
            try { await sendOrderStatusEmail(order, "PAID"); } catch {}
          } else if (st === "EXPIRED") {
            Orders.remove(o.id); // cancel immediately on expiry
          }
        } catch (e) {
          // swallow individual errors to keep the sweeper running
        }
      }
    } catch (e) {
      console.warn("[sweeper] error:", e?.message || e);
    }
  }

  // Run every 60s; first run shortly after boot
  setInterval(sweepPendingInvoices, 60 * 1000);
  setTimeout(() => { sweepPendingInvoices(); }, 5000);
})();

// ---------------------------------------------------------------------
// Optional webhook receiver (disabled by default); add ntfy here too
// NOTE: currently Blink-only. Keep guarded by ENABLE_WEBHOOKS.
// ---------------------------------------------------------------------
if (ENABLE_WEBHOOKS) {
  app.post("/api/webhooks/blink", async (req, res) => {
    try {
      if (!SVIX_SECRET) {
        console.warn("[webhook] SVIX_SECRET missing; rejecting request");
        return res.status(503).json({ error: "Webhook secret not configured" });
      }

      const rawBody = req.rawBody;
      if (!rawBody) {
        console.warn("[webhook] Missing raw body for signature verification");
        return res.status(400).json({ error: "Missing raw body" });
      }

      let evt;
      try {
        evt = verifySvixSignature({
          secret: SVIX_SECRET,
          payload: rawBody,
          headers: req.headers
        });
      } catch (err) {
        console.warn("[webhook] Invalid Svix signature:", err?.message || err);
        return res.status(400).json({ error: "Invalid signature" });
      }

      if (evt?.eventType === "receive.lightning") {
        const hash = evt?.transaction?.initiationVia?.paymentHash;
        if (hash) {
          const order = Orders.markPaidByHash(hash);
          if (order?.__justPaid && order?.items?.length) {
            for (const it of order.items) Products.consumeStock(it.productId, it.qty || 1);
          }
          notifyPaidOnce(order); // << ntfy
          try { await dmOrderUpdate(order, "PAID"); } catch {}
          try { await sendOrderStatusEmail(order, "PAID"); } catch {}
        }
      }
    } catch (e) {
      console.error("Webhook error:", e);
    }
    res.status(204).end();
  });
}

export { app, server };
export default app;
