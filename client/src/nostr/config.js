import { nip19 } from "nostr-tools";

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol"
];

export function nostrCommentsEnabled(settings) {
  return settings?.nostrCommentsEnabled !== false;
}

export function resolveRelays(candidate) {
  const normalized = Array.isArray(candidate)
    ? candidate
        .map((url) => String(url || "").trim())
        .filter((url) => url.startsWith("ws"))
    : [];
  return normalized.length ? normalized : DEFAULT_RELAYS;
}

function normalizeListInput(val) {
  if (Array.isArray(val)) {
    return val
      .map((v) => String(v || "").trim())
      .filter(Boolean);
  }
  if (typeof val === "string") {
    return val
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizePubkey(str) {
  const raw = String(str || "").trim();
  if (!raw) return "";
  if (raw.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(raw);
      if (decoded?.type === "npub" && typeof decoded.data === "string") {
        return decoded.data;
      }
    } catch {
      // ignore decode errors, fall through to raw
    }
  }
  return raw;
}

function normalizeHashtag(tag) {
  return String(tag || "").replace(/^#/, "").trim().toLowerCase();
}

export function getBlockedPubkeys(settings) {
  return normalizeListInput(settings?.nostrBlockedPubkeys || []).map(normalizePubkey).filter(Boolean);
}

export function getBlockedHashtags(settings) {
  return normalizeListInput(settings?.nostrBlockedHashtags || []).map(normalizeHashtag).filter(Boolean);
}

export function makeBlockedSets(settings) {
  const pubkeys = new Set(getBlockedPubkeys(settings));
  const hashtags = new Set(getBlockedHashtags(settings));
  return { pubkeys, hashtags };
}

export function isEventBlocked(ev, { pubkeys, hashtags } = {}) {
  if (!ev) return false;
  const pk = String(ev.pubkey || "");
  if (pubkeys?.size && pubkeys.has(pk)) return true;
  if (hashtags?.size) {
    const tags = Array.isArray(ev.tags) ? ev.tags : [];
    for (const tag of tags) {
      if (Array.isArray(tag) && tag[0] === "t") {
        const normalized = normalizeHashtag(tag[1]);
        if (normalized && hashtags.has(normalized)) return true;
      }
    }
  }
  return false;
}
