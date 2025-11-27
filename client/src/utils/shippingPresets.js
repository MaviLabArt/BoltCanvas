import { CONTINENT_GROUPS } from "../constants/continents.js";

function normalizeStoredZones(list = []) {
  const raw = Array.isArray(list) ? list : [];
  return raw.map((zone, idx) => {
    const normalizedCountries = Array.isArray(zone?.countries)
      ? zone.countries
      : String(zone?.countries || "")
          .split(/[\s,]+/)
          .map((c) => c.trim())
          .filter(Boolean);
    return {
      id: zone?.id || `zone-${idx}`,
      name: zone?.name || `Zone ${idx + 1}`,
      countries: normalizedCountries.length ? normalizedCountries : ["ALL"],
      priceSats: Math.max(0, Number(zone?.priceSats || 0))
    };
  });
}

export function buildPresetZonesFromSettings(settings = {}, t = (value) => value) {
  const normalized = normalizeStoredZones(settings?.shippingZones);
  if (normalized.length) {
    return normalized.map((zone) => ({
      ...zone,
      countries: Array.isArray(zone.countries) ? zone.countries : []
    }));
  }
  const domesticCountry = String(settings?.shippingDomesticCountry || "IT").toUpperCase();
  const domesticPrice = Math.max(0, Number(settings?.shippingDomesticPriceSats || 0));
  const overrides = Array.isArray(settings?.shippingOverrides) ? settings.shippingOverrides : [];
  const continentPrices =
    settings?.shippingContinentPrices && typeof settings.shippingContinentPrices === "object"
      ? settings.shippingContinentPrices
      : {};
  const result = [];
  overrides.forEach((ov, idx) => {
    const country = String(ov?.country || "").toUpperCase();
    if (!country) return;
    result.push({
      id: ov.id || `ovr-${idx}`,
      name: `${t("Override", "Override")} ${country}`,
      countries: [country],
      priceSats: Math.max(0, Number(ov.priceSats || 0))
    });
  });
  result.push({
    id: "domestic",
    name: t("Nazionale", "Domestic"),
    countries: [domesticCountry],
    priceSats: domesticPrice
  });
  CONTINENT_GROUPS.forEach((group) => {
    const price = Math.max(0, Number(continentPrices?.[group.key] || 0));
    result.push({
      id: `ct-${group.key}`,
      name: group.label,
      countries: group.countries,
      priceSats: price
    });
  });
  const fallbackPrice = result.reduce((max, zone) => Math.max(max, Number(zone.priceSats || 0)), 0);
  result.push({
    id: "all",
    name: t("Resto del mondo", "Rest of world"),
    countries: ["ALL"],
    priceSats: fallbackPrice
  });
  return result;
}

export function makeInitialZoneOverrideState(initial) {
  const map = {};
  const entries = Array.isArray(initial?.shippingZoneOverrides) ? initial.shippingZoneOverrides : [];
  for (const entry of entries) {
    const id = String(entry?.id || "").trim();
    if (!id) continue;
    const price = Number(entry?.priceSats);
    map[id] = Number.isFinite(price) ? String(price) : "";
  }
  return map;
}

export function buildZoneOverridePayload(state = {}) {
  return Object.entries(state)
    .map(([id, raw]) => {
      const trimmedId = String(id || "").trim();
      if (!trimmedId) return null;
      if (raw === undefined || raw === null || raw === "") return null;
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0) return null;
      return { id: trimmedId, priceSats: Math.floor(num) };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}
