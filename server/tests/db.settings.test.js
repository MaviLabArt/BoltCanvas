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
      heroLine: "Hello!",
      shippingZones: [{ id: "z1", countries: ["IT"], priceSats: 10 }],
      nostrCommentsEnabled: false
    });
    const next = Settings.getAll();
    expect(next.storeName).toBe("Test Store");
    expect(next.heroLine).toBe("Hello!");
    expect(next.shippingZones[0].id).toBe("z1");
    expect(next.nostrCommentsEnabled).toBe(false);
  });
});
