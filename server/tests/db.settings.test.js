import { describe, expect, it } from "vitest";
import { freshDb } from "./helpers.js";

describe("db: settings", () => {
  it("returns defaults and updates values", async () => {
    const { Settings } = await freshDb();
    const defaults = Settings.getAll();
    expect(defaults.storeName).toBeTruthy();
    expect(defaults.aboutTitle).toBeTruthy();

    Settings.setAll({
      storeName: "Test Store",
      featuredProductId: "artwork-test-123",
      heroLine: "Hello!",
      shippingZones: [{ id: "z1", countries: ["IT"], priceSats: 10 }],
      nostrCommentsEnabled: false
    });
    const next = Settings.getAll();
    expect(next.storeName).toBe("Test Store");
    expect(next.featuredProductId).toBe("artwork-test-123");
    expect(next.heroLine).toBe("Hello!");
    expect(next.shippingZones[0].id).toBe("z1");
    expect(next.nostrCommentsEnabled).toBe(false);
  });

  it("saves and preserves Nostr testimonial identifiers", async () => {
    const { Settings } = await freshDb();
    const identifiers = [
      "nevent1examplefirst",
      "nevent1examplesecond"
    ].join("\\n");

    Settings.setAll({ nostrTestimonials: identifiers });
    expect(Settings.getAll().nostrTestimonials).toBe(identifiers);

    Settings.setAll({ storeName: "Updated Store" });
    expect(Settings.getAll().nostrTestimonials).toBe(identifiers);
  });
});
