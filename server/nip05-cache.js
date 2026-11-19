export function createNip05ResolutionCache(
  resolve,
  {
    ttlMs = 5 * 60 * 1000,
    negativeTtlMs = 30 * 1000,
    maxEntries = 128
  } = {}
) {
  if (typeof resolve !== "function") {
    throw new TypeError("resolve must be a function");
  }

  const successTtl = Number.isFinite(ttlMs) && ttlMs > 0
    ? ttlMs
    : 5 * 60 * 1000;
  const missTtl = Number.isFinite(negativeTtlMs) && negativeTtlMs > 0
    ? negativeTtlMs
    : 30 * 1000;
  const capacity = Number.isFinite(maxEntries)
    ? Math.max(1, Math.floor(maxEntries))
    : 128;
  const entries = new Map();

  return async function resolveCached(identifier) {
    const value = String(identifier || "").trim();
    if (!value) return "";
    // Hex keys and NIP-19 identifiers do not need a network lookup.
    if (!value.includes("@")) return resolve(value);

    // NIP-05 names and DNS hostnames are case-insensitive.
    const key = value.toLowerCase();
    const now = Date.now();
    const cached = entries.get(key);

    if (cached && cached.expiresAt > now) {
      // Refresh insertion order so the bounded map behaves as an LRU cache.
      entries.delete(key);
      entries.set(key, cached);
      return cached.promise;
    }
    if (cached) entries.delete(key);

    const entry = {
      expiresAt: now + successTtl,
      promise: null
    };
    entry.promise = Promise.resolve()
      .then(() => resolve(value))
      .then(
        result => String(result || ""),
        () => ""
      )
      .then(result => {
        if (entries.get(key) === entry) {
          entry.expiresAt = Date.now() + (result ? successTtl : missTtl);
        }
        return result;
      });

    entries.set(key, entry);
    while (entries.size > capacity) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }

    return entry.promise;
  };
}
