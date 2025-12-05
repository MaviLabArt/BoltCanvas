import React, { useEffect, useState } from "react";
import AsyncButton from "../components/AsyncButton.jsx";
import api from "../services/api.js";
import { useAdminI18n } from "./i18n.jsx";

export default function NostrAdmin() {
  const { t } = useAdminI18n();
  const [settings, setSettings] = useState(null);
  const [preview, setPreview] = useState(null);
  const [publishResult, setPublishResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [products, setProducts] = useState([]);
  const [productsBusy, setProductsBusy] = useState(false);
  const [refreshingEvents, setRefreshingEvents] = useState(false);
  const [remoteStatuses, setRemoteStatuses] = useState({});
  const [productStatus, setProductStatus] = useState("");
  const [publishingId, setPublishingId] = useState("");

  const clearMessages = () => {
    setError("");
    setPublishResult(null);
    setImportResult(null);
    setProductStatus("");
  };

  async function handlePreview() {
    clearMessages();
    setBusy(true);
    try {
      // Fetch current settings to show what would be used for the stall event
      const r = await api.get("/admin/settings");
      const s = r.data || {};
      const dTag = s.nostrStallDTag || "main";
      const name = s.storeName || "Lightning Shop";
      const description = s.aboutBody || "";
      const currency = (s.nostrCurrency || "SATS").toUpperCase();
      const relays = Array.isArray(s.nostrRelays) ? s.nostrRelays : [];
      setPreview({
        dTag,
        name,
        description,
        currency,
        relays,
      });
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handlePublish() {
    clearMessages();
    setBusy(true);
    try {
      const r = await api.post("/admin/nostr/stall/publish", {});
      setPublishResult(r.data || {});
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    clearMessages();
    setBusy(true);
    try {
      const r = await api.post("/admin/nostr/import", {});
      setImportResult(r.data || {});
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handlePullProduct() {
    clearMessages();
    setBusy(true);
    try {
      await api.post("/admin/nostr/import", {});
      await refreshProducts();
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function refreshProducts() {
    try {
      setProductsBusy(true);
      const r = await api.get("/admin/products?page=1&pageSize=200");
      const data = r.data;
      const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
      setProducts(items);
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || String(e));
    } finally {
      setProductsBusy(false);
    }
  }

  async function handleRefreshEvents() {
    clearMessages();
    setRefreshingEvents(true);
    try {
      const r = await api.post("/admin/nostr/products/refresh", {});
      const res = r.data || {};
      const map = {};
      (res.results || []).forEach((row) => {
        map[row.productId] = row;
      });
      setRemoteStatuses(map);
      await refreshProducts();
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || String(e));
    } finally {
      setRefreshingEvents(false);
    }
  }

  useEffect(() => {
    api.get("/admin/settings")
      .then((r) => setSettings(r.data || {}))
      .catch(() => setSettings(null));
    refreshProducts();
  }, []);

  async function handlePublishProduct(product) {
    clearMessages();
    if (product?.nostr?.lastEventId) {
      const confirmed = window.confirm(
        t(
          "Esiste già un evento Nostr per questo prodotto. Verrà sovrascritto con i dati locali. Continuare?",
          "A Nostr event already exists for this product. It will be overwritten with local data. Continue?"
        )
      );
      if (!confirmed) return;
    }
    setPublishingId(product.id);
    try {
      const r = await api.post(`/admin/products/${product.id}/nostr/publish`, {});
      const body = r.data || {};
      if (body.skipped) {
        setProductStatus(
          t("Pubblicazione saltata (contenuto invariato).", "Publish skipped (unchanged content).")
        );
      } else {
        const ts = body.nostr?.lastPublishedAt || body.createdAt || Date.now();
        const label = ts ? new Date(ts).toLocaleString() : "";
        setProductStatus(
          label
            ? `${t("Prodotto pubblicato", "Product published")} (${label})`
            : t("Prodotto pubblicato", "Product published")
        );
      }
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || String(e));
    } finally {
      setPublishingId("");
      refreshProducts();
    }
  }

  const stallPublished = !!(settings?.nostrStallLastEventId || settings?.nostrStallCoordinates);
  const stallInfo = stallPublished ? {
    name: settings?.storeName || "",
    coordinates: settings?.nostrStallCoordinates || "",
    eventId: settings?.nostrStallLastEventId || "",
    publishedAt: settings?.nostrStallLastPublishedAt || 0
  } : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">
          {t("Nostr", "Nostr")}
        </h2>
        <p className="text-sm text-slate-300">
          {t(
            "Gestisci l'integrazione Nostr del negozio (stall). Qui pubblichi lo stall, importi da Nostr e controlli gli eventi prodotti.",
            "Manage the shop's Nostr stall integration. Publish the stall, import from Nostr, and inspect product events."
          )}
        </p>
      </div>

      <div className="space-y-3">
        {/* Identifier removed; sync uses shop pubkey from server env */}
        <div className="flex gap-3">
          {!stallPublished && (
            <>
              <AsyncButton
                onClick={handlePreview}
                busy={busy}
                busyText={t("Caricamento...", "Loading...")}
              >
                {t("Anteprima stall", "Preview stall")}
              </AsyncButton>
              <AsyncButton
                onClick={handlePublish}
                busy={busy}
                busyText={t("Pubblicazione...", "Publishing...")}
              >
                {t("Pubblica stall su Nostr", "Publish stall to Nostr")}
              </AsyncButton>
            </>
          )}
          {stallPublished && (
            <div className="flex flex-col gap-2">
              <AsyncButton
                onClick={handleImport}
                busy={busy}
                busyText={t("Sincronizzazione...", "Syncing...")}
              >
                {t("Sync da Nostr", "Sync from Nostr")}
              </AsyncButton>
              <div className="text-xs text-slate-400 bg-slate-900/60 border border-slate-800 rounded-md p-2">
                <div className="mb-1 text-slate-300">
                  {t(
                    "Importa lo stall e SOLO i prodotti nuovi da Nostr. I prodotti esistenti non vengono toccati (usa Pull per un prodotto).",
                    "Imports the stall and ONLY new products from Nostr. Existing products are untouched (use Pull per product)."
                  )}
                </div>
                {stallInfo?.name ? (
                  <div className="font-semibold text-slate-200">{stallInfo.name}</div>
                ) : null}
                {stallInfo?.coordinates ? (
                  <div className="break-all">
                    {t("Coordinate", "Coordinates")}: {stallInfo.coordinates}
                  </div>
                ) : null}
                {stallInfo?.eventId ? (
                  <div className="break-all">
                    {t("Ultimo evento", "Last event")}: {stallInfo.eventId}
                  </div>
                ) : null}
                {stallInfo?.publishedAt ? (
                  <div>
                    {t("Pubblicato il", "Published on")}: {new Date(stallInfo.publishedAt).toLocaleString()}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
        <p className="text-xs text-slate-400">
          {t(
            "L'anteprima mostra i dati che verrebbero usati per costruire l'evento stall (kind 30017) senza inviarlo ai relay.",
            "Preview shows the data that would be used to build the stall event (kind 30017) without sending it to relays."
          )}
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/60 bg-red-950/40 px-3 py-2 text-sm text-red-100">
          {error}
        </div>
      )}

      {preview && (
        <div className="rounded-md border border-slate-700 bg-slate-900/60 p-3 text-sm">
          <div className="font-semibold mb-2">
            {t("Anteprima contenuto stall", "Stall content preview")}
          </div>
          <pre className="whitespace-pre-wrap break-words text-xs">
            {JSON.stringify(
              {
                id: `30017:<pubkey>:${preview.dTag}`,
                name: preview.name,
                description: preview.description,
                currency: preview.currency,
                shipping: [],
              },
              null,
              2
            )}
          </pre>
          <div className="mt-2 text-xs text-slate-400">
            {t("Relay effettivi", "Effective relays")}:{" "}
            {preview.relays && preview.relays.length
              ? preview.relays.join(", ")
              : t("Nessuno configurato", "None configured")}
          </div>
        </div>
      )}

      {publishResult && (
        <div className="rounded-md border border-emerald-600/70 bg-emerald-950/40 p-3 text-sm">
          <div className="font-semibold mb-2">
            {t("Risultato pubblicazione", "Publish result")}
          </div>
          <pre className="whitespace-pre-wrap break-words text-xs">
            {JSON.stringify(publishResult, null, 2)}
          </pre>
        </div>
      )}

      {importResult && (
        <div className="rounded-md border border-sky-600/70 bg-sky-950/40 p-3 text-sm">
          <div className="font-semibold mb-2">
            {t("Risultato sync", "Sync result")}
          </div>
          <pre className="whitespace-pre-wrap break-words text-xs">
            {JSON.stringify(importResult, null, 2)}
          </pre>
        </div>
      )}

      <div className="border-t border-slate-800 pt-6 space-y-4">
        <div className="flex items-center gap-3">
          <div>
            <div className="font-semibold">
              {t("Pubblicazione prodotti su Nostr", "Product publishing on Nostr")}
            </div>
            <p className="text-xs text-slate-400">
              {t(
                "Anteprima rapida di tutti i prodotti con stato di pubblicazione. Ogni card mostra l'ultimo invio Nostr e se esistono versioni remote più recenti.",
                "Quick glance of all products with Nostr publish status. Each card shows the last publish and if newer remote versions exist."
              )}
            </p>
          </div>
          <div className="flex-1" />
          <AsyncButton
            onClick={handleRefreshEvents}
            busy={productsBusy || refreshingEvents}
            busyText={t("Aggiornamento...", "Refreshing...")}
          >
            {t("Aggiorna", "Refresh")}
          </AsyncButton>
        </div>

        {productStatus && (
          <div className="rounded-md border border-emerald-700/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-100">
            {productStatus}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => {
            const status = p?.nostr?.lastPublishedAt
              ? new Date(p.nostr.lastPublishedAt).toLocaleString()
              : null;
            const publishedLabel = status
              ? t("Pubblicato il", "Published on") + ` ${status}`
              : t("Mai pubblicato", "Never published");
            const hash = p?.nostr?.lastContentHash || "";
            const eventId = p?.nostr?.lastEventId || "";
            const lastAck = Array.isArray(p?.nostr?.lastAck) ? p.nostr.lastAck : [];
            const okCount = lastAck.filter((a) => a.ok).length;
            const totalAck = lastAck.length;
            const thumb = p?.mainImageThumbAbsoluteUrl || p?.mainImageThumbUrl || "";
            const alreadyPublished = !!p?.nostr?.lastEventId;
            const remote = remoteStatuses[p.id];
            const newerOnNostr = remote?.remoteIsNewer;
            const remoteLabel = remote?.remoteCreatedAt
              ? new Date(remote.remoteCreatedAt).toLocaleString()
              : null;
            return (
              <div
                key={p.id}
                className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 flex flex-col gap-2"
              >
                <div className="flex gap-3">
                  <div className="w-16 h-16 rounded-md overflow-hidden bg-slate-800 border border-slate-700 flex-shrink-0">
                    {thumb ? (
                      <img src={thumb} alt={p.title} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full grid place-items-center text-xs text-slate-500">
                        {t("Nessuna immagine", "No image")}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">{p.title}</div>
                    <div className="text-xs text-slate-400 truncate">{publishedLabel}</div>
                    {eventId ? (
                    <div className="text-[11px] text-slate-500 break-all leading-snug">
                      {t("Ultimo evento", "Last event")}: {eventId}
                    </div>
                  ) : null}
              {hash ? (
                <div className="text-[11px] text-slate-500 break-all leading-snug">
                  {t("Hash", "Hash")}: {hash}
                </div>
              ) : null}
                  {newerOnNostr && remoteLabel ? (
                    <div className="text-[11px] text-red-400 break-all leading-snug">
                      {t("Evento più recente su Nostr", "Newer event on Nostr")}: {remoteLabel}
                    </div>
                  ) : null}
                  {totalAck ? (
                    <div className="text-[11px] text-slate-500 truncate">
                      {t("Ack", "Ack")}: {okCount}/{totalAck}
                    </div>
                  ) : null}
                  </div>
                </div>
                <div className="flex gap-2">
                  {alreadyPublished ? (
                    <>
                      <AsyncButton
                        className="flex-1"
                        disabled={!stallPublished || busy}
                        onClick={handlePullProduct}
                        busy={busy}
                        busyText={t("Sincronizzo...", "Syncing...")}
                      >
                        {t("Pull da Nostr", "Pull from Nostr")}
                      </AsyncButton>
                      <AsyncButton
                        className="flex-1"
                        onClick={() => handlePublishProduct(p)}
                        disabled={!stallPublished}
                        busy={publishingId === p.id}
                        busyText={t("Pubblico...", "Publishing...")}
                      >
                        {t("Pubblica", "Publish")}
                      </AsyncButton>
                    </>
                  ) : (
                    <AsyncButton
                      className="flex-1"
                      onClick={() => handlePublishProduct(p)}
                      disabled={!stallPublished}
                      busy={publishingId === p.id}
                      busyText={t("Pubblico...", "Publishing...")}
                    >
                      {t("Pubblica", "Publish")}
                    </AsyncButton>
                  )}
                </div>
              </div>
            );
          })}
          {!productsBusy && !products.length && (
            <div className="text-sm text-slate-400">
              {t("Nessun prodotto trovato.", "No products found.")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
