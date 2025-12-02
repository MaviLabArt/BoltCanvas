import React, { useEffect, useMemo, useState } from "react";
import { fetchRecentProductComments } from "../nostr/read-comments.js";
import { fetchProfilesForEvents } from "../nostr/profiles.js";
import { normalizeComments } from "../nostr/normalize.js";
import { useSettings } from "../store/settings.jsx";
import { Link } from "react-router-dom";
import { isEventBlocked, makeBlockedSets, nostrCommentsEnabled } from "../nostr/config.js";

export default function RecentCommentsStrip({ products }) {
  const { settings } = useSettings();
  const relays = useMemo(() => settings?.nostrRelays, [settings]);
  const storePubkey = useMemo(() => String(settings?.nostrShopPubkey || "").toLowerCase(), [settings]);
  const enabled = nostrCommentsEnabled(settings) && !!storePubkey;
  const [comments, setComments] = useState([]);
  const blocked = useMemo(() => makeBlockedSets(settings), [settings]);

  if (!enabled) return null;

  useEffect(() => {
    let cancelled = false;
    if (!settings) {
      return () => {};
    }
    if (!enabled) {
      setComments([]);
      return () => {};
    }
    async function load() {
      try {
        const events = await fetchRecentProductComments({ relays, storePubkey, limit: 12 });
        const filtered = events.filter((ev) => !isEventBlocked(ev, blocked));
        const profiles = await fetchProfilesForEvents(filtered, relays);
        const normalized = normalizeComments(filtered, profiles).filter((c) => c.productId);
        if (!cancelled) setComments(normalized);
      } catch (err) {
        console.warn("[comments strip] load failed", err);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [relays, storePubkey, enabled, blocked, settings]);

  const productMap = useMemo(() => {
    const map = new Map();
    (products || []).forEach((p) => {
      if (p?.id) map.set(String(p.id), p);
    });
    return map;
  }, [products]);

  if (!comments.length) return null;

  return (
    <section className="mt-12">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold">Our Customers say:</h3>
        <span className="text-xs text-white/60">Live from Nostr</span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {comments.map((c) => {
          const product = productMap.get(c.productId);
          const thumb = product?.mainImageThumbUrl || product?.mainImageThumbAbsoluteUrl || product?.mainImageUrl || product?.mainImageAbsoluteUrl || "";
          return (
            <div
              key={c.id}
              className="min-w-[240px] max-w-[280px] rounded-2xl bg-slate-900 ring-1 ring-white/10 p-3 flex flex-col gap-3"
            >
              <div className="flex items-start gap-3">
                <a
                  href={`https://njump.me/${c.npub || ""}`}
                  target="_blank"
                  rel="noreferrer"
                  className="h-8 w-8 rounded-full overflow-hidden bg-slate-800 ring-1 ring-white/10 flex-shrink-0"
                  title="View on njump"
                >
                  {c.profile?.picture ? (
                    <img src={c.profile.picture} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="h-full w-full grid place-items-center text-[11px] text-white/70">
                      {(c.profile?.name || c.shortNpub || "??").slice(0, 2)}
                    </div>
                  )}
                </a>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="text-xs text-white/60 flex justify-between gap-2">
                    <span className="truncate">{c.profile?.name || c.shortNpub}</span>
                    <span>{new Date((c.createdAt || 0) * 1000).toLocaleDateString()}</span>
                  </div>
                  <div className="text-sm text-white/80 line-clamp-3 whitespace-pre-wrap break-words">
                    {c.content}
                  </div>
                </div>
              </div>
              <div className="mt-auto">
                {product ? (
                  <Link
                    to={`/product/${product.id}`}
                    className="text-xs font-medium text-indigo-200 flex items-center gap-3 hover:text-indigo-100"
                  >
                    {thumb ? (
                      <img
                        src={thumb}
                        alt=""
                        className="h-10 w-10 rounded-lg object-cover ring-1 ring-white/10"
                        loading="lazy"
                      />
                    ) : null}
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="truncate max-w-[120px]">{product.title || "View item"}</span>
                      <span aria-hidden>→</span>
                    </div>
                  </Link>
                ) : (
                  <span className="text-xs text-white/50">Product</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
