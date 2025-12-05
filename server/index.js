import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import WebSocket from "ws";
import { createProxyMiddleware } from "http-proxy-middleware";
import { spawn } from "child_process";
import crypto from "crypto";
import sharp from "sharp";
import { verifyEvent, finalizeEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";

import { makeCors, sessions, logger, requireAdmin } from "./middleware.js";
import { Products, Orders, Settings, ProductImages, ProductNostrPosts, NostrCarts, DEFAULT_TEASER_HASHTAGS } from "./db.js";
import { isEurope } from "./countries.js";
import { makeId, now } from "./utils.js";

// ⬇️ Provider-agnostic payment API (Blink or LND)
import {
  ensureBtcWalletId,
  createInvoiceSats,
  createOnchainSwapViaBoltz,
  createOnchainPaymentForOrder,
  invoiceStatus,
  subscribeInvoiceStatus,
  subscribeBoltzSwapStatus,
  boltzSwapStatus,
  getOnchainStatus,
  startPaymentWatcher,
  PAYMENT_PROVIDER,
  ONCHAIN_PROVIDER,
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
  publishStall,
  fetchStallAndProducts,
  publishProduct,
  buildCoordinates,
  KIND_PRODUCT
} from "./nostr.js";

import { sendOrderStatusEmail, label as statusLabel } from "./email.js";
import { verifySvixSignature } from "./svix.js";

const app = express();
// Disable ETag generation to avoid 304s on status endpoints (we rely on fresh payloads)
app.set("etag", false);
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

// LNURL env (when PAYMENT_PROVIDER === "lnurl")
const LNURL_LIGHTNING_ADDRESS = process.env.LNURL_LIGHTNING_ADDRESS || process.env.BLITZ_LIGHTNING_ADDRESS || "";
const LNURL_BECH32 = process.env.LNURL_BECH32 || process.env.BLITZ_LNURL || "";
const LNURL_PAY_URL = process.env.LNURL_PAY_URL || "";

// NWC (Nostr Wallet Connect) env
const NWC_URL = process.env.NWC_URL || process.env.NWC_WALLET_CONNECT_URL || "";
const NWC_RELAYS = (() => {
  const raw = process.env.NWC_RELAYS_CSV || process.env.NWC_RELAYS || "";
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
})();

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
const PLEBEIAN_PUSH_URL = process.env.PLEBEIAN_PUSH_URL || "https://plebeian.market/api/v1/products";
const PLEBEIAN_AUTH_TOKEN = process.env.PLEBEIAN_AUTH_TOKEN || process.env.PLEBEIAN_API_TOKEN || "";

// A small in-memory guard to avoid duplicate notifies for the same payment
const notifiedHashes = new Set();
const notifiedCommentIds = new Set();

async function downloadImageAsDataUrl(url) {
  const src = String(url || "").trim();
  if (!src) return "";
  try {
    const rsp = await fetch(src);
    if (!rsp.ok) {
      console.warn("[nostr-import] image fetch failed", { url: src, status: rsp.status });
      return "";
    }
    const buf = Buffer.from(await rsp.arrayBuffer());
    const mime = rsp.headers.get("content-type") || "image/jpeg";
    const b64 = buf.toString("base64");
    return `data:${mime};base64,${b64}`;
  } catch (e) {
    console.warn("[nostr-import] image fetch error", { url: src, error: e?.message || e });
    return "";
  }
}

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
if (PAYMENT_PROVIDER === "lnurl" && !(LNURL_LIGHTNING_ADDRESS || LNURL_BECH32 || LNURL_PAY_URL)) {
  console.warn("[WARN] LNURL config missing. Set LNURL_LIGHTNING_ADDRESS or LNURL_BECH32 or LNURL_PAY_URL in server/.env.");
}
if (PAYMENT_PROVIDER === "nwc" && !NWC_URL) {
  console.warn("[WARN] NWC_URL is empty. Set it in server/.env (nostr+walletconnect://...).");
}
if ((PAYMENT_PROVIDER === "btcpay" || ONCHAIN_PROVIDER === "btcpay") && (!BTCPAY_API_KEY || !BTCPAY_URL || !BTCPAY_STORE_ID)) {
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
  try { Orders.prunePendingOlderThan(24 * 60 * 60 * 1000, 14 * 24 * 60 * 60 * 1000); } catch {}
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

function parseDataUrl(raw) {
  const value = String(raw || "").trim();
  const match = /^data:([^;]+);base64,(.+)$/i.exec(value);
  if (!match) return null;
  try {
    const mime = match[1] || "image/png";
    const buf = Buffer.from(match[2], "base64");
    return { mime, buffer: buf };
  } catch {
    return null;
  }
}

function normalizeStallImage(req, raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.startsWith("data:")) {
    // Serve the data URL via public endpoint to avoid embedding base64 in Nostr
    return ensureAbsoluteFromReq(req, "/api/public/stall-logo");
  }
  const abs = sanitizeExternalUrl(value) || ensureAbsoluteFromReq(req, value);
  return ensureImageUrlWithExt(abs, "png");
}

function buildStallPublishArgs(req, settings, relays, geo = "") {
  const dTag = settings.nostrStallDTag || (settings.storeName ? String(settings.storeName).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "main" : "main");
  const name = settings.storeName || "Lightning Shop";
  const description = settings.aboutBody || "";
  const currency = (settings.nostrCurrency || "SATS").toUpperCase();
  const rawImage = settings.nostrStallImage || settings.logo || settings.logoLight || settings.logoDark || "";
  const image = normalizeStallImage(req, rawImage);
  const shipping = [{
    id: "pickup",
    name: "Local Pickup",
    cost: "0",
    regions: [],
    countries: []
  }];
  return { dTag, name, description, currency, shipping, image, geo, relays };
}

function buildNostrHttpAuthHeader({ path, method = "PUT" } = {}) {
  const keys = getShopKeys();
  if (!keys) {
    console.warn("[plebeian] http-auth skipped: no server keys");
    return null;
  }
  const uTag = String(path || "").trim();
  if (!uTag) return null;
  try {
    const authEvent = finalizeEvent(
      {
        kind: 27235, // KindHttpAuth
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["u", uTag],
          ["method", String(method || "PUT").toUpperCase()]
        ],
        content: ""
      },
      keys.seckeyBytes
    );
    const token = `Nostr ${Buffer.from(JSON.stringify(authEvent)).toString("base64")}`;
    return { Authorization: token };
  } catch (err) {
    console.warn("[plebeian] http-auth build failed", { error: err?.message || err });
    return null;
  }
}

