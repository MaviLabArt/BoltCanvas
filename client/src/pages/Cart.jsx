import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCart } from "../store/cart.jsx";
import { formatSats } from "../utils/format.js";
import { absoluteApiUrl } from "../services/api.js";

export default function Cart() {
  const { items, remove, updateQty, subtotal } = useCart();
  const nav = useNavigate();

  const handleChange = (id, next, max) => {
    const safeMax = Number.isFinite(max) && max > 0 ? max : undefined;
    const clamped = Math.max(1, Math.floor(Number(next) || 1));
    updateQty(id, safeMax ? Math.min(clamped, safeMax) : clamped);
  };

  return (
    <section className="pt-8">
      <div className="mb-4">
        <button
          className="px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10"
          onClick={() => nav(-1)}
        >
          ← Back
        </button>
      </div>
      <h1 className="text-2xl font-semibold mb-4">Your Cart</h1>
      {items.length === 0 ? (
        <div className="rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10">
          Cart is empty. <Link to="/" className="underline">Go shopping</Link>.
        </div>
      ) : (
        <>
          <div className="grid gap-4">
            {items.map(it => {
              const img = absoluteApiUrl(
                it.product.previewImage ||
                it.product.mainImageThumbAbsoluteUrl ||
                it.product.mainImageThumbUrl ||
                it.product.mainImageAbsoluteUrl ||
                it.product.mainImageUrl ||
                it.product.imageUrls?.[0] ||
                it.product.thumbUrls?.[0] ||
                (Array.isArray(it.product.images) ? it.product.images[0] : null)
              );
              const maxQty = Number.isFinite(it.product.maxQuantity) ? it.product.maxQuantity : undefined;
              const lineTotal = it.product.priceSats * it.qty;
              const showQtyControls = !it.product.isUnique && (maxQty === undefined || maxQty > 1);
              return (
                <div key={it.product.id} className="rounded-2xl p-4 bg-slate-900 ring-1 ring-white/10 flex gap-4 items-center">
                  <div className="w-24 h-16 rounded-xl overflow-hidden bg-slate-800 ring-1 ring-white/10">
                    {img ? (
                      <img src={img} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full grid place-items-center text-white/50 text-sm">Item</div>
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="font-medium">{it.product.title}</div>
                    <div className="text-white/70">{formatSats(it.product.priceSats)} sats</div>
                    {showQtyControls ? (
                      <div className="mt-2 inline-flex items-center gap-2 rounded-full bg-slate-950 px-3 py-1 ring-1 ring-white/10 text-sm">
                        <button
                          className="h-7 w-7 grid place-items-center rounded-full bg-slate-800 text-white"
                          onClick={() => handleChange(it.product.id, it.qty - 1, maxQty)}
                          aria-label="Decrease quantity"
                          disabled={it.qty <= 1}
                        >
                          −
                        </button>
                        <span className="min-w-[2ch] text-center">{it.qty}</span>
                        <button
                          className="h-7 w-7 grid place-items-center rounded-full bg-slate-800 text-white"
                          onClick={() => handleChange(it.product.id, it.qty + 1, maxQty)}
                          aria-label="Increase quantity"
                          disabled={maxQty !== undefined && it.qty >= maxQty}
                        >
                          +
                        </button>
                        {maxQty !== undefined && (
                          <span className="text-xs text-white/50">
                            {maxQty === 1 ? "One available" : `Max ${maxQty}`}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-white/60">Unique item</div>
                    )}
                  </div>
                  <div className="text-right text-sm text-white/70">
                    <div>Qty: {it.qty}</div>
                    <div className="font-semibold">{formatSats(lineTotal)} sats</div>
                  </div>
                  <button className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10" onClick={()=>remove(it.product.id)}>
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
          <div className="mt-6 flex items-center justify-between">
            <div className="text-white/70">Subtotal</div>
            <div className="font-medium">{formatSats(subtotal())} sats</div>
          </div>
          <div className="mt-6 text-right">
            <button className="px-4 py-3 rounded-2xl bg-indigo-500/90 hover:bg-indigo-500"
              onClick={()=>nav("/checkout")}>Checkout</button>
          </div>
        </>
      )}
    </section>
  );
}
