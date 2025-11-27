import React, { useEffect, useMemo, useState } from "react";
import api, { absoluteApiUrl } from "../services/api.js";
import AsyncButton from "../components/AsyncButton.jsx";
import { useAdminI18n } from "./i18n.jsx";
import {
  buildPresetZonesFromSettings,
  makeInitialZoneOverrideState,
  buildZoneOverridePayload
} from "../utils/shippingPresets.js";
import { COUNTRIES } from "../constants/countries.js";

const BASE_FIELD_DEFS = [
  { key: "priceSats", it: "Prezzo (sats)", en: "Price (sats)" }
];

const LEGACY_SHIPPING_FIELD_DEFS = [
  { key: "shippingItalySats", it: "Spedizione Italia (sats)", en: "Shipping Italy (sats)" },
  { key: "shippingEuropeSats", it: "Spedizione Europa (sats)", en: "Shipping Europe (sats)" },
  { key: "shippingWorldSats", it: "Spedizione fuori UE (sats)", en: "Shipping outside EU (sats)" }
];

const DEFAULT_DOMESTIC_COUNTRY = "IT";

const COUNTRY_NAME_MAP = COUNTRIES.reduce((acc, country) => {
  acc[country.code.toUpperCase()] = country.name;
  return acc;
}, {});

const CONTINENT_LABELS = {
  EU: { it: "Europa", en: "Europe" },
  AS: { it: "Asia", en: "Asia" },
  NA: { it: "Nord America", en: "North America" },
  SA: { it: "Sud America", en: "South America" },
  OC: { it: "Oceania", en: "Oceania" },
  AF: { it: "Africa", en: "Africa" },
  ME: { it: "Medio Oriente", en: "Middle East" }
};

const CONTINENT_DISPLAY_ORDER = ["EU", "AS", "NA", "SA", "OC", "AF", "ME"];

function getCountryName(code) {
  const upper = String(code || "").toUpperCase();
  return COUNTRY_NAME_MAP[upper] || upper || "";
}

function buildDomesticLabel(countryCode, t) {
  const name = getCountryName(countryCode);
  const domestic = t("Domestico", "Domestic");
  if (!name) return domestic;
  return `${name} (${domestic})`;
}

function getZoneLabel(zone, domesticLabel, t) {
  if (!zone) return "";
  const id = String(zone?.id || "");
  if (id === "domestic") {
    return domesticLabel || t("Domestico", "Domestic");
  }
  if (id === "all") {
    return t("Resto del mondo", "Rest of world");
  }
  if (id.startsWith("ct-")) {
    const key = id.slice(3).toUpperCase();
    const label = CONTINENT_LABELS[key];
    if (label) {
      return t(label.it, label.en);
    }
  }
  return zone?.name || t("Zona", "Zone");
}

function getZonePriority(zone, fallback) {
  const id = String(zone?.id || "");
  if (id === "domestic") return 0;
  if (id.startsWith("ct-")) {
    const key = id.slice(3).toUpperCase();
    const idx = CONTINENT_DISPLAY_ORDER.indexOf(key);
    return 10 + (idx >= 0 ? idx : 50);
  }
  if (id === "all") return 1000;
  return 100 + fallback;
}

function pickThumb(product) {
  if (!product) return "";
  const idx = Number.isInteger(product.mainImageIndex) ? product.mainImageIndex : 0;
  const thumb =
    product.mainImageThumbAbsoluteUrl ||
    product.mainImageThumbUrl ||
    (Array.isArray(product.thumbUrls) && product.thumbUrls.length
      ? product.thumbUrls[Math.min(Math.max(0, idx), product.thumbUrls.length - 1)] || product.thumbUrls[0]
      : null) ||
    (product.imageCount > 0
      ? (() => {
          const versionTag = product.imageVersion ? `?v=${encodeURIComponent(product.imageVersion)}` : "";
          const safeIdx = Math.min(Math.max(0, idx), Math.max(0, (product.imageCount || 1) - 1));
          return `/api/products/${product.id}/thumb/${safeIdx}${versionTag}`;
        })()
      : null);
  return absoluteApiUrl(thumb || "");
}

