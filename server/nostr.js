// server/nostr.js
// ESM module

import WebSocket from "ws";
import { createHash } from "crypto";
import { nip19 } from "nostr-tools";
import { Relay, useWebSocketImplementation } from "nostr-tools/relay";
import { finalizeEvent, verifyEvent, getEventHash } from "nostr-tools/pure";
import { encrypt } from "nostr-tools/nip04";
import { bytesToHex } from "nostr-tools/utils";
import { schnorr } from "@noble/curves/secp256k1";
import { SimplePool } from "nostr-tools/pool";

// Node 18+ has global fetch
const globalFetch = (...args) => fetch(...args);
const COMMENT_PROOF_TTL_MS = Math.max(5_000, Number(process.env.COMMENT_PROOF_TTL_MS || 60_000));

// Ensure nostr-tools uses ws in Node
try {
  useWebSocketImplementation(WebSocket);
  console.info("[nostr] WebSocket implementation configured (ws)");
} catch (err) {
  console.warn("[nostr] Failed to configure WebSocket implementation", err?.message || err);
}

// ------------------------------
// Small helpers & PR-event constants
// ------------------------------
const HEX64 = /^[0-9a-f]{64}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parameterized replaceable kinds (NIP-33), aligned with plebeian.market
export const PR_KIND_MIN = 30000;
export const PR_KIND_MAX = 40000;
export const KIND_STALL = 30017;
export const KIND_PRODUCT = 30018;
export const KIND_AUCTION = 30020;

function isHex64(s) {
  return typeof s === "string" && HEX64.test(s);
}

function uniq(a) {
  return Array.from(new Set(a.filter(Boolean).map((s) => s.trim()).filter(Boolean)));
}

let _loggedRelays = false;

// ------------------------------
// Coordinate helpers (kind:pubkey:d-tag)
// ------------------------------

export function parseCoordinatesString(input) {
  const raw = String(input || "");
  const parts = raw.split(":");
  const result = {
    tagD: raw
  };

  if (parts.length >= 3) {
    let tagDIndex = parts.length - 1;
    while (tagDIndex >= 0 && !parts[tagDIndex]) {
      tagDIndex -= 1;
    }
    if (tagDIndex >= 0) {
      result.tagD = parts[tagDIndex];
    }

    for (let i = 0; i < tagDIndex; i += 1) {
      const part = parts[i];
      if (!result.kind) {
        const kindNumber = Number(part);
        if (!Number.isNaN(kindNumber) && kindNumber >= PR_KIND_MIN && kindNumber < PR_KIND_MAX) {
          result.kind = kindNumber;
          continue;
        }
      }
      if (!result.pubkey && isHex64(part)) {
        result.pubkey = part.toLowerCase();
      }
    }

    if (result.kind && result.pubkey && result.tagD) {
      result.coordinates = `${result.kind}:${result.pubkey}:${result.tagD}`;
    }
  }

  return result;
}

export function getEventCoordinates(event) {
  if (!event) return null;
  const kind = Number(event.kind || 0);
  const pubkey = String(event.pubkey || "").toLowerCase();
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const dTag = tags.find((t) => Array.isArray(t) && t[0] === "d");
  const tagD = dTag && typeof dTag[1] === "string" ? dTag[1] : "";

  if (!kind || kind < PR_KIND_MIN || kind >= PR_KIND_MAX || !pubkey || !tagD) {
    console.warn(
      "[nostr] getEventCoordinates: invalid event",
      {
        id: event.id,
        kind: event.kind,
        pubkey: event.pubkey,
        hasD: !!tagD
      }
    );
    return null;
  }

  const coordinatesString = `${kind}:${pubkey}:${tagD}`;
  const parsed = parseCoordinatesString(coordinatesString);

  if (parsed.coordinates && parsed.tagD) {
    return {
      coordinates: parsed.coordinates,
      kind,
      pubkey,
      tagD: parsed.tagD
    };
  }

  return null;
}

export function buildCoordinates(kind, pubkey, dTag) {
  const k = Number(kind || 0);
  const pk = String(pubkey || "").toLowerCase();
  const d = String(dTag || "").trim();
  if (!k || k < PR_KIND_MIN || k >= PR_KIND_MAX || !pk || !d) return "";
  return `${k}:${pk}:${d}`;
}

function hashContent(obj) {
  try {
    const json = JSON.stringify(obj || {});
    return createHash("sha1").update(json).digest("hex");
  } catch {
    return "";
  }
}

function normalizeProductDTag(productId, raw) {
  const fallbackBase = String(productId || "").trim() || "product";
  let input = String(raw || "").trim();
  if (!input) input = fallbackBase;
  // Strip legacy "product:" prefix to keep dTag a simple slug
  input = input.replace(/^product:/i, "");
  const cleaned = input.replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "");
  if (!cleaned) return fallbackBase;
  return cleaned.slice(0, 256);
}

