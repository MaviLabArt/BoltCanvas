import React, { useEffect, useState } from "react";
import api from "../services/api.js";
import { absoluteApiUrl } from "../services/api.js";
import { compressImageFile } from "../utils/image.js";
import AsyncButton from "../components/AsyncButton.jsx";
import { useAdminI18n } from "./i18n.jsx";
import {
  buildPresetZonesFromSettings,
  makeInitialZoneOverrideState,
  buildZoneOverridePayload
} from "../utils/shippingPresets.js";

const KEEP_IMAGE_TOKEN_PREFIX = "keep:";

const makeKeepToken = (idx) => `${KEEP_IMAGE_TOKEN_PREFIX}${idx}`;

function mapInitialImagesForPayload(initial) {
  if (!Array.isArray(initial?.images)) return [];
  if (!initial?.id) return initial.images.slice();
  return initial.images.map((_, idx) => makeKeepToken(idx));
}

function mapInitialThumbs(initial) {
  if (Array.isArray(initial?.thumbs) && initial.thumbs.length) return initial.thumbs.slice();
  if (Array.isArray(initial?.images)) return initial.images.slice();
  return [];
}

function sanitizeImagePayload(list = []) {
  return list
    .map((src) => (typeof src === "string" ? src.trim() : ""))
    .filter(Boolean);
}

function filesToDataURLs(fileList, limit = 5) {
  // (kept for back-compat if ever reused elsewhere; not used below)
  const files = Array.from(fileList).slice(0, limit);
  const readers = files.map(
    f =>
      new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(f);
      })
  );
  return Promise.all(readers);
}

