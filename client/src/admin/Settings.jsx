// client/src/admin/Settings.jsx
import React, { useEffect, useMemo, useState } from "react";
import api from "../services/api.js";
import AsyncButton from "../components/AsyncButton.jsx";
import MarkdownEditor from "./components/MarkdownEditor.jsx";
import { useAdminI18n } from "./i18n.jsx";
import { COUNTRIES } from "../constants/countries.js";
import { CONTINENT_GROUPS } from "../constants/continents.js";
import { normalizeShippingZones } from "../utils/shipping.js";
import { renderMarkdown } from "../utils/markdown.js";

async function fileToDataUrl(file) {
  const r = new FileReader();
  return new Promise((resolve, reject) => {
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function HelpBox({ children }) {
  return (
    <div className="text-xs text-white/70 bg-slate-950 ring-1 ring-white/10 rounded-2xl p-3 leading-relaxed">
      {children}
    </div>
  );
}

function parseListInput(raw) {
  return String(raw || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(val) {
  if (Array.isArray(val)) return val.join("\n");
  return String(val || "");
}

export default function Settings() {
  const { t } = useAdminI18n();
  const [s, setS] = useState({
    storeName: "Your Shop Name",
    contactNote: "",
    logo: "",
    logoDark: "",
    logoLight: "",
    favicon: "",
    // New/extended fields
    heroLine: "Quality pieces made for you and shipped with care.",
    productsHeading: "Featured Products",
    radiusScale: "3xl",

    // --- NEW editable content ---
    aboutTitle: "About Us",
    aboutBody: "Use this space to introduce who you are, what you create, and how you work. Update it with your story and what customers can expect.",
    aboutImage: "",
    heroCtaLabel: "Learn more",
    heroCtaHref: "/about",

    shippingTitle: "How shipping works",
    shippingBullet1: "Ships worldwide from HQ.",
    shippingBullet2: "Typical delivery 3–7 days in region.",
    shippingBullet3: "Packed securely with tracking.",
    shippingZones: [],
    shippingMode: "simple",
    shippingDomesticCountry: "IT",
    shippingDomesticPriceSats: 0,
    shippingContinentPrices: { EU: 0, AS: 0, NA: 0, SA: 0, OC: 0, AF: 0, ME: 0 },
    shippingOverrides: [],

    commissionTitle: "Commissions & Contact",
    commissionBody: "Open to custom requests - share your idea and I will reply with options.",
    commissionCtaLabel: "Write to me",
    commissionCtaHref: "/about",

    // --- NEW: Nostr & Lightning ---
    nostrNpub: "",
    nostrNip05: "",
    nostrRelays: ["wss://relay.damus.io", "wss://nos.lol"],
    nostrDefaultHashtags: "#shop #shopping #lightning",
    nostrCommentsEnabled: true,
    nostrBlockedPubkeys: [],
    lightningAddress: "",

    // --- NEW: Theme selector ---
    themeChoice: "dark",

    // --- EMAIL: only signature stays editable (credentials come from .env) ---
    smtpSignature: "Thanks for your support,\nYour Shop Name",

    // --- Notification templates (DM + Email subject/body per status) ---
    notifyDmTemplate_PAID: "",
    notifyDmTemplate_PREPARATION: "",
    notifyDmTemplate_SHIPPED: "",

    notifyEmailSubject_PAID: "",
    notifyEmailSubject_PREPARATION: "",
    notifyEmailSubject_SHIPPED: "",

    notifyEmailBody_PAID: "",
    notifyEmailBody_PREPARATION: "",
    notifyEmailBody_SHIPPED: "",
  });
  const continentPrices = (s.shippingContinentPrices && typeof s.shippingContinentPrices === "object")
    ? s.shippingContinentPrices
    : { EU: 0, AS: 0, NA: 0, SA: 0, OC: 0, AF: 0, ME: 0 };
  const overrides = Array.isArray(s.shippingOverrides) ? s.shippingOverrides : [];
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const validation = useMemo(() => {
    const errors = {
      domesticPrice: "",
      continentPrices: {},
      overrides: []
    };
    let hasErrors = false;

    const parsePrice = (raw) => {
      if (raw === "" || raw === null || raw === undefined) return 0;
      const num = Number(raw);
      return Number.isFinite(num) ? num : NaN;
    };

    const domestic = parsePrice(s.shippingDomesticPriceSats);
    if (!Number.isFinite(domestic) || domestic < 0) {
      errors.domesticPrice = t("Inserisci un numero maggiore o uguale a 0.", "Enter a number greater than or equal to 0.");
      hasErrors = true;
    }

    CONTINENT_GROUPS.forEach((group) => {
      const val = parsePrice(continentPrices?.[group.key]);
      if (!Number.isFinite(val) || val < 0) {
        errors.continentPrices[group.key] = t("Prezzo non valido.", "Invalid price.");
        hasErrors = true;
      }
    });

    const seenCountries = new Set();
    overrides.forEach((ov, idx) => {
      const entry = { country: "", price: "" };
      const country = String(ov.country || "").trim();
      const hasPriceInput = ov.priceSats !== "" && ov.priceSats !== null && ov.priceSats !== undefined;
      const priceNum = parsePrice(ov.priceSats);

      if (!country) {
        entry.country = t("Scegli un paese o rimuovi questa riga.", "Pick a country or remove this row.");
      } else {
        const upper = country.toUpperCase();
        if (seenCountries.has(upper)) {
          entry.country = t("Paese duplicato.", "Duplicate country.");
        }
        seenCountries.add(upper);
      }

      if (!hasPriceInput || !Number.isFinite(priceNum) || priceNum < 0) {
        entry.price = t("Inserisci un numero maggiore o uguale a 0.", "Enter a number greater than or equal to 0.");
      }

      if (entry.country || entry.price) hasErrors = true;
      errors.overrides[idx] = entry;
    });

    return { errors, hasErrors };
  }, [continentPrices, overrides, s.shippingDomesticPriceSats, t]);

  useEffect(() => {
    api.get("/admin/settings").then((r) => {
      const hydrated = hydrateSimplePresetFromZones(r.data || {});
      const { nostrBlockedHashtags: _ignoredBlockedHashtags, ...rest } = hydrated;
      setS((prev) => ({ ...prev, ...rest, shippingMode: "simple" }));
    });
  }, []);

  const addOverride = () => {
    setS((prev) => ({
      ...prev,
      shippingOverrides: [...(Array.isArray(prev.shippingOverrides) ? prev.shippingOverrides : []), {
        country: "",
        priceSats: 0
      }]
    }));
  };
  const updateOverride = (idx, patch) => {
    setS((prev) => {
      const list = Array.isArray(prev.shippingOverrides) ? prev.shippingOverrides.slice() : [];
      if (!list[idx]) return prev;
      list[idx] = { ...list[idx], ...patch };
      return { ...prev, shippingOverrides: list };
    });
  };
  const removeOverride = (idx) => {
    setS((prev) => {
      const list = Array.isArray(prev.shippingOverrides) ? prev.shippingOverrides.slice() : [];
      return { ...prev, shippingOverrides: list.filter((_, i) => i !== idx) };
    });
  };

  const buildSimpleZones = (state) => {
    const domesticCountry = String(state.shippingDomesticCountry || "IT").toUpperCase();
    const priceMap = (state.shippingContinentPrices && typeof state.shippingContinentPrices === "object")
      ? state.shippingContinentPrices
      : {};
    const overridesList = Array.isArray(state.shippingOverrides) ? state.shippingOverrides : [];
    const zonesOut = [];
    const pushZone = (zone) => {
      const countries = Array.from(new Set((zone.countries || []).map((c) => String(c || "").toUpperCase()).filter(Boolean)));
      if (!countries.length) return;
      const priceSats = Math.max(0, Number(zone.priceSats || 0));
      zonesOut.push({
        id: zone.id || `zone-${zonesOut.length}`,
        name: zone.name || "Zone",
        countries,
        priceSats
      });
    };

    overridesList.forEach((ov, idx) => {
      const country = String(ov?.country || "").toUpperCase();
      if (!country) return;
      pushZone({
        id: `ovr-${idx}`,
        name: `${t("Override", "Override")} ${country}`,
        countries: [country],
        priceSats: Math.max(0, Number(ov.priceSats || 0))
      });
    });

    pushZone({
      id: "domestic",
      name: t("Nazionale", "Domestic"),
      countries: [domesticCountry],
      priceSats: Math.max(0, Number(state.shippingDomesticPriceSats || 0))
    });

    CONTINENT_GROUPS.forEach((group) => {
      const price = Math.max(0, Number(priceMap[group.key] || 0));
      pushZone({
        id: `ct-${group.key}`,
        name: group.label,
        countries: group.countries,
        priceSats: price
      });
    });

    // Fallback: ensure every destination has a price by adding ALL with the max configured
    const maxPrice = zonesOut.reduce((m, z) => Math.max(m, Number(z.priceSats || 0)), 0);
    pushZone({
      id: "all",
      name: t("Resto del mondo", "Rest of world"),
      countries: ["ALL"],
      priceSats: maxPrice
    });

    return zonesOut;
  };

  async function pickAboutImage(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const dataUrl = await fileToDataUrl(f);
    setS((prev) => ({ ...prev, aboutImage: dataUrl }));
  }

  async function pickLogoImage(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const dataUrl = await fileToDataUrl(f);
    setS((prev) => ({ ...prev, logo: dataUrl, logoDark: dataUrl }));
  }

  async function pickLogoLightImage(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const dataUrl = await fileToDataUrl(f);
    setS((prev) => ({ ...prev, logoLight: dataUrl }));
  }

  async function pickFaviconImage(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const dataUrl = await fileToDataUrl(f);
    setS((prev) => ({ ...prev, favicon: dataUrl }));
  }

  async function save() {
    if (validation.hasErrors) {
      setMessage("");
      setError(t("Correggi i campi evidenziati prima di salvare.", "Fix the highlighted fields before saving."));
      return;
    }
    try {
      setSaving(true);
      setMessage("");
      setError("");
      const normalizedOverrides = overrides
        .map((ov, idx) => ({
          id: ov.id || `ovr-${idx}`,
          country: String(ov.country || "").toUpperCase(),
          priceSats: Math.max(0, Number(ov.priceSats || 0))
        }))
        .filter((ov) => ov.country);
      const normalizedContinentPrices = CONTINENT_GROUPS.reduce((acc, g) => {
        acc[g.key] = Math.max(0, Number(continentPrices?.[g.key] || 0));
        return acc;
      }, {});
      const zonesToSend = buildSimpleZones({
        ...s,
        shippingContinentPrices: normalizedContinentPrices,
        shippingOverrides: normalizedOverrides
      });
      const { nostrBlockedHashtags: _dropBlockedHashtags, ...stateWithoutBlockedHashtags } = s;
      const payload = {
        ...stateWithoutBlockedHashtags,
        // ensure relays are serialized correctly (server accepts string/array)
        nostrRelays: Array.isArray(s.nostrRelays)
          ? s.nostrRelays
          : String(s.nostrRelays || ""),
        nostrBlockedPubkeys: Array.isArray(s.nostrBlockedPubkeys)
          ? s.nostrBlockedPubkeys
          : parseListInput(s.nostrBlockedPubkeys),
        shippingZones: zonesToSend,
        shippingMode: "simple",
        shippingDomesticCountry: s.shippingDomesticCountry || "IT",
        shippingDomesticPriceSats: Math.max(0, Number(s.shippingDomesticPriceSats || 0)),
        shippingContinentPrices: normalizedContinentPrices,
        shippingOverrides: normalizedOverrides
      };
      const r = await api.put("/admin/settings", payload);
      setS((prev) => ({ ...prev, ...r.data }));
      setMessage(t("Impostazioni salvate.", "Settings saved."));
    } catch (e) {
      const msg =
        e?.response?.data?.error ||
        e?.message ||
        t("Errore durante il salvataggio delle impostazioni.", "Error while saving settings.");
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10 max-w-3xl">
      <div className="text-lg font-semibold">{t("Impostazioni Negozio", "Store Settings")}</div>

      <div className="mt-4 grid gap-3">
        <input
          className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
          placeholder={t("Nome negozio", "Store name")}
          value={s.storeName}
          onChange={(e) => setS({ ...s, storeName: e.target.value })}
        />
        <textarea
          rows={3}
          className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
          placeholder={t("Nota di contatto", "Contact note")}
          value={s.contactNote}
          onChange={(e) => setS({ ...s, contactNote: e.target.value })}
        />

        {/* Homepage heading for the grid */}
        <input
          className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
          placeholder={t("Titolo homepage (lista quadri), es. Opere disponibili", "Homepage title (product grid), e.g. Available works")}
          value={s.productsHeading}
          onChange={(e) =>
            setS({ ...s, productsHeading: e.target.value })
          }
        />

        {/* Hero line (one-sentence artist statement + location) */}
        <input
          className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
          placeholder={t('Riga sotto il titolo, es. "Original oil on canvas by M. V., Milan."', 'Line under the title, e.g. "Original oil on canvas by M. V., Milan."')}
          value={s.heroLine}
          onChange={(e) => setS({ ...s, heroLine: e.target.value })}
        />

        {/* Card corner radius scale */}
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-white/70 mb-1">
              {t("Raggio angoli schede (card)", "Card corner radius")}
            </label>
            <select
              className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
              value={s.radiusScale}
              onChange={(e) =>
                setS({ ...s, radiusScale: e.target.value })
              }
            >
              <option value="xl">xl</option>
              <option value="2xl">2xl</option>
              <option value="3xl">3xl</option>
            </select>
          </div>
        </div>
      </div>

      {/* Logo */}
      <div className="mt-6 flex flex-col gap-3">
        <div className="text-sm text-white/70">
          {t(
            "Puoi caricare un logo per i temi scuri e uno per il tema chiaro. Se manca il logo, verrà usato il Nome negozio come titolo.",
            "You can upload one logo for dark themes and one for the light theme. If no logo is uploaded, the Store name will be used as the title."
          )}
        </div>
        <div className="flex items-center gap-3">
        <label className="px-3 py-2 rounded-2xl bg-slate-950 ring-1 ring-white/10 cursor-pointer">
          {t("Carica logo", "Upload logo")}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={pickLogoImage}
          />
        </label>
        {s.logoDark || s.logo ? (
          <>
            <img
              src={s.logoDark || s.logo}
              alt="Logo preview"
              className="h-10 w-auto rounded-xl object-contain ring-1 ring-white/10 bg-black/20"
            />
            <button
              type="button"
              className="px-3 py-2 rounded-2xl bg-slate-950 ring-1 ring-white/10"
              onClick={() => setS((prev) => ({ ...prev, logo: "", logoDark: "" }))}
            >
              {t("Rimuovi", "Remove")}
            </button>
          </>
        ) : (
          <div className="text-xs text-white/50 space-y-1">
            <div>
              {t(
                "Consigliato: PNG orizzontale con sfondo trasparente.",
                "Recommended: horizontal PNG with transparent background."
              )}
            </div>
            <div>
              {t(
                "Se non carichi un logo, verrà usato il Nome negozio come titolo principale in homepage.",
                "If you don't upload a logo, the Store name will be used as the main hero title on the homepage."
              )}
            </div>
          </div>
        )}
        </div>

        <div className="flex items-center gap-3">
          <label className="px-3 py-2 rounded-2xl bg-slate-950 ring-1 ring-white/10 cursor-pointer">
            {t("Carica logo per tema chiaro", "Upload logo for light theme")}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={pickLogoLightImage}
            />
          </label>
          {s.logoLight ? (
            <>
              <img
                src={s.logoLight}
                alt="Light logo preview"
                className="h-10 w-auto rounded-xl object-contain ring-1 ring-white/10 bg-black/20"
              />
              <button
                type="button"
                className="px-3 py-2 rounded-2xl bg-slate-950 ring-1 ring-white/10"
                onClick={() => setS((prev) => ({ ...prev, logoLight: "" }))}
              >
                {t("Rimuovi", "Remove")}
              </button>
            </>
          ) : (
            <div className="text-xs text-white/50">
              {t(
                "Opzionale: logo alternativo da usare sul tema chiaro.",
                "Optional: alternate logo to be used on the light theme."
              )}
            </div>
          )}
        </div>
      </div>

      {/* Favicon */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="px-3 py-2 rounded-2xl bg-slate-950 ring-1 ring-white/10 cursor-pointer">
          {t("Carica favicon", "Upload favicon")}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={pickFaviconImage}
          />
        </label>
        {s.favicon ? (
          <>
            <img
              src={s.favicon}
              alt="Favicon preview"
              className="h-8 w-8 rounded-lg object-contain ring-1 ring-white/10 bg-black/20"
            />
            <button
              type="button"
              className="px-3 py-2 rounded-2xl bg-slate-950 ring-1 ring-white/10"
              onClick={() => setS((prev) => ({ ...prev, favicon: "" }))}
            >
              {t("Rimuovi", "Remove")}
            </button>
          </>
        ) : (
          <div className="text-xs text-white/50">
            {t("Consigliato: PNG quadrato (32–64px). Il logo non verrà usato come favicon.", "Recommended: square PNG (32–64px). Logo will not be used as favicon.")}
          </div>
        )}
      </div>

      {/* --- HERO CTA --- */}
      <div className="mt-6 grid sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm text-white/70 mb-1">
            {t("Etichetta CTA hero", "Hero CTA label")}
          </label>
          <input
            className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            value={s.heroCtaLabel}
            onChange={(e) =>
              setS({ ...s, heroCtaLabel: e.target.value })
            }
          />
        </div>
        <div>
          <label className="block text-sm text-white/70 mb-1">
            {t("Link CTA hero (es. /about)", "Hero CTA link (e.g. /about)")}
          </label>
          <input
            className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            value={s.heroCtaHref}
            onChange={(e) =>
              setS({ ...s, heroCtaHref: e.target.value })
            }
          />
        </div>
      </div>

      {/* --- THEME SELECTOR --- */}
      <div className="mt-8">
        <div className="text-lg font-semibold mb-2">Tema</div>
        <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-3">
          <label className="flex items-center gap-2 px-3 py-2 rounded-2xl bg-slate-950 ring-1 ring-white/10 cursor-pointer">
            <input
              type="radio"
              name="themeChoice"
              value="dark"
              checked={s.themeChoice === "dark"}
              onChange={(e) =>
                setS({ ...s, themeChoice: e.target.value })
              }
            />
            <span>Dark Ink</span>
          </label>
          <label className="flex items-center gap-2 px-3 py-2 rounded-2xl bg-slate-950 ring-1 ring-white/10 cursor-pointer">
            <input
              type="radio"
              name="themeChoice"
              value="ember"
              checked={s.themeChoice === "ember"}
              onChange={(e) =>
                setS({ ...s, themeChoice: e.target.value })
              }
            />
            <span>Ember Night</span>
          </label>
          <label className="flex items-center gap-2 px-3 py-2 rounded-2xl bg-slate-950 ring-1 ring-white/10 cursor-pointer">
            <input
              type="radio"
              name="themeChoice"
              value="light"
              checked={s.themeChoice === "light"}
              onChange={(e) =>
                setS({ ...s, themeChoice: e.target.value })
              }
            />
            <span>Light Atelier</span>
          </label>
          <label className="flex items-center gap-2 px-3 py-2 rounded-2xl bg-slate-950 ring-1 ring-white/10 cursor-pointer">
            <input
              type="radio"
              name="themeChoice"
              value="auto"
              checked={s.themeChoice === "auto"}
            onChange={(e) =>
              setS({ ...s, themeChoice: e.target.value })
            }
          />
            <span>{t("Auto (sistema)", "Auto (system)")}</span>
          </label>
        </div>
      </div>

      {/* --- ABOUT --- */}
      <div className="mt-8">
        <div className="text-lg font-semibold mb-2">{t("Sezione “About”", "“About” section")}</div>
        <div className="grid gap-3">
          <input
            className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            placeholder={t("Titolo About", "About title")}
            value={s.aboutTitle}
            onChange={(e) => setS({ ...s, aboutTitle: e.target.value })}
          />
          <MarkdownEditor
            value={s.aboutBody}
            onChange={(val) => setS({ ...s, aboutBody: val })}
            placeholder={t("Testo lungo o Markdown semplice", "Long text or simple Markdown")}
            showPreview={false}
          />
          <div className="flex items-center gap-3">
            <label className="px-3 py-2 rounded-2xl bg-slate-950 ring-1 ring-white/10 cursor-pointer">
              {t("Carica foto About", "Upload About photo")}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={pickAboutImage}
              />
            </label>
            {s.aboutImage ? (
              <img
                src={s.aboutImage}
                alt="About preview"
                className="h-14 w-14 rounded-xl object-cover ring-1 ring-white/10"
              />
            ) : (
              <div className="text-xs text-white/50">
                {t("Nessuna immagine", "No image yet")}
              </div>
            )}
            {s.aboutImage && (
              <button
                className="px-3 py-2 rounded-2xl bg-slate-950 ring-1 ring-white/10"
                onClick={() =>
                  setS((prev) => ({ ...prev, aboutImage: "" }))
                }
              >
                {t("Rimuovi", "Remove")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* --- SHIPPING BULLETS --- */}
      <div className="mt-8">
        <div className="text-lg font-semibold mb-2">{t("Blocchetto Spedizioni", "Shipping block")}</div>
        <input
          className="mb-2 w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
          placeholder={t("Titolo", "Title")}
          value={s.shippingTitle}
          onChange={(e) =>
            setS({ ...s, shippingTitle: e.target.value })
          }
        />
        <div className="grid sm:grid-cols-3 gap-3">
          <input
            className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            value={s.shippingBullet1}
            onChange={(e) =>
              setS({ ...s, shippingBullet1: e.target.value })
            }
            placeholder={t("Punto 1", "Bullet 1")}
          />
          <input
            className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            value={s.shippingBullet2}
            onChange={(e) =>
              setS({ ...s, shippingBullet2: e.target.value })
            }
            placeholder={t("Punto 2", "Bullet 2")}
          />
          <input
            className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            value={s.shippingBullet3}
            onChange={(e) =>
              setS({ ...s, shippingBullet3: e.target.value })
            }
            placeholder={t("Punto 3", "Bullet 3")}
          />
        </div>
      </div>

      {/* --- COMMISSION CALLOUT --- */}
      <div className="mt-8">
        <div className="text-lg font-semibold mb-2">
          {t("Callout Commissioni / Contatti", "Commission / Contact callout")}
        </div>
        <input
          className="mb-2 w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
          placeholder={t("Titolo", "Title")}
          value={s.commissionTitle}
          onChange={(e) =>
            setS({ ...s, commissionTitle: e.target.value })
          }
        />
        <textarea
          rows={4}
          className="mb-2 w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
          placeholder={t("Testo", "Body text")}
          value={s.commissionBody}
          onChange={(e) =>
            setS({ ...s, commissionBody: e.target.value })
          }
        />
        <div className="grid sm:grid-cols-2 gap-3">
          <input
            className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            value={s.commissionCtaLabel}
            onChange={(e) =>
              setS({ ...s, commissionCtaLabel: e.target.value })
            }
            placeholder={t("Etichetta bottone", "Button label")}
          />
          <input
            className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            value={s.commissionCtaHref}
            onChange={(e) =>
              setS({ ...s, commissionCtaHref: e.target.value })
            }
            placeholder={t("Link (es. /about o mailto:)", "Link (e.g. /about or mailto:)")}
          />
        </div>
      </div>

      {/* --- SHIPPING PRESET --- */}
      <div className="mt-8 rounded-3xl bg-slate-950 ring-1 ring-white/10 p-4 space-y-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:gap-4">
          <div className="flex-1">
            <div className="text-lg font-semibold">{t("Preset spedizione", "Shipping preset")}</div>
            <div className="text-sm text-white/60">
              {t("Tre livelli: domestico, continenti, override per singoli paesi. Generiamo le zone automaticamente.", "Three tiers: domestic, continents, overrides for single countries. We generate the zones for you.")}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-white/70 mb-1">{t("Paese domestico", "Domestic country")}</label>
              <select
                className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
                value={s.shippingDomesticCountry}
                onChange={(e) => setS({ ...s, shippingDomesticCountry: e.target.value })}
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-white/70 mb-1">{t("Prezzo domestico (sats)", "Domestic price (sats)")}</label>
              <input
                type="number"
                min={0}
                step="1"
                className={`w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ${
                  validation.errors.domesticPrice ? "ring-rose-400/70 bg-rose-950/20" : "ring-white/10"
                }`}
                value={s.shippingDomesticPriceSats}
                onChange={(e) => setS({ ...s, shippingDomesticPriceSats: e.target.value })}
                placeholder="0"
              />
              {validation.errors.domesticPrice ? (
                <div className="text-xs text-amber-300 mt-1">{validation.errors.domesticPrice}</div>
              ) : null}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
            {CONTINENT_GROUPS.map((g) => (
              <div key={g.key}>
                <label className="block text-sm text-white/70 mb-1">{g.label}</label>
                <input
                  type="number"
                  min={0}
                  step="1"
                  className={`w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ${
                    validation.errors.continentPrices?.[g.key]
                      ? "ring-rose-400/70 bg-rose-950/20"
                      : "ring-white/10"
                  }`}
                  value={continentPrices?.[g.key] ?? 0}
                  onChange={(e) =>
                    setS((prev) => ({
                      ...prev,
                      shippingContinentPrices: { ...(prev.shippingContinentPrices || {}), [g.key]: e.target.value }
                    }))
                  }
                  placeholder="0"
                />
                {validation.errors.continentPrices?.[g.key] ? (
                  <div className="text-xs text-amber-300 mt-1">
                    {validation.errors.continentPrices[g.key]}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 p-3 space-y-3">
            <div className="flex items-center gap-3">
              <div className="font-semibold">{t("Override per paese", "Country overrides")}</div>
              <div className="flex-1" />
              <button
                type="button"
                className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10"
                onClick={addOverride}
              >
                {t("Aggiungi override", "Add override")}
              </button>
            </div>
            {overrides.length === 0 && (
              <div className="text-white/60 text-sm">
                {t("Nessun override. Useremo domestico/continente.", "No overrides. We’ll use domestic/continent pricing.")}
              </div>
            )}
            <div className="grid gap-3">
              {overrides.map((ov, idx) => (
                <div key={idx} className="grid md:grid-cols-3 gap-2 items-end">
                  <div>
                    <label className="block text-xs text-white/60 mb-1">{t("Paese", "Country")}</label>
                    <select
                      className={`w-full px-3 py-2 rounded-xl bg-slate-950 ring-1 ${
                        validation.errors.overrides[idx]?.country
                          ? "ring-rose-400/70 bg-rose-950/20"
                          : "ring-white/10"
                      }`}
                      value={ov.country || ""}
                      onChange={(e) => updateOverride(idx, { country: e.target.value })}
                    >
                      <option value="">{t("Seleziona", "Select")}</option>
                      {COUNTRIES.map((c) => (
                        <option key={c.code} value={c.code}>{c.name}</option>
                      ))}
                    </select>
                    {validation.errors.overrides[idx]?.country ? (
                      <div className="text-xs text-amber-300 mt-1">
                        {validation.errors.overrides[idx].country}
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <label className="block text-xs text-white/60 mb-1">{t("Prezzo (sats)", "Price (sats)")}</label>
                    <input
                      type="number"
                      min={0}
                      step="1"
                      className={`w-full px-3 py-2 rounded-xl bg-slate-950 ring-1 ${
                        validation.errors.overrides[idx]?.price
                          ? "ring-rose-400/70 bg-rose-950/20"
                          : "ring-white/10"
                      }`}
                      value={ov.priceSats ?? 0}
                      onChange={(e) => updateOverride(idx, { priceSats: e.target.value })}
                    />
                    {validation.errors.overrides[idx]?.price ? (
                      <div className="text-xs text-amber-300 mt-1">
                        {validation.errors.overrides[idx].price}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-end">
                    <button
                      type="button"
                      className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10 h-[42px]"
                      onClick={() => removeOverride(idx)}
                    >
                      {t("Rimuovi", "Remove")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 p-3">
            <div className="font-semibold mb-2">{t("Anteprima zone generate", "Generated zones preview")}</div>
            <div className="grid gap-2 md:grid-cols-2">
              {buildSimpleZones({
                ...s,
                shippingContinentPrices: continentPrices,
                shippingOverrides: overrides
              }).map((z, idx) => (
                <div key={idx} className="rounded-xl bg-slate-950 ring-1 ring-white/10 p-2 text-sm">
                  <div className="font-medium">{z.name}</div>
                  <div className="text-white/60 truncate">{(z.countries || []).join(",")}</div>
                  <div className="text-white/80 mt-1">{t("Prezzo", "Price")}: {z.priceSats} sats</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* --- NOSTR + LIGHTNING --- */}
      <div className="mt-10 rounded-3xl p-4 bg-slate-950 ring-1 ring-white/10">
        <div className="text-lg font-semibold mb-2">{t("Nostr & Lightning", "Nostr & Lightning")}</div>
        <div className="grid gap-3">
          <label className="inline-flex items-center gap-2 text-sm text-white/80">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-700 bg-slate-900"
              checked={!!s.nostrCommentsEnabled}
              onChange={(e) => setS({ ...s, nostrCommentsEnabled: e.target.checked })}
            />
            <span>{t("Enable Nostr comments", "Enable Nostr comments")}</span>
          </label>
          <input
            className="px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
            placeholder="Shop npub (public identity)"
            value={s.nostrNpub || ""}
            onChange={(e) => setS({ ...s, nostrNpub: e.target.value })}
          />
          <input
            className="px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
            placeholder="NIP-05 (name@domain), optional"
            value={s.nostrNip05 || ""}
            onChange={(e) => setS({ ...s, nostrNip05: e.target.value })}
          />
          <input
            className="px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
            placeholder='Relays (JSON array or CSV), e.g. ["wss://relay.damus.io","wss://nos.lol"]'
            value={
              Array.isArray(s.nostrRelays)
                ? JSON.stringify(s.nostrRelays)
                : s.nostrRelays || ""
            }
            onChange={(e) =>
              setS({ ...s, nostrRelays: e.target.value })
            }
          />
          <input
            className="px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
            placeholder={t("Hashtag predefiniti teaser, es. #shop #shopping #lightning", "Default teaser hashtags, e.g. #shop #shopping #lightning")}
            value={s.nostrDefaultHashtags || ""}
            onChange={(e) =>
              setS({ ...s, nostrDefaultHashtags: e.target.value })
            }
          />
          <textarea
            rows={3}
            className="px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
            placeholder={t(
              "Per evitare spam visibile nei commenti Nostr, blocca pubkey (hex o npub), una per riga",
              "To avoid spam shown in Nostr comments, block pubkeys (hex or npub), one per line"
            )}
            value={joinList(s.nostrBlockedPubkeys)}
            onChange={(e) =>
              setS({ ...s, nostrBlockedPubkeys: parseListInput(e.target.value) })
            }
          />
          <input
            className="px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
            placeholder="Lightning Address for Zaps (e.g. you@blink.sv)"
            value={s.lightningAddress || ""}
            onChange={(e) =>
              setS({ ...s, lightningAddress: e.target.value })
            }
          />
          <div className="text-xs text-white/60">
            {t("Nota: la chiave privata del negozio per inviare DM Nostr è", "Note: the shop private key for Nostr DMs is")}{" "}
            {t("configurata solo lato server via env:", "configured server-side via env:")}{" "}
            <code>SHOP_NOSTR_NSEC</code> o{" "}
            <code>SHOP_NOSTR_SECRET_HEX</code>.
          </div>
        </div>
      </div>

      {/* --- EMAIL: Signature only (credentials from .env) --- */}
      <div className="mt-10 rounded-3xl p-4 bg-slate-950 ring-1 ring-white/10">
        <div className="text-lg font-semibold mb-2">{t("Email", "Email")}</div>
        <div className="text-sm text-white/70 mb-1">
          {t("Firma (verrà aggiunta in fondo a tutte le email)", "Signature (appended to every email)")}
        </div>
        <textarea
          rows={3}
          className="w-full px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
          value={s.smtpSignature}
          onChange={(e) =>
            setS({ ...s, smtpSignature: e.target.value })
          }
        />
        <div className="text-xs text-white/60 mt-2">
          {t("Le credenziali/parametri SMTP e IMAP sono letti dal file", "SMTP/IMAP credentials are read from the")} <code>.env</code>{" "}
          {t("sul server e non sono modificabili da qui.", "on the server and cannot be edited here.")}
        </div>
      </div>

      {/* --- NOTIFICATION TEMPLATES --- */}
      <div className="mt-10 rounded-3xl p-4 bg-slate-950 ring-1 ring-white/10">
        <div className="text-lg font-semibold mb-2">
          {t("Notification Templates (DM + Email)", "Notification Templates (DM + Email)")}
        </div>

        <HelpBox>
          <div className="font-semibold mb-1">{t("Placeholders disponibili:", "Available placeholders:")}</div>
          <div className="grid sm:grid-cols-2 gap-x-6">
            <ul className="list-disc ml-5 space-y-1">
              <li><code>{`{{storeName}}`}</code></li>
              <li><code>{`{{orderId}}`}</code></li>
              <li><code>{`{{status}}`}</code> / <code>{`{{statusLabel}}`}</code></li>
              <li><code>{`{{totalSats}}`}</code>, <code>{`{{subtotalSats}}`}</code>, <code>{`{{shippingSats}}`}</code></li>
              <li><code>{`{{courier}}`}</code>, <code>{`{{tracking}}`}</code></li>
            </ul>
            <ul className="list-disc ml-5 space-y-1">
              <li><code>{`{{productTitle}}`}</code></li>
              <li><code>{`{{customerName}}`}</code></li>
              <li><code>{`{{address}}`}</code></li>
              <li><code>{`{{createdAt}}`}</code></li>
              <li><code>{`{{paymentHash}}`}</code></li>
            </ul>
          </div>
          <div className="mt-2">
            {t(
              "I corpi email supportano testo semplice (verrà creato anche HTML semplice). La firma configurata sopra verrà aggiunta in coda.",
              "Email bodies support plain text (simple HTML will be generated). The signature above will be appended."
            )}
          </div>
        </HelpBox>

        {/* DM Templates */}
        <div className="mt-5">
          <div className="text-sm font-semibold mb-2">
            {t("Direct Message (Nostr) - Testi", "Direct Message (Nostr) - Texts")}
          </div>

          <div className="grid gap-3">
            <div>
              <label className="block text-sm text-white/70 mb-1">PAID</label>
              <textarea
                rows={4}
                className="w-full px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
                placeholder={t("Testo DM quando l'ordine è pagato", "DM text when the order is paid")}
                value={s.notifyDmTemplate_PAID}
                onChange={(e) =>
                  setS({ ...s, notifyDmTemplate_PAID: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-sm text-white/70 mb-1">PREPARATION</label>
              <textarea
                rows={4}
                className="w-full px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
                placeholder={t("Testo DM quando l'ordine è in preparazione", "DM text when the order is in preparation")}
                value={s.notifyDmTemplate_PREPARATION}
                onChange={(e) =>
                  setS({
                    ...s,
                    notifyDmTemplate_PREPARATION: e.target.value,
                  })
                }
              />
            </div>
            <div>
              <label className="block text-sm text-white/70 mb-1">SHIPPED</label>
              <textarea
                rows={4}
                className="w-full px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
                placeholder={t("Testo DM quando l'ordine è spedito", "DM text when the order is shipped")}
                value={s.notifyDmTemplate_SHIPPED}
                onChange={(e) =>
                  setS({
                    ...s,
                    notifyDmTemplate_SHIPPED: e.target.value,
                  })
                }
              />
            </div>
          </div>
        </div>

        {/* Email Templates */}
        <div className="mt-8">
          <div className="text-sm font-semibold mb-2">
            {t("Email - Oggetto & Corpo", "Email - Subject & Body")}
          </div>

          {/* PAID */}
          <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 p-3 mb-3">
            <div className="text-sm font-semibold mb-2">PAID</div>
            <input
              className="mb-2 w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
              placeholder={t("Oggetto (es. `[{{storeName}}] Order {{orderId}}, {{statusLabel}}`)", "Subject (e.g. `[{{storeName}}] Order {{orderId}}, {{statusLabel}}`)")}
              value={s.notifyEmailSubject_PAID}
              onChange={(e) =>
                setS({ ...s, notifyEmailSubject_PAID: e.target.value })
              }
            />
            <textarea
              rows={6}
              className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
              placeholder={t("Corpo email per PAID", "Email body for PAID")}
              value={s.notifyEmailBody_PAID}
              onChange={(e) =>
                setS({ ...s, notifyEmailBody_PAID: e.target.value })
              }
            />
          </div>

          {/* PREPARATION */}
          <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 p-3 mb-3">
            <div className="text-sm font-semibold mb-2">PREPARATION</div>
            <input
              className="mb-2 w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
              placeholder={t("Oggetto (es. `[{{storeName}}] Order {{orderId}}, {{statusLabel}}`)", "Subject (e.g. `[{{storeName}}] Order {{orderId}}, {{statusLabel}}`)")}
              value={s.notifyEmailSubject_PREPARATION}
              onChange={(e) =>
                setS({
                  ...s,
                  notifyEmailSubject_PREPARATION: e.target.value,
                })
              }
            />
            <textarea
              rows={6}
              className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
              placeholder={t("Corpo email per PREPARATION", "Email body for PREPARATION")}
              value={s.notifyEmailBody_PREPARATION}
              onChange={(e) =>
                setS({
                  ...s,
                  notifyEmailBody_PREPARATION: e.target.value,
                })
              }
            />
          </div>

          {/* SHIPPED */}
          <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 p-3">
            <div className="text-sm font-semibold mb-2">SHIPPED</div>
            <input
              className="mb-2 w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
              placeholder={t("Oggetto (es. `[{{storeName}}] Order {{orderId}}, {{statusLabel}}`)", "Subject (e.g. `[{{storeName}}] Order {{orderId}}, {{statusLabel}}`)")}
              value={s.notifyEmailSubject_SHIPPED}
              onChange={(e) =>
                setS({
                  ...s,
                  notifyEmailSubject_SHIPPED: e.target.value,
                })
              }
            />
            <textarea
              rows={6}
              className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
              placeholder={t("Corpo email per SHIPPED (puoi includere {{courier}} e {{tracking}})", "Email body for SHIPPED (you can include {{courier}} and {{tracking}})")}
              value={s.notifyEmailBody_SHIPPED}
              onChange={(e) =>
                setS({
                  ...s,
                  notifyEmailBody_SHIPPED: e.target.value,
                })
              }
            />
          </div>
        </div>
      </div>

      {message && (
        <div className="mt-4 text-sm text-emerald-400">{message}</div>
      )}
      {error && (
        <div className="mt-4 text-sm text-rose-400">{error}</div>
      )}

      <AsyncButton
        className="mt-4"
        onClick={save}
        busyText={t("Salvo...", "Saving...")}
        loading={saving}
      >
        {t("Salva", "Save")}
      </AsyncButton>

      {/* Floating preview trigger */}
      <button
        type="button"
        onClick={() => setPreviewOpen(true)}
        className="fixed right-4 top-1/2 -translate-y-1/2 z-40 px-3 py-2 rounded-2xl bg-indigo-500/90 hover:bg-indigo-500 shadow-lg ring-1 ring-white/20 text-sm font-semibold"
        title={t("Anteprima live", "Live preview")}
      >
        {t("Anteprima live", "Live preview")}
      </button>

      <StorefrontPreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        settings={s}
        t={t}
      />
    </div>
  );
}

function StorefrontPreview({ settings, t }) {
  const theme =
    settings.themeChoice === "light"
      ? "light"
      : settings.themeChoice === "ember"
      ? "ember"
      : "dark";
  const heroTitle = !settings.logo
    ? (settings.storeName || t("Your Shop Name", "Your Shop Name"))
    : "";
  const heroLine = settings.heroLine || t("Pezzi curati per te, spediti con attenzione.", "Quality pieces made for you and shipped with care.");
  const aboutHtml = renderMarkdown(settings.aboutBody || "");
  const shippingItems = [settings.shippingBullet1, settings.shippingBullet2, settings.shippingBullet3].filter(Boolean);
  const commissionTitle = settings.commissionTitle || t("Commissioni & Contatti", "Commissions & Contact");
  const commissionBody = settings.commissionBody || t("Disponibile per commissioni: raccontami la tua idea e ti rispondo con opzioni.", "Open to custom requests - share your idea and I will reply with options.");
  const commissionCtaLabel = settings.commissionCtaLabel || t("Scrivici", "Write to us");
  const commissionCtaHref = settings.commissionCtaHref || "/about";
  const gridTitle = settings.productsHeading || t("Opere in evidenza", "Featured products");

  const previewLogo =
    theme === "light"
      ? (settings.logoLight || settings.logoDark || settings.logo)
      : (settings.logoDark || settings.logo || settings.logoLight);

  return (
    <div
      data-theme={theme}
      className="rounded-3xl bg-slate-950 ring-1 ring-white/10 p-4 space-y-4"
    >
      <div className="flex items-center gap-3">
        <div className="text-lg font-semibold">{t("Anteprima live", "Live preview")}</div>
        <div className="text-xs text-white/60">{t("Aggiornata in tempo reale mentre compili.", "Updates live while you edit.")}</div>
      </div>

      <div className="space-y-3">
        <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 p-4">
          <div className="text-sm text-white/60">{t("Hero", "Hero")}</div>
          {previewLogo ? (
            <div className="mb-2 flex justify-start">
              <img
                src={previewLogo}
                alt="logo preview"
                className="max-h-12 w-auto object-contain"
              />
            </div>
          ) : null}
          {heroTitle ? (
            <div className="text-2xl font-semibold">{heroTitle}</div>
          ) : null}
          {heroLine ? <div className="text-white/70 mt-1">{heroLine}</div> : null}
          {settings.heroCtaLabel ? (
            <div className="mt-3 inline-flex px-3 py-2 rounded-xl bg-indigo-500/80 text-xs text-white">
              {settings.heroCtaLabel}
            </div>
          ) : null}
        </div>

        {(settings.aboutTitle || settings.aboutBody) && (
          <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 p-4 space-y-2">
            <div className="text-sm text-white/60">{t("About", "About")}</div>
            <div className="font-semibold">{settings.aboutTitle || t("About title", "About title")}</div>
            {settings.contactNote ? (
              <div className="text-sm text-white/60">{settings.contactNote}</div>
            ) : null}
            {settings.aboutImage ? (
              <img
                src={settings.aboutImage}
                alt="about preview"
                className="h-16 w-16 rounded-xl object-cover ring-1 ring-white/10"
              />
            ) : null}
            {aboutHtml ? (
              <div
                className="text-sm text-white/80 prose-invert prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: aboutHtml }}
              />
            ) : (
              <div className="text-sm text-white/60">
                {t("Aggiungi testo per vedere l'anteprima.", "Add text to see the preview.")}
              </div>
            )}
          </div>
        )}

        <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 p-4 space-y-3">
          <div className="text-sm text-white/60">{t("Griglia prodotti", "Product grid")}</div>
          <div className="text-xl font-semibold">{gridTitle}</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, idx) => (
              <div
                key={idx}
                className="rounded-2xl bg-slate-950 ring-1 ring-white/10 overflow-hidden"
                aria-hidden
              >
                <div className="aspect-[4/3] bg-slate-800" />
                <div className="p-3 space-y-2">
                  <div className="h-4 bg-slate-800 rounded" />
                  <div className="h-3 bg-slate-800/80 rounded w-2/3" />
                  <div className="h-3 bg-slate-800/70 rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {shippingItems.length > 0 && (
          <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 p-4 space-y-2">
            <div className="text-sm text-white/60">{t("Spedizioni", "Shipping")}</div>
            <div className="font-semibold">{settings.shippingTitle || t("Come spediamo", "How we ship")}</div>
            <ul className="list-disc ml-5 text-sm text-white/80 space-y-1">
              {shippingItems.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 p-4 space-y-2">
          <div className="text-sm text-white/60">{t("Commissioni / Contatti", "Commissions / Contact")}</div>
          <div className="font-semibold">{commissionTitle}</div>
          <div className="text-sm text-white/70 whitespace-pre-wrap">{commissionBody}</div>
          <div className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-indigo-500/80 text-white w-fit">
            {commissionCtaLabel}
            <span aria-hidden>→</span>
          </div>
          <div className="text-[11px] text-white/50 break-all">{commissionCtaHref}</div>
        </div>

        <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 p-4">
          <div className="text-sm text-white/60">{t("Footer", "Footer")}</div>
          <div className="text-sm text-white/80">© {new Date().getFullYear()} {settings.storeName || t("Your Shop Name", "Your Shop Name")}</div>
          {settings.contactNote ? (
            <div className="text-xs text-white/60 mt-1">{settings.contactNote}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StorefrontPreviewModal({ open, onClose, settings, t }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-3xl bg-slate-950 ring-1 ring-white/10 p-4 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="text-lg font-semibold">{t("Anteprima store", "Store preview")}</div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10 text-sm"
          >
            {t("Chiudi", "Close")}
          </button>
        </div>
        <StorefrontPreview settings={settings} t={t} />
      </div>
    </div>
  );
}

function hydrateSimplePresetFromZones(settings) {
  const data = { ...settings };
  const zones = normalizeShippingZones(settings?.shippingZones);
  if (!zones.length) return data;
  const domesticCountry = String(data.shippingDomesticCountry || "IT").toUpperCase();
  let derivedDomestic = null;
  const derivedContinentPrices = {};
  const derivedOverrides = [];
  const continentGroups = CONTINENT_GROUPS.map((group) => ({
    key: group.key,
    countries: group.countries.map((c) => String(c || "").toUpperCase()).sort()
  }));
  const normalizeList = (arr = []) =>
    arr
      .map((c) => String(c || "").toUpperCase())
      .filter(Boolean)
      .sort();
  const sameCountries = (a = [], b = []) => {
    if (a.length !== b.length) return false;
    return a.every((c, idx) => c === b[idx]);
  };
  zones.forEach((zone) => {
    const countries = normalizeList(zone?.countries || []);
    if (!countries.length) return;
    const price = Math.max(0, Number(zone?.priceSats || 0));
    if (countries.length === 1 && countries[0] === domesticCountry) {
      derivedDomestic = price;
      return;
    }
    const groupMatch = continentGroups.find((group) => sameCountries(group.countries, countries));
    if (groupMatch) {
      derivedContinentPrices[groupMatch.key] = price;
      return;
    }
    if (
      countries.length === 1 &&
      countries[0] !== "ALL" &&
      countries[0] !== "*" &&
      countries[0] !== domesticCountry
    ) {
      derivedOverrides.push({
        id: zone?.id || `zone-${countries[0]}`,
        country: countries[0],
        priceSats: price
      });
    }
  });

  if (derivedDomestic !== null && !Number(data.shippingDomesticPriceSats)) {
    data.shippingDomesticPriceSats = derivedDomestic;
  }
  const baseContinentPrices =
    data.shippingContinentPrices && typeof data.shippingContinentPrices === "object"
      ? { ...data.shippingContinentPrices }
      : {};
  CONTINENT_GROUPS.forEach((group) => {
    const existing = Number(baseContinentPrices?.[group.key] || 0);
    if (!existing && derivedContinentPrices[group.key] !== undefined) {
      baseContinentPrices[group.key] = derivedContinentPrices[group.key];
    } else if (existing) {
      baseContinentPrices[group.key] = baseContinentPrices[group.key];
    } else {
      baseContinentPrices[group.key] = 0;
    }
  });
  data.shippingContinentPrices = baseContinentPrices;
  if ((!Array.isArray(data.shippingOverrides) || !data.shippingOverrides.length) && derivedOverrides.length) {
    data.shippingOverrides = derivedOverrides;
  }
  return data;
}
