import { describe, expect, it, vi } from "vitest";
import { createNip05ResolutionCache } from "../nip05-cache.js";

describe("NIP-05 resolution cache", () => {
  it("deduplicates concurrent lookups and normalizes identifiers", async () => {
    const resolve = vi.fn(async identifier => identifier.toLowerCase());
    const cachedResolve = createNip05ResolutionCache(resolve);

    const results = await Promise.all([
      cachedResolve("Artist@Example.com"),
      cachedResolve("artist@example.COM")
    ]);

    expect(results).toEqual(["artist@example.com", "artist@example.com"]);
    expect(resolve).toHaveBeenCalledTimes(1);

    await cachedResolve("ARTIST@example.com");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("keeps different configured NIP-05 identifiers in separate entries", async () => {
    const resolve = vi.fn(async identifier => identifier);
    const cachedResolve = createNip05ResolutionCache(resolve);

    await expect(cachedResolve("one@example.com")).resolves.toBe("one@example.com");
    await expect(cachedResolve("two@example.com")).resolves.toBe("two@example.com");

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("expires negative results sooner than successful results", async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.fn(async () => "");
      const cachedResolve = createNip05ResolutionCache(resolve, {
        ttlMs: 60_000,
        negativeTtlMs: 1_000
      });

      await cachedResolve("missing@example.com");
      await cachedResolve("missing@example.com");
      expect(resolve).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_001);
      await cachedResolve("missing@example.com");
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the cache and evicts the least recently used identifier", async () => {
    const resolve = vi.fn(async identifier => identifier);
    const cachedResolve = createNip05ResolutionCache(resolve, { maxEntries: 2 });

    await cachedResolve("one@example.com");
    await cachedResolve("two@example.com");
    await cachedResolve("one@example.com");
    await cachedResolve("three@example.com");
    await cachedResolve("two@example.com");

    expect(resolve).toHaveBeenCalledTimes(4);
  });
});
