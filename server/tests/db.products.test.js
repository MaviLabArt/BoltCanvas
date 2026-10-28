import { describe, expect, it } from "vitest";
import { freshDb } from "./helpers.js";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("db: products", () => {
  it("creates, lists, paginates, and filters public products", async () => {
    const { Products } = await freshDb();
    const p1 = Products.create({
      title: "Art One",
      description: "desc",
      priceSats: 1500,
      images: [PNG_DATA_URL]
    });
    const p2 = Products.create({
      title: "Hidden",
      description: "secret",
      priceSats: 999,
      images: []
    });
    Products.update(p2.id, { hidden: true });

    const all = Products.all({ includeImages: true });
    expect(all).toHaveLength(2);
    expect(all[0]).toHaveProperty("imageCount");

    const publics = Products.allPublic();
    expect(publics.find((p) => p.id === p1.id)).toBeTruthy();
    expect(publics.find((p) => p.id === p2.id)).toBeFalsy();

    const count = Products.count();
    expect(count).toBe(2);
    const page = Products.page({ limit: 1, offset: 0 });
    expect(page).toHaveLength(1);
  });

  it("normalizes image metadata when main image index is out of bounds", async () => {
    const { Products } = await freshDb();
    const product = Products.create({
      title: "Indexed",
      description: "desc",
      priceSats: 2000,
      images: [PNG_DATA_URL],
      mainImageIndex: 5
    });
    const stored = Products.get(product.id, { includeImages: true });
    expect(stored.mainImageIndex).toBe(0);
    const publics = Products.allPublic();
    expect(publics[0].mainImageIndex).toBe(0);
  });

  it("defaults new products to for_sale", async () => {
    const { Products } = await freshDb();
    const product = Products.create({
      title: "New artwork",
      priceSats: 2000,
      images: []
    });
    expect(product.artworkStatus).toBe("for_sale");
  });

  it("manual availability changes do not mark an artwork sold", async () => {
    const { Products } = await freshDb();
    const product = Products.create({
      title: "Temporarily unavailable",
      priceSats: 2000,
      images: []
    });

    const updated = Products.update(product.id, { available: false });
    expect(updated.available).toBe(false);
    expect(updated.artworkStatus).toBe("for_sale");
    expect(updated.lastSoldAt).toBe(0);
  });

  it("hides the public price for artworks not for sale", async () => {
    const { Products } = await freshDb();
    const product = Products.create({
      title: "Gifted artwork",
      priceSats: 5000,
      images: []
    });
    Products.update(product.id, { artworkStatus: "gifted" });

    const publicProduct = Products.allPublic().find((p) => p.id === product.id);
    expect(publicProduct.artworkStatus).toBe("gifted");
    expect(publicProduct).not.toHaveProperty("priceSats");
    expect(Products.get(product.id).priceSats).toBe(5000);
  });

  it("marks a unique artwork sold when its stock is consumed", async () => {
    const { Products } = await freshDb();
    const product = Products.create({
      title: "One of a kind",
      priceSats: 3000,
      images: []
    });

    const updated = Products.consumeStock(product.id);
    expect(updated.artworkStatus).toBe("sold");
    expect(updated.available).toBe(false);
    expect(updated.quantityAvailable).toBe(0);
    expect(updated.lastSoldAt).toBeGreaterThan(0);
  });

  it("marks multi-quantity artwork sold only when stock reaches zero", async () => {
    const { Products } = await freshDb();
    const product = Products.create({
      title: "Small edition",
      priceSats: 1000,
      images: [],
      isUnique: false,
      quantityAvailable: 2
    });

    const first = Products.consumeStock(product.id);
    expect(first.artworkStatus).toBe("for_sale");
    expect(first.quantityAvailable).toBe(1);
    expect(first.available).toBe(true);

    const second = Products.consumeStock(product.id);
    expect(second.artworkStatus).toBe("sold");
    expect(second.quantityAvailable).toBe(0);
    expect(second.lastSoldAt).toBeGreaterThan(0);
  });

  it("does not exhaust unlimited stock", async () => {
    const { Products } = await freshDb();
    const product = Products.create({
      title: "Open edition",
      priceSats: 1000,
      images: [],
      isUnique: false
    });

    const updated = Products.consumeStock(product.id, 3);
    expect(updated.artworkStatus).toBe("for_sale");
    expect(updated.available).toBe(true);
    expect(updated.quantityAvailable).toBe(null);
    expect(updated.lastSoldAt).toBe(0);
  });


  it("preserves manual order in admin and public listings", async () => {
    const { Products } = await freshDb();
    const available = Products.create({
      title: "Available artwork",
      priceSats: 2000,
      images: []
    });
    const unavailable = Products.create({
      title: "Archived artwork",
      priceSats: 3000,
      images: []
    });
    Products.update(unavailable.id, { available: false, artworkStatus: "sold" });

    Products.reorder([unavailable.id, available.id]);

    expect(Products.allForAdmin().map((p) => p.id))
      .toEqual([unavailable.id, available.id]);
    expect(Products.pageForAdmin({ limit: 2 }).map((p) => p.id))
      .toEqual([unavailable.id, available.id]);
    expect(Products.allPublic().map((p) => p.id))
      .toEqual([unavailable.id, available.id]);
  });


});
