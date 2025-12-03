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
});