async function pushEventsToPlebeian(events = []) {
  const url = String(PLEBEIAN_PUSH_URL || "").trim();
  if (!url) return { skipped: true, reason: "PLEBEIAN_PUSH_URL missing" };
  console.info("[plebeian] push start", { url, count: Array.isArray(events) ? events.length : 0 });

  const firstEvent = Array.isArray(events) && events.length === 1 ? events[0] : null;
  const base = url.replace(/\/+$/, "");
  const authHeader = PLEBEIAN_AUTH_TOKEN ? { Authorization: `Bearer ${PLEBEIAN_AUTH_TOKEN}` } : {};

  function eventCoordinates(ev) {
    try {
      const kind = Number(ev?.kind || 0);
      const pubkey = String(ev?.pubkey || "").trim();
      if (!kind || !pubkey) return "";
      const d = Array.isArray(ev?.tags) ? ev.tags.find((t) => Array.isArray(t) && t[0] === "d" && t[1]) : null;
      const dTag = d ? String(d[1]) : "";
      if (!dTag) return "";
      return `${kind}:${pubkey}:${dTag}`;
    } catch {
      return "";
    }
  }

  // If single product event, try PUT for updates when it already exists.
  if (firstEvent && Number(firstEvent.kind) === 30018) {
    const coord = eventCoordinates(firstEvent);
    if (coord) {
      const existsUrl = `${base}/${encodeURIComponent(coord)}?exists`;
      try {
        const existsResp = await fetch(existsUrl, { method: "GET", headers: { ...authHeader } });
        const existsText = await existsResp.text();
        let existsJson = {};
        try { existsJson = JSON.parse(existsText); } catch {}
        const exists = existsJson?.exists === true;
        console.info("[plebeian] exists check", { url: existsUrl, status: existsResp.status, exists });
        if (exists) {
          const urlObj = new URL(base);
          const pathForAuth = `${urlObj.pathname.replace(/\/+$/, "")}/${coord}`;
          const nostrAuth = buildNostrHttpAuthHeader({ path: pathForAuth, method: "PUT" });
          if (!nostrAuth) {
            console.warn("[plebeian] PUT skipped: cannot build Nostr Authorization header");
            return { ok: false, status: 0, error: "Missing Nostr auth header", method: "PUT" };
          }
          try {
            const putResp = await fetch(`${base}/${encodeURIComponent(coord)}`, {
              method: "PUT",
              headers: { "content-type": "application/json", ...nostrAuth },
              body: JSON.stringify(firstEvent)
            });
            const bodyText = await putResp.text();
            const limited = bodyText.length > 2000 ? `${bodyText.slice(0, 2000)}…` : bodyText;
            const result = { ok: putResp.ok, status: putResp.status, body: limited, method: "PUT" };
            console.info("[plebeian] push result", result);
            return result;
          } catch (err) {
            const result = { ok: false, status: 0, error: err?.message || String(err), method: "PUT" };
            console.warn("[plebeian] push failed", result);
            return result;
          }
        }
      } catch (err) {
        console.warn("[plebeian] exists check failed", { error: err?.message || err });
      }
    }
  }

  try {
    const rsp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader },
      body: JSON.stringify(events)
    });
    const text = await rsp.text();
    const limited = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
    const result = { ok: rsp.ok, status: rsp.status, body: limited };
    console.info("[plebeian] push result", result);
    return result;
  } catch (err) {
    const result = { ok: false, status: 0, error: err?.message || String(err) };
    console.warn("[plebeian] push failed", result);
    return result;
  }
}

function plebeianProductUrl(coord) {
  const base = new URL(PLEBEIAN_PUSH_URL);
  const path = base.pathname.replace(/\/+$/, "").replace(/\/products\/?$/i, "/products") || "/api/v1/products";
  return `${base.origin}${path}/${encodeURIComponent(coord)}`;
}

function plebeianStallUrl(coord) {
  const base = new URL(PLEBEIAN_PUSH_URL);
  const path = base.pathname
    .replace(/\/+$/, "")
    .replace(/\/products\/?$/i, "/stalls")
    .replace(/\/stalls\/?$/i, "/stalls") || "/api/v1/stalls";
  return `${base.origin}${path}/${encodeURIComponent(coord)}`;
}

