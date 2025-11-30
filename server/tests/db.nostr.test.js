import { describe, expect, it } from "vitest";
import { freshDb } from "./helpers.js";

describe("db: nostr carts", () => {
  it("stores and retrieves carts keyed by pubkey", async () => {
    const { NostrCarts } = await freshDb();
    const pk = "npub1test";
    const payload = { items: [{ id: "p1", qty: 2 }] };
    const saved = NostrCarts.set(pk, payload);
    expect(saved).toBe(true);
    expect(NostrCarts.get(pk)).toEqual(payload);
    NostrCarts.clear(pk);
    expect(NostrCarts.get(pk)).toBeNull();
  });
});