export default function Products() {
  const { t } = useAdminI18n();
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null);
  const [loadingList, setLoadingList] = useState(false);

  // NEW: pagination (optional; server still supports legacy array response)
  const [page, setPage] = useState(1);
  const [pageSize] = useState(24);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [teaserEditing, setTeaserEditing] = useState(null);
  const [shippingPresetZones, setShippingPresetZones] = useState([]);
  const [reordering, setReordering] = useState(false);
  const [reorderLoading, setReorderLoading] = useState(false);
  const [orderDraft, setOrderDraft] = useState([]);
  const [orderOriginal, setOrderOriginal] = useState([]);
  const [savingOrder, setSavingOrder] = useState(false);

  async function fetchProductDetail(id) {
    const r = await api.get(`/admin/products/${id}`);
    const data = r.data || {};
    const preferredThumbs = Array.isArray(data.absThumbUrls) && data.absThumbUrls.length
      ? data.absThumbUrls.slice()
      : (
        Array.isArray(data.thumbUrls) && data.thumbUrls.length
          ? data.thumbUrls.slice()
          : (Array.isArray(data.images) ? data.images.slice() : [])
      );
    const normalizedThumbs = preferredThumbs
      .map((url) => {
        const str = String(url || "").trim();
        if (!str) return "";
        if (str.startsWith("data:")) return str;
        return absoluteApiUrl(str);
      })
      .filter(Boolean);
    return { ...data, thumbs: normalizedThumbs };
  }

  async function refresh(nextPage = page) {
    try {
      setLoadingList(true);
      const r = await api.get(`/admin/products?page=${nextPage}&pageSize=${pageSize}`);
      const data = r.data;
      if (data && Array.isArray(data.items)) {
        setList(data.items);
        setPage(data.page);
        setTotalPages(data.totalPages);
        setTotal(data.total);
      } else {
        // back-compat: API returned an array
        const arr = Array.isArray(data) ? data : [];
        setList(arr);
        setPage(1);
        setTotalPages(1);
        setTotal(arr.length);
      }
    } catch (e) {
      // Most common causes in prod: 401 without proper throw, or proxy serving HTML
      console.warn("Failed to load admin products:", e?.message || e);
      setList([]);
      setPage(1);
      setTotalPages(1);
      setTotal(0);
    } finally {
      setLoadingList(false);
    }
  }
  useEffect(() => {
    refresh(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch preset zones from settings
  useEffect(() => {
    api.get("/admin/settings")
      .then((r) => {
        const data = r.data || {};
        const zones = buildPresetZonesFromSettings(data, t);
        setShippingPresetZones(zones);
      })
      .catch(() => {
        setShippingPresetZones([]);
      }); // non-blocking
  }, [t]);
  useEffect(() => {
    if (!reordering) {
      const arr = Array.isArray(list) ? list.slice() : [];
      setOrderDraft(arr);
      setOrderOriginal(arr.map((p) => p.id));
    }
  }, [list, reordering]);

  function startNew() {
    setEditing({
      // campi minimi
      title: "",
      subtitle: "",
      description: "",
      longDescription: "",
      priceSats: 0,
      images: [],
      thumbs: [],            // kept for local previews during edit only
      mainImageIndex: 0,
      available: true,
      hidden: false,
      // dimensioni (solo numeri, cm)
      widthCm: "",
      heightCm: "",
      depthCm: "",
      showDimensions: true,
      // spedizioni (sats)
      shippingItalySats: 0,
      shippingEuropeSats: 0,
      shippingWorldSats: 0,
      shippingZoneOverrides: [],
    });
  }

  async function toggleAvailable(p) {
    try {
      await api.put(`/admin/products/${p.id}`, { available: !p.available });
      refresh(page);
    } catch (err) {
      console.warn("toggleAvailable failed:", err);
      alert(t("Impossibile aggiornare la disponibilità. Riprova.", "Could not update availability. Please try again."));
    }
  }

  async function toggleHidden(p) {
    try {
      await api.put(`/admin/products/${p.id}`, { hidden: !p.hidden });
      refresh(page);
    } catch (err) {
      console.warn("toggleHidden failed:", err);
      alert(t("Impossibile aggiornare la visibilità. Riprova.", "Could not update visibility. Please try again."));
    }
  }

  async function removeProduct(id) {
    if (!confirm(t(
      "Eliminare questo quadro? L'operazione è irreversibile.",
      "Delete this product? This action cannot be undone."
    ))) return;
    await api.delete(`/admin/products/${id}`);
    refresh();
  }

  async function beginReorder() {
    try {
      setReorderLoading(true);
      const r = await api.get("/admin/products?page=1&pageSize=9999");
      const data = r.data;
      const items = Array.isArray(data?.items)
        ? data.items
        : (Array.isArray(data) ? data : []);
      const arr = items.slice();
      setOrderDraft(arr);
      setOrderOriginal(arr.map((p) => p.id));
      setReordering(true);
    } catch (err) {
      console.warn("Failed to load products for reorder:", err);
      alert(t("Impossibile caricare i prodotti per riordinarli. Riprova.", "Unable to load products to reorder. Please try again."));
    } finally {
      setReorderLoading(false);
    }
  }

  function cancelReorder() {
    if (savingOrder) return;
    setReordering(false);
    const arr = Array.isArray(list) ? list.slice() : [];
    setOrderDraft(arr);
    setOrderOriginal(arr.map((p) => p.id));
  }

  function moveProductTo(id, targetIndex) {
    if (!reordering || savingOrder) return;
    setOrderDraft(prev => {
      if (!Array.isArray(prev) || prev.length === 0) return prev;
      const next = prev.slice();
      const currentIndex = next.findIndex(item => item.id === id);
      if (currentIndex === -1 || targetIndex < 0 || targetIndex >= next.length) {
        return prev;
      }
      if (currentIndex === targetIndex) return prev;
      const [item] = next.splice(currentIndex, 1);
      next.splice(targetIndex, 0, item);
      return next;
    });
  }

  function moveProduct(id, delta) {
    if (!reordering || savingOrder) return;
    setOrderDraft(prev => {
      if (!Array.isArray(prev) || prev.length === 0) return prev;
      const next = prev.slice();
      const index = next.findIndex(item => item.id === id);
      if (index === -1) return prev;
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  }

  async function saveOrder() {
    if (!reordering || savingOrder) return;
    const ids = Array.isArray(orderDraft) ? orderDraft.map((p) => p.id) : [];
    if (!ids.length) {
      alert(t("Nessun prodotto da salvare.", "No products to save."));
      return;
    }
    try {
      setSavingOrder(true);
      await api.post("/admin/products/reorder", { order: ids });
      setReordering(false);
      await refresh(page);
    } catch (err) {
      console.warn("Failed to save product order:", err);
      alert(t("Impossibile salvare il nuovo ordine. Riprova.", "Could not save the new order. Please try again."));
    } finally {
      setSavingOrder(false);
    }
  }

  const displayList = reordering ? orderDraft : list;
  const orderChanged = reordering && (
    orderDraft.length !== orderOriginal.length ||
    orderDraft.some((p, idx) => p.id !== orderOriginal[idx])
  );
  const totalDisplay = Array.isArray(displayList) ? displayList.length : 0;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          className="px-4 py-3 rounded-2xl bg-indigo-500/90 hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed"
          onClick={startNew}
          disabled={reordering}
        >
          {t("+ Aggiungi quadro", "+ Add product")}
        </button>
        {!reordering ? (
          <AsyncButton
            onClick={beginReorder}
            loading={reorderLoading}
            disabled={loadingList || reorderLoading || total <= 1}
            busyText={t("Carico prodotti…", "Loading products…")}
            className="bg-slate-800 hover:bg-slate-700"
          >
            {t("Riordina", "Reorder")}
          </AsyncButton>
        ) : (
          <>
            <AsyncButton
              onClick={saveOrder}
              loading={savingOrder}
              disabled={!orderChanged || savingOrder}
              busyText={t("Salvo ordine…", "Saving order…")}
              className="bg-emerald-600 hover:bg-emerald-500"
            >
              {t("Salva ordine", "Save order")}
            </AsyncButton>
            <button
              type="button"
              className="px-4 py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 ring-1 ring-white/10 text-white disabled:opacity-60"
              onClick={cancelReorder}
              disabled={savingOrder}
            >
              {t("Annulla", "Cancel")}
            </button>
          </>
        )}
        <div className="ml-auto text-sm text-white/60">
          {total > 0 ? `${t("Totale", "Total")}: ${total}` : null}
        </div>
      </div>

      {reordering && (
        <div className="mb-4 text-sm text-white/70">
          {t(
            "Modalità riordino attiva: usa i pulsanti sulle card per spostare i quadri e premi “Salva ordine”.",
            "Reorder mode on: use the card buttons to move products, then press “Save order”."
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {(!reordering && !loadingList && totalDisplay === 0) && (
          <div className="p-6 rounded-3xl bg-slate-900 ring-1 ring-white/10 text-white/70">
            {t('Nessun quadro. Clicca “Aggiungi quadro”.', 'No products. Click “Add product”.')}
          </div>
        )}
        {reordering && !reorderLoading && totalDisplay === 0 && (
          <div className="p-6 rounded-3xl bg-slate-900 ring-1 ring-white/10 text-white/70">
            {t("Nessun prodotto da riordinare.", "No products to reorder.")}
          </div>
        )}
        {(reordering ? reorderLoading : loadingList) && (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={`sk-${i}`} className="rounded-3xl overflow-hidden bg-slate-900 ring-1 ring-white/10 animate-pulse">
              <div className="aspect-[4/3] bg-slate-800/70" />
              <div className="p-4 space-y-2">
                <div className="h-4 bg-slate-800 rounded" />
                <div className="h-3 bg-slate-800/80 rounded w-2/3" />
                <div className="h-3 bg-slate-800/80 rounded w-1/2" />
              </div>
            </div>
          ))
        )}
        {Array.isArray(displayList) && !(reordering ? reorderLoading : loadingList) && displayList.map((p, position) => {
          const idx = Math.max(0, p.mainImageIndex | 0);
          const fallbackIdx = Math.min(idx, Math.max(0, (p.imageCount || 1) - 1));
          const versionTag = p.imageVersion
            ? `?v=${encodeURIComponent(`${p.imageVersion}-${fallbackIdx}`)}`
            : "";
      const fallbackThumb =
        p.imageCount > 0
          ? `/api/products/${p.id}/thumb/${fallbackIdx}.jpg${versionTag}`
          : "";
      const main = absoluteApiUrl(p.mainImageThumbAbsoluteUrl || p.mainImageThumbUrl || fallbackThumb);
          const showDims = p.showDimensions !== false;
          const dims = showDims ? [
            p.widthCm ? `${p.widthCm}` : null,
            p.heightCm ? `${p.heightCm}` : null,
            p.depthCm ? `${p.depthCm}` : null,
          ].filter(Boolean) : [];
          const isHidden = !!p.hidden;
          return (
            <div
              key={p.id}
              className={[
                "rounded-3xl overflow-hidden bg-slate-900 ring-1 ring-white/10",
                reordering ? "ring-indigo-400/40" : ""
              ].filter(Boolean).join(" ")}
            >
              <div className="aspect-[4/3] bg-black/30 relative">
                {main ? (
                  <img
                    src={main}
                    alt={p.title}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full grid place-items-center text-white/40">
                    {t("Nessuna immagine", "No image")}
                  </div>
                )}
                {reordering && (
                  <div className="absolute top-2 left-2 px-2 py-1 rounded-full bg-black/60 text-xs text-white">
                    #{position + 1}
                  </div>
                )}
                {isHidden && (
                  <div className="absolute inset-0 bg-black/60 grid place-items-center">
                    <span className="px-3 py-1 rounded-xl bg-white/10 ring-1 ring-white/20 text-white">
                      {t("NASCOSTO", "HIDDEN")}
                    </span>
                  </div>
                )}
                {!isHidden && !p.available && (
                  <div className="absolute inset-0 bg-black/60 grid place-items-center">
                    <span className="px-3 py-1 rounded-xl bg-white/10 ring-1 ring-white/20 text-white">
                      {t("VENDUTO", "SOLD")}
                    </span>
                  </div>
                )}
              </div>
              <div className="p-4">
                <div className="font-medium">{p.title || t("Senza titolo", "Untitled")}</div>
                {p.subtitle && (
                  <div className="mt-0.5 text-sm text-white/70 line-clamp-1">
                    {p.subtitle}
                  </div>
                )}
                <div className="text-sm text-white/70 mt-1">
                  {Number(p.priceSats || 0).toLocaleString("en-US")} sats
                </div>
                {isHidden && (
                  <div className="text-xs text-amber-400 mt-1">
                    {t("Nascosto dal sito", "Hidden from site")}
                  </div>
                )}
                {showDims && dims.length > 0 && (
                  <div className="text-xs text-white/60 mt-1">
                    {t("Dimensioni", "Dimensions")}: {dims.join(" × ")} cm
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {reordering ? (
                    <>
                      <button
                        type="button"
                        className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10 text-white disabled:opacity-50"
                        onClick={() => moveProductTo(p.id, 0)}
                        disabled={savingOrder || position === 0}
                      >
                        {t("In cima", "To top")}
                      </button>
                      <button
                        type="button"
                        className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10 text-white disabled:opacity-50"
                        onClick={() => moveProduct(p.id, -1)}
                        disabled={savingOrder || position === 0}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10 text-white disabled:opacity-50"
                        onClick={() => moveProduct(p.id, 1)}
                        disabled={savingOrder || position === totalDisplay - 1}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10 text-white disabled:opacity-50"
                        onClick={() => moveProductTo(p.id, totalDisplay - 1)}
                        disabled={savingOrder || position === totalDisplay - 1}
                      >
                        {t("In fondo", "To bottom")}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10"
                        onClick={async () => {
                          const detail = await fetchProductDetail(p.id);
                          setEditing(detail);
                        }}
                      >
                        {t("Modifica", "Edit")}
                      </button>
                      <AsyncButton
                        onClick={() => removeProduct(p.id)}
                        busyText={t("Elimino...", "Deleting...")}
                      >
                        {t("Elimina", "Delete")}
                      </AsyncButton>
                      <AsyncButton
                        onClick={() => toggleAvailable(p)}
                        busyText={p.available ? t("Segno venduto...", "Marking sold...") : t("Segno disponibile...", "Marking available...")}
                      >
                        {p.available ? t("Segna venduto", "Mark sold") : t("Segna disponibile", "Mark available")}
                      </AsyncButton>
                      <AsyncButton
                        onClick={() => toggleHidden(p)}
                        busyText={p.hidden ? t("Mostro...", "Showing...") : t("Nascondo...", "Hiding...")}
                      >
                        {p.hidden ? t("Mostra sul sito", "Show on site") : t("Nascondi", "Hide")}
                      </AsyncButton>
                      <AsyncButton
                        className="bg-pink-900 hover:bg-pink-800 text-white"
                        busyText={t("Apro Nostr…", "Opening Nostr…")}
                        onClick={async () => {
                          const detail = await fetchProductDetail(p.id);
                          setTeaserEditing(detail);
                        }}
                      >
                        NOSTR
                      </AsyncButton>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination controls */}
      {!reordering && totalPages > 1 && (
        <div className="mt-6 flex items-center gap-3">
          <button
            className="px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10 disabled:opacity-50"
            disabled={page <= 1}
            onClick={() => { const np = Math.max(1, page - 1); refresh(np); }}
          >
            ← {t("Precedente", "Prev")}
          </button>
          <div className="text-white/70 text-sm">
            {t("Pagina", "Page")} {page} / {totalPages}
          </div>
          <button
            className="px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10 disabled:opacity-50"
            disabled={page >= totalPages}
            onClick={() => { const np = Math.min(totalPages, page + 1); refresh(np); }}
          >
            {t("Successiva", "Next")} →
          </button>
        </div>
      )}

      {editing && (
        <Editor
          initial={editing}
          shippingZones={shippingPresetZones}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {teaserEditing && (
        <TeaserModal
          initial={teaserEditing}
          onClose={() => {
            setTeaserEditing(null);
            refresh(page);
          }}
        />
      )}
    </>
  );
}

function Editor({ initial, shippingZones = [], onClose, onSaved }) {
  const maxPhotos = 5;
  const { t } = useAdminI18n();

  const [title, setTitle] = useState(initial.title || "");
  const [subtitle, setSubtitle] = useState(initial.subtitle || "");
  const [priceSats, setPriceSats] = useState(initial.priceSats || 0);

  // breve = "description" (preview legacy); lunga = "longDescription"
  const [longDescription, setLongDescription] = useState(
    initial.longDescription || ""
  );

  const [images, setImages] = useState(() => mapInitialImagesForPayload(initial));
  const [thumbs, setThumbs] = useState(() => mapInitialThumbs(initial)); // local previews only
  const [mainImageIndex, setMainImageIndex] = useState(
    Number.isInteger(initial.mainImageIndex) ? initial.mainImageIndex : 0
  );
  const [available, setAvailable] = useState(initial.available ?? true);
  const [hidden, setHidden] = useState(initial.hidden ?? false);

  // Dimensioni
  const [widthCm, setWidthCm] = useState(
    initial.widthCm === 0 ? 0 : initial.widthCm || ""
  );
  const [heightCm, setHeightCm] = useState(
    initial.heightCm === 0 ? 0 : initial.heightCm || ""
  );
  const [depthCm, setDepthCm] = useState(
    initial.depthCm === 0 ? 0 : initial.depthCm || ""
  );
  const [showDimensions, setShowDimensions] = useState(initial.showDimensions !== false);

  // Spedizioni per destinazione (sats)
  const [shippingItalySats, setShippingItalySats] = useState(
    initial.shippingItalySats || 0
  );
  const [shippingEuropeSats, setShippingEuropeSats] = useState(
    initial.shippingEuropeSats || 0
  );
  const [shippingWorldSats, setShippingWorldSats] = useState(
    initial.shippingWorldSats || 0
  );
  const [zoneOverrides, setZoneOverrides] = useState(() => makeInitialZoneOverrideState(initial));
  const [formErrors, setFormErrors] = useState({});
  const [formMessage, setFormMessage] = useState("");
  const [formError, setFormError] = useState("");

  const isNew = !initial.id;
  useEffect(() => {
    setHidden(initial.hidden ?? false);
    setShowDimensions(initial.showDimensions !== false);
    setZoneOverrides(makeInitialZoneOverrideState(initial));
  }, [initial]);

  const parseNonNegative = (raw, allowEmpty = true) => {
    if (allowEmpty && (raw === "" || raw === null || raw === undefined)) return 0;
    const num = Number(raw);
    return Number.isFinite(num) && num >= 0 ? num : null;
  };

  function validate() {
    const errors = {
      override: {},
      shipping: {}
    };
    let hasErrors = false;

    if (!title.trim()) {
      errors.title = t("Inserisci un titolo.", "Enter a title.");
      hasErrors = true;
    }
    const priceNum = Number(priceSats);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      errors.priceSats = t("Prezzo non valido. Usa sats maggiori di 0.", "Invalid price. Use sats greater than 0.");
      hasErrors = true;
    }
    if (!images.length) {
      errors.images = t("Aggiungi almeno una foto.", "Add at least one photo.");
      hasErrors = true;
    }

    const shippingFields = [
      ["shippingItalySats", shippingItalySats],
      ["shippingEuropeSats", shippingEuropeSats],
      ["shippingWorldSats", shippingWorldSats]
    ];
    shippingFields.forEach(([key, value]) => {
      const parsed = parseNonNegative(value, true);
      if (parsed === null) {
        errors.shipping[key] = t("Inserisci un numero maggiore o uguale a 0.", "Enter a number greater than or equal to 0.");
        hasErrors = true;
      }
    });

    Object.entries(zoneOverrides || {}).forEach(([zoneId, raw]) => {
      if (raw === "" || raw === null || raw === undefined) return;
      const parsed = parseNonNegative(raw, false);
      if (parsed === null) {
        errors.override[zoneId] = t("Prezzo non valido.", "Invalid price.");
        hasErrors = true;
      }
    });

    setFormErrors(errors);
    return { hasErrors, errors };
  }

  async function addFiles(e) {
    if (!e.target.files?.length) return;
    const remaining = maxPhotos - images.length;
    if (remaining <= 0) {
      alert(`Massimo ${maxPhotos} foto.`);
      return;
    }
  // Compress in the browser - low CPU, very simple for grandma
    const files = Array.from(e.target.files).slice(0, remaining);

    for (const f of files) {
      try {
        // Full (existing behavior)
        const full = f.size <= 150 * 1024
          ? await fileToDataUrl(f)
          : await compressImageFile(f, {
              maxSide: 1600,
              mimeType: 'image/webp',
              quality: 0.82,
              targetBytes: 600 * 1024,
            });

        // NEW: small thumbnail (~400px long side, ~100KB target)
        const thumb = f.size <= 80 * 1024
          ? await fileToDataUrl(f)
          : await compressImageFile(f, {
              maxSide: 400,
              mimeType: 'image/webp',
              quality: 0.8,
              targetBytes: 100 * 1024,
            });

        setImages((arr) => [...arr, full]);
        setThumbs((arr) => [...arr, thumb]);
      } catch {
        const dataUrl = await fileToDataUrl(f);
        setImages((arr) => [...arr, dataUrl]);
        setThumbs((arr) => [...arr, dataUrl]);
      }
      // Yield to keep UI responsive on low-end devices
      // eslint-disable-next-line no-await-in-loop
      await new Promise(requestAnimationFrame);
    }
  }

  function removeImage(i) {
    setImages((arr) => {
      const next = arr.filter((_, idx) => idx !== i);
      // riposiziona l'indice principale se necessario
      if (i === mainImageIndex) {
        setMainImageIndex(0);
      } else if (i < mainImageIndex) {
        setMainImageIndex(Math.max(0, mainImageIndex - 1));
      }
      return next;
    });
    setThumbs((arr) => arr.filter((_, idx) => idx !== i));
  }
  const presetZones = Array.isArray(shippingZones) ? shippingZones : [];
  const handleOverrideChange = (zoneId, value) => {
    setZoneOverrides((prev) => {
      if (!zoneId) return prev;
      if (value === "" || value === null) {
        if (!Object.prototype.hasOwnProperty.call(prev, zoneId)) return prev;
        const next = { ...prev };
        delete next[zoneId];
        return next;
      }
      return { ...prev, [zoneId]: value };
    });
    setFormErrors((prev) => ({
      ...prev,
      override: { ...(prev.override || {}), [zoneId]: "" }
    }));
  };
  const clearOverride = (zoneId) => {
    setZoneOverrides((prev) => {
      if (!zoneId || !Object.prototype.hasOwnProperty.call(prev, zoneId)) return prev;
      const next = { ...prev };
      delete next[zoneId];
      return next;
    });
  };
  async function save() {
    setFormMessage("");
    setFormError("");
    const { hasErrors } = validate();
    const imagePayload = sanitizeImagePayload(images);
    if (hasErrors || imagePayload.length === 0) {
      if (!imagePayload.length) {
        setFormErrors((prev) => ({ ...prev, images: t("Aggiungi almeno una foto.", "Add at least one photo.") }));
      }
      setFormError(t("Correggi i campi evidenziati prima di salvare.", "Fix the highlighted fields before saving."));
      return;
    }

    const payload = {
      title: title.trim(),
      subtitle: subtitle.trim(),
      longDescription: longDescription,
      priceSats: Math.floor(Number(priceSats || 0)),
      images: imagePayload, // thumbs are not sent; server generates thumbnails on demand
      mainImageIndex: Math.min(
        Math.max(0, Number(mainImageIndex) | 0),
        Math.max(0, imagePayload.length - 1)
      ),
      available: !!available,
      hidden: !!hidden,
      widthCm: toNumOrNull(widthCm),
      heightCm: toNumOrNull(heightCm),
      depthCm: toNumOrNull(depthCm),
      showDimensions: !!showDimensions,
      shippingItalySats: Math.max(0, Number(shippingItalySats || 0)),
      shippingEuropeSats: Math.max(0, Number(shippingEuropeSats || 0)),
      shippingWorldSats: Math.max(0, Number(shippingWorldSats || 0)),
      shippingZoneOverrides: buildZoneOverridePayload(zoneOverrides),
    };

    if (isNew) {
      await api.post("/admin/products", payload);
    } else {
      await api.put(`/admin/products/${initial.id}`, payload);
    }
    setFormMessage(isNew ? t("Prodotto creato.", "Product created.") : t("Salvato.", "Saved."));
    setFormError("");
    setFormErrors({});
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="dialog" aria-modal="true">
      {/* backdrop */}
      <div className="fixed inset-0 bg-black/60 z-0" onClick={onClose} />
      {/* container */}
      <div className="relative z-10 flex min-h-full items-start justify-center p-4 sm:p-6">
        {/* card */}
        <div className="relative w-full max-w-3xl mx-auto rounded-3xl bg-slate-900 ring-1 ring-white/10 p-6 max-h-[90vh] overflow-y-auto">
          <button
            type="button"
            className="absolute top-4 right-4 p-2 rounded-full text-white/70 hover:text-white hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            onClick={onClose}
            aria-label={t("Chiudi modale", "Close modal")}
          >
            <span aria-hidden="true">{"\u00D7"}</span>
          </button>
          <div className="text-lg font-semibold mb-1">
            {isNew ? t("Aggiungi quadro", "Add product") : t("Modifica quadro", "Edit product")}
          </div>
          <p className="text-white/80 mb-4">
            {t("Compila i campi. Foto: massimo 5.", "Fill in the fields. Photos: up to 5.")}
          </p>
          {formError ? (
            <div className="mb-3 rounded-2xl bg-rose-950/40 ring-1 ring-rose-400/40 text-sm text-rose-100 p-3">
              {formError}
            </div>
          ) : null}
          {formMessage ? (
            <div className="mb-3 rounded-2xl bg-emerald-950/40 ring-1 ring-emerald-400/40 text-sm text-emerald-100 p-3">
              {formMessage}
            </div>
          ) : null}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-white/70 mb-1">{t("Titolo", "Title")}</label>
              <input
                className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setFormErrors((prev) => ({ ...prev, title: "" }));
                }}
                placeholder={t("Es. Tramonto sul mare", "e.g. Sunset on the sea")}
              />
              {formErrors.title ? (
                <div className="text-xs text-amber-300 mt-1">{formErrors.title}</div>
              ) : null}
            </div>

            <div>
              <label className="block text-sm text-white/70 mb-1">{t("Prezzo (sats)", "Price (sats)")}</label>
              <input
                type="number"
                min={0}
                step={1}
                className={`w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ${
                  formErrors.priceSats ? "ring-rose-400/70 bg-rose-950/20" : "ring-white/10"
                }`}
                value={priceSats}
                onChange={(e) => {
                  setPriceSats(e.target.value);
                  setFormErrors((prev) => ({ ...prev, priceSats: "" }));
                }}
                placeholder={t("Es. 120000", "e.g. 120000")}
              />
              {formErrors.priceSats ? (
                <div className="text-xs text-amber-300 mt-1">{formErrors.priceSats}</div>
              ) : null}
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm text-white/70 mb-1">
                {t("Sottotitolo (anteprima in homepage)", "Subtitle (shown on home preview)")}
              </label>
              <input
                className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                placeholder={t("Breve frase di anteprima", "Short preview sentence")}
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm text-white/70 mb-1">
                {t("Descrizione lunga (pagina prodotto)", "Long description (product page)")}
              </label>
              <textarea
                rows={5}
                className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
                value={longDescription}
                onChange={(e) => setLongDescription(e.target.value)}
                placeholder={t("Dettagli completi dell'opera", "Full details about the product")}
              />
            </div>

            {/* Foto */}
            <div className="md:col-span-2">
              <div className="flex items-end justify-between mb-2">
                <div>
                  <div className="text-sm text-white/70">
                    {t("Foto", "Photos")} ({images.length}/{maxPhotos})
                  </div>
                  <div className="text-xs text-white/60">
                    {t("Seleziona l'immagine principale tra le miniature.", "Select the main image from the thumbnails.")}
                  </div>
                </div>
                <label className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10 cursor-pointer">
                  {t("+ Aggiungi foto", "+ Add photos")}
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={addFiles}
                  />
                </label>
              </div>
              {formErrors.images ? (
                <div className="text-xs text-amber-300 mb-2">{formErrors.images}</div>
              ) : null}

              {images.length === 0 ? (
                <div className="h-40 grid place-items-center rounded-2xl bg-slate-950 ring-1 ring-white/10 text-white/40">
                  {t("Nessuna foto", "No photos yet")}
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {images.map((src, i) => (
                    <div
                      key={i}
                      className={`relative rounded-2xl overflow-hidden ring-2 ${
                        i === mainImageIndex ? "ring-indigo-400" : "ring-white/10"
                      }`}
                    >
                      <img src={thumbs[i] || src} className="w-full h-40 object-cover" />
                      <div className="absolute inset-x-0 bottom-0 p-2 flex gap-2 justify-between bg-gradient-to-t from-black/60 to-transparent">
                        <button
                          className={`px-2 py-1 rounded-lg text-xs ${
                            i === mainImageIndex
                              ? "bg-indigo-500"
                              : "bg-slate-900 ring-1 ring-white/20"
                          }`}
                          onClick={() => setMainImageIndex(i)}
                          title={t("Imposta come principale", "Set as main image")}
                        >
                          {i === mainImageIndex ? t("Principale", "Main") : t("Imposta principale", "Set main")}
                        </button>
                        <button
                          className="px-2 py-1 rounded-lg text-xs bg-slate-900 ring-1 ring-white/20"
                          onClick={() => removeImage(i)}
                        >
                          {t("Elimina", "Delete")}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Dimensioni */}
            <div className="md:col-span-2">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showDimensions}
                  onChange={(e) => setShowDimensions(e.target.checked)}
                />
                <span>{t("Mostra le dimensioni nella pagina prodotto", "Show dimensions on product page")}</span>
              </label>
              <div className="text-xs text-white/60 mt-1">
                {t(
                  "Disattiva se le misure non servono o vuoi nasconderle.",
                  "Disable if measurements are irrelevant or you want to hide them."
                )}
              </div>
            </div>
            <div>
              <label className="block text-sm text-white/70 mb-1">{t("Larghezza (cm)", "Width (cm)")}</label>
              <input
                type="number"
                min={0}
                step="1"
                className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
                value={widthCm}
                onChange={(e) => setWidthCm(e.target.value)}
                placeholder={t("Es. 40", "e.g. 40")}
              />
            </div>
            <div>
              <label className="block text-sm text-white/70 mb-1">{t("Altezza (cm)", "Height (cm)")}</label>
              <input
                type="number"
                min={0}
                step="1"
                className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
                value={heightCm}
                onChange={(e) => setHeightCm(e.target.value)}
                placeholder={t("Es. 30", "e.g. 30")}
              />
            </div>
            <div>
              <label className="block text-sm text-white/70 mb-1">{t("Profondità (cm)", "Depth (cm)")}</label>
              <input
                type="number"
                min={0}
                step="1"
                className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
                value={depthCm}
                onChange={(e) => setDepthCm(e.target.value)}
                placeholder={t("Es. 2", "e.g. 2")}
              />
            </div>

            {/* Spedizione sats */}
            <div className="md:col-span-2 space-y-3 rounded-2xl bg-slate-900 ring-1 ring-white/10 p-3">
              <div className="text-sm text-white/70">
                {t(
                  "I prezzi di spedizione arrivano dalle impostazioni (domestico/continenti/override). Lascia vuoto per usare il preset oppure inserisci un valore per sovrascrivere questo prodotto.",
                  "Shipping prices come from Settings (domestic/continents/overrides). Leave empty to use the preset or enter a value to override this listing."
                )}
              </div>
              {presetZones.length === 0 ? (
                <div className="text-xs text-white/60">
                  {t("Nessun preset definito. Configura le zone in Impostazioni.", "No presets defined. Configure zones in Settings.")}
                </div>
              ) : (
                <div className="space-y-3">
                  {presetZones.map((zone, idx) => {
                    const zoneId = zone?.id || `zone-${idx}`;
                    const hasOverride = Object.prototype.hasOwnProperty.call(zoneOverrides, zoneId);
                    const overrideValue = hasOverride ? zoneOverrides[zoneId] : "";
                    const defaultPrice = Math.max(0, Number(zone?.priceSats || 0));
                    return (
                      <div key={zoneId} className="rounded-2xl bg-slate-950 ring-1 ring-white/10 p-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                        <div className="flex-1">
                          <div className="font-semibold">{zone?.name || `Zone ${idx + 1}`}</div>
                        </div>
                        <div className="text-xs text-white/60">
                          {t("Preset", "Preset")}: {defaultPrice} sats
                        </div>
                      </div>
                      <div className="grid sm:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
                        <div>
                          <label className="block text-xs text-white/60 mb-1">{t("Override (sats)", "Override (sats)")}</label>
                          <input
                            type="number"
                            min={0}
                            step="1"
                            className={`w-full px-3 py-2 rounded-xl bg-slate-950 ring-1 ${
                              formErrors.override?.[zoneId]
                                ? "ring-rose-400/70 bg-rose-950/20"
                                : "ring-white/10"
                            }`}
                            value={overrideValue}
                            onChange={(e) => handleOverrideChange(zoneId, e.target.value)}
                            placeholder={String(defaultPrice)}
                          />
                          <div className="text-[11px] text-white/40 mt-1">
                            {t("Imposta 0 per spedizione gratuita su questa zona.", "Set 0 for free shipping in this zone.")}
                          </div>
                          {formErrors.override?.[zoneId] ? (
                            <div className="text-xs text-amber-300 mt-1">{formErrors.override[zoneId]}</div>
                          ) : null}
                        </div>
                        {hasOverride && (
                          <button
                            type="button"
                            className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10 h-[38px]"
                              onClick={() => clearOverride(zoneId)}
                            >
                              {t("Reimposta", "Reset")}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Disponibilità */}
            <div className="md:col-span-2">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={available}
                  onChange={(e) => setAvailable(e.target.checked)}
                />
                <span>{t("Disponibile", "Available")}</span>
              </label>
            </div>
            <div className="md:col-span-2">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={hidden}
                  onChange={(e) => setHidden(e.target.checked)}
                />
                <span>{t("Nascondi dal sito (non visibile al pubblico)", "Hide from site (not visible publicly)")}</span>
              </label>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-3">
            <button
              className="px-4 py-3 rounded-2xl bg-slate-800 ring-1 ring-white/10"
              onClick={onClose}
            >
              {t("Annulla", "Cancel")}
            </button>
            <AsyncButton
              onClick={save}
              busyText={isNew ? t("Aggiungo...", "Adding...") : t("Salvo...", "Saving...")}
            >
              {isNew ? t("Aggiungi", "Add") : t("Salva", "Save")}
            </AsyncButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function TeaserModal({ initial, onClose }) {
  const { t } = useAdminI18n();
  const [teaser, setTeaser] = useState(() => makeInitialTeaserState(initial));
  const [teaserSaving, setTeaserSaving] = useState(false);
  const [teaserPublishing, setTeaserPublishing] = useState(false);
  const [teaserMessage, setTeaserMessage] = useState("");
  const [teaserError, setTeaserError] = useState("");

  useEffect(() => {
    setTeaser(makeInitialTeaserState(initial));
  }, [initial]);

  const updateTeaser = (patch) => {
    setTeaser((prev) => ({ ...prev, ...patch }));
    setTeaserMessage("");
    setTeaserError("");
  };

  const applyTeaserDefault = () => {
    const nextDefault = teaser.defaultContent || buildDefaultTeaserForInitial(initial, {
      ...teaser,
      defaultImageUrl: teaser.defaultImageUrl,
      imageUrl: teaser.imageUrl
    });
    const defaultImage = ensureImageUrlExt(teaser.defaultImageUrl || teaser.imageUrl || "");
    updateTeaser({
      content: nextDefault,
      defaultContent: nextDefault,
      imageUrl: defaultImage || ensureImageUrlExt(teaser.imageUrl)
    });
    setTeaserMessage(t("Testo suggerito applicato.", "Suggested text applied."));
  };

  async function saveTeaserConfig() {
    try {
      setTeaserSaving(true);
      setTeaserMessage("");
      setTeaserError("");
      const resp = await api.put(`/admin/products/${initial.id}/nostr/teaser`, {
        content: teaser.content,
        imageUrl: ensureImageUrlExt(teaser.imageUrl),
        relays: teaser.relays
      });
      const updated = resp.data?.nostr;
      if (updated) {
        setTeaser(makeInitialTeaserState({ ...initial, nostr: updated }));
      }
      setTeaserMessage(t("Teaser salvato.", "Teaser saved."));
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || t("Errore nel salvataggio del teaser.", "Error saving teaser.");
      setTeaserError(msg);
    } finally {
      setTeaserSaving(false);
    }
  }

  async function publishTeaser() {
    try {
      setTeaserPublishing(true);
      setTeaserMessage("");
      setTeaserError("");
      const resp = await api.post(`/admin/products/${initial.id}/nostr/teaser/publish`, {
        content: teaser.content,
        imageUrl: ensureImageUrlExt(teaser.imageUrl),
        relays: teaser.relays
      });
      const updated = resp.data?.nostr;
      if (updated) {
        setTeaser(makeInitialTeaserState({ ...initial, nostr: updated }));
      }
      const relayResults = resp.data?.relayResults || [];
      const okCount = relayResults.filter((r) => r?.ok).length;
      const totalRelays = relayResults.length || 0;
      setTeaserMessage(
        `${t("Teaser pubblicato", "Teaser published")}: ${okCount}/${totalRelays} ${t("relay OK", "relays OK")}`
      );
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || t("Errore durante la pubblicazione del teaser.", "Error while publishing teaser.");
      setTeaserError(msg);
    } finally {
      setTeaserPublishing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="dialog" aria-modal="true">
      <div className="fixed inset-0 bg-black/60 z-0" onClick={onClose} />
      <div className="relative z-10 flex min-h-full items-start justify-center p-4 sm:p-6">
        <div className="w-full max-w-2xl mx-auto rounded-3xl bg-slate-900 ring-1 ring-white/10 p-6 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-lg font-semibold">{t("Teaser Nostr", "Nostr teaser")}</div>
              <p className="text-sm text-white/60">
                {t("Testo breve per Nostr (Kind-1).", "Short Nostr (Kind-1) note.")}
              </p>
            </div>
            <button
              className="px-3 py-2 rounded-2xl bg-slate-800 ring-1 ring-white/10"
              onClick={onClose}
            >
              {t("Chiudi", "Close")}
            </button>
          </div>

          <NostrTeaserPanel
            value={teaser}
            onChange={updateTeaser}
            onUseDefault={applyTeaserDefault}
            onSave={saveTeaserConfig}
            onPublish={publishTeaser}
            saving={teaserSaving}
            publishing={teaserPublishing}
            message={teaserMessage}
            error={teaserError}
            onClosePanel={onClose}
          />
        </div>
      </div>
    </div>
  );
}

function NostrTeaserPanel({
  value,
  onChange,
  onUseDefault,
  onSave,
  onPublish,
  saving,
  publishing,
  message,
  error,
  onClosePanel
}) {
  const { t } = useAdminI18n();
  const lastPublished =
    value.lastPublishedAt ? new Date(value.lastPublishedAt).toLocaleString() : "";
  const ackList = Array.isArray(value.lastAck) ? value.lastAck : [];
  const successCount = ackList.filter((it) => it.ok).length;
  const relaysText = (value.relays || []).join("\n");
  const fallbackRelays = value.fallbackRelays || [];
  const fallbackRelaysText = fallbackRelays.join("\n");
  const imagePreview = ensureImageUrlExt(value.imageUrl || value.defaultImageUrl || "");
  const livePreview = buildTeaserPreview(value);

  return (
    <div className="rounded-3xl bg-fuchsia-950 ring-1 ring-fuchsia-400/40 p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-lg font-semibold">{t("Teaser Nostr", "Nostr teaser")}</div>
          <div className="text-xs text-white/60">{t("Testo breve da pubblicare come nota Kind-1.", "Short note to publish as Kind-1.")}</div>
        </div>
        <div className="flex-1" />
        {onClosePanel && (
          <button
            type="button"
            className="px-3 py-2 rounded-xl bg-fuchsia-900/80 ring-1 ring-fuchsia-400/40 text-sm"
            onClick={onClosePanel}
          >
            {t("Chiudi", "Close")}
          </button>
        )}
        <button
          type="button"
          className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/20 text-sm"
          onClick={onUseDefault}
        >
          {t("Usa testo suggerito", "Use suggested text")}
        </button>
      </div>

      <div className="grid gap-3">
        <textarea
          rows={8}
          className="w-full px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10 font-mono text-sm"
          value={value.content}
          onChange={(e) => onChange({ content: e.target.value })}
          placeholder={t(
            "🎨 Titolo, breve frase\nPrezzo: 120000 sats\nLink prodotto\nHashtag",
            "🎨 Title, short line\nPrice: 120000 sats\nProduct link\nHashtags"
          )}
        />
        <div className="text-xs text-white/60">{t("Mantieni pochi paragrafi, ogni link su una riga.", "Keep a few short lines; put each link on its own line.")}</div>
      </div>

      <div>
        <div className="text-xs text-white/60 mb-1">{t("Anteprima nota", "Note preview")}</div>
        <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 p-3">
          <pre className="whitespace-pre-wrap text-sm text-white/80">
            {livePreview || t("(nessun contenuto)", "(no content)")}
          </pre>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <label className="block text-sm text-white/70 mb-1">{t("Immagine (URL diretto)", "Image (direct URL)")}</label>
          <input
            className="w-full px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
            value={value.imageUrl || ""}
            onChange={(e) => onChange({ imageUrl: e.target.value })}
            placeholder="https://…/image.jpg"
          />
          <div className="flex items-center gap-3 mt-2 text-xs text-white/60">
            <span>{t("Vuoto = usa l'immagine principale del prodotto.", "Leave empty to use the main product image.")}</span>
            {value.defaultImageUrl && (
              <button
                type="button"
                className="px-2 py-1 rounded-xl bg-slate-800 ring-1 ring-white/20"
                onClick={() => onChange({ imageUrl: value.defaultImageUrl })}
              >
                {t("Usa immagine catalogo", "Use catalog image")}
              </button>
            )}
          </div>
        </div>
        <div className="space-y-3">
          {imagePreview && (
            <div className="rounded-2xl bg-slate-900 ring-1 ring-white/10 h-36 w-full overflow-hidden">
              <img
                src={imagePreview}
                alt={t("Anteprima teaser", "Teaser preview")}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </div>
          )}
          <div>
            <label className="block text-sm text-white/70 mb-1">{t("Relay personalizzati", "Custom relays")}</label>
            <textarea
              rows={3}
              className="w-full px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
              value={relaysText}
              onChange={(e) => onChange({ relays: splitRelaysInput(e.target.value) })}
              placeholder="wss://relay.example\nwss://altro.relay"
            />
            <div className="text-xs text-white/50 mt-1">
              {t("Lascia vuoto per usare i relays di negozio.", "Leave blank to use store relays.")}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <AsyncButton onClick={onSave} loading={saving} busyText={t("Salvo teaser", "Saving teaser")}>
          {t("Salva teaser", "Save teaser")}
        </AsyncButton>
        <AsyncButton
          onClick={onPublish}
          loading={publishing}
          busyText={t("Pubblico teaser…", "Publishing teaser…")}
          className="bg-indigo-500 hover:bg-indigo-400"
        >
          {t("Pubblica teaser", "Publish teaser")}
        </AsyncButton>
      </div>

      {(message || error) && (
        <div className="text-sm">
          {message && <div className="text-emerald-400">{message}</div>}
          {error && <div className="text-rose-400">{error}</div>}
        </div>
      )}

      <div className="rounded-2xl bg-slate-900/60 ring-1 ring-white/10 p-4 space-y-2">
        <div className="text-sm text-white/70 font-medium">
          {t("Ultima pubblicazione teaser", "Last teaser publish")}
        </div>
        <div className="text-xs text-white/50">
          {t("Stato", "Status")}: {ackList.length ? `${successCount} OK / ${ackList.length}` : t("mai pubblicato", "never published")}
        </div>
        {lastPublished && (
          <div className="text-xs text-white/50">{t("Data", "Date")}: {lastPublished}</div>
        )}
        {value.lastEventId && (
          <div className="text-xs text-white/50">
            Event ID:{" "}
            <span className="font-mono break-all text-white/70">{value.lastEventId}</span>
          </div>
        )}
        {ackList.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-white/60">
            {ackList.map((ack) => (
              <li key={`${ack.relay}-${ack.ok ? "ok" : "err"}`}>
                {ack.ok ? "✅" : "⚠️"} {ack.relay}
                {!ack.ok && ack.error ? `, ${ack.error}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function makeInitialTeaserState(initial) {
  const raw = initial?.nostr || {};
  const normalizedDefaultImage = ensureImageUrlExt(raw.defaultImageUrl || raw.imageUrl || "");
  const normalizedImage = ensureImageUrlExt(raw.imageUrl || normalizedDefaultImage || "");
  const defaultContent = raw.teaserDefaultContent || buildDefaultTeaserForInitial(initial, { ...raw, defaultImageUrl: normalizedDefaultImage, imageUrl: normalizedImage });
  return {
    content: raw.teaserContent || defaultContent || "",
    defaultContent,
    relays: Array.isArray(raw.relays) ? raw.relays.slice(0, 16) : [],
    fallbackRelays: Array.isArray(raw.fallbackRelays) ? raw.fallbackRelays : [],
    productUrl: raw.productUrl || "",
    defaultImageUrl: normalizedDefaultImage || "",
    lastEventId: raw.teaserLastEventId || "",
    lastPublishedAt: raw.teaserLastPublishedAt || 0,
    lastAck: Array.isArray(raw.teaserLastAck) ? raw.teaserLastAck : [],
    imageUrl: normalizedImage
  };
}

function buildDefaultTeaserForInitial(initial, raw = {}) {
  const lines = [];
  const title = initial?.title || "";
  const subtitle = initial?.subtitle || "";
  if (title) {
    lines.push(`🎨 ${title}${subtitle ? `, ${subtitle}` : ""}`);
    lines.push("");
  }
  const description = initial?.longDescription || initial?.description || "";
  const firstLine = String(description || "").split("\n").find((l) => l.trim());
  if (firstLine) {
    lines.push(firstLine.trim());
    lines.push("");
  }
  const price = Math.max(0, Number(initial?.priceSats) || 0);
  if (price > 0) {
    lines.push(`Price: ${price.toLocaleString("en-US")} sats`);
    lines.push("");
  }
  if (raw.productUrl) {
    lines.push(`Available here 👉 ${raw.productUrl}`);
  }
  const hashtags = String(raw.teaserHashtags || raw.teaserDefaultHashtags || "").trim();
  if (hashtags) {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(hashtags);
  }
  let output = lines.join("\n");
  output = output.replace(/\n?Buy\/details:[^\n]*/gi, "");
  output = output.replace(/\n{3,}/g, "\n\n").trim();
  return output;
}

function ensureImageUrlExt(url, ext = "jpg") {
  const value = String(url || "").trim();
  if (!value) return "";
  if (!value.includes("/image/") && !value.includes("/thumb/")) return value;
  const [base, ...queryParts] = value.split("?");
  if (/\.(jpg|jpeg|png|webp|gif)$/i.test(base)) {
    return queryParts.length ? `${base}?${queryParts.join("?")}` : base;
  }
  const suffixed = `${base}.${ext}`;
  return queryParts.length ? `${suffixed}?${queryParts.join("?")}` : suffixed;
}

function buildTeaserPreview(value = {}) {
  const base = String(value.content || "").trim();
  const rawLines = base ? base.split(/\r?\n/) : [];
  const imageUrl = ensureImageUrlExt(value.imageUrl || value.defaultImageUrl || "");
  const bodyLines = rawLines.filter((line) => line.trim() !== imageUrl);
  const hasBody = bodyLines.some((line) => line.trim());
  const lines = [];

  if (imageUrl) {
    lines.push(imageUrl);
    if (hasBody) lines.push(""); // spacer after image when body exists
  }

  lines.push(...bodyLines);

  const productUrl = String(value.productUrl || "").trim();
  if (productUrl) {
    const productLine = `Available here 👉 ${productUrl}`;
    const hasProductLine = lines.some((line) => {
      const trimmed = line.trim();
      return trimmed === productLine || trimmed === productUrl;
    });
    if (!hasProductLine) {
      if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
      lines.push(productLine);
    }
  }

  return lines.join("\n").trim();
}

function splitRelaysInput(text) {
  return String(text || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 16);
}

function toNumOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fileToDataUrl(file) {
  const r = new FileReader();
  return new Promise((resolve, reject) => {
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
