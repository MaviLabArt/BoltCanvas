// server/nostr.js
// ESM module

import { nip19 } from "nostr-tools";
import { Relay } from "nostr-tools/relay";
import { finalizeEvent, verifyEvent, getEventHash } from "nostr-tools/pure";
import { encrypt } from "nostr-tools/nip04";
import { bytesToHex } from "nostr-tools/utils";
import { schnorr } from "@noble/curves/secp256k1";

// Node 18+ has global fetch
const globalFetch = (...args) => fetch(...args);

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

// ------------------------------
// Server keys (from env), cached
// ------------------------------
let _keysCache = null;

function loadServerKeysFromEnv() {
  if (_keysCache) return _keysCache;

  const nsecStr =
    process.env.SHOP_NOSTR_NSEC ||
    process.env.NOSTR_NSEC ||
    "";

  if (!nsecStr) return null;

  try {
    const dec = nip19.decode(nsecStr);
    if (dec.type !== "nsec") return null;

    const seckeyBytes = dec.data; // Uint8Array(32)
    // Derive x-only schnorr pubkey (32 bytes)
    const pubkeyBytes = schnorr.getPublicKey(seckeyBytes);
    const seckeyHex = bytesToHex(seckeyBytes);
    const pubkeyHex = bytesToHex(pubkeyBytes);

    _keysCache = { seckeyBytes, seckeyHex, pubkeyHex };
    return _keysCache;
  } catch {
    return null;
  }
}

export function getShopKeys() {
  return loadServerKeysFromEnv();
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
  return list.length ? list : defaults;
}

// ------------------------------
// Identity resolvers
// ------------------------------
async function resolveNip05(nip05) {
  // "name@domain"
  const s = String(nip05 || "").trim();
  const at = s.indexOf("@");
  if (at <= 0) return "";

  const name = s.slice(0, at).toLowerCase();
  const host = s.slice(at + 1);
  if (!name || !host) return "";

  const url = `https://${host}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;

  try {
    const rsp = await globalFetch(url, { headers: { accept: "application/json" } });
    if (!rsp.ok) return "";
    const j = await rsp.json();
    const hex = j?.names?.[name];
    return isHex64(hex) ? hex.toLowerCase() : "";
  } catch {
    return "";
  }
}

export async function resolveToPubkey(identifier) {
  const id = String(identifier || "").trim();
  if (!id) return "";

  // 64-hex
  if (isHex64(id)) return id.toLowerCase();

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
    } catch {}
  }

  // nip05 name@domain
  if (id.includes("@")) {
    const hex = await resolveNip05(id);
    if (hex) return hex;
  }

  return "";
}

// ------------------------------
// Login event verification
// ------------------------------
export function verifyLoginEvent(evt, expectedChallenge) {
  try {
    if (!evt || typeof evt !== "object") return false;
    if (!evt.kind || !evt.pubkey || !evt.sig) return false;
    if (!isHex64(evt.pubkey)) return false;

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
    const hasChallengeInContent = String(evt.content || "").includes(challenge);
    if (challenge && !(hasChallengeTag || hasChallengeInContent)) return false;

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
  if (_dmDedup.has(key)) return { should: false, key };
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
  if (!keys) throw new Error("Server Nostr keys not configured");

  const to = String(toPubkeyHex || "").toLowerCase();
  if (!isHex64(to)) throw new Error("Invalid recipient pubkey");

  // Idempotency: if we very recently sent the same *semantic* message
  // (same recipient, *and* same order+status when extractable),
  // do nothing and report deduped=true to caller.
  const { should, key } = _shouldSendAndMark(to, String(message || ""));
  if (!should) {
    return { ok: true, relay: null, deduped: true, key };
  }

  const relayList = uniq(Array.isArray(relays) ? relays : []).filter((u) => u.startsWith("ws"));
  if (!relayList.length) relayList.push("wss://relay.damus.io", "wss://nos.lol");

  // Build & sign event
  const content = await encrypt(keys.seckeyBytes, to, String(message || ""));
  const unsigned = {
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    pubkey: keys.pubkeyHex,
    tags: [["p", to]],
    content,
  };
  const event = finalizeEvent(unsigned, keys.seckeyBytes);

  // Try relays sequentially, closing each gracefully
  let lastError = null;
  for (const url of relayList) {
    let relay = null;
    try {
      relay = await Relay.connect(url);
      await publishAndWait(relay, event, 8000);

      // Give the socket a beat before closing to avoid noisy close warnings
      await sleep(150);
      try { relay.close(); } catch {}
      await sleep(20);

      return { ok: true, relay: url, deduped: false, key };
    } catch (e) {
      lastError = e;
      try { relay?.close(); } catch {}
      // Continue to next relay
    }
  }

  // If we reach here, all relays failed.
  const msg = lastError?.message || "All relays failed";
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

    const hasImageLine = finalContent.split(/\r?\n/).some((line) => line.trim() === normalizedImageUrl);
    if (!hasImageLine) {
      finalContent = finalContent ? `${finalContent}\n\n${normalizedImageUrl}` : normalizedImageUrl;
    }
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
