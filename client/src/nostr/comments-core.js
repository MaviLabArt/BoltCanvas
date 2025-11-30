import { resolveRelays } from "./config.js";
import {
  fetchEventsOnce as poolFetchEventsOnce,
  subscribeEvents as poolSubscribeEvents
} from "./pool.js";

// Use a regular custom kind (non-parameterized) so relays keep all events.
export const PRODUCT_COMMENT_KIND = 43115;
export const PRODUCT_COMMENT_VERSION = "product-comment-v1";

// Canonical x-tag value for a given product, shared by publisher and filters.
export function productXTagValue(productId, storePubkey = "") {
  const normalizedStoreKey = String(storePubkey || "").trim().toLowerCase();
  if (normalizedStoreKey) {
    return `shop:${normalizedStoreKey}:product:${productId}`;
  }
  const envNs = typeof import.meta !== "undefined" && import.meta.env?.VITE_SITE_NAMESPACE;
  const ns = envNs
    ? String(envNs).trim()
    : (typeof window !== "undefined" ? String(window.location.host || "").trim() : "shop");
  return `${ns.toLowerCase()}:product:${productId}`;
}

export function buildProductTags({ productId, storePubkey = "", proof = null }) {
  const key = String(storePubkey || "").trim().toLowerCase();
  const tags = [
    ["x", productXTagValue(productId, key)],
    ["k", PRODUCT_COMMENT_VERSION],
    ["client", "lightning-shop"]
  ];
  if (proof?.sig && proof?.ts) tags.push(["proof", proof.sig, String(proof.ts)]);
  return tags;
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

export function dedupeAndSort(events) {
  const map = new Map();
  for (const ev of events || []) {
    const prev = map.get(ev.id);
    if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) {
      map.set(ev.id, ev);
    }
  }
  return Array.from(map.values()).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

export function productCommentsFilters({ productId, storePubkey, limit = 50, since, until } = {}) {
  const key = String(storePubkey || "").trim().toLowerCase();
  const xValue = productXTagValue(productId, key);
  const filters = [
    {
      kinds: [PRODUCT_COMMENT_KIND],
      "#x": [xValue],
      limit
    }
  ];
  if (!key) {
    filters.push({
      kinds: [1],
      "#t": [`product:${productId}`],
      limit
    });
  }
  if (since) filters.forEach((f) => { f.since = since; });
  if (until) filters.forEach((f) => { f.until = until; });
  return filters;
}

export function recentProductCommentsFilters({ storePubkey, limit = 10, since } = {}) {
  const key = String(storePubkey || "").trim().toLowerCase();
  const filters = [
    {
      kinds: [PRODUCT_COMMENT_KIND],
      "#k": [PRODUCT_COMMENT_VERSION],
      limit
    }
  ];
  if (!key) {
    filters.push({
      kinds: [1],
      "#t": ["product"],
      limit
    });
  }
  if (since) filters.forEach((f) => { f.since = since; });
  return filters;
}

export function fetchEventsOnce(relays, filters) {
  const list = resolveRelays(relays);
  return poolFetchEventsOnce(list, filters);
}

export function subscribeEvents(relays, filters, { onEvent, onEose } = {}) {
  const list = resolveRelays(relays);
  const sub = poolSubscribeEvents(list, filters, { onEvent, onEose });
  if (typeof sub === "function") return sub;
  if (sub && typeof sub.close === "function") return () => sub.close();
  return () => {};
}
