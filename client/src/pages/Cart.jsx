import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCart } from "../store/cart.jsx";
import { formatSats } from "../utils/format.js";
import { absoluteApiUrl } from "../services/api.js";

export default function Cart() {
  const { items, remove, subtotal } = useCart();
  const nav = useNavigate();

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
              return (
                <div key={it.product.id} className="rounded-2xl p-4 bg-slate-900 ring-1 ring-white/10 flex gap-4 items-center">
                  <div className="w-24 h-16 rounded-xl overflow-hidden bg-slate-800 ring-1 ring-white/10">
                    {img ? (
                      <img src={img} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full grid place-items-center text-white/50 text-sm">Art</div>
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="font-medium">{it.product.title}</div>
                    <div className="text-white/70">{formatSats(it.product.priceSats)} sats</div>
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
