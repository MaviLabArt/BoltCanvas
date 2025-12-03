import { describe, expect, it } from "vitest";
import { computeShippingQuote, normalizeShippingZones } from "./shipping.js";

describe("normalizeShippingZones", () => {
  it("uppercases country codes and drops empty entries", () => {
    const zones = normalizeShippingZones([
      { name: "Ignore", countries: "", priceSats: 0 },
      { name: "Europe", countries: "it, fr ,de", priceSats: "200" },
      { countries: ["*"], priceSats: 0 }
    ]);

    expect(zones).toHaveLength(2);
    expect(zones[0]).toMatchObject({
      name: "Europe",
      priceSats: 200
    });
    expect(zones[0].countries).toEqual(["IT", "FR", "DE"]);
    expect(zones[1].id).toMatch(/^zone-/);
    expect(zones[1].countries).toEqual(["*"]);
  });
});

describe("computeShippingQuote", () => {
  it("returns zero totals for an empty cart", () => {
    const quote = computeShippingQuote({
      items: [],
      settings: {},
      country: "IT"
    });

    expect(quote).toMatchObject({
      subtotalSats: 0,
      shippingSats: 0,
      totalSats: 0,
      freeShippingApplied: true,
      available: true,
      reason: "empty",
      zone: null
    });
  });

  it("applies zone-based shipping and overrides", () => {
    const quote = computeShippingQuote({
      items: [
        {
          priceSats: 1000,
          qty: 2,
          shippingZoneOverrides: [{ id: "it", priceSats: 50 }]
        },
        { priceSats: 2000, qty: 1 }
      ],
      settings: {
        shippingZones: [
          { id: "it", name: "Italy", countries: ["IT"], priceSats: 100 },
          { id: "rest", name: "World", countries: ["ALL"], priceSats: 800 }
        ]
      },
      country: "IT"
    });

    expect(quote.subtotalSats).toBe(4000);
    expect(quote.shippingSats).toBe(200);
    expect(quote.totalSats).toBe(4200);
    expect(quote.zone).toMatchObject({ id: "it" });
    expect(quote.available).toBe(true);
    expect(quote.reason).toBe("zone");
  });

  it("falls back to zero shipping when no zones are configured", () => {
    const quote = computeShippingQuote({
      items: [
        { priceSats: 1000, qty: 1 },
        { priceSats: 500, qty: 3 }
      ],
      settings: { shippingZones: [] },
      country: "PL"
    });

    expect(quote.subtotalSats).toBe(2500);
    expect(quote.shippingSats).toBe(0);
    expect(quote.totalSats).toBe(2500);
    expect(quote.reason).toBe("fallback_zero");
    expect(quote.available).toBe(true);
  });

  it("marks unavailable when no matching zone exists", () => {
    const quote = computeShippingQuote({
      items: [
        {
          priceSats: 1200,
          qty: 1
        }
      ],
      settings: {
        shippingZones: [{ id: "it", countries: ["IT"], priceSats: 25 }]
      },
      country: "US"
    });

    expect(quote.available).toBe(false);
    expect(quote.reason).toBe("no_zone");
    expect(quote.shippingSats).toBe(0);
    expect(quote.totalSats).toBe(1200);
  });
});
