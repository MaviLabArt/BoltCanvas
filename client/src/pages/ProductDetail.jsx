import React, { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api, { absoluteApiUrl } from "../services/api.js";
import { useCart } from "../store/cart.jsx";
import { useSettings } from "../store/settings.jsx";
import { formatSats } from "../utils/format.js";
import { motion, useReducedMotion, AnimatePresence } from "framer-motion";
import { normalizeShippingZones } from "../utils/shipping.js";
import ProductComments from "../components/ProductComments.jsx";

export default function ProductDetail() {
  const { id } = useParams();
  const [p, setP] = useState(null);
  const [active, setActive] = useState(0);
  const nav = useNavigate();
  const { add } = useCart();
  const { settings: remoteSettings } = useSettings();

  // Always call hooks - never behind conditionals
  const reduce = useReducedMotion();
  const [lightbox, setLightbox] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [zoomOrigin, setZoomOrigin] = useState({ x: 50, y: 50 });
  const zoomSteps = [1, 2.4, 3.4];
  const [isMobile, setIsMobile] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const productUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    try {
      const url = new URL(`/product/${id}`, window.location.origin);
      return url.toString();
    } catch {
      return "";
    }
  }, [id]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => {
      setIsMobile(window.innerWidth < 768);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Determine if we have in-app history; otherwise fallback to home on "Back"
  useEffect(() => {
    if (typeof window === "undefined") return;
    const idx = window.history?.state?.idx;
    setCanGoBack(Number.isInteger(idx) && idx > 0);
  }, [id]);

  // Fetch product
  useEffect(() => {
    api
      .get(`/products/${id}`)
      .then((r) => {
        const data = r.data || {};
        const absImages = Array.isArray(data.absImageUrls) ? data.absImageUrls : data.imageUrls;
        const absThumbs = Array.isArray(data.absThumbUrls) ? data.absThumbUrls : data.thumbUrls;
        const merged = { ...data };
        if (absImages) merged.imageUrls = absImages;
        if (absThumbs) merged.thumbUrls = absThumbs;
        setP(merged);
        const idx = Number.isInteger(data?.mainImageIndex)
          ? data.mainImageIndex
          : 0;
        setActive(Math.max(0, idx));
      })
      .catch(() => nav("/"));
  }, [id, nav]);

  // Derive arrays/length safely even when p is null (so effects can depend on them)
  const mainImgs = p
    ? (Array.isArray(p.imageUrls) && p.imageUrls.length > 0
        ? p.imageUrls
        : Array.isArray(p.images)
        ? p.images
        : [])
    : [];
  const thumbImgs = p
    ? (Array.isArray(p.thumbUrls) && p.thumbUrls.length > 0
        ? p.thumbUrls
        : Array.isArray(p.images)
        ? p.images
        : [])
    : [];
  const mainImgsAbs = mainImgs.map((u) => absoluteApiUrl(u));
  const thumbImgsAbs = thumbImgs.map((u) => absoluteApiUrl(u));
  const mainImgsLen = mainImgs.length;

  // Lightbox keyboard controls - depend only on booleans/length, not arrays themselves
  useEffect(() => {
    function onKey(e) {
      if (!lightbox) return;
      if (e.key === "Escape") setLightbox(false);
      if (e.key === "ArrowRight")
        setActive((a) => Math.min(mainImgsLen - 1, a + 1));
      if (e.key === "ArrowLeft") setActive((a) => Math.max(0, a - 1));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, mainImgsLen]);

  // Reset zoom when closing lightbox or switching image
  useEffect(() => {
    if (!lightbox) setZoomLevel(1);
  }, [lightbox, active]);

  const cycleZoom = () => {
    if (isMobile) {
      // On mobile: simple toggle between fit and max zoom
      setZoomLevel((prev) => (prev > 1 ? 1 : zoomSteps[zoomSteps.length - 1]));
      return;
    }
    const idx = zoomSteps.findIndex((z) => z === zoomLevel);
    const next = zoomSteps[(idx + 1) % zoomSteps.length];
    setZoomLevel(next);
  };

  const maxZoom = zoomSteps[zoomSteps.length - 1];
  const isMaxZoom = zoomLevel >= maxZoom;
  const zoomCursor = zoomLevel >= maxZoom ? "zoom-out" : "zoom-in";
  const zoomLabel = `${zoomLevel.toFixed(1).replace(/\\.0$/, "")}x`;

  // Early return is fine now - all hooks above have already run this render
  if (!p) return null;
  const handleBack = () => {
    if (canGoBack) {
      nav(-1);
    } else {
      nav("/", { replace: true });
    }
  };

  const dimText =
    p.showDimensions === false
      ? null
      : (p.widthCm || p.heightCm || p.depthCm
          ? `${p.widthCm ?? "?"}×${p.heightCm ?? "?"}${p.depthCm ? `×${p.depthCm}` : ""} cm`
          : null);

  const shippingZones = normalizeShippingZones(remoteSettings?.shippingZones);
  const productZoneOverrides = Array.isArray(p?.shippingZoneOverrides) ? p.shippingZoneOverrides : [];
  const hasFreePresetForAllZones =
    shippingZones.length > 0 &&
    shippingZones.every((zone) => {
      const match = productZoneOverrides.find((ov) => ov.id === zone.id);
      const price = match ? match.priceSats : zone.priceSats;
      return Number(price || 0) === 0;
    });
  const perProductFreeEverywhere =
    shippingZones.length === 0 &&
    ["shippingItalySats", "shippingEuropeSats", "shippingWorldSats"].every(
      (key) => Number(p?.[key]) === 0
    );
  const showFreeShippingPill = hasFreePresetForAllZones || perProductFreeEverywhere;
  const freeShippingLabel = hasFreePresetForAllZones
    ? "Free Shipping Worldwide"
    : "Free shipping on this piece";

  const hasImages = mainImgs.length > 0;
  const mainImageAbsolute = hasImages ? mainImgsAbs[Math.max(0, Math.min(active, mainImgsAbs.length - 1))] || mainImgsAbs[0] : "";

  return (
    <section className="pt-6">
      <div className="mb-4">
        <button
          className="px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10"
          onClick={handleBack}
        >
          ← Back
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <div className="rounded-3xl overflow-hidden bg-slate-900 ring-1 ring-white/10 aspect-square">
            {hasImages && mainImgsAbs[active] ? (
              <img
                src={mainImgsAbs[active]}
                alt={p.title}
                className="w-full h-full object-contain bg-black/40 cursor-zoom-in"
                loading="eager"
                onClick={() => setLightbox(true)}
              />
            ) : (
              <div className="w-full h-full grid place-items-center text-white/40">
                No image
              </div>
            )}
          </div>
          {thumbImgsAbs.length > 1 && (
            <div className="mt-3 grid grid-cols-5 gap-3">
              {thumbImgsAbs.map((src, i) => (
                <button
                  key={i}
                  onClick={() => setActive(i)}
                  className={`aspect-square rounded-2xl overflow-hidden ring-1 ring-white/10 ${
                    i === active ? "ring-indigo-400" : ""
                  }`}
                >
                  <img
                    src={src}
                    alt={`thumb ${i + 1}`}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <h1 className="text-2xl font-semibold">{p.title}</h1>
          {p.subtitle && <div className="mt-1 text-white/70">{p.subtitle}</div>}
          <div className="mt-4 flex items-center gap-3">
            <span className="text-xs uppercase tracking-[0.25em] text-white/50">Price</span>
            <span className="inline-flex items-baseline gap-1 rounded-2xl bg-indigo-500/15 px-4 py-2 text-3xl font-semibold text-indigo-100">
              {formatSats(p.priceSats)}
              <span className="text-sm font-medium text-indigo-200/80">sats</span>
            </span>
          </div>
          {showFreeShippingPill && (
            <div className="mt-3 inline-flex items-center gap-1 rounded-2xl px-3 py-1 text-xs font-semibold free-shipping-pill">
              {freeShippingLabel}
            </div>
          )}
          {!p.available && (
            <div className="mt-2 inline-block px-2 py-1 rounded-lg bg-white/10 ring-1 ring-white/20 text-white sold-pill">
              SOLD
            </div>
          )}
          {dimText && (
            <div className="mt-3 text-sm text-white/70">Dimensions: {dimText}</div>
          )}

          <p className="mt-6 whitespace-pre-wrap text-white/80">
            {p.longDescription || p.description}
          </p>

          <div className="mt-8">
            <button
              className="px-4 py-3 rounded-2xl bg-indigo-500/90 hover:bg-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-50"
              disabled={!p.available}
              onClick={() => {
                add(p, 1);
              }}
            >
              Add to Cart
            </button>
          </div>
        </div>
      </div>

      <ProductComments productId={p.id} />

      {/* Lightbox */}
      <AnimatePresence>
        {lightbox && (
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={reduce ? false : { opacity: 0 }}
            animate={reduce ? {} : { opacity: 1 }}
            exit={reduce ? {} : { opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
            onClick={() => setLightbox(false)}
          >
            <div
              className="w-[95vw] h-[90vh] max-w-6xl overflow-hidden rounded-2xl bg-black/30 flex items-center justify-center"
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const x = ((e.clientX - rect.left) / rect.width) * 100;
                const y = ((e.clientY - rect.top) / rect.height) * 100;
                setZoomOrigin({ x, y });
                cycleZoom();
              }}
              onPointerMove={(e) => {
                if (zoomLevel <= 1) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const x = ((e.clientX - rect.left) / rect.width) * 100;
                const y = ((e.clientY - rect.top) / rect.height) * 100;
                setZoomOrigin({ x, y });
              }}
              onPointerLeave={(e) => {
                // On desktop, reset zoom when leaving; on touch, keep it
                if (e.pointerType === "mouse" || e.pointerType === "pen" || !e.pointerType) {
                  setZoomLevel(1);
                }
              }}
            >
              <img
                src={mainImgs[active]}
                alt={p.title}
                className="max-h-full max-w-full object-contain transition-transform duration-150 ease-out"
                style={
                  zoomLevel > 1
                    ? {
                        transform: `scale(${zoomLevel})`,
                        transformOrigin: `${zoomOrigin.x}% ${zoomOrigin.y}%`,
                        cursor: zoomCursor
                      }
                    : { cursor: zoomCursor }
                }
                draggable={false}
              />
              <div className="absolute top-3 left-3 px-2.5 py-1 rounded-full bg-black/60 text-xs text-white/80 ring-1 ring-white/10 backdrop-blur zoom-indicator-pill">
                {zoomLabel}
              </div>
            </div>
            <button
              type="button"
              className="absolute top-3 right-3 px-2.5 py-1 rounded-full bg-black/60 text-xs text-white/80 ring-1 ring-white/10 backdrop-blur"
              onClick={(e) => {
                e.stopPropagation();
                setLightbox(false);
              }}
              aria-label="Close image viewer"
            >
              ×
            </button>
            {/* Prev/Next (desktop) */}
            {mainImgsLen > 1 && (
              <>
                <button
                  className="hidden md:flex absolute left-4 top-1/2 -translate-y-1/2 px-3 py-2 rounded-xl bg-white/10 ring-1 ring-white/20 lightbox-arrow"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActive((a) => Math.max(0, a - 1));
                  }}
                >
                  ←
                </button>
                <button
                  className="hidden md:flex absolute right-4 top-1/2 -translate-y-1/2 px-3 py-2 rounded-xl bg-white/10 ring-1 ring-white/20 lightbox-arrow"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActive((a) => Math.min(mainImgsLen - 1, a + 1));
                  }}
                >
                  →
                </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