function toInputValue(value) {
  if (value === null || value === undefined) return "";
  if (Number.isNaN(Number(value))) return "";
  return String(value);
}

export default function BulkPricing() {
  const { t } = useAdminI18n();
  const [rows, setRows] = useState([]);
  const [originals, setOriginals] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [shippingZones, setShippingZones] = useState([]);
  const [domesticCountry, setDomesticCountry] = useState(DEFAULT_DOMESTIC_COUNTRY);
  const [hasCustomZones, setHasCustomZones] = useState(false);
  const [showShipping, setShowShipping] = useState(false);
  const hasConfiguredZones = shippingZones.length > 0;
  const baseFields = useMemo(
    () => BASE_FIELD_DEFS.map((f) => ({ key: f.key, label: t(f.it, f.en) })),
    [t]
  );
  const legacyFields = useMemo(
    () => LEGACY_SHIPPING_FIELD_DEFS.map((f) => ({ key: f.key, label: t(f.it, f.en) })),
    [t]
  );
  const allFields = useMemo(
    () => (hasConfiguredZones ? baseFields : [...baseFields, ...legacyFields]),
    [baseFields, legacyFields, hasConfiguredZones]
  );
  const visibleFields = useMemo(
    () => (showShipping ? allFields : baseFields),
    [showShipping, allFields, baseFields]
  );
  const fieldKeys = useMemo(() => allFields.map((f) => f.key), [allFields]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api
      .get("/admin/settings")
      .then((r) => {
        const data = r.data || {};
        const hasCustom = Array.isArray(data?.shippingZones) && data.shippingZones.length > 0;
        setHasCustomZones(hasCustom);
        const domesticCode = String(data?.shippingDomesticCountry || DEFAULT_DOMESTIC_COUNTRY).toUpperCase();
        setDomesticCountry(domesticCode);
        const zones = buildPresetZonesFromSettings(data, t);
        setShippingZones(zones);
      })
      .catch(() => {
        setShippingZones([]);
        setHasCustomZones(false);
        setDomesticCountry(DEFAULT_DOMESTIC_COUNTRY);
      });
  }, [t]);

  async function refresh() {
    try {
      setLoading(true);
      const r = await api.get("/admin/products?page=1&pageSize=200");
      const data = r.data;
      const list = Array.isArray(data?.items)
        ? data.items
        : (Array.isArray(data) ? data : []);
      const mapped = list.map((item) => {
        const overrideState = makeInitialZoneOverrideState(item);
        return {
          id: item.id,
          title: item.title || t("Senza titolo", "Untitled"),
          mainImageIndex: item.mainImageIndex || 0,
          mainImageThumbUrl: item.mainImageThumbAbsoluteUrl || item.mainImageThumbUrl || "",
          thumbUrls: item.thumbUrls,
          imageCount: item.imageCount || 0,
          imageVersion: item.imageVersion || "",
          priceSats: toInputValue(item.priceSats),
          shippingItalySats: toInputValue(item.shippingItalySats),
          shippingEuropeSats: toInputValue(item.shippingEuropeSats),
          shippingWorldSats: toInputValue(item.shippingWorldSats),
          zoneOverrides: overrideState
        };
      });
      const originalsMap = {};
      for (const it of list) {
        const overrideState = makeInitialZoneOverrideState(it);
        originalsMap[it.id] = {
          priceSats: Number(it.priceSats || 0),
          shippingItalySats: Number(it.shippingItalySats || 0),
          shippingEuropeSats: Number(it.shippingEuropeSats || 0),
          shippingWorldSats: Number(it.shippingWorldSats || 0),
          zoneOverrides: overrideState
        };
      }
      setRows(mapped);
      setOriginals(originalsMap);
    } catch (e) {
      console.warn("Failed to load products", e);
      setRows([]);
      setOriginals({});
    } finally {
      setLoading(false);
    }
  }

  function handleFieldChange(id, key, value) {
    if (!fieldKeys.includes(key)) return;
    setRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, [key]: value } : row))
    );
  }

  function handleOverrideChange(id, zoneId, value) {
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        const current = row.zoneOverrides || {};
        if (value === "" || value === null) {
          if (!Object.prototype.hasOwnProperty.call(current, zoneId)) return row;
          const next = { ...current };
          delete next[zoneId];
          return { ...row, zoneOverrides: next };
        }
        return { ...row, zoneOverrides: { ...current, [zoneId]: value } };
      })
    );
  }

  function encodeOverrides(state = {}) {
    return buildZoneOverridePayload(state)
      .map((entry) => `${entry.id}:${entry.priceSats}`)
      .join("|");
  }

  function isDirty(row) {
    const base = originals[row.id];
    if (!base) return false;
    const fieldsChanged = fieldKeys.some((key) => {
      const next = Math.max(0, Math.floor(Number(row[key] || 0)));
      return next !== Math.max(0, Math.floor(Number(base[key] || 0)));
    });
    if (fieldsChanged) return true;
    const overridesChanged = encodeOverrides(row.zoneOverrides) !== encodeOverrides(base.zoneOverrides);
    return overridesChanged;
  }

  const dirtyRows = useMemo(() => rows.filter(isDirty), [rows]);
  const zoneColumns = useMemo(() => {
    if (!shippingZones.length) return [];
    const domesticLabel = buildDomesticLabel(domesticCountry, t);
    return shippingZones
      .map((zone, idx) => ({
        id: zone?.id || `zone-${idx}`,
        label: getZoneLabel(zone, domesticLabel, t),
        presetPrice: Math.max(0, Number(zone?.priceSats || 0)),
        countries: Array.isArray(zone?.countries) ? zone.countries : [],
        priority: hasCustomZones ? idx : getZonePriority(zone, idx)
      }))
      .sort((a, b) => a.priority - b.priority)
      .map(({ priority, ...rest }) => rest);
  }, [shippingZones, domesticCountry, hasCustomZones, t]);
  const activeZoneColumns = showShipping ? zoneColumns : [];
  const tableColumns = 2 + visibleFields.length + activeZoneColumns.length + 1;

  async function saveChanges() {
    if (dirtyRows.length === 0) return;
    try {
      setSaving(true);
      for (const row of dirtyRows) {
        const payload = {
          priceSats: Math.max(0, Math.floor(Number(row.priceSats || 0))),
          shippingItalySats: Math.max(0, Math.floor(Number(row.shippingItalySats || 0))),
          shippingEuropeSats: Math.max(0, Math.floor(Number(row.shippingEuropeSats || 0))),
          shippingWorldSats: Math.max(0, Math.floor(Number(row.shippingWorldSats || 0))),
          shippingZoneOverrides: buildZoneOverridePayload(row.zoneOverrides)
        };
        await api.put(`/admin/products/${row.id}`, payload);
      }
      await refresh();
    } catch (e) {
      console.error("Unable to save pricing changes", e);
      alert(t("Non sono riuscito a salvare le modifiche. Riprova.", "Could not save changes. Please retry."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div>
          <h2 className="text-xl font-semibold">
            {t("Prezzi e Spedizioni", "Pricing & Shipping")}
          </h2>
          <p className="text-sm text-white/70">
            {t(
              "Aggiorna rapidamente prezzi e costi di spedizione per tutti i quadri.",
              "Quickly update prices and shipping costs for all products."
            )}
          </p>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          className="px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10 hover:ring-indigo-400/40"
          onClick={() => setShowShipping((prev) => !prev)}
          disabled={loading}
        >
          {showShipping
            ? t("Nascondi spedizioni", "Hide shipping")
            : t("Mostra spedizioni", "Show shipping")}
        </button>
        <AsyncButton
          onClick={saveChanges}
          loading={saving}
          disabled={dirtyRows.length === 0 || loading}
          busyText={t("Salvataggio in corso", "Saving changes")}
        >
          {t("Salva modifiche", "Save changes")} ({dirtyRows.length})
        </AsyncButton>
        <button
          type="button"
          className="px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10 hover:ring-indigo-400/40"
          onClick={refresh}
          disabled={loading || saving}
        >
          {t("Ricarica", "Reload")}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-white/10">
          <thead className="bg-slate-900/60">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-semibold text-white/70">
                {t("Opera", "Item")}
              </th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-white/70">
                {t("Anteprima", "Preview")}
              </th>
              {visibleFields.map((field) => (
                <th
                  key={field.key}
                  className="px-4 py-3 text-left text-sm font-semibold text-white/70"
                >
                  {field.label}
                </th>
              ))}
              {activeZoneColumns.map((column) => (
                <th
                  key={`zone-${column.id}`}
                  className="px-4 py-3 text-left text-sm font-semibold text-white/70"
                  title={(column.countries || []).join(", ")}
                >
                  {column.label}
                </th>
              ))}
              <th className="px-4 py-3 text-left text-sm font-semibold text-white/70">
                Stato
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {loading ? (
              <tr>
                <td colSpan={tableColumns} className="px-4 py-6 text-center text-white/60">
                  {t("Caricamento in corso…", "Loading…")}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={tableColumns} className="px-4 py-6 text-center text-white/60">
                  {t("Nessun prodotto trovato.", "No products found.")}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const dirty = isDirty(row);
                const thumb = pickThumb(row);
                return (
                  <tr
                    key={row.id}
                    className={dirty ? "bg-indigo-500/10" : ""}
                  >
                    <td className="px-4 py-3 text-sm font-medium">{row.title}</td>
                    <td className="px-4 py-3">
                      {thumb ? (
                        <img
                          src={thumb}
                          alt={row.title}
                          className="h-16 w-24 object-cover rounded-xl ring-1 ring-white/10"
                          loading="lazy"
                        />
                      ) : (
                        <div className="h-16 w-24 rounded-xl bg-slate-800 ring-1 ring-white/10 grid place-items-center text-xs text-white/50">
                          {t("Nessuna foto", "No photo")}
                        </div>
                      )}
                    </td>
                    {visibleFields.map((field) => (
                      <td key={field.key} className="px-4 py-3 align-middle">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={row[field.key]}
                          onChange={(e) => handleFieldChange(row.id, field.key, e.target.value)}
                          className="w-full max-w-[10rem] px-3 py-2 rounded-xl bg-slate-950 ring-1 ring-white/10"
                        />
                      </td>
                    ))}
                    {activeZoneColumns.map((column) => {
                      const overrideValue = row.zoneOverrides?.[column.id] ?? "";
                      const hasOverride =
                        overrideValue !== "" && overrideValue !== null && overrideValue !== undefined;
                      return (
                        <td key={column.id} className="px-4 py-3 align-top">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={overrideValue}
                                onChange={(e) => handleOverrideChange(row.id, column.id, e.target.value)}
                                placeholder={String(column.presetPrice)}
                                className="w-full px-3 py-2 rounded-xl bg-slate-950 ring-1 ring-white/10"
                              />
                              {hasOverride && (
                                <button
                                  type="button"
                                  className="px-2 py-1 rounded-lg bg-slate-800 ring-1 ring-white/10 text-xs whitespace-nowrap"
                                  onClick={() => handleOverrideChange(row.id, column.id, "")}
                                >
                                  {t("Reset", "Reset")}
                                </button>
                              )}
                            </div>
                            <div className="text-[10px] text-white/40">
                              {t("Preset", "Preset")}: {column.presetPrice} sats · {t("Vuoto = preset", "Empty = preset")}
                            </div>
                          </div>
                        </td>
                      );
                    })}
                    <td className="px-4 py-3 text-sm text-white/60">
                      {dirty ? t("Modificato", "Changed") : t("Invariato", "Unchanged")}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
