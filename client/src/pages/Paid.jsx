import React, { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import api, { absoluteApiUrl } from "../services/api.js";
import { formatSats } from "../utils/format.js";

/**
 * Paid page:
 * - Still uses the payment hash route param to find the order (not displayed).
 * - Enhancements:
 *   • English status labels on the badge.
 *   • No payment hash shown.
 *   • Prominent, copyable Order ID.
 *   • If SHIPPED, show a shipped headline and courier/tracking details.
 *   • Pretty receipt with thumbnails, address, contacts, notes.
 *   • Simple status timeline (PAID → PREPARATION → SHIPPED).
 */
export default function Paid() {
  const { hash } = useParams();

  const [orders, setOrders] = useState([]);
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [prodCache, setProdCache] = useState({}); // productId -> product detail (with thumbUrls)
  const [copying, setCopying] = useState({ id: false });

  // load /api/orders/mine and pick the order by paymentHash
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const r = await api.get("/orders/mine");
        if (cancelled) return;
        const list = Array.isArray(r.data) ? r.data : [];
        setOrders(list);
        const match = list.find((o) => String(o.paymentHash || "") === String(hash || ""));
        setOrder(match || null);

        // prefetch product data for thumbnails
        if (match && Array.isArray(match.items)) {
          const uniqueIds = Array.from(new Set(match.items.map((it) => it.productId).filter(Boolean)));
          if (uniqueIds.length) {
            const results = await Promise.all(
              uniqueIds.map(async (pid) => {
                try {
                  const pr = await api.get(`/products/${pid}`);
                  return [pid, pr.data];
                } catch {
                  return [pid, null];
                }
              })
            );
            if (!cancelled) {
              const dict = {};
              for (const [pid, val] of results) dict[pid] = val;
              setProdCache(dict);
            }
          }
        }
      } catch {
        if (!cancelled) {
          setOrders([]);
          setOrder(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [hash]);

  const storeDate = useMemo(() => {
    if (!order?.createdAt) return "";
    try { return new Date(order.createdAt).toLocaleString(); } catch { return ""; }
  }, [order?.createdAt]);

  const statusLabel = useMemo(() => {
    const s = String(order?.status || "PAID").toUpperCase();
    if (s === "PENDING") return "PENDING";
    if (s === "PAID") return "PAID";
    if (s === "PREPARATION") return "IN PREPARATION";
    if (s === "SHIPPED") return "SHIPPED";
    return s;
  }, [order?.status]);

  function statusBadgeClasses(s) {
    switch (String(s || "").toUpperCase()) {
      case "PAID": return "bg-emerald-600/30 text-emerald-200 ring-emerald-400/30";
      case "PREPARATION": return "bg-amber-600/30 text-amber-200 ring-amber-400/30";
      case "SHIPPED": return "bg-blue-600/30 text-blue-200 ring-blue-400/30";
      default: return "bg-white/10 text-white/80 ring-white/20";
    }
  }

  function thumbFor(productId) {
    const p = prodCache[productId];
    if (!p) return "";
    const idx = Number.isInteger(p.mainImageIndex) ? p.mainImageIndex : 0;
    const arr = Array.isArray(p.thumbUrls) ? p.thumbUrls : [];
    if (arr[idx]) return absoluteApiUrl(arr[idx]);
    if (arr[0]) return absoluteApiUrl(arr[0]);
    const full = Array.isArray(p.imageUrls) ? p.imageUrls : [];
    if (full[idx]) return absoluteApiUrl(full[idx]);
    if (full[0]) return absoluteApiUrl(full[0]);
    // legacy: products API body may include base64 images; avoid huge inline <img>
    return "";
  }

  async function copy(val, which) {
    try {
      await navigator.clipboard.writeText(String(val || ""));
      setCopying((c) => ({ ...c, [which]: true }));
      setTimeout(() => setCopying((c) => ({ ...c, [which]: false })), 900);
    } catch {}
  }

  function stepClasses(active) {
    return active
      ? "border-emerald-400/60 text-white"
      : "border-white/15 text-white/70";
  }

  // simple logic for the three steps
  const statusUpper = String(order?.status || "PAID").toUpperCase();
  const isPaid = statusUpper === "PAID" || statusUpper === "PREPARATION" || statusUpper === "SHIPPED";
  const isPrep = statusUpper === "PREPARATION" || statusUpper === "SHIPPED";
  const isShipped = statusUpper === "SHIPPED";

  return (
    <section className="pt-8 md:pt-12">
      <div className="max-w-4xl mx-auto grid gap-6">
        {/* Header / hero */}
        <div className="rounded-3xl p-6 md:p-8 bg-slate-900 ring-1 ring-white/10 relative overflow-hidden">
          <div className="absolute inset-0 pointer-events-none opacity-20" aria-hidden>
            <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-indigo-500/20 blur-3xl" />
            <div className="absolute -left-24 -bottom-24 h-64 w-64 rounded-full bg-emerald-500/20 blur-3xl" />
          </div>

          <div className="relative">
            <div className="text-3xl md:text-4xl font-semibold">
              {isShipped
                ? <>🎉 Great news, your order has shipped! 🚚</>
                : <>Payment received <span role="img" aria-label="party">🎉</span></>}
            </div>

            <div className="mt-2 text-white/80">
              {isShipped
                ? "Below are your shipment details and your receipt."
                : <>Thank you! We’ll contact you within <span className="font-semibold">24 hours</span> to confirm shipping details.</>}
            </div>

            {/* Status + date + prominent Order ID */}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className={`inline-flex items-center gap-2 px-2 py-1 rounded-xl text-xs ring-1 ${statusBadgeClasses(order?.status)}`}>
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-current/80" />
                {statusLabel}
              </span>

              {storeDate ? (
                <span className="text-xs text-white/70">• {storeDate}</span>
              ) : null}

              {order?.id ? (
                <div className="ml-auto flex items-center gap-2">
                  <div className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10 font-mono text-sm">
                    <span className="text-white/70 mr-2">Order ID</span>
                    <span className="font-semibold">{order.id}</span>
                  </div>
                  <button
                    onClick={() => copy(order.id, "id")}
                    className="text-xs px-2 py-1 rounded-lg bg-slate-800 ring-1 ring-white/10"
                    title="Copy order ID"
                  >
                    {copying.id ? "Copied!" : "Copy"}
                  </button>
                </div>
              ) : null}
            </div>

            {/* Shipped details (courier + tracking) */}
            {isShipped && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <div className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10">
                  <span className="text-white/70 mr-2">Courier</span>
                  <span className="font-semibold">{order?.courier || "-"}</span>
                </div>
                <div className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10 break-all">
                  <span className="text-white/70 mr-2">Tracking</span>
                  <span className="font-semibold">{order?.tracking || "-"}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Receipt / summary */}
        <div className="rounded-3xl p-6 md:p-7 bg-slate-900 ring-1 ring-white/10">
          <div className="flex items-center gap-3">
            <div className="text-lg font-semibold">Order summary</div>
            {loading && (
              <div className="ml-auto text-xs text-white/60">Loading your order…</div>
            )}
            {!loading && !order && (
              <div className="ml-auto text-xs text-white/60">
                We couldn’t find an order for this session.
                <span className="hidden sm:inline"> You can still see it later under “My Orders”.</span>
              </div>
            )}
          </div>

          {/* Items */}
          {order && (
            <>
              <ul className="mt-4 divide-y divide-white/10">
                {(order.items || []).map((it, i) => {
                  const src = thumbFor(it.productId);
                  return (
                    <li key={`${it.productId || i}-${i}`} className="py-3 flex items-center gap-3">
                      <div className="h-16 w-20 rounded-xl bg-slate-950 ring-1 ring-white/10 overflow-hidden grid place-items-center">
                        {src ? (
                          <img src={src} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-xs text-white/40">No image</span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{it.title}</div>
                        <div className="text-sm text-white/70">Qty: 1</div>
                      </div>
                      <div className="text-right font-medium">{formatSats(it.priceSats)} sats</div>
                    </li>
                  );
                })}
              </ul>

              {/* Totals */}
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10">
                  <div className="text-white/70 text-sm">Subtotal</div>
                  <div className="font-semibold">{formatSats(order.subtotalSats)} sats</div>
                </div>
                <div className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10">
                  <div className="text-white/70 text-sm">Shipping</div>
                  <div className="text-right">
                    {Number(order.shippingSats || 0) === 0 ? (
                      <span className="font-semibold uppercase">FREE</span>
                    ) : (
                      <span className="font-semibold">{formatSats(order.shippingSats)} sats</span>
                    )}
                  </div>
                </div>
                <div className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10">
                  <div className="text-white/70 text-sm">Total</div>
                  <div className="font-semibold">{formatSats(order.totalSats)} sats</div>
                </div>
              </div>

              {/* Address + Contacts + Notes */}
              <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10">
                  <div className="text-white/70 text-sm mb-1">Ship to</div>
                  <div className="whitespace-pre-wrap">
                    {[
                      `${(order.name || "").trim()} ${(order.surname || "").trim()}`.trim(),
                      order.address || "",
                      [order.city, order.province].filter(Boolean).join(", "),
                      [order.postalCode || "", order.country || ""].filter(Boolean).join(" • ")
                    ]
                      .filter((line) => line && line.trim())
                      .join("\n")}
                  </div>
                </div>
                <div className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10">
                  <div className="text-white/70 text-sm mb-1">Contacts</div>
                  <div className="space-y-1">
                    {order.contactEmail ? (
                      <div>Email: <a className="underline" href={`mailto:${order.contactEmail}`}>{order.contactEmail}</a></div>
                    ) : null}
                    {order.contactTelegram ? <div>Telegram: {order.contactTelegram}</div> : null}
                    {order.contactNostr ? <div>Nostr: {order.contactNostr}</div> : null}
                    {order.contactPhone ? <div>Phone: {order.contactPhone}</div> : null}
                    {!order.contactEmail && !order.contactTelegram && !order.contactNostr && !order.contactPhone ? (
                      <div className="text-white/50">—</div>
                    ) : null}
                  </div>
                </div>
                <div className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10">
                  <div className="text-white/70 text-sm mb-1">Notes</div>
                  {String(order.notes || "").trim()
                    ? <div className="whitespace-pre-wrap">{order.notes}</div>
                    : <div className="text-white/50">—</div>}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Timeline / what's next */}
        <div className="rounded-3xl p-6 md:p-7 bg-slate-900 ring-1 ring-white/10">
          <div className="text-lg font-semibold mb-3">What happens next</div>
          <div className="grid sm:grid-cols-3 gap-3">
            <div className={`px-4 py-3 rounded-2xl ring-1 ${stepClasses(isPaid)}`}>
              <div className="font-semibold flex items-center gap-2">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${isPaid ? "bg-emerald-400" : "bg-white/30"}`} />
                Payment received
              </div>
              <div className="text-sm text-white/70 mt-1">We’re verifying and tagging your order.</div>
            </div>
            <div className={`px-4 py-3 rounded-2xl ring-1 ${stepClasses(isPrep)}`}>
              <div className="font-semibold flex items-center gap-2">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${isPrep ? "bg-emerald-400" : "bg-white/30"}`} />
                Preparation
              </div>
              <div className="text-sm text-white/70 mt-1">We package your painting with care.</div>
            </div>
            <div className={`px-4 py-3 rounded-2xl ring-1 ${stepClasses(isShipped)}`}>
              <div className="font-semibold flex items-center gap-2">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${isShipped ? "bg-emerald-400" : "bg-white/30"}`} />
                Shipped
              </div>
              <div className="text-sm text-white/70 mt-1">
                You’ll receive tracking number automatically by Nostr DM and email (if provided). Or we will contact you manually!
              </div>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => window.print()}
            className="px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
          >
            Print receipt
          </button>
          <Link
            to="/orders"
            className="px-4 py-3 rounded-2xl bg-slate-900 ring-1 ring-white/10"
          >
            View my orders
          </Link>
          <Link
            to="/"
            className="px-4 py-3 rounded-2xl bg-indigo-500/90 hover:bg-indigo-500"
          >
            Back to Home
          </Link>
        </div>
      </div>
    </section>
  );
}
