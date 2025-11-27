import { isEurope } from "../constants/countries.js";

/**
 * Normalize zones exactly like the server does to keep client previews aligned.
 * Accepts either arrays or CSV strings for countries.
 */
export function normalizeShippingZones(zones) {
  const arr = Array.isArray(zones) ? zones : [];
  const result = [];
  let counter = 0;
  for (const z of arr) {
    const rawCountries = Array.isArray(z?.countries)
      ? z.countries
      : String(z?.countries || "").split(/[\s,]+/);
    const countries = rawCountries
      .map((c) => String(c || "").trim().toUpperCase())
      .filter(Boolean);
    const price = Math.max(0, Number(z?.priceSats || 0));
    if (!countries.length && price === 0) continue;
    result.push({
      id: z?.id || `zone-${counter++}`,
      name: z?.name || `Zone ${counter}`,
      countries: countries.length ? countries : ["ALL"],
      priceSats: price
    });
  }
  return result;
}

/**
 * Compute the shipping quote the same way the server does during checkout.
 */
export function computeShippingQuote({ items, settings, country }) {
  const entries = (Array.isArray(items) ? items : []).map((it) => ({
    priceSats: Math.max(0, Number(it?.priceSats || 0)),
    shippingItalySats: Math.max(0, Number(it?.shippingItalySats || 0)),
    shippingEuropeSats: Math.max(0, Number(it?.shippingEuropeSats || 0)),
    shippingWorldSats: Math.max(0, Number(it?.shippingWorldSats || 0)),
    qty: Math.max(1, Math.floor(Number(it?.qty) || 1)),
    shippingZoneOverrides: normalizeZoneOverrides(it?.shippingZoneOverrides)
  }));

  const subtotalSats = entries.reduce((x, it) => x + it.priceSats * it.qty, 0);
  if (!entries.length) {
    return {
      subtotalSats: 0,
      shippingSats: 0,
      totalSats: 0,
      freeShippingApplied: true,
      zone: null,
      available: true,
      reason: "empty"
    };
  }

  const zones = normalizeShippingZones(settings?.shippingZones);
  const upperCountry = String(country || "").toUpperCase();

  let shippingSats = 0;
  let zone = null;
  let available = true;
  let reason = null;

  if (zones.length > 0) {
    const direct = zones.find((z) => (z.countries || []).includes(upperCountry));
    const fallback = zones.find((z) =>
      (z.countries || []).some((c) => c === "ALL" || c === "*")
    );
    zone = direct || fallback || null;
    if (!zone) {
      available = false;
      reason = "no_zone";
    } else {
      shippingSats = entries.reduce(
        (sum, it) =>
          sum + it.qty * resolveZonePriceForProduct(zone, it.shippingZoneOverrides),
        0
      );
      reason = shippingSats === 0 ? "zone_free" : "zone";
    }
  } else {
    shippingSats = entries.reduce((sum, it) => {
      if (upperCountry === "IT") return sum + it.qty * it.shippingItalySats;
      if (isEurope(upperCountry)) return sum + it.qty * it.shippingEuropeSats;
      return sum + it.qty * it.shippingWorldSats;
    }, 0);
    reason = shippingSats === 0 ? "fallback_zero" : "fallback";
  }

  return {
    subtotalSats,
    shippingSats,
    totalSats: subtotalSats + shippingSats,
    freeShippingApplied: shippingSats === 0,
    zone,
    available,
    reason
  };
}

function normalizeZoneOverrides(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const result = [];
  for (const entry of list) {
    const id = String(entry?.id || "").trim();
    if (!id || seen.has(id)) continue;
    const price = Math.max(0, Number(entry?.priceSats || 0));
    result.push({ id, priceSats: price });
    seen.add(id);
  }
  return result;
}

function resolveZonePriceForProduct(zone, overrides) {
  if (!zone) return 0;
  const list = Array.isArray(overrides) ? overrides : [];
  const match = list.find((ov) => ov.id === zone.id);
  const price = match ? match.priceSats : zone.priceSats;
  return Math.max(0, Number(price || 0));
}
