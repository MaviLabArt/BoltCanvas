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
  it("persists additional NIP-05 identities without changing the primary identity", async () => {
    const { Settings } = await freshDb();
    const primary = {
      nostrNpub: "npub-primary",
      nostrNip05: "isolabellart@isolabellart.it.com"
    };
    const identities = [
      { name: "beaunique", npub: "b".repeat(64) },
      { name: "postilla", npub: "c".repeat(64) }
    ];

    Settings.setAll(primary);
    Settings.setAll({ nostrAdditionalNip05Identities: identities });

    expect(Settings.getAll().nostrNpub).toBe(primary.nostrNpub);
    expect(Settings.getAll().nostrNip05).toBe(primary.nostrNip05);
    expect(Settings.getAll().nostrAdditionalNip05Identities).toEqual(identities);

    Settings.setAll({ storeName: "Updated Store" });
    expect(Settings.getAll().nostrAdditionalNip05Identities).toEqual(identities);
  });

  it("rejects malformed additional NIP-05 identities without partially saving settings", async () => {
    const { Settings } = await freshDb();
    Settings.setAll({ storeName: "Before", nostrNip05: "isolabellart" });

    const invalidInputs = [
      "not-json",
      "{}",
      null,
      Array.from({ length: 26 }, (_, i) => ({
        name: `alias${i}`,
        npub: "a".repeat(64)
      })),
      [{ name: "bad username", npub: "a".repeat(64) }],
      [{ name: "missing-key", npub: "" }],
      [{ name: "bad-key", npub: "npub-not-valid" }],
      [{ name: "isolabellart", npub: "a".repeat(64) }],
      [
        { name: "same", npub: "a".repeat(64) },
        { name: "SAME", npub: "b".repeat(64) }
      ]
    ];

    for (const identities of invalidInputs) {
      expect(() => Settings.setAll({
        storeName: "Must Not Be Saved",
        nostrAdditionalNip05Identities: identities
      })).toThrowError();
      expect(Settings.getAll().storeName).toBe("Before");
      expect(Settings.getAll().nostrAdditionalNip05Identities).toEqual([]);
    }
  });

  it("validates aliases against the already stored primary identity", async () => {
    const { Settings } = await freshDb();
    Settings.setAll({ nostrNip05: "isolabellart" });

    expect(() => Settings.setAll({
      nostrAdditionalNip05Identities: [
        { name: "isolabellart", npub: "a".repeat(64) }
      ]
    })).toThrowError(/Duplicate NIP-05 username/i);
  });

  it("rejects changing the primary NIP-05 name to an existing alias without partial writes", async () => {
    const { Settings } = await freshDb();
    Settings.setAll({
      storeName: "Before",
      nostrNip05: "isolabellart",
      nostrAdditionalNip05Identities: [
        { name: "beaunique", npub: "b".repeat(64) }
      ]
    });

    expect(() => Settings.setAll({
      storeName: "Must Not Be Saved",
      nostrNip05: "beaunique"
    })).toThrowError(/Duplicate NIP-05 username/i);
    expect(Settings.getAll().storeName).toBe("Before");
    expect(Settings.getAll().nostrNip05).toBe("isolabellart");
  });

  it("accepts a valid npub and stores normalized alias data", async () => {
    const { Settings } = await freshDb();
    const validNpub = "npub1ty8ptvutuptqxzws9nua6gpukttpmpe89hts3teatgg9ymefl6uspn6fgn";

    Settings.setAll({
      nostrAdditionalNip05Identities: [
        { name: " BeaUnique ", npub: validNpub }
      ]
    });

    expect(Settings.getAll().nostrAdditionalNip05Identities).toEqual([
      { name: "beaunique", npub: validNpub }
    ]);
  });

});
