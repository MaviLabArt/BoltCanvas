import React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Link } from "react-router-dom";
import { formatSats } from "../utils/format.js";
import { absoluteApiUrl } from "../services/api.js";

/**
 * ProductCard
 * - Keeps all original behaviors (SOLD overlay, title/subtitle).
 * - Adds price as a pill inside the image (top-right).
 * - Adds a subtle bottom gradient with "View →" on hover (desktop).
 * - Supports configurable corner radius via `radiusScale` ("xl" | "2xl" | "3xl").
 * - Honors prefers-reduced-motion.
 * - NEW: shows dimensions (W × H × D cm) under the subtitle when available.
 */
export default function ProductCard({ p, radiusScale = "3xl" }) {
  const reduce = useReducedMotion();
  const showDimensions = p?.showDimensions !== false;
  const artworkStatus = p?.artworkStatus || "unclassified";
  const isForSale = artworkStatus === "for_sale" && !!p?.available;
  const statusLabels = {
    sold: "SOLD",
    gifted: "GIFTED",
    personal_collection: "PERSONAL COLLECTION",
    unclassified: "UNCLASSIFIED",
    for_sale: "FOR SALE"
  };
  const statusLabel = artworkStatus === "for_sale" && !p?.available
    ? "NOT AVAILABLE"
    : (statusLabels[artworkStatus] || "UNCLASSIFIED");

  // Prefer server-cached URLs & thumbs when available, fall back to existing fields
  const mainRaw =
    p.mainImageThumbAbsoluteUrl ||
    p.mainImageThumbUrl ||                                        p.mainImageThumb ||
    p.mainImageAbsoluteUrl ||
    p.mainImageUrl ||
    p.mainImage ||
    p.images?.[p.mainImageIndex || 0] ||
    p.images?.[0];
  const main = absoluteApiUrl(mainRaw);

  // Map allowed radius values to Tailwind classes to avoid dynamic-class purge issues
  const radiusMap = {
    xl: "rounded-xl",
    "2xl": "rounded-2xl",
    "3xl": "rounded-3xl"
  };
  const cardRadius = radiusMap[radiusScale] || radiusMap["3xl"];

  // Build dimensions string if values exist (W × H × D cm)
  const dims = (() => {
    if (!showDimensions) return "";
    const w = Number(p.widthCm);
    const h = Number(p.heightCm);
    const d = Number(p.depthCm);
    const hasW = Number.isFinite(w);
    const hasH = Number.isFinite(h);
    const hasD = Number.isFinite(d);

    if (hasW && hasH) return `${w} × ${h}${hasD ? ` × ${d}` : ""} cm`;
    if (hasW || hasH) return `${hasW ? w : ""}${hasW && hasH ? " × " : hasH ? "" : ""}${hasH ? h : ""} cm`;
    return "";
  })();

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={reduce ? {} : { opacity: 1, y: 0 }}
      className={`text-left ${cardRadius} overflow-hidden bg-slate-900 ring-1 ring-white/10`}
      aria-label={`${p.title || "Untitled"}${isForSale ? `, ${formatSats(p.priceSats)} sats` : `, ${statusLabel}`}`}
    >
      <Link to={`/product/${p.id}`} className="block group">
        <div className={`aspect-[4/3] bg-black/40 relative ${cardRadius} overflow-hidden`}>
          {main ? (
            <img
              src={main}
              alt={p.title}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full grid place-items-center text-white/40">No image</div>
          )}

          {isForSale && (
            <div className="absolute top-3 right-3">
              <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-[#292B2A]/95 text-[#F5F0E6] backdrop-blur-sm ring-1 ring-[#B8734F]">
                {formatSats(p.priceSats)} sats
              </span>
            </div>
          )}

          {!isForSale && (
            <div className="absolute bottom-3 right-3">
              <span className="px-2.5 py-1 text-[10px] sm:text-xs font-semibold tracking-wide rounded-full bg-[#292B2A]/90 text-[#F5F0E6] ring-1 ring-[#B8734F]/60">
                {statusLabel}
              </span>
            </div>
          )}

          {/* Hover affordance on desktop */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <div className="rounded-xl bg-gradient-to-t from-black/60 to-transparent px-2 py-1 w-fit flex items-center gap-1 view-pill">
              <span className="text-sm">View</span>
              <span aria-hidden>→</span>
            </div>
          </div>
        </div>

        {/* Title + optional subtitle (price moved to pill) */}
        <div className="p-4">
          <div className="flex items-center gap-2">
            <div className="font-medium truncate" title={p.title}>{p.title || "Untitled"}</div>
            {isForSale && (
              <span className="sr-only">{formatSats(p.priceSats)} sats</span>
            )}
          </div>

          {p.subtitle ? (
            <div className="mt-1 text-sm text-white/60 line-clamp-2">{p.subtitle}</div>
          ) : null}

          {/* NEW: Dimensions line under the subtitle (or under title if no subtitle) */}
          {dims ? (
            <div className={`mt-1 text-xs text-white/60 ${p.subtitle ? "" : ""}`}>
              {dims}
            </div>
          ) : null}
        </div>
      </Link>
    </motion.div>
  );
}
