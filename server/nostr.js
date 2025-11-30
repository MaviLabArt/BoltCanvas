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
// Small helpers
// ------------------------------
const HEX64 = /^[0-9a-f]{64}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isHex64(s) {
  return typeof s === "string" && HEX64.test(s);
}

function uniq(a) {
  return Array.from(new Set(a.filter(Boolean).map((s) => s.trim()).filter(Boolean)));
}

let _loggedRelays = false;

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

async function publishAndWait(relay, event, timeoutMs = 8000) {
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
  console.info("[nostr] sendDM: event finalized", { id: event.id, valid });
  if (!valid) throw new Error("DM event verification failed");

  // Try relays sequentially, closing each gracefully
  const results = [];
  let lastError = null;
  for (const url of relayList) {
    let relay = null;
    try {
      console.info("[nostr] sendDM: connecting relay", { url });
      relay = await Relay.connect(url);
      await publishAndWait(relay, event, 8000);

      // Give the socket a beat before closing to avoid noisy close warnings
      await sleep(150);
      try { relay.close(); } catch {}
      await sleep(20);

      console.info("[nostr] sendDM: publish ok", { url });
      results.push({ relay: url, ok: true, error: "" });
      return { ok: true, relay: url, deduped: false, key, results };
    } catch (e) {
      lastError = e;
      console.error("[nostr] sendDM: publish failed", { url, error: e?.message || e });
      results.push({ relay: url, ok: false, error: e?.message || "publish failed" });
      try { relay?.close(); } catch {}
      // Continue to next relay
    }
  }

  // If we reach here, all relays failed.
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

export async function publishProductTeaser({
  content = "",
  relays = [],
  imageUrl = "",
  imageMime = "image/jpeg",
  imageAlt = "",
  imageDim = "",
  productUrl = ""
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
      .filter((line) => line.trim() && line.trim() !== normalizedImageUrl);
    finalContent = linesWithoutImage.length
      ? `${normalizedImageUrl}\n\n${linesWithoutImage.join("\n")}`
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

  const relayResults = [];
  let lastError = null;

  for (const url of relayList) {
    let relay = null;
    try {
      relay = await Relay.connect(url);
      await publishAndWait(relay, event, 8000);
      relayResults.push({ relay: url, ok: true, error: "" });
    } catch (err) {
      relayResults.push({ relay: url, ok: false, error: err?.message || "publish failed" });
      lastError = err;
    } finally {
      try { relay?.close(); } catch {}
      await sleep(20);
    }
  }

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