async function ensureStallLinkedOnStartup() {
  if (TEST_MODE) return;
  try {
    const settings = Settings.getAll();
    if (settings.nostrStallCoordinates || settings.nostrStallLastEventId) return;
    const pubkeyHex = getShopPubkey();
    if (!pubkeyHex) return;
    const stallDTag = settings.nostrStallDTag || "main";
    const relays = nostrRelays();
    if (!relays.length) return;
    console.info("[nostr-startup] attempting stall link from relays", { pubkeyHex, stallDTag, relays });
    const catalog = await fetchStallAndProducts({ pubkeyHex, relays, stallDTag });
    const coordsObj = catalog?.stall?.coordinates || {};
    const coordinates = coordsObj.coordinates || catalog?.stall?.coordinates || "";
    const event = catalog?.stall?.event;
    if (coordinates && event?.id) {
      Settings.recordStallPublish({
        coordinates,
        eventId: event.id,
        publishedAt: (event.created_at || Math.floor(Date.now() / 1000)) * 1000,
        relayResults: catalog?.relays || relays
      });
      console.info("[nostr-startup] stall linked", { coordinates, eventId: event.id });
    } else {
      console.info("[nostr-startup] no stall found on relays");
    }
  } catch (err) {
    console.warn("[nostr-startup] failed to link stall", { error: err?.message || err });
  }
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
    lastNaddr: row?.lastNaddr || "",
    coordinates: row?.coordinates || "",
    dTag: row?.dTag || "",
    lastEventId: row?.lastEventId || "",
    lastPublishedAt: row?.lastPublishedAt || 0,
    lastContentHash: row?.lastContentHash || "",
    lastAck: Array.isArray(row?.lastAck) ? row.lastAck : []
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

// ────────────────────────────────────────────────────────────────────
// NOSTR: Stall publishing (kind 30017)
// ────────────────────────────────────────────────────────────────────
app.post("/api/admin/nostr/stall/publish", requireAdmin, async (req, res) => {
  try {
    const settings = Settings.getAll();
    const fallbackRelays = nostrRelays();
    const body = req.body || {};
    const relaysOverride = Array.isArray(body.relays) ? parseRelaysInput(body.relays) : null;
    const relays = (relaysOverride && relaysOverride.length) ? relaysOverride : fallbackRelays;
    const geo = typeof body.geo === "string" ? body.geo.trim() : "";
    if (!relays.length) {
      return res.status(400).json({ error: "No relays configured" });
    }

    const publishResult = await publishStall(buildStallPublishArgs(req, settings, relays, geo));

    Settings.recordStallPublish({
      coordinates: publishResult.coordinates,
      eventId: publishResult.event.id,
      publishedAt: publishResult.createdAt * 1000,
      relayResults: publishResult.relayResults
    });

    res.json({
      ok: true,
      eventId: publishResult.event.id,
      kind: publishResult.event.kind,
      coordinates: publishResult.coordinates,
      relays: publishResult.relays,
      relayResults: publishResult.relayResults,
      event: publishResult.event
    });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// NOSTR: Product publishing (kind 30018)
app.post("/api/admin/products/:id/nostr/publish", requireAdmin, async (req, res) => {
  try {
    const product = Products.get(req.params.id, { includeImages: false });
    if (!product) return res.status(404).json({ error: "Not found" });
    const settings = Settings.getAll();
    const nostrMeta = ProductNostrPosts.get(product.id) || {};
    const body = req.body || {};
    const relaysOverride = Array.isArray(body.relays) ? parseRelaysInput(body.relays) : null;
    const relays = (relaysOverride && relaysOverride.length) ? relaysOverride : nostrRelays();
    const force = !!body.force;
    if (!relays.length) {
      return res.status(400).json({ error: "No relays configured" });
    }

    // Build a default image URL for Nostr payload (mirrors public catalog)
    const count = Math.max(0, Number(product.imageCount || 0));
    const idx = Number.isInteger(product.mainImageIndex) ? product.mainImageIndex : 0;
    const safeIdx = Math.min(Math.max(0, idx | 0), Math.max(0, count - 1));
    const imageUrls = [];
    for (let i = 0; i < count; i += 1) {
      const vtag = makeImageVersionQuery(product.imageVersion, i);
      imageUrls.push(ensureAbsoluteFromReq(req, `/api/products/${product.id}/image/${i}.jpg${vtag}`));
    }
    const versionTag = makeImageVersionQuery(product.imageVersion, safeIdx);
    const defaultImageUrl = imageUrls[safeIdx] || (count ? ensureAbsoluteFromReq(req, `/api/products/${product.id}/image/${safeIdx}.jpg${versionTag}`) : "");

    const publishResult = await publishProduct({
      product,
      settings,
      nostrMeta,
      relays,
      force,
      fallbackImages: imageUrls.length ? imageUrls : (defaultImageUrl ? [defaultImageUrl] : [])
    });
    const collision = ProductNostrPosts.findByCoordinates(publishResult.coordinates);
    if (collision && collision.productId !== product.id) {
      return res.status(409).json({
        error: `Coordinates already used by product ${collision.productId}`,
        coordinates: publishResult.coordinates,
        productId: collision.productId
      });
    }

    if (publishResult.skipped) {
      return res.json({
        ok: true,
        skipped: true,
        reason: publishResult.reason || "unchanged",
        coordinates: publishResult.coordinates,
        contentHash: publishResult.contentHash
      });
    }

    ProductNostrPosts.recordPublish(product.id, {
      dTag: publishResult.dTag,
      title: product.title,
      summary: product.description || "",
      content: publishResult.event?.content || "",
      imageUrl: nostrMeta.imageUrl || "",
      topics: nostrMeta.topics || [],
      relays: publishResult.relays,
      mode: "live",
      listingStatus: product.available ? "available" : "sold",
      lastEventId: publishResult.event.id,
      lastKind: publishResult.event.kind,
      lastPublishedAt: publishResult.createdAt * 1000,
      lastAck: publishResult.relayResults,
      lastNaddr: "",
      coordinates: publishResult.coordinates,
      kind: publishResult.event.kind,
      rawContent: publishResult.event.content || "",
      lastContentHash: publishResult.contentHash
    });
    const nostrRow = ProductNostrPosts.get(product.id);

    let plebeianPush = null;
    try {
      plebeianPush = await pushEventsToPlebeian([publishResult.event]);
    } catch (err) {
      plebeianPush = { ok: false, error: err?.message || String(err) };
    }

    res.json({
      ok: true,
      eventId: publishResult.event.id,
      kind: publishResult.event.kind,
      coordinates: publishResult.coordinates,
      relays: publishResult.relays,
      relayResults: publishResult.relayResults,
      event: publishResult.event,
      nostr: nostrRow,
      plebeianPush
    });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// NOSTR: Refresh all products (republish if changed)
app.post("/api/admin/nostr/products/refresh", requireAdmin, async (req, res) => {
  try {
    const settings = Settings.getAll();
    const relays = nostrRelays();
    if (!relays.length) {
      return res.status(400).json({ error: "No relays configured" });
    }
    const shopPubkey = getShopPubkey();
    if (!shopPubkey) {
      return res.status(400).json({ error: "Missing SHOP_NOSTR_NSEC / server pubkey" });
    }

    const products = Products.all({ includeImages: false }) || [];
    const filters = [];
    const mapByDTag = new Map();
    for (const product of products) {
      const nostrMeta = ProductNostrPosts.get(product.id) || {};
      const dTag = nostrMeta?.dTag || `product:${product.id}`;
      mapByDTag.set(dTag, {
        product,
        nostrMeta
      });
      filters.push({
        kinds: [KIND_PRODUCT],
        authors: [shopPubkey],
        "#d": [dTag],
        limit: 1
      });
    }

    const pool = new SimplePool({ enableReconnect: false });
    const latest = new Map(); // dTag -> { created_at, id }
    try {
      let events = [];
      const batchSize = 20;
      const batches = [];
      for (let i = 0; i < filters.length; i += batchSize) {
        batches.push(filters.slice(i, i + batchSize));
      }

      for (const batch of batches) {
        let batchEvents = [];
        if (typeof pool.querySync === "function") {
          const results = await Promise.all(
            batch.map((f) => pool.querySync(relays, f).catch(() => []))
          );
          batchEvents = results.flat();
        } else if (typeof pool.list === "function") {
          batchEvents = await pool.list(relays, batch);
        } else {
          throw new Error("SimplePool does not support list/querySync");
        }
        events = events.concat(batchEvents || []);
      }

      for (const ev of events || []) {
        const dTag = Array.isArray(ev.tags) ? (ev.tags.find((t) => t[0] === "d")?.[1] || "") : "";
        if (!dTag) continue;
        const prev = latest.get(dTag);
        if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) {
          latest.set(dTag, { created_at: ev.created_at, id: ev.id });
        }
      }
    } finally {
      try { pool.close(relays); } catch {}
    }

    const results = [];
    for (const [dTag, ctx] of mapByDTag.entries()) {
      const { product, nostrMeta } = ctx;
      const remote = latest.get(dTag);
      const localTs = Number(nostrMeta?.lastPublishedAt || 0);
      const remoteMs = remote?.created_at ? remote.created_at * 1000 : 0;
      const hasNewer = remoteMs && remoteMs > localTs;
      results.push({
        productId: product.id,
        dTag,
        lastPublishedAt: localTs,
        remoteCreatedAt: remoteMs,
        remoteEventId: remote?.id || "",
        remoteIsNewer: hasNewer
      });
    }

    res.json({ ok: true, relays, results });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// Import stall + products from Nostr into local DB
app.post("/api/admin/nostr/import", requireAdmin, async (req, res) => {
  try {
    const settings = Settings.getAll();
    const body = req.body || {};

    const pubkeyHex = getShopPubkey();
    if (!pubkeyHex) {
      return res.status(400).json({ error: "Missing SHOP_NOSTR_NSEC / server pubkey" });
    }

    console.info("[nostr-import] start", { pubkeyHex });

    const stallDTag = String(body.stallDTag || settings.nostrStallDTag || "main").trim() || "main";
    const relaysOverride = Array.isArray(body.relays) ? parseRelaysInput(body.relays) : null;
    const relays = (relaysOverride && relaysOverride.length) ? relaysOverride : nostrRelays();
    if (!relays.length) {
      return res.status(400).json({ error: "No relays configured" });
    }

    console.info("[nostr-import] resolved", {
      pubkeyHex,
      stallDTag,
      relays
    });

    const catalog = await fetchStallAndProducts({
      pubkeyHex,
      relays,
      stallDTag
    });

    const updatedSettings = [];
    function normalizeStallContent(content) {
      if (!content || typeof content !== "object") return null;
      const name = String(content.name || "").trim();
      const description = typeof content.description === "string" ? content.description : "";
      const currency = String(content.currency || settings.nostrCurrency || "SATS").toUpperCase();
      if (!name) return null;
      return { name, description, currency };
    }

    if (catalog.stall) {
      const stall = catalog.stall;
      const c = normalizeStallContent(stall.content || {});
      if (!c) {
        console.warn("[nostr-import] stall content invalid, skipping settings update", { eventId: stall.event.id });
      } else {
        const coords = stall.coordinates || {};
        const nextStoreName = c.name || settings.storeName;
        const nextAboutBody = c.description || settings.aboutBody || "";
        const nextCurrency = c.currency || settings.nostrCurrency || "SATS";
        Settings.setAll({
          storeName: nextStoreName,
          aboutBody: nextAboutBody,
          nostrCurrency: nextCurrency,
          nostrStallDTag: coords.tagD || stallDTag
      });
      Settings.recordStallPublish({
        coordinates: coords.coordinates || "",
        eventId: stall.event.id,
        publishedAt: (stall.event.created_at || Math.floor(Date.now() / 1000)) * 1000,
        relayResults: []
      });
      updatedSettings.push("stall");
      console.info("[nostr-import] stall imported", {
        storeName: nextStoreName,
        nostrCurrency: nextCurrency,
        nostrStallDTag: coords.tagD || stallDTag
      });
      }
    }

    const createdProducts = [];
    const updatedProducts = [];
    function normalizeImportedProductContent(raw, coords) {
      try {
        const name = String(raw?.name || coords?.tagD || raw?.id || "").trim();
        if (!name) return null;
        const description = typeof raw?.description === "string" ? raw.description : "";
        const price = Math.max(0, Math.floor(Number(raw?.price || 0)));
        const qtyRaw = raw?.quantity;
        const quantity = Number.isFinite(Number(qtyRaw)) ? Math.max(0, Math.floor(Number(qtyRaw))) : undefined;
        const isUnique = quantity === 1;
        const images = Array.isArray(raw?.images) ? raw.images.map((u) => String(u || "").trim()).filter(Boolean) : [];
        const gallery = Array.isArray(raw?.gallery) ? raw.gallery.map((u) => String(u || "").trim()).filter(Boolean) : images;
        const specs = Array.isArray(raw?.specs)
          ? raw.specs
              .filter((pair) => Array.isArray(pair) && pair.length >= 2)
              .map(([k, v]) => [String(k || "").slice(0, 64), String(v || "").slice(0, 256)])
              .filter((pair) => pair[0] && pair[1])
              .slice(0, 12)
          : [];
        return { name, description, price, quantity, isUnique, images: gallery, specs };
      } catch {
        return null;
      }
    }

    for (const p of catalog.products || []) {
      const coords = p.coordinates || {};
      const norm = normalizeImportedProductContent(p.content || {}, coords);
      if (!norm) {
        console.warn("[nostr-import] skipping product: invalid content", { eventId: p.event.id });
        continue;
      }
      const { name, description, price, quantity, isUnique, images: rawImages } = norm;
      const images = [];
      for (const url of rawImages) {
        const dataUrl = await downloadImageAsDataUrl(url);
        if (dataUrl) images.push(dataUrl);
      }

      const incomingMs = Math.max(0, (p.event.created_at || 0) * 1000);

      const existingByCoords = ProductNostrPosts.findByCoordinates(coords.coordinates || "");
      if (existingByCoords) {
        console.info("[nostr-import] skipping existing product", { coordinates: coords.coordinates });
        continue;
      }

      console.info("[nostr-import] creating product", {
        sourceId: p.event.id,
        coordinates: coords.coordinates,
        title: name,
        priceSats: price,
        quantityAvailable: quantity,
        imageUrls: rawImages,
        imagesStored: images.length
      });

      const product = Products.create({
        title: name,
        subtitle: "",
        description,
        longDescription: description,
        priceSats: price,
        images,
        mainImageIndex: 0,
        widthCm: null,
        heightCm: null,
        depthCm: null,
        showDimensions: false,
        shippingZoneOverrides: [],
        isUnique,
        quantityAvailable: quantity
      });

      ProductNostrPosts.recordPublish(product.id, {
        dTag: coords.tagD,
        title: name,
        summary: description,
        content: JSON.stringify(p.content || {}),
        imageUrl: rawImages[0] || "",
        topics: [],
        relays: catalog.relays || relays,
        mode: "live",
        listingStatus: quantity === 0 ? "sold" : "available",
        lastEventId: p.event.id,
        lastKind: p.event.kind,
        lastPublishedAt: incomingMs || (p.event.created_at || Math.floor(Date.now() / 1000)) * 1000,
        lastAck: [],
        lastNaddr: "",
        coordinates: coords.coordinates || "",
        kind: p.event.kind,
        rawContent: p.event.content || ""
      });

      createdProducts.push({
        id: product.id,
        title: product.title,
        sourceEventId: p.event.id,
        sourceCoordinates: coords.coordinates || "",
        imageCount: images.length
      });
    }

    console.info("[nostr-import] completed", {
      pubkey: catalog.pubkey,
      relays: catalog.relays,
      stallImported: updatedSettings.includes("stall"),
      productsImported: createdProducts.length
    });

    res.json({
      ok: true,
      pubkey: catalog.pubkey,
      relays: catalog.relays,
      stallImported: updatedSettings.includes("stall"),
      productsImported: createdProducts.length,
      products: createdProducts,
      productsUpdated: updatedProducts
    });
  } catch (e) {
    console.error("[nostr-import] failed", e?.message || e);
    res.status(400).json({ error: String(e?.message || e) });
  }
});

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
// Expose the stall logo when stored as a data URL (for Nostr publishing)
app.get("/api/public/stall-logo", (req, res) => {
  try {
    const settings = Settings.getAll();
    const rawImage = settings.nostrStallImage || settings.logo || settings.logoLight || settings.logoDark || "";
    const parsed = parseDataUrl(rawImage);
    if (!parsed || !parsed.buffer?.length) {
      return res.status(404).end();
    }
    res.set("Content-Type", parsed.mime || "image/png");
    res.set("Cache-Control", "public, max-age=86400, immutable");
    res.send(parsed.buffer);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});
app.get("/api/payments/config", (req, res) => {
  res.json({
    provider: PAYMENT_PROVIDER,
    lightningProvider: PAYMENT_PROVIDER,
    onchainProvider: ONCHAIN_PROVIDER,
    onchainEnabled: ONCHAIN_ENABLED,
    onchainMinSats: ONCHAIN_MIN_SATS,
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
  const shopPubkey = getShopPubkey();
  const nostrRow = ProductNostrPosts.get(p.id);
  const dTag = nostrRow?.dTag || `product:${p.id}`;
  const coordinates = (shopPubkey && dTag) ? buildCoordinates(KIND_PRODUCT, shopPubkey, dTag) : "";
  res.json({ ...p, imageUrls, thumbUrls, absImageUrls, absThumbUrls, nostr: { coordinates } });
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
    const all = Products.all({ includeImages: true }) || [];
    const withNostr = all.map((p) => {
      const nostrRow = ProductNostrPosts.get(p.id);
      return { ...p, nostr: nostrRow ? {
        dTag: nostrRow.dTag || "",
        coordinates: nostrRow.coordinates || "",
        lastEventId: nostrRow.lastEventId || "",
        lastPublishedAt: nostrRow.lastPublishedAt || 0,
        lastContentHash: nostrRow.lastContentHash || "",
        lastAck: Array.isArray(nostrRow.lastAck) ? nostrRow.lastAck : [],
        teaserLastEventId: nostrRow.teaserLastEventId || "",
        teaserLastPublishedAt: nostrRow.teaserLastPublishedAt || 0
      } : null };
    });
    return res.json(withNostr);
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
    const nostrRow = ProductNostrPosts.get(p.id);
    const nostr = nostrRow
      ? {
          dTag: nostrRow.dTag || "",
          coordinates: nostrRow.coordinates || "",
          lastEventId: nostrRow.lastEventId || "",
          lastPublishedAt: nostrRow.lastPublishedAt || 0,
          lastContentHash: nostrRow.lastContentHash || "",
          lastAck: Array.isArray(nostrRow.lastAck) ? nostrRow.lastAck : [],
          teaserLastEventId: nostrRow.teaserLastEventId || "",
          teaserLastPublishedAt: nostrRow.teaserLastPublishedAt || 0
        }
      : null;
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
      showDimensions: p.showDimensions,
      shippingZoneOverrides: Array.isArray(p.shippingZoneOverrides) ? p.shippingZoneOverrides : [],
      nostr
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
    const dTag = config?.dTag || `product:${product.id}`;
    const shopPubkey = getShopPubkey();
    const coordinates = config?.coordinates || (shopPubkey ? buildCoordinates(KIND_PRODUCT, shopPubkey, dTag) : "");
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
      productUrl,
      coordinates
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

function normalizeHexPrivateKey(maybeKey) {
  if (!maybeKey) return "";
  if (Buffer.isBuffer(maybeKey)) {
    return maybeKey.toString("hex");
  }
  const s = String(maybeKey || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s;
  if (s.includes(",")) {
    const bytes = s
      .split(",")
      .map((n) => Number(n.trim()) & 0xff)
      .filter((n) => Number.isFinite(n));
    if (bytes.length) {
      return Buffer.from(bytes).toString("hex");
    }
  }
  return s;
}

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
    shippingZoneOverrides,
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
    showDimensions: showDimensions !== undefined ? !!showDimensions : true,
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
    shipping = 0;
  }
    const total = subtotal + shipping;
    if (paymentMethod === "onchain" && ONCHAIN_MIN_SATS > 0 && total < ONCHAIN_MIN_SATS) {
      return res.status(400).json({ error: `Minimum on-chain amount is ${ONCHAIN_MIN_SATS} sats` });
    }

    // Provider-specific wallet resolution (Lightning side)
    const walletId = await (async () => {
      // On-chain via BTCPay does not need a lightning walletId
      if (paymentMethod === "onchain" && ONCHAIN_PROVIDER === "btcpay") {
        return { storeId: BTCPAY_STORE_ID || undefined };
      }
      if (paymentMethod === "onchain" && ONCHAIN_PROVIDER === "xpub") {
        return null;
      }
      return ensureBtcWalletId(
        PAYMENT_PROVIDER === "blink"
          ? {
              url: BLINK_GRAPHQL_URL,
              apiKey: BLINK_API_KEY,
              explicitWalletId: BLINK_BTC_WALLET_ID || undefined
            }
          : PAYMENT_PROVIDER === "lnurl"
            ? {}
          : PAYMENT_PROVIDER === "nwc"
            ? {
                url: NWC_URL,
                relayUrls: NWC_RELAYS
              }
          : PAYMENT_PROVIDER === "btcpay"
            ? {
                url: BTCPAY_URL,
                apiKey: BTCPAY_API_KEY,
                explicitStoreId: BTCPAY_STORE_ID || undefined
              }
            : {}
      );
    })();

    // Memo: "Order <store name> <product name>"
    const { storeName } = Settings.getAll();
    const firstTitle = loaded[0]?.title || "";
    const memo = `Order ${storeName || "Lightning Shop"} ${firstTitle}`.trim();
    const orderRef = memo;

    // If signed-in with Nostr, bind orders to nostr:<hex> so they persist across devices
    const clientId =
      (req.session?.nostrPubkey ? `nostr:${req.session.nostrPubkey}` : "") ||
      (req.session?.cid || "");

    const baseOrderPayload = {
      clientId,
      items: loaded,
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
      paymentMethod,
      lnurlVerifyUrl: "",
      lnurlExpiresAt: 0,
      notes: sanitizedCustomer.notes || ""
    };

    let inv;
    let created;

    if (paymentMethod === "onchain" && ONCHAIN_PROVIDER !== "boltz") {
      const pre = Orders.create({
        ...baseOrderPayload,
        paymentHash: null,
        paymentRequest: null,
        onchainProvider: ONCHAIN_PROVIDER,
        onchainAmountSats: total,
        onchainId: "",
        onchainStatus: "UNPAID"
      });
      try {
        inv = await createOnchainPaymentForOrder({
          order: pre,
          amountSats: total,
          memo,
          expiresIn: ONCHAIN_INVOICE_EXPIRES_IN,
          url: ONCHAIN_PROVIDER === "btcpay" ? BTCPAY_URL : undefined,
          apiKey: ONCHAIN_PROVIDER === "btcpay" ? BTCPAY_API_KEY : undefined,
          walletId
        });
        const attachPayload = {
          provider: ONCHAIN_PROVIDER,
          onchainId: inv.onchainId || pre.id,
          address: inv.onchainAddress || "",
          amountSats: inv.onchainAmountSats ?? total,
          bip21: inv.onchainBip21 || inv.bip21 || "",
          onchainStatus: "UNPAID",
          onchainExpiresAt: inv.onchainExpiresAt || ""
        };
        if (inv.xpubIndex !== undefined) {
          attachPayload.xpubIndex = inv.xpubIndex;
        }
        Orders.attachOnchainPayment(pre.id, attachPayload);
        if (inv?.paymentHash || inv?.paymentRequest) {
          Orders.setPaymentInfo(pre.id, {
            paymentHash: inv.paymentHash,
            paymentRequest: inv.paymentRequest
          });
        }
        created = Orders.get(pre.id);
      } catch (e) {
        Orders.remove(pre.id);
        throw e;
      }
    } else {
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
            : PAYMENT_PROVIDER === "lnurl"
              ? {
                  amount: total,
                  memo,
                  webhookUrl: BOLTZ_WEBHOOK_URL || undefined,
                  expiresIn: ONCHAIN_INVOICE_EXPIRES_IN
                }
            : PAYMENT_PROVIDER === "nwc"
              ? {
                  url: NWC_URL,
                  relayUrls: NWC_RELAYS,
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
            : PAYMENT_PROVIDER === "lnurl"
              ? {
                  amount: total,
                  memo
                }
            : PAYMENT_PROVIDER === "nwc"
              ? {
                  url: NWC_URL,
                  relayUrls: NWC_RELAYS,
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

      created = Orders.create({
        ...baseOrderPayload,
        paymentHash: inv.paymentHash,
        paymentRequest: inv.paymentRequest,
        boltzSwapId: inv.boltzSwapId || inv.swapId || "",
        boltzAddress: inv.onchainAddress || "",
        boltzExpectedAmountSats: inv.onchainAmountSats || 0,
        boltzTimeoutBlockHeight: inv.timeoutBlockHeight || 0,
        boltzRefundPrivKey: "",
        boltzRefundPubKey: inv.boltzRefundPubKey || "",
        boltzRedeemScript: "",
        boltzRescueIndex: inv.boltzRescueIndex ?? inv.rescueIndex ?? null,
        boltzSwapTree: "",
        boltzStatus: inv.boltzStatus || "",
        lnurlVerifyUrl: inv.verifyUrl || "",
        lnurlExpiresAt: inv.expiresAt || 0,
        onchainId: paymentMethod === "onchain" && ONCHAIN_PROVIDER !== "boltz" ? (inv.onchainId || inv.onchainSwapId || "") : "",
        onchainSwapId: paymentMethod === "onchain" && ONCHAIN_PROVIDER === "boltz" ? (inv.boltzSwapId || inv.swapId || "") : "",
        onchainProvider: paymentMethod === "onchain" ? ONCHAIN_PROVIDER : "",
        onchainAddress: inv.onchainAddress || "",
        onchainAmountSats: inv.onchainAmountSats || 0,
        onchainBip21: inv.onchainBip21 || inv.bip21 || "",
        onchainStatus: paymentMethod === "onchain" ? "UNPAID" : "",
        onchainExpiresAt: inv.onchainExpiresAt || ""
      });
    }

    const onchainIdOut = inv?.onchainId || inv?.onchainSwapId || created.onchainId || created.onchainSwapId || created.id;
    const swapIdOut = (paymentMethod === "onchain" && ONCHAIN_PROVIDER === "boltz")
      ? (inv?.boltzSwapId || inv?.swapId || created.onchainSwapId || "")
      : "";

    res.json({
      orderId: created.id,
      paymentMethod,
      paymentRequest: inv?.paymentRequest || "",
      paymentHash: inv?.paymentHash || created.paymentHash || "",
      satoshis: inv?.satoshis ?? created.totalSats ?? total,
      totalSats: total,
      swapId: swapIdOut,
      onchainId: onchainIdOut,
      onchainAddress: inv?.onchainAddress || created.onchainAddress || "",
      onchainAmountSats: inv?.onchainAmountSats ?? created.onchainAmountSats ?? 0,
      onchainBip21: inv?.onchainBip21 || inv?.bip21 || created.onchainBip21 || "",
      onchainTimeoutBlockHeight: inv?.timeoutBlockHeight || created.boltzTimeoutBlockHeight || 0,
      checkoutLink: inv?.checkoutLink || "",
      invoiceId: inv?.invoiceId || ""
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
        : PAYMENT_PROVIDER === "lnurl"
          ? {}
        : PAYMENT_PROVIDER === "nwc"
          ? {
              url: NWC_URL,
              relayUrls: NWC_RELAYS
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
        : PAYMENT_PROVIDER === "lnurl"
          ? {
              amount: sats,
              memo
            }
        : PAYMENT_PROVIDER === "nwc"
          ? {
              url: NWC_URL,
              relayUrls: NWC_RELAYS,
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

// Resolve a payment identifier into type + normalized ids
function resolvePaymentById(id) {
  if (!id) return null;
  const bySwap = Orders.bySwapId(id);
  if (bySwap) {
    const isBoltz = String(bySwap.onchainProvider || "").toLowerCase() === "boltz" || !!bySwap.boltzSwapId;
    const swapId = isBoltz ? (bySwap.boltzSwapId || bySwap.onchainSwapId || id) : (bySwap.onchainId || bySwap.onchainSwapId || id);
    return { type: "onchain", swapId, order: bySwap };
  }
  const byHash = Orders.byPaymentHash(id);
  if (byHash) return { type: "lightning", hash: byHash.paymentHash || id, order: byHash };
  const byId = Orders.get(id);
  if (!byId) return null;
  if (String(byId.paymentMethod || "").toLowerCase() === "onchain") {
    const isBoltz = String(byId.onchainProvider || "").toLowerCase() === "boltz" || !!byId.boltzSwapId;
    const swapId = isBoltz ? (byId.boltzSwapId || byId.onchainSwapId || byId.id) : (byId.onchainId || byId.onchainSwapId || byId.id);
    return { type: "onchain", swapId, order: byId };
  }
  return { type: "lightning", hash: byId.paymentHash || id, order: byId };
}

// ---------------------------------------------------------------------
// Invoice status (polling fallback) - cancels order on EXPIRED
// ---------------------------------------------------------------------
async function handleInvoiceStatus(req, res) {
  try {
    const orderForHash = Orders.byPaymentHash(req.params.hash);
    const args =
      PAYMENT_PROVIDER === "blink"
        ? { url: BLINK_GRAPHQL_URL, apiKey: BLINK_API_KEY, paymentHash: req.params.hash }
        : PAYMENT_PROVIDER === "lnurl"
          ? {
              paymentHash: req.params.hash,
              verifyUrl: orderForHash?.lnurlVerifyUrl,
              paymentRequest: orderForHash?.paymentRequest,
              expiresAt: orderForHash?.lnurlExpiresAt
            }
        : PAYMENT_PROVIDER === "nwc"
          ? { url: NWC_URL, relayUrls: NWC_RELAYS, paymentHash: req.params.hash }
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
}
app.get("/api/invoices/:hash/status", handleInvoiceStatus);

// ---------------------------------------------------------------------
// On-chain (Boltz) swap status (polling)
// ---------------------------------------------------------------------
async function handleOnchainStatus(req, res) {
  try {
    const swapId = req.params.swapId;
    const order = Orders.bySwapId(swapId) || Orders.get(swapId);
    if (!order) return res.status(404).json({ error: "Not found" });

    // Avoid client caching (304) so status updates propagate
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");

    const orderProvider = String(
      order.onchainProvider || (order.boltzSwapId ? "boltz" : ONCHAIN_PROVIDER) || ""
    ).toLowerCase();

    // If order already marked paid, short-circuit
    if (String(order.status || "").toUpperCase() === "PAID") {
      return res.json({
        status: "PAID",
        rawStatus: order.onchainStatus || order.boltzStatus || "invoice.paid",
        onchainAddress: order.onchainAddress || "",
        onchainAmountSats: order.onchainAmountSats || 0,
        timeoutBlockHeight: order.boltzTimeoutBlockHeight || 0,
        onchainTxid: order.onchainTxid || ""
      });
    }

    const statusPayload = await getOnchainStatus(order, {
      btcpayConfig: { url: BTCPAY_URL, apiKey: BTCPAY_API_KEY, storeId: BTCPAY_STORE_ID }
    });
    const mappedStatus = statusPayload?.status || "PENDING";
    const rawStatus = statusPayload?.rawStatus || mappedStatus;
    const onchainAddress = statusPayload?.onchainAddress || order.onchainAddress || order.boltzAddress || "";
    const onchainAmountSats = statusPayload?.onchainAmountSats ?? order.onchainAmountSats ?? order.boltzExpectedAmountSats ?? 0;
    const timeoutBlockHeight = statusPayload?.timeoutBlockHeight || order.boltzTimeoutBlockHeight || 0;
    const onchainTxid = statusPayload?.onchainTxid || order.onchainTxid || "";

    if (orderProvider === "boltz") {
      await handleBoltzStatusSideEffects({ swapId, mappedStatus, rawStatus });
    } else if (mappedStatus === "CONFIRMED") {
      const updated =
        Orders.markPaidBySwapId(swapId) ||
        Orders.markPaidByHash(order.paymentHash || order.id);
      if (updated?.__justPaid && updated?.items?.length) {
        for (const it of updated.items) Products.consumeStock(it.productId, it.qty || 1);
      }
      notifyPaidOnce(updated);
      try { await dmOrderUpdate(updated, "PAID"); } catch {}
      try { await sendOrderStatusEmail(updated, "PAID"); } catch {}
    } else if (mappedStatus === "EXPIRED") {
      if (order.status === "PENDING") {
        Orders.remove(order.id);
      }
    } else if (mappedStatus === "FAILED") {
      Orders.setStatus(order.id, "FAILED");
    }

    res.json({
      status: mappedStatus,
      rawStatus,
      onchainAddress,
      onchainAmountSats,
      timeoutBlockHeight,
      onchainTxid
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
}
app.get("/api/onchain/:swapId/status", handleOnchainStatus);

// ---------------------------------------------------------------------
// Unified payment status (lightning or on-chain)
// ---------------------------------------------------------------------
app.get("/api/payments/:id/status", async (req, res) => {
  const resolved = resolvePaymentById(req.params.id);
  if (!resolved) return res.status(404).json({ error: "Not found" });
  if (resolved.type === "onchain") {
    req.params.swapId = resolved.swapId;
    return handleOnchainStatus(req, res);
  }
  req.params.hash = resolved.hash;
  return handleInvoiceStatus(req, res);
});

// ---------------------------------------------------------------------
/* Provider-agnostic WS → SSE bridge for live status in-browser
   Also cancels order on EXPIRED even if UI is open.                  */
// ---------------------------------------------------------------------
async function handleInvoiceStream(req, res) {
  const paymentHash = req.params.hash;
  const orderForHash = Orders.byPaymentHash(paymentHash);

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
    verifyUrl: orderForHash?.lnurlVerifyUrl,
    paymentRequest: orderForHash?.paymentRequest,
    expiresAt: orderForHash?.lnurlExpiresAt,
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
}
app.get("/api/invoices/:hash/stream", handleInvoiceStream);

// ---------------------------------------------------------------------
// On-chain (Boltz) SSE bridge
// ---------------------------------------------------------------------
async function handleOnchainStream(req, res) {
  const swapId = req.params.swapId;
  const order = Orders.bySwapId(swapId) || Orders.get(swapId);
  if (!order) return res.status(404).json({ error: "Not found" });
  const orderProvider = String(
    order.onchainProvider || (order.boltzSwapId ? "boltz" : ONCHAIN_PROVIDER) || ""
  ).toLowerCase();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const ping = () => res.write(`: ping\n\n`);
  const hb = setInterval(ping, 20000);
  const pollMs = Number(process.env.ONCHAIN_MEMPOOL_POLL_MS || (orderProvider === "btcpay" ? 5000 : 15000));

  let closed = false;
  let unsub = null;
  let currentStatus = String(order.onchainStatus || "UNPAID").toUpperCase();
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

  const finalizePaid = async (payload, rawStatus) => {
    const updated =
      Orders.markPaidBySwapId(swapId) ||
      Orders.markPaidByHash(order.paymentHash || order.id);
    if (updated?.__justPaid && updated?.items?.length) {
      for (const it of updated.items) Products.consumeStock(it.productId, it.qty || 1);
    }
    notifyPaidOnce(updated);
    try { await dmOrderUpdate(updated, "PAID"); } catch {}
    try { await sendOrderStatusEmail(updated, "PAID"); } catch {}
    send({ ...payload, status: "PAID", rawStatus: rawStatus || payload.rawStatus || "invoice.paid" });
    closeAll();
  };

  const handleStatus = async (statusPayload) => {
    if (!statusPayload || closed) return;
    const mappedStatus = (statusPayload.status || "PENDING").toUpperCase();
    const rawStatus = statusPayload.rawStatus || mappedStatus;
    if (mappedStatus === currentStatus && mappedStatus !== "CONFIRMED" && mappedStatus !== "PAID") {
      return;
    }
    currentStatus = mappedStatus;
    const payload = {
      status: mappedStatus,
      rawStatus,
      onchainAddress: statusPayload.onchainAddress || order.onchainAddress || order.boltzAddress || "",
      onchainAmountSats: statusPayload.onchainAmountSats ?? order.onchainAmountSats ?? order.boltzExpectedAmountSats ?? 0,
      timeoutBlockHeight: statusPayload.timeoutBlockHeight || order.boltzTimeoutBlockHeight || 0
    };
    send(payload);

    if (orderProvider === "boltz") {
      await handleBoltzStatusSideEffects({ swapId, mappedStatus, rawStatus });
      const latest = Orders.bySwapId(swapId) || order;
      const alreadyPaid = String(latest.status || "").toUpperCase() === "PAID";
      if (BOLTZ_FINAL_STATUSES.has(mappedStatus) || alreadyPaid) {
        if (alreadyPaid && mappedStatus !== "PAID") {
          send({ ...payload, status: "PAID", rawStatus: rawStatus || "invoice.paid" });
        }
        closeAll();
      }
      return;
    }

    if (mappedStatus === "CONFIRMED") {
      await finalizePaid(payload, rawStatus);
      return;
    }
    if (mappedStatus === "EXPIRED") {
      const pending = Orders.bySwapId(swapId);
      if (pending && pending.status === "PENDING") {
        Orders.remove(pending.id);
      }
      closeAll();
      return;
    }
    if (mappedStatus === "FAILED") {
      Orders.setStatus(order.id, "FAILED");
      closeAll();
      return;
    }

    const latest = Orders.bySwapId(swapId) || order;
    const alreadyPaid = String(latest.status || "").toUpperCase() === "PAID";
    if (alreadyPaid) {
      if (mappedStatus !== "PAID") {
        send({ ...payload, status: "PAID", rawStatus: rawStatus || "invoice.paid" });
      }
      closeAll();
    }
  };

  try {
    const initialOrder = Orders.bySwapId(swapId);
    if (String(initialOrder?.status || "").toUpperCase() === "PAID") {
      send({
        status: "PAID",
        rawStatus: initialOrder?.onchainStatus || initialOrder?.boltzStatus || "invoice.paid",
        onchainAddress: initialOrder?.onchainAddress || initialOrder?.boltzAddress || "",
        onchainAmountSats: initialOrder?.onchainAmountSats || initialOrder?.boltzExpectedAmountSats || 0,
        timeoutBlockHeight: initialOrder?.boltzTimeoutBlockHeight || 0
      });
      return closeAll();
    }

    const prime = await getOnchainStatus(order, {
      btcpayConfig: { url: BTCPAY_URL, apiKey: BTCPAY_API_KEY, storeId: BTCPAY_STORE_ID }
    });
    if (prime) {
      await handleStatus(prime);
      if (closed) return;
    }
  } catch {
    // ignore prime failure; SSE will still start
  }

  if (orderProvider === "boltz") {
    unsub = subscribeBoltzSwapStatus({
      swapId,
      onUpdate: async ({ swap, rawStatus, mappedStatus }) => {
        const addr = swap?.lockupAddress || swap?.address || order.onchainAddress || order.boltzAddress || "";
        const amt = Math.max(
          0,
          Math.floor(Number((swap?.expectedAmount ?? swap?.expected ?? order.onchainAmountSats ?? order.boltzExpectedAmountSats ?? 0)))
        );
        const timeout = Math.max(
          0,
          Math.floor(Number((swap?.timeoutBlockHeight ?? swap?.lockupTimeoutBlock ?? order.boltzTimeoutBlockHeight ?? 0)))
        );
        await handleStatus({
          status: mappedStatus,
          rawStatus,
          onchainAddress: addr,
          onchainAmountSats: amt,
          timeoutBlockHeight: timeout
        });
      }
    });
  } else {
    unsub = setInterval(async () => {
      try {
        const latestOrder = Orders.bySwapId(swapId) || order;
        const statusPayload = await getOnchainStatus(latestOrder, {
          btcpayConfig: { url: BTCPAY_URL, apiKey: BTCPAY_API_KEY, storeId: BTCPAY_STORE_ID }
        });
        await handleStatus(statusPayload);
      } catch {
        // ignore and continue
      }
    }, pollMs);
  }

  req.on("close", () => closeAll());
}
app.get("/api/onchain/:swapId/stream", handleOnchainStream);

// ---------------------------------------------------------------------
// Unified payment stream (lightning or on-chain)
// ---------------------------------------------------------------------
app.get("/api/payments/:id/stream", async (req, res) => {
  const resolved = resolvePaymentById(req.params.id);
  if (!resolved) return res.status(404).json({ error: "Not found" });
  if (resolved.type === "onchain") {
    req.params.swapId = resolved.swapId;
    return handleOnchainStream(req, res);
  }
  req.params.hash = resolved.hash;
  return handleInvoiceStream(req, res);
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
    if (PAYMENT_PROVIDER !== "btcpay" && ONCHAIN_PROVIDER !== "btcpay") {
      return res.status(503).json({ error: "BTCPay not configured as lightning or on-chain provider" });
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
  // On startup, if stall coordinates are missing, try to fetch from relays and link them.
  ensureStallLinkedOnStartup();
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
      const pending = Array.isArray(all) ? all.filter(o => o.status === "PENDING") : [];
      for (const o of pending) {
        try {
          if (o.paymentMethod === "onchain") {
            const provider = String(
              o.onchainProvider || (o.boltzSwapId ? "boltz" : ONCHAIN_PROVIDER) || ""
            ).toLowerCase();
            try {
              const statusPayload = await getOnchainStatus(o, {
                btcpayConfig: { url: BTCPAY_URL, apiKey: BTCPAY_API_KEY, storeId: BTCPAY_STORE_ID }
              });
              const mappedStatus = statusPayload?.status || "PENDING";
              const rawStatus = statusPayload?.rawStatus || mappedStatus;
              if (provider === "boltz") {
                await handleBoltzStatusSideEffects({
                  swapId: o.boltzSwapId || o.onchainSwapId,
                  mappedStatus,
                  rawStatus
                });
                if (BOLTZ_FINAL_STATUSES.has(mappedStatus)) {
                  continue;
                }
              } else {
                if (mappedStatus === "CONFIRMED") {
                  const updated =
                    Orders.markPaidBySwapId(o.onchainId || o.onchainSwapId || o.boltzSwapId) ||
                    Orders.markPaidByHash(o.paymentHash || o.id);
                  if (updated?.__justPaid && updated?.items?.length) {
                    for (const it of updated.items) Products.consumeStock(it.productId, it.qty || 1);
                  }
                  notifyPaidOnce(updated);
                  try { await dmOrderUpdate(updated, "PAID"); } catch {}
                  try { await sendOrderStatusEmail(updated, "PAID"); } catch {}
                  continue;
                }
                if (mappedStatus === "EXPIRED") {
                  if (o.status === "PENDING") Orders.remove(o.id);
                  continue;
                }
                if (mappedStatus === "FAILED") {
                  Orders.setStatus(o.id, "FAILED");
                  continue;
                }
              }
            } catch {
              // swallow and fall back to invoice polling
            }
          }

          if (o.paymentMethod === "onchain") {
            continue;
          }
          if (!o.paymentHash) {
            continue;
          }

          const args =
            PAYMENT_PROVIDER === "blink"
              ? { url: BLINK_GRAPHQL_URL, apiKey: BLINK_API_KEY, paymentHash: o.paymentHash }
              : PAYMENT_PROVIDER === "lnurl"
                ? { paymentHash: o.paymentHash, verifyUrl: o.lnurlVerifyUrl, paymentRequest: o.paymentRequest, expiresAt: o.lnurlExpiresAt }
              : PAYMENT_PROVIDER === "nwc"
                ? { url: NWC_URL, relayUrls: NWC_RELAYS, paymentHash: o.paymentHash }
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
