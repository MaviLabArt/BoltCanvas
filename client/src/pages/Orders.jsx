import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api, { absoluteApiUrl } from "../services/api.js";
import { formatSats } from "../utils/format.js";

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [prodCache, setProdCache] = useState({}); // productId -> { thumbUrls, imageUrls, mainImageIndex }
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const r = await api.get("/orders/mine");
        if (cancelled) return;
        const list = Array.isArray(r.data) ? r.data : [];
        setOrders(list);

        // Prefetch product details for thumbnails (unique productIds across all orders)
        const ids = new Set();
        for (const o of list) {
          for (const it of o.items || []) {
            if (it.productId) ids.add(it.productId);
          }
        }
        if (ids.size > 0) {
          const entries = await Promise.all(
            [...ids].map(async (pid) => {
              try {
                const pr = await api.get(`/products/${pid}`);
                return [pid, pr.data];
              } catch {
                return [pid, null];
              }
            })
          );
          if (!cancelled) {
            const map = {};
            for (const [pid, val] of entries) map[pid] = val;
            setProdCache(map);
          }
        }
      } catch {
        if (!cancelled) setOrders([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  function statusChipClass(s) {
    const v = String(s || "").toUpperCase();
    if (v === "PENDING") return "bg-amber-600/30";
    if (v === "PAID") return "bg-emerald-600/30";
    if (v === "PREPARATION") return "bg-amber-600/30";
    if (v === "SHIPPED") return "bg-blue-600/30";
    return "bg-white/10";
  }

  function thumbForProduct(product) {
    if (!product) return "";
    const idx = Number.isInteger(product.mainImageIndex) ? product.mainImageIndex : 0;
    const thumbs = Array.isArray(product.thumbUrls) ? product.thumbUrls : [];
    const full = Array.isArray(product.imageUrls) ? product.imageUrls : [];
    const raw =
      product.mainImageThumbAbsoluteUrl ||
      thumbs[idx] ||
      thumbs[0] ||
      product.mainImageAbsoluteUrl ||
      full[idx] ||
      full[0] ||
      "";
    return absoluteApiUrl(raw);
  }

  function thumbsForOrder(o) {
    const out = [];
    const seen = new Set();
    for (const it of o.items || []) {
      const pid = it.productId;
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      const p = prodCache[pid];
      const src = thumbForProduct(p);
      if (src) out.push(src);
      if (out.length >= 3) break; // show up to 3 thumbs
    }
    return out;
  }

  return (
    <section className="pt-8">
      <h1 className="text-2xl font-semibold mb-4">My Orders</h1>

      {orders.length === 0 && !loading ? (
        <div className="rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10">No orders yet.</div>
      ) : (
        <div className="grid gap-4">
          {orders.map((o) => {
            const thumbs = thumbsForOrder(o);
            const isPending = String(o.status || "").toUpperCase() === "PENDING";
            const href = o.paymentHash ? `/paid/${o.paymentHash}` : null; // fallback: if no hash, card is not a link

            const Card = ({ children }) =>
              href ? (
                <Link
                  to={href}
                  className="block rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10 hover:ring-indigo-400/40 hover:bg-slate-900/90 transition"
                  aria-label={`Open details for order ${o.id}`}
                >
                  {children}
                </Link>
              ) : (
                <div className="rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10">{children}</div>
              );

            return (
              <Card key={o.id}>
                <div className="flex items-center gap-3">
                  <div className="font-semibold">Order {o.id}</div>
                  <div className={`px-2 py-1 rounded-lg ${statusChipClass(o.status)}`}>
                    {o.status}
                  </div>
                  <div className="ml-auto text-sm text-white/70">
                    {new Date(o.createdAt).toLocaleString()}
                  </div>
                </div>

                {/* Thumbnails row (up to 3) */}
                <div className="mt-3 flex items-center gap-2">
                  {thumbs.length > 0 ? (
                    thumbs.map((src, i) => (
                      <div
                        key={`${o.id}-thumb-${i}`}
                        className="h-16 w-24 rounded-xl overflow-hidden ring-1 ring-white/10 bg-slate-950"
                      >
                        <img src={src} alt="" className="h-full w-full object-cover" />
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-white/50">No image preview</div>
                  )}
                </div>

                {/* Items list (kept from original) */}
                <ul className="mt-3 list-disc ml-5">
                  {(o.items || []).map((it, i) => (
                    <li key={i}>
                      {it.title}, {formatSats(it.priceSats)} sats
                    </li>
                  ))}
                </ul>

                {/* Totals (kept) */}
                <div className="mt-3 text-sm text-white/70">
                  Total: <span className="font-semibold">{formatSats(o.totalSats)} sats</span>
                </div>

                {/* Notes (kept) */}
                {String(o.notes || "").trim() && (
                  <div className="mt-2 text-sm text-white/70">
                    Notes: <span className="whitespace-pre-wrap text-white/80">{o.notes}</span>
                  </div>
                )}

                {/* Shipping info when available (kept) */}
                {o.status === "SHIPPED" && (o.courier || o.tracking) && (
                  <div className="mt-3 text-sm text-white/70">
                    <div className="font-semibold mb-1">Shipping</div>
                    {o.courier ? (
                      <div>
                        Courier: <span className="text-white/80">{o.courier}</span>
                      </div>
                    ) : null}
                    {o.tracking ? (
                      <div>
                        Tracking: <span className="text-white/80">{o.tracking}</span>
                      </div>
                    ) : null}
                  </div>
                )}

                {/* Inline hint when clickable */}
                {href ? (
                  <div className="mt-3 text-xs text-white/60">
                    {isPending ? "Tap to resume your payment →" : "Click to view details & receipt →"}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