function validateProductContentShape(content) {
  const errors = [];
  const out = { ...content };

  out.name = String(out.name || "").trim();
  if (!out.name) errors.push("name is required");

  out.description = typeof out.description === "string" ? out.description : "";
  out.currency = String(out.currency || "SATS").toUpperCase();
  out.price = Math.max(0, Math.floor(Number(out.price || 0)));
  if (out.quantity !== undefined && out.quantity !== null) {
    const q = Number(out.quantity);
    out.quantity = Number.isFinite(q) ? Math.max(0, Math.floor(q)) : undefined;
  }

  out.images = Array.isArray(out.images) ? out.images.map((u) => String(u || "").trim()).filter(Boolean) : [];

  out.specs = Array.isArray(out.specs)
    ? out.specs
        .filter((pair) => Array.isArray(pair) && pair.length >= 2)
        .map(([k, v]) => [String(k || "").slice(0, 64), String(v || "").slice(0, 256)])
        .filter((pair) => pair[0] && pair[1])
        .slice(0, 12)
    : [];

  out.shipping = Array.isArray(out.shipping)
    ? out.shipping
        .map((s, idx) => ({
            id: String(s?.id || `ship-${idx + 1}`).slice(0, 128),
            name: String(s?.name || s?.id || "Shipping").slice(0, 128),
            cost: String(Math.max(0, Math.floor(Number(s?.cost ?? 0)))),
            regions: Array.isArray(s?.regions) ? s.regions : null,
            countries: Array.isArray(s?.countries) ? s.countries : null
          }))
        .slice(0, 16)
    : [];

  delete out.gallery; // schema is strict: omit gallery entirely

  if (errors.length) {
    const err = new Error(`Invalid product event: ${errors.join(", ")}`);
    err.name = "ProductEventValidationError";
    throw err;
  }
  return out;
}

// ------------------------------
// Server keys (from env), cached
// ------------------------------
let _keysCache = null;
let _keysWarned = false;
const _proofCache = new Map(); // productId -> { storePubkey, ts, sig, _createdMs }

function decodeSecret(name, raw) {
  const val = String(raw || "").trim();
  if (!val) return null;

  if (val.startsWith("nsec1")) {
    try {
      const dec = nip19.decode(val);
      if (dec.type === "nsec" && dec.data) {
        return dec.data; // Uint8Array(32)
      }
    } catch (err) {
      console.warn("[nostr] failed to decode nsec", { env: name, error: err?.message || err });
    }
  }

  if (isHex64(val)) {
    try {
      const buf = Buffer.from(val, "hex");
      if (buf.length === 32) return new Uint8Array(buf);
    } catch (err) {
      console.warn("[nostr] failed to parse hex secret", { env: name, error: err?.message || err });
    }
  }
  return null;
}

function loadServerKeysFromEnv() {
  if (_keysCache) return _keysCache;

  const candidates = [
    "SHOP_NOSTR_NSEC",
    "NOSTR_NSEC",
    "SHOP_NOSTR_SECRET_HEX",
    "NOSTR_SECRET_HEX"
  ];

  for (const name of candidates) {
    const raw = process.env[name];
    const seckeyBytes = decodeSecret(name, raw);
    if (!seckeyBytes) continue;
    try {
      const pubkeyBytes = schnorr.getPublicKey(seckeyBytes);
      const seckeyHex = bytesToHex(seckeyBytes);
      const pubkeyHex = bytesToHex(pubkeyBytes);
      _keysCache = { seckeyBytes, seckeyHex, pubkeyHex, sourceEnv: name };
      console.info("[nostr] server Nostr key configured", { sourceEnv: name, pubkey: pubkeyHex });
      return _keysCache;
    } catch (err) {
      console.warn("[nostr] failed to derive pubkey", { env: name, error: err?.message || err });
    }
  }

  if (!_keysWarned) {
    _keysWarned = true;
    console.warn("[nostr] no valid Nostr server key found; DMs are DISABLED");
  }
  return null;
}

export function getShopKeys() {
  const keys = loadServerKeysFromEnv();
  if (!keys && !_keysWarned) {
    _keysWarned = true;
    console.warn("[nostr] getShopKeys: no keys configured, returning null");
  }
  return keys;
}

export function getShopPubkey() {
  return getShopKeys()?.pubkeyHex || "";
}

export function npubFromHex(hex) {
  const pk = String(hex || "").trim();
  if (!pk) return "";
  try {
    return nip19.npubEncode(pk);
  } catch {
    return pk;
  }
}

