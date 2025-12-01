import React, { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { useCart } from "../store/cart.jsx";
import { useSettings } from "../store/settings.jsx";
import { COUNTRIES } from "../constants/countries.js";
import { formatSats } from "../utils/format.js";
import api, { API_BASE, absoluteApiUrl } from "../services/api.js";
import QR from "../components/QR.jsx";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import AsyncButton from "../components/AsyncButton.jsx";
import { decode as decodeBolt11 } from "light-bolt11-decoder";
import { loadNip19 } from "../utils/loadNip19.js";
import { computeShippingQuote } from "../utils/shipping.js";

const ACTIVE_PAYMENT_KEY = "lightning-shop-active-payment";

function saveActivePayment(inv) {
  try {
    if (!inv || String(inv.provider || "").toLowerCase() === "btcpay") return;
    localStorage.setItem(ACTIVE_PAYMENT_KEY, JSON.stringify({ ...inv, savedAt: Date.now() }));
  } catch {}
}

function clearActivePayment() {
  try {
    localStorage.removeItem(ACTIVE_PAYMENT_KEY);
  } catch {}
}

export default function Checkout() {
  const { items, clear, subtotal } = useCart();
  const { settings: remoteSettings } = useSettings();
  const [paymentConfig, setPaymentConfig] = useState({ onchainEnabled: true, onchainMinSats: 0 });
  const [form, setForm] = useState({
    name: "",
    surname: "",
    address: "",
    postalCode: "",
    country: "IT",
    contactEmail: "",
    contactTelegram: "",
    contactNostr: "",
    contactPhone: "",
    notes: ""
  });
  const [paymentMethod, setPaymentMethod] = useState("lightning");

  // Prefill Nostr contact if the user is signed in (non-destructive)
  useEffect(() => {
    api
      .get("/nostr/me")
      .then(async (r) => {
        const pk = r.data?.pubkey || "";
        if (!pk) return;
        let nextValue = pk;
        try {
          const { npubEncode } = await loadNip19();
          nextValue = pk.startsWith("npub1") ? pk : npubEncode(pk);
        } catch {
          nextValue = pk;
        }
        setForm((prev) => {
          if (String(prev.contactNostr || "").trim()) return prev; // don't overwrite user input
          return { ...prev, contactNostr: nextValue };
        });
      })
      .catch(() => {});
  }, []);

  // {orderId,paymentHash,paymentRequest,satoshis,totalSats}
  const [inv, setInv] = useState(null);
  const [status, setStatus] = useState("");
  const [showPay, setShowPay] = useState(false);
  const [sseConnected, setSseConnected] = useState(false); // to show LIVE badge
  const nav = useNavigate();
  const provider = useMemo(() => String(paymentConfig?.provider || "").toLowerCase(), [paymentConfig]);
  const isBtcpay = provider === "btcpay";
  const [btcpayFrameUrl, setBtcpayFrameUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.get("/payments/config")
      .then((r) => {
        if (!cancelled) setPaymentConfig(r.data || {});
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Restore active payment if the user reloads mid-payment
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ACTIVE_PAYMENT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const ageMs = Date.now() - Number(parsed.savedAt || 0);
      if (ageMs > 4 * 60 * 60 * 1000) {
        clearActivePayment();
        return;
      }
      const provider = String(parsed.provider || "").toLowerCase();
      if (provider === "btcpay") return; // don't restore BTCPay modal
      const isBtcpay = false;
      const pm = String(parsed.paymentMethod || "").toLowerCase();
      if (pm === "onchain" && parsed.swapId && parsed.onchainAddress) {
        setPaymentMethod("onchain");
        setInv(parsed);
        setStatus("PENDING");
        setShowPay(!isBtcpay);
      } else if (pm === "lightning" && parsed.paymentHash && parsed.paymentRequest) {
        setPaymentMethod("lightning");
        setInv(parsed);
        setStatus("PENDING");
        setShowPay(!isBtcpay);
      }
    } catch {
      // ignore restore errors
    }
  }, []);

  const shippingQuote = useMemo(() => {
    const country = String(form.country || "").toUpperCase();
    return computeShippingQuote({
      items: items.map((it) => ({
        priceSats: Number(it.product?.priceSats || 0),
        shippingItalySats: it.product?.shippingItalySats,
        shippingEuropeSats: it.product?.shippingEuropeSats,
        shippingWorldSats: it.product?.shippingWorldSats,
        shippingZoneOverrides: it.product?.shippingZoneOverrides,
        qty: Math.max(1, Math.floor(Number(it.qty) || 1))
      })),
      settings: remoteSettings || {},
      country
    });
  }, [items, form.country, remoteSettings]);

  const shippingUnavailable = shippingQuote.available === false;
  const shippingSatsDisplay = shippingUnavailable ? null : (shippingQuote.shippingSats || 0);
  const subtotalSats = shippingQuote.subtotalSats ?? subtotal();
  const total = shippingUnavailable
    ? subtotalSats
    : (shippingQuote.totalSats ?? subtotalSats + (shippingQuote.shippingSats || 0));
  const onchainAllowed =
    paymentConfig?.onchainEnabled !== false &&
    (!paymentConfig?.onchainMinSats || total >= paymentConfig.onchainMinSats);
  const countryLabel = useMemo(() => {
    const code = String(form.country || "").toUpperCase();
    const match = COUNTRIES.find((c) => c.code === code);
    return match ? match.name : (code || "Destination");
  }, [form.country]);
  const shipLabel = shippingQuote.zone?.name || countryLabel;

  // --- Guard to ensure PAID/EXPIRED are handled only once per invoice ---
  const resolvedRef = useRef(false);

  // Reset invoice when switching payment method
  useEffect(() => {
    resolvedRef.current = false;
    setInv(null);
    setStatus("");
    setShowPay(false);
  }, [paymentMethod]);

  // Force Lightning if on-chain is not allowed for this total
  useEffect(() => {
    if (paymentMethod === "onchain" && !onchainAllowed) {
      setPaymentMethod("lightning");
    }
  }, [paymentMethod, onchainAllowed]);

  // NEW: hold a pending navigation to /paid/:hash if the tab is hidden when payment completes
  const pendingNavHashRef = useRef(null);

  const handlePaid = useCallback((hash) => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    try {
      clear();
      clearActivePayment();
    } catch {}
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      pendingNavHashRef.current = hash;
    } else {
      nav(`/paid/${hash}`, { replace: true });
    }
  }, [clear, nav]);

  const handleExpired = useCallback((reason = "EXPIRED") => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    const r = String(reason || "EXPIRED").toUpperCase();
    setStatus(r);
    setInv(null);
    setShowPay(false);
    clearActivePayment();
    const msg = r === "FAILED"
      ? "Payment failed. You can create a new payment request."
      : "Invoice expired. You can safely create a new one.";
    alert(msg);
  }, []);

  // Navigate to /paid/:hash as soon as tab becomes visible again
  useEffect(() => {
    function onVis() {
      if (document.visibilityState === "visible" && pendingNavHashRef.current) {
        const h = pendingNavHashRef.current;
        pendingNavHashRef.current = null;
        nav(`/paid/${h}`, { replace: true });
      }
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [nav]);

  // BTCPay inline modal polling
  useEffect(() => {
    if (!isBtcpay || !btcpayFrameUrl || !inv?.paymentHash) return;
    let timer;
    const poll = async () => {
      try {
        const r = await api.get(`/invoices/${inv.paymentHash}/status`);
        const st = String(r.data?.status || "").toUpperCase();
        setStatus(st);
        if (st === "PAID") {
          setBtcpayFrameUrl("");
          return handlePaid(inv.paymentHash);
        }
        if (st === "EXPIRED") {
          setBtcpayFrameUrl("");
          return handleExpired();
        }
      } catch {
        // ignore
      }
      timer = setTimeout(poll, 3000);
    };
    poll();
    return () => {
      clearTimeout(timer);
    };
  }, [isBtcpay, btcpayFrameUrl, inv?.paymentHash, handlePaid, handleExpired]);

  // Live updates via SSE (server proxies Blink GraphQL-WS) with polling fallback
  useEffect(() => {
    if (!inv?.paymentHash) return;
    const isOnchain = String(inv.paymentMethod || "").toLowerCase() === "onchain";
    const invProvider = String(inv?.provider || "").toLowerCase();
    if (invProvider === "btcpay") return; // BTCPay handled via inline modal + webhook
    if (isOnchain && !inv.swapId) return;

    resolvedRef.current = false; // reset on new invoice
    let es;
    let fallbackTimer;

    const startPollingFallback = () => {
      if (resolvedRef.current) return; // don't start polling if already resolved
      setSseConnected(false);
      const poll = async () => {
        if (resolvedRef.current) return;
        try {
          if (isOnchain && inv.swapId) {
            const r = await api.get(`/onchain/${inv.swapId}/status`);
            const st = String(r.data?.status || "").toUpperCase();
            setStatus(st);
            if (st === "PAID") return handlePaid(inv.paymentHash);
            if (st === "EXPIRED" || st === "FAILED") return handleExpired(st);
          } else {
            const r = await api.get(`/invoices/${inv.paymentHash}/status`);
            const st = String(r.data?.status || "").toUpperCase();
            setStatus(st);
            if (st === "PAID") return handlePaid(inv.paymentHash);
            if (st === "EXPIRED") return handleExpired();
          }
        } catch {}
        fallbackTimer = setTimeout(poll, isOnchain ? 5000 : 3000);
      };
      poll();
    };

    try {
      const url = isOnchain
        ? `${API_BASE}/onchain/${inv.swapId}/stream`
        : `${API_BASE}/invoices/${inv.paymentHash}/stream`;
      es = new EventSource(url, { withCredentials: true });
      es.onopen = () => setSseConnected(true);
      es.onmessage = (evt) => {
        if (resolvedRef.current) return;
        try {
          const payload = JSON.parse(evt.data);
          if (!payload?.status) return;
          const st = String(payload.status || "").toUpperCase();
          setStatus(st);
          if (st === "PAID") handlePaid(inv.paymentHash);
          if (st === "EXPIRED" || st === "FAILED") handleExpired(st);
        } catch {}
      };
      es.onerror = () => {
        // When the server closes after PAID/EXPIRED, browsers fire 'error'.
        // Only start fallback if we haven't already resolved.
        try {
          es.close();
        } catch {}
        if (!resolvedRef.current) startPollingFallback();
      };
    } catch {
      startPollingFallback();
    }

    return () => {
      try {
        es?.close();
      } catch {}
      clearTimeout(fallbackTimer);
    };
  }, [inv?.paymentHash, inv?.swapId, inv?.paymentMethod, clear, nav, handlePaid, handleExpired]);

  if (items.length === 0 && !inv) {
    return (
      <section className="pt-8">
        <div className="mb-4">
          <button
            type="button"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10 text-sm"
            onClick={() => nav("/")}
          >
            <span aria-hidden="true">←</span>
            <span>Home</span>
          </button>
        </div>
        <div className="rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10">Your cart is empty.</div>
      </section>
    );
  }

  const BtcpayModal = ({ url, onClose }) => {
    if (!url) return null;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="absolute inset-0" onClick={onClose} />
        <div className="relative w-[92vw] max-w-3xl h-[80vh] bg-slate-900 ring-1 ring-white/10 rounded-2xl overflow-hidden shadow-2xl">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 z-10 rounded-full bg-black/60 text-white px-3 py-1 text-sm"
          >
            Close
          </button>
          <iframe
            title="BTCPay Checkout"
            src={url}
            className="w-full h-full border-0 bg-black"
            allow="payment *; clipboard-read; clipboard-write"
          />
        </div>
      </div>
    );
  };

  function contactProvided() {
    const { contactEmail, contactTelegram, contactNostr } = form;
    return Boolean(
      String(contactEmail || "").trim() ||
        String(contactTelegram || "").trim() ||
        String(contactNostr || "").trim()
    );
  }

  async function submit() {
    if (!String(form.address || "").trim()) {
      alert("Please enter your street address.");
      return;
    }
    if (!String(form.city || "").trim()) {
      alert("Please enter your city.");
      return;
    }
    if (!String(form.province || "").trim()) {
      alert("Please enter your province or state.");
      return;
    }
    if (!String(form.contactPhone || "").trim()) {
      alert("Phone number is required for the courier.");
      return;
    }
    if (!contactProvided()) {
      alert("Please provide at least one contact method: email, Telegram or Nostr.");
      return;
    }
    if (shippingUnavailable) {
      alert("Shipping is not available for this destination. Please pick another country or contact us.");
      return;
    }
    const payload = {
      items: items.map((it) => ({ productId: it.product.id, qty: Math.max(1, Number(it.qty) || 1) })),
      customer: {
        ...form
      },
      paymentMethod
    };
    try {
      const r = await api.post("/checkout/create-invoice", payload);
      const pm = r.data?.paymentMethod || paymentMethod;
      const nextInv = { ...r.data, paymentMethod: pm, provider };
      resolvedRef.current = false;
      setInv(nextInv);
      saveActivePayment(nextInv);
      setStatus("PENDING");
      if (isBtcpay) {
        if (r.data?.checkoutLink) {
          setBtcpayFrameUrl(r.data.checkoutLink);
          setShowPay(false);
          return;
        }
      }
      setShowPay(true);
    } catch (e) {
      alert(e?.response?.data?.error || "Failed to create invoice");
    }
  }

  return (
    <section className="pt-8 grid grid-cols-1 lg:grid-cols-2 gap-8">
      <div className="lg:col-span-2 mb-2">
        <button
          type="button"
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10 text-sm"
          onClick={() => nav("/")}
        >
          <span aria-hidden="true">←</span>
          <span>Home</span>
        </button>
      </div>
      {/* Shipping details */}
      <div className="rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10">
        <div className="text-lg font-semibold mb-4">Shipping Details</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <input
            className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            placeholder="Surname"
            value={form.surname}
            onChange={(e) => setForm({ ...form, surname: e.target.value })}
          />
          <input
            className="sm:col-span-2 px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            placeholder="Address"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
          <input
            className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            placeholder="City"
            value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
          />
          <input
            className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            placeholder="Province / State"
            value={form.province}
            onChange={(e) => setForm({ ...form, province: e.target.value })}
          />
          <input
            className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            placeholder="Postal code"
            value={form.postalCode}
            onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
          />
          <select
            className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            value={form.country}
            onChange={(e) => setForm({ ...form, country: e.target.value })}
          >
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            className="sm:col-span-2 px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            placeholder="Phone number (required for courier)"
            value={form.contactPhone}
            onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
            type="tel"
          />
        </div>

        <div className="mt-2 text-xs text-white/60">
          Couriers require a valid phone number to accept the parcel.
        </div>

        <div className="mt-6">
          <div className="text-lg font-semibold mb-2">Contact (at least one)</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <input
              className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
              placeholder="Email"
              value={form.contactEmail}
              onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
              type="email"
            />
            <input
              className="px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
              placeholder="Telegram (e.g. @nickname)"
              value={form.contactTelegram}
              onChange={(e) => setForm({ ...form, contactTelegram: e.target.value })}
            />
            <input
              className="sm:col-span-2 px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
              placeholder="Nostr npub"
              value={form.contactNostr}
              onChange={(e) => setForm({ ...form, contactNostr: e.target.value })}
            />
          </div>

          <div className="mt-2 text-xs text-white/60">
            Provide at least one contact for proactive updates: <span className="text-white/80 font-medium">email</span>, Telegram, or <span className="text-white/80 font-medium">Nostr</span>.
            Email and Nostr contacts automatically receive updates for every status change.
          </div>
        </div>

        {/* Notes (optional) */}
        <div className="mt-6">
          <div className="text-lg font-semibold mb-2">Notes (optional)</div>
          <textarea
            rows={4}
            className="w-full px-4 py-3 rounded-2xl bg-slate-950 ring-1 ring-white/10"
            placeholder="Anything you'd like us to know (delivery preferences, gift message, VAT details, etc.)"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </div>

        <div className="mt-6">
          <div className="text-lg font-semibold mb-2">Payment Method</div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`px-3 py-2 rounded-2xl ring-1 ${paymentMethod === "lightning" ? "bg-indigo-500/90 ring-indigo-400/60 text-white" : "bg-slate-900 ring-white/10 text-white/80"}`}
              onClick={() => setPaymentMethod("lightning")}
            >
              Lightning (fast)
            </button>
            <button
              type="button"
              className={`px-3 py-2 rounded-2xl ring-1 ${paymentMethod === "onchain" ? "bg-emerald-600/80 ring-emerald-400/60 text-white" : "bg-slate-900 ring-white/10 text-white/80"} ${!onchainAllowed ? "opacity-50 cursor-not-allowed" : ""}`}
              onClick={() => {
                if (onchainAllowed) setPaymentMethod("onchain");
              }}
              disabled={!onchainAllowed}
            >
              On-chain (BTC)
            </button>
          </div>
          <div className="mt-2 text-xs text-white/60">
            Lightning is instant. On-chain uses a Boltz swap: we detect mempool → confirmation → paid and mark your order automatically.
            {!onchainAllowed && paymentConfig?.onchainMinSats ? (
              <div className="text-amber-200 mt-1">
                On-chain available from {formatSats(paymentConfig.onchainMinSats)} sats.
              </div>
            ) : null}
          </div>
        </div>

        {!inv && (
          <AsyncButton
            className="mt-6 pay-now-btn"
            onClick={submit}
            busyText={paymentMethod === "onchain" ? "Creating on-chain request…" : "Creating invoice…"}
          >
            Pay Now
          </AsyncButton>
        )}
      </div>

      {/* Order summary */}
      <div className="rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10">
        <div className="text-lg font-semibold mb-4">Order Summary</div>
        <ul className="space-y-3">
          {items.map((it) => {
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
              <li key={it.product.id} className="flex items-center gap-3">
                <div className="w-16 h-12 rounded-xl overflow-hidden bg-slate-800 ring-1 ring-white/10">
                  {img ? (
                    <img
                      src={img}
                      className="w-full h-full object-cover"
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full grid place-items-center text-white/60 text-xs">
                      Art
                    </div>
                  )}
                </div>
                <div className="flex-1">
                  <div className="font-medium">{it.product.title}</div>
                  <div className="text-white/70 text-sm">
                    {formatSats(it.product.priceSats)} sats
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex items-center justify-between">
          <div className="text-white/70">Subtotal</div>
          <div className="font-medium">{formatSats(subtotalSats)} sats</div>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <div className="text-white/70">Shipping ({shipLabel})</div>
          <div className="text-right">
            {shippingUnavailable ? (
              <span className="text-amber-200 font-medium text-sm">Not available</span>
            ) : shippingSatsDisplay === 0 ? (
              <span className="font-semibold uppercase">FREE</span>
            ) : (
              <span className="font-medium">{formatSats(shippingSatsDisplay)} sats</span>
            )}
          </div>
        </div>
        {shippingUnavailable && (
          <div className="mt-2 text-xs text-amber-200">
            No shipping zone covers {countryLabel}. Choose a different country or contact us.
          </div>
        )}
        <div className="mt-2 flex items-center justify-between text-lg">
          <div className="font-semibold">Total</div>
          <div className="font-semibold">{formatSats(total)} sats</div>
        </div>

        {inv && (
          <div className="mt-6 text-sm text-white/70">
            {paymentMethod === "onchain" ? "On-chain amount (satoshis): " : "Invoice amount (satoshis): "}
            <span className="font-semibold">
              {paymentMethod === "onchain"
                ? formatSats(inv.onchainAmountSats || inv.satoshis || total)
                : formatSats(inv.satoshis ?? inv.totalSats)}
            </span>
            {paymentMethod === "onchain" && paymentConfig?.onchainMinSats ? (
              <span className="ml-2 text-xs text-white/50">(min {formatSats(paymentConfig.onchainMinSats)} sats)</span>
            ) : null}
          </div>
        )}
      </div>

      {/* QR Modal */}
      <AnimatePresence>
        {showPay && inv && (
          inv.paymentMethod === "onchain" ? (
            <OnchainModal
              onClose={() => setShowPay(false)}
              status={status}
              live={sseConnected}
              onchainAddress={inv.onchainAddress}
              onchainAmountSats={inv.onchainAmountSats}
              invoiceSats={inv.satoshis ?? inv.totalSats}
              bip21={inv.onchainBip21}
            />
          ) : (
            <PayModal
              onClose={() => setShowPay(false)}
              paymentRequest={inv.paymentRequest}
              satoshis={inv.satoshis ?? inv.totalSats}
              status={status}
              live={sseConnected}
            />
          )
        )}
      </AnimatePresence>
      <BtcpayModal url={btcpayFrameUrl} onClose={() => setBtcpayFrameUrl("")} />
    </section>
  );
}

function OnchainModal({ onClose, status, live, onchainAddress, onchainAmountSats, invoiceSats = 0, bip21 }) {
  const [copiedAddr, setCopiedAddr] = useState(false);
  const [copiedUri, setCopiedUri] = useState(false);
  const reduce = useReducedMotion();
  const [now, setNow] = useState(Date.now());
  const [startMs] = useState(() => Date.now());
  useStatusFeedback(status);

  const sats = Math.max(0, Math.floor(Number(onchainAmountSats || 0)));
  const btcAmount = sats > 0 ? (sats / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "";
  const uri = bip21 || (onchainAddress ? `bitcoin:${onchainAddress}${btcAmount ? `?amount=${btcAmount}` : ""}` : "");
  const invoiceSatsSafe = Math.max(0, Math.floor(Number(invoiceSats || 0)));
  const feeSats = Math.max(0, sats - invoiceSatsSafe);

  const statusUpper = String(status || "PENDING").toUpperCase();
  const statusLabel = (() => {
    switch (statusUpper) {
      case "MEMPOOL": return "Seen in mempool";
      case "CONFIRMED": return "Confirmed on-chain";
      case "PAID": return "Lightning invoice paid";
      case "FAILED": return "Failed";
      case "EXPIRED": return "Expired";
      default: return "Waiting for payment";
    }
  })();
  const statusClass = (() => {
    if (statusUpper === "PAID") return "bg-emerald-600 text-emerald-50 ring-emerald-200/80";
    if (statusUpper === "CONFIRMED" || statusUpper === "MEMPOOL") return "bg-blue-600 text-blue-50 ring-blue-200/80";
    if (statusUpper === "FAILED" || statusUpper === "EXPIRED") return "bg-rose-600 text-rose-50 ring-rose-200/80";
    return "bg-amber-600 text-amber-50 ring-amber-200/80";
  })();

  async function copyValue(val, setter) {
    try {
      await navigator.clipboard.writeText(val || "");
      setter(true);
      setTimeout(() => setter(false), 1500);
    } catch {}
  }

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const expiryMs = startMs + 2 * 60 * 60 * 1000; // 2h from modal open
  const secsLeft = Math.max(0, Math.floor((expiryMs - now) / 1000));
  const countdown = (() => {
    const h = Math.floor(secsLeft / 3600);
    const m = Math.floor((secsLeft % 3600) / 60);
    const s = secsLeft % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  })();

  const isMempool = statusUpper === "MEMPOOL";

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center"
      initial={reduce ? false : { opacity: 0 }}
      animate={reduce ? {} : { opacity: 1 }}
      exit={reduce ? {} : { opacity: 0 }}
    >
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <motion.div
        initial={reduce ? false : { y: 20, opacity: 0 }}
        animate={reduce ? {} : { y: 0, opacity: 1 }}
        exit={reduce ? {} : { y: 20, opacity: 0 }}
        className="relative w-full max-w-md mx-auto p-6 rounded-3xl bg-slate-900 ring-1 ring-white/10"
      >
        <div className="flex items-center gap-2">
          <div className="text-lg font-semibold">Pay on-chain 🪙</div>
          <span
            className={`ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] ${
              live
                ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30"
                : "bg-yellow-500/10 text-yellow-200 ring-1 ring-yellow-400/30"
            }`}
            title={live ? "Live updates via SSE" : "Syncing via fallback polling"}
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                live ? "bg-emerald-400" : "bg-yellow-300 animate-pulse"
              }`}
            />
            {live ? "LIVE" : "SYNCING"}
          </span>
        </div>
        <div className="mt-2 text-white/80">
          Pay once to this address with the exact amount. We’ll see it in mempool, confirm it, and settle Lightning. Once paid, we’ll contact you within 24h to arrange shipping.
        </div>

        <div className="mt-3 flex flex-wrap gap-3 items-center">
          <div className="text-xl font-semibold">{formatSats(sats)} sats</div>
          {btcAmount && <div className="px-2 py-1 rounded-lg bg-slate-800 ring-1 ring-white/10 text-sm text-white/70">{btcAmount} BTC</div>}
          <motion.span
            key={statusUpper}
            initial={reduce ? false : { scale: 0.9, opacity: 0.6 }}
            animate={reduce ? {} : { scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 18 }}
            className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ring-2 ${statusClass}`}
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-current/80" />
            {statusLabel}
          </motion.span>
          <span className="ml-auto text-xs text-white/70">
            Expires in <span className="font-semibold text-white">{countdown}</span>
          </span>
        </div>
        {feeSats > 0 && (
          <div className="mt-1 text-xs text-white/60">
            Includes on-chain fee: <span className="font-semibold text-white/80">{formatSats(feeSats)} sats</span>
          </div>
        )}
        {isMempool && (
          <div className="mt-3 text-xs text-white/70 flex items-center gap-2">
            <span className="inline-flex gap-1">
              <motion.span
                className="inline-block h-2 w-2 rounded-full bg-white/80"
                animate={reduce ? {} : { x: [0, 12, 0], opacity: [0.6, 1, 0.6] }}
                transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut", delay: 0 }}
              />
              <motion.span
                className="inline-block h-2 w-2 rounded-full bg-white/70"
                animate={reduce ? {} : { x: [0, 12, 0], opacity: [0.6, 1, 0.6] }}
                transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut", delay: 0.2 }}
              />
              <motion.span
                className="inline-block h-2 w-2 rounded-full bg-white/60"
                animate={reduce ? {} : { x: [0, 12, 0], opacity: [0.6, 1, 0.6] }}
                transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut", delay: 0.4 }}
              />
            </span>
            <span>
              Hang in there—once this hits the first confirmation, we’ll settle the Lightning invoice automatically.
            </span>
          </div>
        )}

        <div className="mt-4 grid place-items-center">
          {!isMempool ? (
            <>
              {uri ? (
                <QR value={uri} href={uri} asLink className="rounded-2xl" ariaLabel="Open in on-chain wallet" />
              ) : (
                <div className="w-40 h-40 rounded-2xl bg-slate-800 ring-1 ring-white/10 grid place-items-center text-white/60">
                  Missing address
                </div>
              )}
              <div className="mt-2 text-xs text-white/60 text-center px-4">
                Scan with your on-chain wallet or tap to open if supported.
              </div>
            </>
          ) : (
            <div className="w-48 h-40 rounded-2xl bg-slate-900 ring-1 ring-white/10 grid place-items-center">
              <div className="flex flex-col items-center gap-2 text-white/80 text-sm">
                <div className="inline-flex gap-1">
                  <motion.span
                    className="inline-block h-2.5 w-2.5 rounded-full bg-white/90"
                    animate={reduce ? {} : { x: [0, 10, 0], opacity: [0.5, 1, 0.5] }}
                    transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut", delay: 0 }}
                  />
                  <motion.span
                    className="inline-block h-2.5 w-2.5 rounded-full bg-white/80"
                    animate={reduce ? {} : { x: [0, 10, 0], opacity: [0.5, 1, 0.5] }}
                    transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut", delay: 0.2 }}
                  />
                  <motion.span
                    className="inline-block h-2.5 w-2.5 rounded-full bg-white/70"
                    animate={reduce ? {} : { x: [0, 10, 0], opacity: [0.5, 1, 0.5] }}
                    transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut", delay: 0.4 }}
                  />
                </div>
                <div className="text-center text-white/80 text-xs px-3">
                  Hang in there—waiting for the first confirmation to settle your Lightning payment.
                </div>
              </div>
            </div>
          )}
        </div>

        {!isMempool && (
          <div className="mt-5 space-y-3">
            <div>
              <label className="block text-sm text-white/70 mb-1">Address</label>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={onchainAddress || ""}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 px-3 py-2 rounded-xl bg-slate-950 ring-1 ring-white/10 font-mono text-xs break-all"
                />
                <button
                  onClick={() => copyValue(onchainAddress, setCopiedAddr)}
                  className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10"
                  title="Copy address"
                >
                  {copiedAddr ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm text-white/70 mb-1">BIP-21 link</label>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={uri}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 px-3 py-2 rounded-xl bg-slate-950 ring-1 ring-white/10 font-mono text-xs break-all"
                />
                <button
                  onClick={() => copyValue(uri, setCopiedUri)}
                  className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10"
                  title="Copy payment link"
                >
                  {copiedUri ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 text-sm text-white/80">
          Status: <span className="font-semibold">{statusLabel}</span>
        </div>
        <div className="mt-1 text-xs text-white/60">
          Use normal or higher miner fees. Very low-fee transactions may not confirm before the timeout.
        </div>

        <div className="mt-6 text-right">
          <button className="px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10" onClick={onClose}>
            Close
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// Shared: tiny audible + animation cue on status change
const audioCtxSingleton = (() => {
  let ctx = null;
  return () => {
    if (typeof window === "undefined") return null;
    if (ctx) return ctx;
    const Klass = window.AudioContext || window.webkitAudioContext;
    if (!Klass) return null;
    ctx = new Klass();
    return ctx;
  };
})();

function playPing() {
  try {
    const ctx = audioCtxSingleton();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(880, now);
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    osc.start(now);
    osc.stop(now + 0.21);
  } catch {}
}

function useStatusFeedback(status) {
  const prev = useRef(status);
  useEffect(() => {
    const s = String(status || "").trim();
    if (prev.current && prev.current !== s && s) {
      playPing();
    }
    prev.current = s;
  }, [status]);
}

/** ---------- PayModal with countdown (timestamp-free), wake lock, no ring ---------- */
function PayModal({ onClose, paymentRequest, satoshis, status, live }) {
  const [copied, setCopied] = useState(false);
  const lightningHref = `lightning:${paymentRequest || ""}`;
  // IMPORTANT: call hooks unconditionally (no optional chaining here)
  const reduce = useReducedMotion();
  useStatusFeedback(status);

  // Decode only expiry seconds; ignore invoice timestamp to avoid skew
  const [expirySecs, setExpirySecs] = useState(null);
  useEffect(() => {
    try {
      if (!paymentRequest) return;
      const decoded = decodeBolt11(paymentRequest);
      const exp = Number(decoded.sections.find((s) => s.name === "expiry")?.value);
      setExpirySecs(Number.isFinite(exp) && exp > 0 ? exp : 3600); // default 1h if missing
    } catch {
      setExpirySecs(3600);
    }
  }, [paymentRequest]);

  // Countdown from local start time: always begins at expirySecs and counts down
  const [startMs, setStartMs] = useState(() => Date.now());
  useEffect(() => {
    setStartMs(Date.now()); // reset the timer when a new invoice is shown
  }, [paymentRequest]);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const secsElapsed = Math.floor((now - startMs) / 1000);
  const secsLeft = expirySecs != null ? Math.max(0, expirySecs - secsElapsed) : null;
  const expired = secsLeft === 0 && expirySecs != null;

  // Screen wake lock (best effort)
  useEffect(() => {
    let sentinel;
    let released = false;
    async function lock() {
      try {
        if ("wakeLock" in navigator && navigator.wakeLock?.request) {
          sentinel = await navigator.wakeLock.request("screen");
          sentinel.addEventListener?.("release", () => {});
        }
      } catch {}
    }
    lock();
    return () => {
      try {
        if (!released && sentinel?.release) {
          sentinel.release();
          released = true;
        }
      } catch {}
    };
  }, []);

  function mmss(s) {
    if (s === null || s === undefined) return "—";
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m)}:${String(r).padStart(2, "0")}`;
  }

  async function copyInvoice() {
    try {
      await navigator.clipboard.writeText(paymentRequest || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center"
      initial={reduce ? false : { opacity: 0 }}
      animate={reduce ? {} : { opacity: 1 }}
      exit={reduce ? {} : { opacity: 0 }}
    >
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <motion.div
        initial={reduce ? false : { y: 20, opacity: 0 }}
        animate={reduce ? {} : { y: 0, opacity: 1 }}
        exit={reduce ? {} : { y: 20, opacity: 0 }}
        className="relative w-full max-w-md mx-auto p-6 rounded-3xl bg-slate-900 ring-1 ring-white/10"
      >
        <div className="flex items-center gap-2">
          <div className="text-lg font-semibold">Pay with Lightning ⚡</div>
          <span
            className={`ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] ${
              live
                ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30"
                : "bg-yellow-500/10 text-yellow-200 ring-1 ring-yellow-400/30"
            }`}
            title={live ? "Live updates via SSE" : "Syncing via fallback polling"}
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                live ? "bg-emerald-400" : "bg-yellow-300 animate-pulse"
              }`}
            />
            {live ? "LIVE" : "SYNCING"}
          </span>
        </div>
        <div className="mt-2 text-white/80">Tap the QR to open your wallet or copy the invoice:</div>
        <div className="mt-2 text-xl font-semibold">{formatSats(satoshis)} sats</div>

        {/* QR only */}
        <div className="mt-4 grid place-items-center">
          <div className={`rounded-2xl ${expired ? "opacity-40 pointer-events-none" : "opacity-100"}`}>
            <QR value={paymentRequest} asLink={!expired} className="rounded-2xl min-w-[200px] min-h-[200px]" />
          </div>
          <div className="mt-2 text-xs text-white/60">
            {expired ? "Invoice expired – create a new one." : "Tip: On mobile, tap the QR to open your wallet."}
          </div>

          {/* Countdown */}
          <div className="mt-3 text-sm">
            <span className="text-white/70">Time left:</span>{" "}
            <span className={`font-semibold ${expired ? "text-red-300" : ""}`}>{mmss(secsLeft)}</span>
          </div>
        </div>

        {/* Copyable invoice string */}
        <div className="mt-5">
          <label className="block text-sm text-white/70 mb-1">Lightning Invoice</label>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={paymentRequest || ""}
              onFocus={(e) => e.target.select()}
              className="flex-1 px-3 py-2 rounded-xl bg-slate-950 ring-1 ring-white/10 font-mono text-xs break-all"
            />
            <button onClick={copyInvoice} className="px-3 py-2 rounded-xl bg-slate-800 ring-1 ring-white/10" title="Copy invoice">
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <a
              href={lightningHref}
              className={`px-3 py-2 rounded-2xl ${
                expired ? "bg-slate-800 ring-1 ring-white/10 cursor-not-allowed" : "bg-indigo-500/90 hover:bg-indigo-500"
              }`}
              aria-disabled={expired}
              onClick={(e) => {
                if (expired) e.preventDefault();
              }}
            >
              Open in wallet
            </a>
            {expired && (
              <button className="px-3 py-2 rounded-2xl bg-slate-800 ring-1 ring-white/10" onClick={onClose} title="Close and create a new invoice">
                Close
              </button>
            )}
          </div>
        </div>

      <div className="mt-4 text-sm text-white/80" aria-live="polite">
          Status: <span className="font-semibold">{status || "PENDING"}</span>
        </div>
        <div className="mt-1 text-xs text-white/60">Once paid, we’ll contact you within 24h to arrange shipping.</div>

        {!expired && (
          <div className="mt-6 text-right">
            <button className="px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
