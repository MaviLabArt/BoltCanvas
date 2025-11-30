import fs from "fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DB_PATH, freshDb } from "./helpers.js";

describe("db: orders", () => {
  it("creates and fetches orders with payment metadata", async () => {
    const { Orders } = await freshDb();
    const created = Orders.create({
      items: [{ productId: "p1", title: "Art", priceSats: 1000 }],
      subtotalSats: 1000,
      shippingSats: 100,
      totalSats: 1100,
      paymentHash: "hash-1",
      contactEmail: "buyer@example.com",
      address: "123 St",
      city: "Town",
      province: "TS",
      country: "IT",
      contactPhone: "123"
    });

    expect(created.status).toBe("PENDING");
    const byId = Orders.get(created.id);
    expect(byId.paymentHash).toBe("hash-1");
    expect(byId.totalSats).toBe(1100);

    const byHash = Orders.byPaymentHash("hash-1");
    expect(byHash?.id).toBe(created.id);
  });

  it("prunes stale pending orders", async () => {
    const { Orders } = await freshDb();
    const old = Orders.create({
      items: [],
      subtotalSats: 0,
      shippingSats: 0,
      totalSats: 0,
      paymentHash: "old-hash",
      address: "A",
      city: "B",
      province: "C",
      country: "IT",
      contactPhone: "123"
    });
    const db = new Database(DB_PATH);
    const oldTs = Date.now() - 10 * 24 * 60 * 60 * 1000;
    db.prepare(`UPDATE orders SET createdAt=? WHERE id=?`).run(oldTs, old.id);
    db.close();

    Orders.prunePendingOlderThan(24 * 60 * 60 * 1000); // 1 day
    const gone = Orders.get(old.id);
    expect(gone).toBeNull();
  });
});
