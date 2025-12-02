import React, { useEffect, useMemo, useState } from "react";
import api from "../services/api.js";
import { formatSats } from "../utils/format.js";
import AsyncButton from "../components/AsyncButton.jsx";
import { useAdminI18n } from "./i18n.jsx";

export default function Orders() {
  const { t } = useAdminI18n();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [shippingInputs, setShippingInputs] = useState({});
  const LABEL = useMemo(() => ({
    PENDING: t("IN ATTESA", "PENDING"),
    PAID: t("PAGATO", "PAID"),
    PREPARATION: t("IN PREPARAZIONE", "IN PREPARATION"),
    SHIPPED: t("SPEDITO", "SHIPPED")
  }), [t]);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      // Add an explicit Accept to coax strict proxies/CDNs to return JSON
      const r = await api.get("/admin/orders", {
        headers: { Accept: "application/json" }
      });
      const data = Array.isArray(r.data) ? r.data : [];
      setOrders(data);
    } catch (e) {
      // Keep prior behavior (show "Nessun ordine") but ALSO surface the error so it’s debuggable
      setOrders([]);
      try {
        const status = e?.response?.status;
        const ct = String(e?.response?.headers?.["content-type"] || "");
        const body = (typeof e?.response?.data === "string")
          ? e.response.data.slice(0, 200) // avoid dumping HTML walls
          : JSON.stringify(e?.response?.data || {}, null, 2).slice(0, 200);
        setErr({
          message: e?.message || "Request failed",
          status,
          contentType: ct,
          bodyPreview: body
        });
      } catch {
        setErr({ message: e?.message || String(e) });
      }
      // Console still logs like before (useful when inspecting in devtools)
      console.warn("Failed to load admin orders:", e?.message || e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    setShippingInputs((prev) => {
      const next = {};
      (Array.isArray(orders) ? orders : []).forEach((o) => {
        const existing = prev[o.id] || {};
        next[o.id] = {
          courier: existing.courier !== undefined ? existing.courier : (o.courier || ""),
          tracking: existing.tracking !== undefined ? existing.tracking : (o.tracking || "")
        };
      });
      return next;
    });
  }, [orders]);

  async function setStatus(id, status, extras) {
    await api.post(`/admin/orders/${id}/status`, { status, ...(extras || {}) });
    refresh();
  }
  async function del(id) {
    if (!confirm(t(
      "Eliminare questo ordine? L'operazione è irreversibile.",
      "Delete this order? This cannot be undone."
    ))) return;
    await api.delete(`/admin/orders/${id}`);
    refresh();
  }

  async function markShipped(o) {
    const inputs = shippingInputs[o.id] || { courier: o.courier || "", tracking: o.tracking || "" };
    const courier = String(inputs.courier || "").trim();
    const tracking = String(inputs.tracking || "").trim();
    if (!courier) {
      alert(t("Inserisci il nome del corriere.", "Enter the courier name."));
      return;
    }
    if (!tracking) {
      alert(t("Inserisci il codice di tracking.", "Enter the tracking code."));
      return;
    }
    await setStatus(o.id, "SHIPPED", { courier, tracking });
  }

  function updateShippingInput(id, field, value) {
    setShippingInputs((prev) => {
      const next = { ...prev };
      const current = next[id] || { courier: "", tracking: "" };
      next[id] = { ...current, [field]: value };
      return next;
    });
  }

  return (
    <div className="grid gap-4">
      {/* Error banner (only when the request failed) */}
      {err && (
        <div className="rounded-3xl p-4 bg-red-900/40 ring-1 ring-red-400/40 text-sm">
          <div className="font-semibold">
            {t("Errore nel caricamento ordini", "Error loading orders")}
          </div>
          <div className="mt-1">
            {err.status ? `HTTP ${err.status}` : null}
            {err.contentType ? ` • Content-Type: ${err.contentType}` : null}
          </div>
          <pre className="mt-2 whitespace-pre-wrap text-white/80 break-words">
            {(err.message || "").toString()}
            {err.bodyPreview ? `\n\n${t("Anteprima risposta:", "Response preview:")}\n${err.bodyPreview}` : ""}
          </pre>
          <div className="mt-3 flex gap-2">
            <AsyncButton onClick={refresh} busyText={t("Ricarico...", "Reloading...")}>
              {t("Riprova", "Retry")}
            </AsyncButton>
            <a
              href="/api/admin/orders"
              target="_blank"
              rel="noreferrer"
              className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10"
              title={t(
                "Apri la rotta in una nuova scheda per verificare cosa risponde il proxy",
                "Open the endpoint in a new tab to inspect the proxy response"
              )}
            >
              {t("Apri /api/admin/orders", "Open /api/admin/orders")}
            </a>
          </div>
        </div>
      )}

      {/* Loading indicator (non-blocking) */}
      {loading && (
        <div className="rounded-3xl p-4 bg-slate-900 ring-1 ring-white/10 text-white/70">
          {t("Caricamento ordini…", "Loading orders…")}
        </div>
      )}

      {(!Array.isArray(orders) || orders.length===0) && !loading && (
        <div className="rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10">
          {t("Nessun ordine.", "No orders yet.")}
        </div>
      )}

      {Array.isArray(orders) && orders.map(o=>(
        <div key={o.id} className="rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10">
          <div className="flex items-center gap-3">
            <div className="font-semibold">
              {t("Ordine", "Order")} {o.id}
            </div>
            <div className={`px-2 py-1 rounded-lg ${
              o.status==="PAID"?"bg-emerald-600/30":
              o.status==="PREPARATION"?"bg-amber-600/30":
              o.status==="SHIPPED"?"bg-blue-600/30":"bg-white/10"}`}>
              {LABEL[o.status] || o.status}
            </div>
            <div className="ml-auto text-sm text-white/70">{new Date(o.createdAt).toLocaleString()}</div>
          </div>

          <div className="mt-3 grid md:grid-cols-3 gap-3">
            <div>
              <div className="text-white/70 text-sm">{t("Articoli", "Items")}</div>
              <ul className="list-disc ml-5">
                {(o.items || []).map((it, i)=>(
                  <li key={i}>
                    {it.title}, {formatSats(it.priceSats)} sats
                    {Number.isFinite(it.qty) && it.qty > 1 ? (
                      <span className="text-white/60"> × {it.qty}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <div className="text-white/70 text-sm">{t("Spedire a", "Ship to")}</div>
              <div>{o.name} {o.surname}</div>
              <div>{o.address}</div>
              {[o.city, o.province].some((entry) => entry) && (
                <div>{[o.city, o.province].filter(Boolean).join(", ")}</div>
              )}
              {[o.postalCode, o.country].some((entry) => entry) && (
                <div>{[o.postalCode, o.country].filter(Boolean).join(" • ")}</div>
              )}
            </div>

            <div>
              <div className="text-white/70 text-sm">{t("Contatti", "Contacts")}</div>
              {o.contactEmail && <div>Email: {o.contactEmail}</div>}
              {o.contactTelegram && <div>Telegram: {o.contactTelegram}</div>}
              {o.contactNostr && <div>Nostr: {o.contactNostr}</div>}
              {o.contactPhone && <div>{t("Telefono", "Phone")}: {o.contactPhone}</div>}
              {!o.contactEmail && !o.contactTelegram && !o.contactNostr && !o.contactPhone && (
                <div className="text-white/50">—</div>
              )}
            </div>

            {/* Customer Notes */}
            <div className="md:col-span-3">
              <div className="text-white/70 text-sm">{t("Note cliente", "Customer notes")}</div>
              {String(o.notes || "").trim()
                ? <div className="whitespace-pre-wrap">{o.notes}</div>
                : <div className="text-white/50">—</div>}
            </div>

            {/* Shipment details (visible if present) */}
            {(o.courier || o.tracking) && (
              <div className="md:col-span-3">
                <div className="text-white/70 text-sm">
                  {t("Dettagli spedizione", "Shipping details")}
                </div>
                <div className="flex flex-wrap gap-3">
                  {o.courier ? <div>{t("Corriere", "Courier")}: <span className="font-medium">{o.courier}</span></div> : null}
                  {o.tracking ? <div>Tracking: <span className="font-medium">{o.tracking}</span></div> : null}
                </div>
              </div>
            )}

            {/* Shipment inputs for PAID/PREPARATION orders */}
            {(o.status==="PAID" || o.status==="PREPARATION") && (
              <div className="md:col-span-3">
                <div className="text-white/70 text-sm">
                  {t("Imposta corriere e tracking", "Set courier and tracking")}
                </div>
                <div className="mt-2 grid gap-3 md:grid-cols-2">
                  <label className="block text-sm">
                    <span className="text-xs uppercase tracking-wide text-white/50">
                      {t("Corriere", "Courier")}
                    </span>
                    <input
                      type="text"
                      value={(shippingInputs[o.id]?.courier) ?? (o.courier || "")}
                      onChange={(e)=>updateShippingInput(o.id, "courier", e.target.value)}
                      className="mt-1 w-full px-4 py-2.5 rounded-2xl bg-slate-900 ring-1 ring-white/10 focus:outline-hidden focus:ring-2 focus:ring-indigo-400"
                      placeholder={t("Es. DHL, SDA, GLS…", "E.g. DHL, FedEx, UPS…")}
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="text-xs uppercase tracking-wide text-white/50">Tracking</span>
                    <input
                      type="text"
                      value={(shippingInputs[o.id]?.tracking) ?? (o.tracking || "")}
                      onChange={(e)=>updateShippingInput(o.id, "tracking", e.target.value)}
                      className="mt-1 w-full px-4 py-2.5 rounded-2xl bg-slate-900 ring-1 ring-white/10 focus:outline-hidden focus:ring-2 focus:ring-indigo-400"
                      placeholder={t("Inserisci il codice di tracking", "Enter the tracking code")}
                    />
                  </label>
                </div>
                <div className="text-xs text-white/60 mt-2">
                  {t(
                    'Questi campi sono obbligatori per segnare l\'ordine come "Spedito".',
                    'These fields are required before marking the order as "Shipped".'
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div>{t("Subtotale", "Subtotal")}: {formatSats(o.subtotalSats)} sats</div>
            <div>{t("Spedizione", "Shipping")}: {formatSats(o.shippingSats)} sats</div>
            <div className="font-semibold">{t("Totale", "Total")}: {formatSats(o.totalSats)} sats</div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {/* Vai a PAGATO da PREPARATION o SHIPPED */}
            {(o.status === "PREPARATION" || o.status === "SHIPPED") && (
              <AsyncButton onClick={()=>setStatus(o.id,"PAID")} busyText={t("Aggiorno...", "Updating...")}>
                {t('Segna "Pagato"', 'Mark "Paid"')}
              </AsyncButton>
            )}

            {/* Vai a IN PREPARAZIONE da PAID o SHIPPED */}
            {(o.status === "PAID" || o.status === "SHIPPED") && (
              <AsyncButton onClick={()=>setStatus(o.id,"PREPARATION")} busyText={t("Aggiorno...", "Updating...")}>
                {t('Segna "In preparazione"', 'Mark "In preparation"')}
              </AsyncButton>
            )}

            {/* Vai a SPEDITO da PAID o PREPARATION - asks courier+tracking first */}
            {(o.status==="PAID" || o.status==="PREPARATION") && (
              <AsyncButton onClick={()=>markShipped(o)} busyText={t("Aggiorno...", "Updating...")}>
                {t('Segna "Spedito"', 'Mark "Shipped"')}
              </AsyncButton>
            )}

            <AsyncButton onClick={()=>del(o.id)} busyText={t("Elimino...", "Deleting...")}>
              {t("Elimina ordine", "Delete order")}
            </AsyncButton>
          </div>

          {o.status==="PENDING" && (
            <div className="mt-2 text-xs text-white/60">
              {t(
                "Gli ordini in attesa da oltre 24 ore vengono eliminati automaticamente.",
                "Pending orders older than 24 hours are deleted automatically."
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