export async function fetchProfile(pubkey, relays = []) {
  const pk = String(pubkey || "").trim();
  if (!pk) return null;
  const urls = Array.isArray(relays) && relays.length ? relays : [];
  if (!urls.length) return null;
  const pool = new SimplePool({ enableReconnect: false });
  try {
    const events = await pool.list(urls, [{ kinds: [0], authors: [pk], limit: 1 }]);
    if (!events || !events.length) return null;
    const latest = events.reduce((a, b) => ((b.created_at || 0) > (a.created_at || 0) ? b : a), events[0]);
    if (!latest?.content) return null;
    try {
      return JSON.parse(latest.content || "{}");
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    try { pool.close(urls); } catch {}
  }
}

// ------------------------------
// Relay selection
// ------------------------------
export function relaysFrom(settings = {}) {
  const fromEnv = (process.env.NOSTR_RELAYS_CSV || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const fromSettings = Array.isArray(settings.nostrRelays)
    ? settings.nostrRelays.map((s) => String(s || "").trim())
    : [];

  const defaults = ["wss://relay.damus.io", "wss://nos.lol"];
  const list = uniq([...fromSettings, ...fromEnv, ...defaults]);
  if (!_loggedRelays) {
    _loggedRelays = true;
    console.info("[nostr] relay configuration", { envCsv: process.env.NOSTR_RELAYS_CSV, settingsRelays: fromSettings, effective: list });
  }
  return list.length ? list : defaults;
}

// ------------------------------
// Identity resolvers
// ------------------------------
function isPrivateHost(host) {
  const h = String(host || "").trim().toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local")) return true;
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
  return false;
}

async function resolveNip05(nip05) {
  // "name@domain"
  const s = String(nip05 || "").trim();
  const at = s.indexOf("@");
  if (at <= 0) return "";

  const name = s.slice(0, at).toLowerCase();
  const host = s.slice(at + 1);
  if (!name || !host) return "";
  if (isPrivateHost(host)) return "";

  const url = `https://${host}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
  const controller = new AbortController();
  const timeout = Number(process.env.NIP05_FETCH_TIMEOUT_MS || 2000);
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const rsp = await globalFetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!rsp.ok) return "";
    const j = await rsp.json();
    const hex = j?.names?.[name];
    return isHex64(hex) ? hex.toLowerCase() : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveToPubkey(identifier, { allowNip05 = true } = {}) {
  const id = String(identifier || "").trim();
  if (!id) {
    console.warn("[nostr] resolveToPubkey: missing identifier");
    return "";
  }

  // 64-hex
  if (isHex64(id)) {
    const hex = id.toLowerCase();
    console.info("[nostr] resolveToPubkey: detected hex", { pubkey: hex });
    return hex;
  }

  // npub / nprofile
  if (id.startsWith("npub") || id.startsWith("nprofile")) {
    try {
      const dec = nip19.decode(id);
      if (dec.type === "npub") return String(dec.data).toLowerCase();
      if (dec.type === "nprofile") {
        const data = dec.data;
        if (typeof data === "string") return data.toLowerCase();
        if (data && data.pubkey) return String(data.pubkey).toLowerCase();
      }
    } catch (err) {
      console.warn("[nostr] resolveToPubkey: npub/nprofile decode failed", { identifier: id, error: err?.message || err });
    }
  }

  // nip05 name@domain
  if (allowNip05 && id.includes("@")) {
    const hex = await resolveNip05(id);
    if (hex) return hex;
  }

  console.warn("[nostr] resolveToPubkey: unsupported identifier", { identifier: id });
  return "";
}

function commentProofMessage({ storePubkey, productId, ts }) {
  const pid = String(productId || "").trim();
  const timestamp = Math.floor(Number(ts || Date.now() / 1000));
  return `comment-proof:${storePubkey}:${pid}:${timestamp}`;
}

export function makeCommentProof({ productId, ts } = {}) {
  const keys = getShopKeys();
  if (!keys) return null;
  const storePubkey = keys.pubkeyHex;
  const pid = String(productId || "").trim();
  if (!pid) return null;
  const nowMs = Date.now();
  const cached = _proofCache.get(pid);
  if (cached && nowMs - cached._createdMs < COMMENT_PROOF_TTL_MS) {
    return { storePubkey: cached.storePubkey, ts: cached.ts, sig: cached.sig };
  }
  const timestamp = Math.floor(Number(ts || nowMs / 1000));
  const msg = commentProofMessage({ storePubkey, productId: pid, ts: timestamp });
  const hash = createHash("sha256").update(msg).digest();
  const sigBytes = schnorr.sign(hash, keys.seckeyHex || keys.seckeyBytes);
  const sig = bytesToHex(sigBytes);
  const proof = { storePubkey, ts: timestamp, sig };
  _proofCache.set(pid, { ...proof, _createdMs: nowMs });
  return proof;
}

export function verifyCommentProof({ sig, ts, storePubkey, productId } = {}) {
  const key = String(storePubkey || "").trim().toLowerCase();
  if (!isHex64(key)) return false;
  const proofSig = String(sig || "");
  const proofTs = Math.floor(Number(ts || 0));
  if (!proofSig || !proofTs) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - proofTs);
  // Allow up to 15 minutes skew for a proof to remain valid.
  if (!Number.isFinite(age) || age > 15 * 60) return false;
  const pid = String(productId || "").trim();
  if (!pid) return false;
  try {
    const msg = commentProofMessage({ storePubkey: key, productId: pid, ts: proofTs });
    const hash = createHash("sha256").update(msg).digest();
    return !!schnorr.verify(proofSig, hash, key);
  } catch {
    return false;
  }
}

export function extractProductIdFromTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const xTag = list.find((t) => Array.isArray(t) && t[0] === "x" && typeof t[1] === "string" && t[1].includes(":product:"));
  if (xTag?.[1]) {
    const idx = xTag[1].lastIndexOf(":product:");
    if (idx >= 0) {
      const pid = xTag[1].slice(idx + ":product:".length);
      if (pid) return pid;
    }
  }
  const legacy = list.find((t) => Array.isArray(t) && t[0] === "t" && typeof t[1] === "string" && t[1].startsWith("product:"));
  if (legacy?.[1]) return legacy[1].slice("product:".length);
  return "";
}

// ------------------------------
// Login event verification
// ------------------------------
export function verifyLoginEvent(evt, expectedChallenge, {
  expectedKind = 27235,
  expectedDomain = ""
} = {}) {
  try {
    if (!evt || typeof evt !== "object") return false;
    if (!evt.kind || !evt.pubkey || !evt.sig) return false;
    if (!isHex64(evt.pubkey)) return false;
    if (expectedKind !== undefined && evt.kind !== expectedKind) return false;

    const created = Number(evt.created_at || 0);
    if (!Number.isFinite(created)) return false;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - created) > 5 * 60) return false; // 5-minute skew window

    // Challenge must appear either as a tag or in content.
    const challenge = String(expectedChallenge || "").trim();
    const tags = Array.isArray(evt.tags) ? evt.tags : [];
    const hasChallengeTag = tags.some(
      (t) => Array.isArray(t) && t[0] === "challenge" && String(t[1] || "") === challenge
    );
    if (challenge && !hasChallengeTag) return false;

    const domain = String(expectedDomain || "").trim().toLowerCase();
    if (domain) {
      const domainTag = tags.find((t) => Array.isArray(t) && t[0] === "domain");
      if (!domainTag || String(domainTag[1] || "").toLowerCase() !== domain) {
        return false;
      }
    }

    // Ensure id is consistent
    const computedId = getEventHash({
      kind: evt.kind,
      pubkey: evt.pubkey,
      created_at: evt.created_at,
      tags: evt.tags || [],
      content: evt.content || "",
    });
    if (evt.id && evt.id !== computedId) return false;

    const ok = verifyEvent({ ...evt, id: computedId });
    return !!ok;
  } catch {
    return false;
  }
}

// ------------------------------
// DM sender (kind 4) with robust relay handling
// + smarter idempotency to avoid duplicate DMs
// ------------------------------

// In-memory idempotency cache with TTL
// Keyed by a *semantic* key when we can extract it from the message,
// otherwise falls back to (toPubkey + hash(message)).
const _dmDedup = new Map(); // key -> timestamp (ms)
const DM_DEDUP_TTL_MS = Number(process.env.DM_DEDUP_TTL_MS || 5 * 60 * 1000);
console.info("[nostr] DM dedup TTL (ms)", { env: process.env.DM_DEDUP_TTL_MS, effective: DM_DEDUP_TTL_MS });

function _pruneDedup() {
  const now = Date.now();
  for (const [k, ts] of _dmDedup) {
    if (now - ts > DM_DEDUP_TTL_MS) _dmDedup.delete(k);
  }
}

function _hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return String(h >>> 0);
}

// Try to build a stable, order-aware dedup key from the message the app sends, e.g.:
//
// Thank you for your order ABC123.
// Status: PAID
// ...
//
// If we can extract {orderId, status}, dedup on "to:<hex>|order:<id>|status:<status>".
// Otherwise fall back to "to:<hex>|msg:<hash(message)>".
function _buildDedupKey(toPubkeyHex, message) {
  try {
    const mOrder = /Thank you for your order\s+([A-Za-z0-9._-]+)/i.exec(message || "");
    const mStatus = /Status:\s*([A-Z]+)/i.exec(message || "");
    const orderId = (mOrder && mOrder[1]) ? mOrder[1] : "";
    const status = (mStatus && mStatus[1]) ? mStatus[1].toUpperCase() : "";
    if (orderId && status) {
      return `to:${toPubkeyHex}|order:${orderId}|status:${status}`;
    }
  } catch {
    // ignore and fall back
  }
  return `to:${toPubkeyHex}|msg:${_hash(String(message || ""))}`;
}

function _shouldSendAndMark(toPubkeyHex, message) {
  _pruneDedup();
  const key = _buildDedupKey(toPubkeyHex, message);
  if (_dmDedup.has(key)) {
    const age = Date.now() - (_dmDedup.get(key) || 0);
    console.info("[nostr] DM dedup HIT", { key, ageMs: age, ttlMs: DM_DEDUP_TTL_MS });
    return { should: false, key };
  }
  console.info("[nostr] DM dedup MISS", { key, ttlMs: DM_DEDUP_TTL_MS });
  _dmDedup.set(key, Date.now());
  return { should: true, key };
}

const PUBLISH_TIMEOUT_MS = Math.max(15000, Number(process.env.NOSTR_PUBLISH_TIMEOUT_MS || 15000));
const publishPool = new SimplePool({ enablePing: true, enableReconnect: true });

function attachRelayLogging(relay, label) {
  if (!relay || relay._lsLogAttached) return;
  const prevOnclose = relay.onclose;
  relay.onclose = (reason) => {
    console.warn("[nostr] relay closed", { relay: relay.url, label, reason });
    try { prevOnclose?.(reason); } catch {}
  };
  const prevOnerror = relay.onerror;
  relay.onerror = (err) => {
    console.warn("[nostr] relay error", { relay: relay.url, label, error: err?.message || err });
    try { prevOnerror?.(err); } catch {}
  };
  relay._lsLogAttached = true;
}

function logEventDebug(label, event) {
  try {
    const content = (() => {
      try { return JSON.parse(event?.content || ""); } catch { return event?.content; }
    })();
    console.info("[nostr] publish payload", { label, event, content });
  } catch {
    // ignore logging failures
  }
}

async function publishAndWait(relay, event, timeoutMs = PUBLISH_TIMEOUT_MS) {
  let timer;
  const to = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error("publish timeout")), timeoutMs);
  });

  try {
    const ret = relay.publish(event);

    // Newer nostr-tools: publish() returns a Promise
    if (ret && typeof ret.then === "function") {
      await Promise.race([ret, to]);
      return;
    }

    // Older shape: publish() returns an object with .on(...)
    if (ret && typeof ret.on === "function") {
      await Promise.race([
        new Promise((resolve, reject) => {
          ret.on("ok", resolve);
          ret.on("seen", resolve);
          ret.on("failed", (reason) => reject(new Error(reason || "relay failed")));
        }),
        to,
      ]);
      return;
    }

    // Fallback: if it returns neither, assume best effort success
    await Promise.race([sleep(50), to]);
  } finally {
    clearTimeout(timer);
  }
}

async function publishWithPool(relays, event, { stopOnFirstOk = false, label = "publish" } = {}) {
  const relayList = normalizeRelayList(relays);
  const results = [];
  let lastError = null;

  for (const url of relayList) {
    try {
      const relay = await publishPool.ensureRelay(url, { connectionTimeout: Math.min(PUBLISH_TIMEOUT_MS - 500, PUBLISH_TIMEOUT_MS) });
      attachRelayLogging(relay, label);
      console.info("[nostr] relay connected", { relay: relay.url, label });
      await publishAndWait(relay, event, PUBLISH_TIMEOUT_MS);
      console.info("[nostr] publish ok", { relay: url, label });
      results.push({ relay: url, ok: true, error: "" });
      if (stopOnFirstOk) break;
    } catch (err) {
      lastError = err;
      console.error("[nostr] publish failed", {
        relay: url,
        label,
        message: err?.message,
        stack: err?.stack,
        cause: err?.cause
      });
      results.push({ relay: url, ok: false, error: err?.message || "publish failed" });
    }
  }

  return { results, lastError };
}

export async function sendDM({ toPubkeyHex, message, relays }) {
  const keys = getShopKeys();
  if (!keys) {
    console.warn("[nostr] sendDM: no server keys configured");
    throw new Error("Server Nostr keys not configured");
  }

  const to = String(toPubkeyHex || "").toLowerCase();
  if (!isHex64(to)) {
    console.warn("[nostr] sendDM: invalid recipient pubkey", { toPubkeyHex });
    throw new Error("Invalid recipient pubkey");
  }

  const relayList = uniq(Array.isArray(relays) ? relays : []).filter((u) => u.startsWith("ws"));
  if (!relayList.length) relayList.push("wss://relay.damus.io", "wss://nos.lol");
  console.info("[nostr] sendDM: start", {
    to,
    relays: relayList,
    messagePreview: String(message || "").slice(0, 120)
  });

  // Idempotency: if we very recently sent the same *semantic* message
  // (same recipient, *and* same order+status when extractable),
  // do nothing and report deduped=true to caller.
  const { should, key } = _shouldSendAndMark(to, String(message || ""));
  if (!should) {
    console.info("[nostr] sendDM: dedup prevented send", { key });
    return { ok: true, relay: null, deduped: true, key };
  }

  // Build & sign event
  let content;
  try {
    content = await encrypt(keys.seckeyBytes, to, String(message || ""));
    console.info("[nostr] sendDM: nip04 encrypt ok", { contentPreview: String(content).slice(0, 40) });
  } catch (err) {
    console.error("[nostr] sendDM: nip04 encrypt failed", { error: err?.message || err });
    throw err;
  }
  const unsigned = {
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    pubkey: keys.pubkeyHex,
    tags: [["p", to]],
    content,
  };
  const event = finalizeEvent(unsigned, keys.seckeyBytes);
  const valid = verifyEvent(event);
  console.info("[nostr] sendDM: event finalized", {
    id: event.id,
    valid,
    created_at: event.created_at,
    tags: event.tags
  });
  if (!valid) throw new Error("DM event verification failed");
  logEventDebug("dm", event);

  // Try relays sequentially (pool keeps connections alive)
  const { results, lastError } = await publishWithPool(relayList, event, { stopOnFirstOk: true, label: "dm" });
  const okRelay = results.find((r) => r.ok);
  if (okRelay) {
    return { ok: true, relay: okRelay.relay, deduped: false, key, results };
  }

  const msg = lastError?.message || "All relays failed";
  console.error("[nostr] sendDM: failed on all relays", { msg, results });
  throw new Error(msg);
}

function normalizeRelayList(relays) {
  if (!Array.isArray(relays)) return [];
  return uniq(
    relays
      .map((url) => String(url || "").trim())
      .filter((url) => url.startsWith("ws"))
  );
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

function extractTopicsFromContent(content) {
  const seen = new Set();
  const topics = [];
  const regex = /(^|\s)#([a-zA-Z0-9_:-]{1,64})/g;
  let match;
  while ((match = regex.exec(String(content || "")))) {
    const raw = match[2]?.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(key);
  }
  return topics;
}

export async function publishStall({
  dTag,
  name,
  description,
  currency = "SATS",
  shipping = [],
  relays = [],
  image = "",
  geo = ""
} = {}) {
  const keys = getShopKeys();
  if (!keys) throw new Error("Server Nostr keys not configured");

  const stallD = String(dTag || "main").trim() || "main";
  const stallName = String(name || "").trim() || "Lightning Shop";
  const stallDescription = String(description || "").trim();
  const stallCurrency = String(currency || "SATS").trim().toUpperCase() || "SATS";

  const relayList = normalizeRelayList(relays);
  if (!relayList.length) throw new Error("No relays provided");

  const created_at = Math.floor(Date.now() / 1000);
  const pubkey = keys.pubkeyHex;
  const coordinates = buildCoordinates(KIND_STALL, pubkey, stallD);

  const tags = [["d", stallD]];
  const geoTag = String(geo || "").trim();
  if (geoTag) tags.push(["g", geoTag]);
  const stallImage = String(image || "").trim();
  if (stallImage) tags.push(["image", stallImage]);

  const safeShipping = Array.isArray(shipping)
    ? shipping.map((s, idx) => ({
        id: String(s?.id || `method-${idx + 1}`),
        name: String(s?.name || "").trim() || "Shipping",
        cost: String(s?.cost ?? "0"),
        regions: Array.isArray(s?.regions) ? s.regions : [],
        countries: Array.isArray(s?.countries) ? s.countries : []
      }))
    : [];

  const contentObj = {
    id: stallD,
    name: stallName,
    description: stallDescription,
    currency: stallCurrency,
    shipping: safeShipping,
    ...(stallImage ? { image: stallImage } : {})
  };

  const event = finalizeEvent(
    {
      kind: KIND_STALL,
      created_at,
      pubkey,
      tags,
      content: JSON.stringify(contentObj)
    },
    keys.seckeyBytes
  );

  const valid = verifyEvent(event);
  console.info("[nostr] publishStall: event finalized", {
    id: event.id,
    valid,
    coordinates,
    created_at: event.created_at,
    tags: event.tags
  });
  if (!valid) {
    throw new Error("Stall event verification failed");
  }
  logEventDebug("stall", event);

  const { results: relayResults, lastError } = await publishWithPool(relayList, event, { label: "stall" });

  const anyOk = relayResults.some((r) => r.ok);
  if (!anyOk) {
    throw new Error(lastError?.message || "All relays failed");
  }

  return {
    event,
    coordinates,
    relays: relayList,
    relayResults,
    createdAt: created_at
  };
}

export function buildProductEvent({
  product,
  settings,
  nostrMeta,
  stallCoordinates,
  stallDTag,
  pubkeyHex,
  fallbackImages = []
} = {}) {
  if (!product) throw new Error("Product is required");
  const dTag = normalizeProductDTag(product.id, nostrMeta?.dTag);
  const coordinates = buildCoordinates(KIND_PRODUCT, pubkeyHex, dTag);
  const stallId = stallCoordinates;
  const price = Math.max(0, Math.floor(Number(product.priceSats || 0)));
  const qtyRaw = Number(product.quantityAvailable);
  const qty = Number.isFinite(qtyRaw) ? Math.max(0, qtyRaw) : (product.isUnique ? (product.available ? 1 : 0) : null);
  const qtyOut = qty === null ? undefined : qty;
  const currency = String(settings?.nostrCurrency || "SATS").toUpperCase();
  const imageUrl = nostrMeta?.imageUrl ? String(nostrMeta.imageUrl).trim() : "";
  const topics = Array.isArray(nostrMeta?.topics) ? nostrMeta.topics : [];
  const galleryInput = Array.isArray(nostrMeta?.gallery) ? nostrMeta.gallery : [];
  const gallery = uniq([imageUrl, ...galleryInput, ...fallbackImages].filter(Boolean));

  const specs = [];
  const dims = [product.widthCm, product.heightCm, product.depthCm]
    .map((v) => (v === null || v === undefined ? "" : String(v)))
    .filter((v) => v !== "");
  if (dims.length) {
    specs.push(["dimensions", `${dims.join(" x ")} cm`]);
  }

  // Skip per-product shipping to avoid FK issues on remote ingest; stall shipping covers defaults.
  const shipping = [];

  const content = validateProductContentShape({
    id: dTag || undefined,
    stall_id: stallDTag || stallId || undefined,
    name: product.title || "",
    type: "simple",
    description: product.longDescription || product.description || "",
    images: gallery.slice(0, 8),
    currency,
    price,
    quantity: qtyOut,
    specs,
    shipping
  });

  const tags = [["d", dTag]];
  if (stallCoordinates) {
    tags.push(["a", stallCoordinates]);
  }
  for (const t of topics) {
    if (t) tags.push(["t", String(t)]);
  }

  const contentHash = hashContent(content);
  return { coordinates, tags, content, contentHash, dTag };
}

export async function publishProduct({
  product,
  settings,
  nostrMeta = {},
  relays = [],
  force = false,
  fallbackImages = []
} = {}) {
  const keys = getShopKeys();
  if (!keys) throw new Error("Server Nostr keys not configured");
  const relayList = normalizeRelayList(relays);
  if (!relayList.length) throw new Error("No relays provided");

  const stallDTag = settings?.nostrStallDTag || "main";
  const stallCoords =
    settings?.nostrStallCoordinates ||
    buildCoordinates(KIND_STALL, keys.pubkeyHex, stallDTag);

  const { coordinates, tags, content, contentHash, dTag } = buildProductEvent({
    product,
    settings,
    nostrMeta,
    stallCoordinates: stallCoords,
    stallDTag,
    pubkeyHex: keys.pubkeyHex,
    fallbackImages
  });

  if (!force && nostrMeta?.lastContentHash && nostrMeta.lastContentHash === contentHash && nostrMeta.lastEventId) {
    return {
      skipped: true,
      reason: "unchanged",
      coordinates,
      contentHash
    };
  }

  const created_at = Math.floor(Date.now() / 1000);
  const event = finalizeEvent(
    {
      kind: KIND_PRODUCT,
      created_at,
      pubkey: keys.pubkeyHex,
      tags,
      content: JSON.stringify(content)
    },
    keys.seckeyBytes
  );

  const valid = verifyEvent(event);
  console.info("[nostr] publishProduct: event finalized", {
    id: event.id,
    valid,
    coordinates,
    dTag,
    created_at: event.created_at,
    tags: event.tags
  });
  if (!valid) {
    throw new Error("Product event verification failed");
  }
  logEventDebug("product", event);

  const { results: relayResults, lastError } = await publishWithPool(relayList, event, { label: "product" });

  const anyOk = relayResults.some((r) => r.ok);
  if (!anyOk) {
    throw new Error(lastError?.message || "All relays failed");
  }

  return {
    event,
    coordinates,
    relays: relayList,
    relayResults,
    contentHash,
    dTag,
    createdAt: created_at
  };
}

// ---------------------------------------------------------------------
// Nostr catalog fetch (stall + products) for import
// ---------------------------------------------------------------------

export async function fetchStallAndProducts({ pubkeyHex, relays, stallDTag } = {}) {
  const pk = String(pubkeyHex || "").trim().toLowerCase();
  if (!pk || !isHex64(pk)) {
    throw new Error("Invalid pubkey for Nostr import");
  }
  const relayList = normalizeRelayList(Array.isArray(relays) ? relays : []);
  if (!relayList.length) {
    throw new Error("No relays provided for Nostr import");
  }

  const pool = new SimplePool({ enableReconnect: false });
  try {
    console.info("[nostr-import] fetchStallAndProducts start", {
      pubkey: pk,
      relays: relayList,
      stallDTag
    });
    const filters = [
      { kinds: [KIND_STALL], authors: [pk] },
      { kinds: [KIND_PRODUCT], authors: [pk] }
    ];
    let events = [];
    if (typeof pool.querySync === "function") {
      const results = await Promise.all(
        filters.map((f) => pool.querySync(relayList, f).catch(() => []))
      );
      const dedup = new Map();
      for (const ev of results.flat()) {
        if (ev && ev.id) dedup.set(ev.id, ev);
      }
      events = Array.from(dedup.values());
    } else if (typeof pool.list === "function") {
      events = await pool.list(relayList, filters);
    } else {
      throw new Error("SimplePool does not support querySync or list");
    }
    console.info("[nostr-import] querying relays with filters", filters);
    const stalls = [];
    const products = [];

    for (const ev of events || []) {
      if (!ev || typeof ev.kind !== "number") continue;
      if (ev.kind === KIND_STALL) stalls.push(ev);
      else if (ev.kind === KIND_PRODUCT) products.push(ev);
    }

    const targetD = stallDTag ? String(stallDTag).trim() : "";
    let selectedStall = null;

    // First pass: prefer stall matching the requested d-tag (if any)
    for (const ev of stalls) {
      const coords = getEventCoordinates(ev);
      if (!coords) continue;
      if (targetD && coords.tagD !== targetD) continue;
      if (!selectedStall || (ev.created_at || 0) > (selectedStall.event.created_at || 0)) {
        selectedStall = { event: ev, coordinates: coords };
      }
    }

    // Fallback: if nothing matched the requested d-tag, pick the latest stall for this pubkey
    if (!selectedStall && targetD) {
      for (const ev of stalls) {
        const coords = getEventCoordinates(ev);
        if (!coords) continue;
        if (!selectedStall || (ev.created_at || 0) > (selectedStall.event.created_at || 0)) {
          selectedStall = { event: ev, coordinates: coords };
        }
      }
      if (selectedStall) {
        console.info("[nostr-import] stall fallback without dTag match", {
          requestedDTag: targetD,
          chosenDTag: selectedStall.coordinates?.tagD
        });
      }
    }

    let stall = null;
    if (selectedStall) {
      let stallContent;
      try {
        stallContent = JSON.parse(selectedStall.event.content || "{}");
      } catch {
        stallContent = {};
      }
      stall = {
        event: selectedStall.event,
        coordinates: selectedStall.coordinates,
        content: stallContent
      };
    }

    const normalizedProducts = [];
    for (const ev of products) {
      const coords = getEventCoordinates(ev);
      if (!coords) continue;
      let productContent;
      try {
        productContent = JSON.parse(ev.content || "{}");
      } catch {
        productContent = {};
      }
      normalizedProducts.push({
        event: ev,
        coordinates: coords,
        content: productContent
      });
    }

    const result = {
      pubkey: pk,
      stall,
      products: normalizedProducts,
      relays: relayList
    };
    console.info("[nostr-import] fetchStallAndProducts done", {
      pubkey: pk,
      relays: relayList,
      hasStall: !!stall,
      products: normalizedProducts.length
    });
    return result;
  } finally {
    try { pool.close(relayList); } catch {}
  }
}

export async function publishProductTeaser({
  content = "",
  relays = [],
  imageUrl = "",
  imageMime = "image/jpeg",
  imageAlt = "",
  imageDim = "",
  productUrl = "",
  coordinates = ""
}) {
  const keys = getShopKeys();
  if (!keys) throw new Error("Server Nostr keys not configured");

  const relayList = normalizeRelayList(relays);
  if (!relayList.length) throw new Error("No relays provided");

  const created_at = Math.floor(Date.now() / 1000);
  const tags = [];

  let finalContent = String(content || "").trim();
  const normalizedImageUrl = ensureImageUrlWithExt(imageUrl);

  if (normalizedImageUrl) {
    const imeta = ["imeta", `url ${String(normalizedImageUrl)}`, `m ${String(imageMime || "image/jpeg")}`];
    if (imageDim) imeta.push(`dim ${String(imageDim)}`);
    imeta.push(`alt ${String(imageAlt || "").replace(/\s+/g, " ").trim() || "image"}`);
    tags.push(imeta);
    tags.push(["r", String(normalizedImageUrl)]);

    const linesWithoutImage = finalContent
      .split(/\r?\n/)
      .filter((line) => line.trim() !== normalizedImageUrl);
    const hasBody = linesWithoutImage.some((line) => line.trim());
    const body = hasBody ? linesWithoutImage.join("\n") : "";
    finalContent = body
      ? `${normalizedImageUrl}\n\n${body}`
      : normalizedImageUrl;
  }

  if (productUrl) {
    const productLine = `Available here 👉 ${productUrl}`;
    const hasProductLine = finalContent.split(/\r?\n/).some((line) => line.trim() === productLine || line.trim() === productUrl);
    if (!hasProductLine) {
      finalContent = finalContent
        ? `${finalContent}\n\n${productLine}`
        : productLine;
    }
  }

  const topics = extractTopicsFromContent(finalContent);
  for (const topic of topics) {
    tags.push(["t", topic]);
  }
  if (coordinates) {
    const aTag = ["a", coordinates];
    if (relayList[0]) aTag.push(relayList[0]);
    tags.push(aTag);
  }

  if (!finalContent) {
    throw new Error("Teaser content is empty");
  }

  const event = finalizeEvent(
    {
      kind: 1,
      created_at,
      pubkey: keys.pubkeyHex,
      tags,
      content: finalContent
    },
    keys.seckeyBytes
  );

  const valid = verifyEvent(event);
  console.info("[nostr] publishProductTeaser: event finalized", {
    id: event.id,
    valid,
    coordinates,
    created_at: event.created_at,
    tags: event.tags
  });
  if (!valid) {
    throw new Error("Teaser event verification failed");
  }
  logEventDebug("teaser", event);

  const { results: relayResults, lastError } = await publishWithPool(relayList, event, { label: "teaser" });

  const anyOk = relayResults.some((r) => r.ok);
  if (!anyOk) {
    throw new Error(lastError?.message || "All relays failed");
  }

  return {
    event,
    relayResults,
    relays: relayList,
    createdAt: created_at
  };
}
