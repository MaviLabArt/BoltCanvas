import React, { useEffect, useMemo, useRef, useState } from "react";
import { nip19 } from "nostr-tools";
import api from "../services/api.js";
import { fetchProfilesForEvents } from "../nostr/profiles.js";
import { resolveRelays } from "../nostr/config.js";
import { useSettings } from "../store/settings.jsx";

function formatDate(timestamp) {
  const seconds = Number(timestamp || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";

  try {
    return new Date(seconds * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  } catch {
    return "";
  }
}

function getReferencedPubkey(identifier) {
  try {
    const decoded = nip19.decode(identifier);

    if (decoded.type === "npub" && typeof decoded.data === "string") {
      return decoded.data;
    }

    if (
      decoded.type === "nprofile" &&
      decoded.data &&
      typeof decoded.data.pubkey === "string"
    ) {
      return decoded.data.pubkey;
    }
  } catch {
    // Keep the original identifier visible if it cannot be decoded.
  }

  return "";
}

function shortIdentifier(identifier) {
  if (!identifier || identifier.length <= 24) return identifier || "";
  return `${identifier.slice(0, 10)}…${identifier.slice(-6)}`;
}

function getReferences(content) {
  const pattern = /nostr:(npub1[023456789acdefghjklmnpqrstuvwxyz]+|nprofile1[023456789acdefghjklmnpqrstuvwxyz]+)/gi;
  return [...new Set(
    [...String(content || "").matchAll(pattern)].map((match) => match[1])
  )];
}

function renderContent(content, profiles) {
  const text = String(content || "");
  const pattern = /nostr:(npub1[023456789acdefghjklmnpqrstuvwxyz]+|nprofile1[023456789acdefghjklmnpqrstuvwxyz]+)/gi;
  const parts = [];
  let lastIndex = 0;
  let match;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const identifier = match[1];
    const pubkey = getReferencedPubkey(identifier);
    const profile = pubkey ? profiles[pubkey] : null;
    const name = String(profile?.display_name || profile?.name || "").trim();
    const label = name || shortIdentifier(identifier);

    parts.push(
      <a
        key={`${identifier}-${index++}`}
        href={`https://njump.me/${identifier}`}
        target="_blank"
        rel="noopener noreferrer"
        title={identifier}
        className="font-medium underline decoration-current/30 underline-offset-4 hover:opacity-75"
      >
        {label}
      </a>
    );

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

export default function NostrTestimonials() {
  const [items, setItems] = useState([]);
  const [referencedProfiles, setReferencedProfiles] = useState({});
  const scrollRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const { settings } = useSettings();

  const relays = useMemo(
    () => resolveRelays(settings?.nostrRelays),
    [settings?.nostrRelays]
  );

  useEffect(() => {
    let active = true;

    api.get("/public/nostr-testimonials")
      .then((response) => {
        const data = response?.data?.testimonials;
        if (active && Array.isArray(data)) setItems(data);
      })
      .catch(() => {
        if (active) setItems([]);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function loadReferencedProfiles() {
      const identifiers = [...new Set(items.flatMap((item) => getReferences(item.content)))];
      const pubkeys = [...new Set(
        identifiers.map(getReferencedPubkey).filter(Boolean)
      )];

      if (!pubkeys.length) {
        setReferencedProfiles({});
        return;
      }

      try {
        const profiles = await fetchProfilesForEvents(
          pubkeys.map((pubkey) => ({ pubkey })),
          relays
        );

        if (active) setReferencedProfiles(profiles || {});
      } catch {
        if (active) setReferencedProfiles({});
      }
    }

    loadReferencedProfiles();

    return () => {
      active = false;
    };
  }, [items, relays]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const updateScrollButtons = () => {
      setCanScrollLeft(element.scrollLeft > 2);
      setCanScrollRight(
        element.scrollLeft + element.clientWidth < element.scrollWidth - 2
      );
    };

    updateScrollButtons();
    element.addEventListener("scroll", updateScrollButtons, { passive: true });

    const observer = new ResizeObserver(updateScrollButtons);
    observer.observe(element);

    return () => {
      element.removeEventListener("scroll", updateScrollButtons);
      observer.disconnect();
    };
  }, [items.length]);

  if (!items.length) return null;

  return (
    <section
      aria-labelledby="nostr-testimonials-heading"
      className="mt-8 mx-auto w-full max-w-6xl"
    >
      <div className="mb-3 flex items-center justify-between gap-3 px-1">
        <h2
          id="nostr-testimonials-heading"
          className="text-lg font-semibold"
        >
          What people say on Nostr
        </h2>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs text-white/60">
            {items.length} {items.length === 1 ? "post" : "posts"}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Scroll testimonials left"
              title="Previous testimonials"
              disabled={!canScrollLeft}
              onClick={() =>
                scrollRef.current?.scrollBy({
                  left: -320,
                  behavior: "smooth"
                })
              }
              className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-lg ring-1 ring-white/10 transition hover:bg-slate-800 disabled:cursor-default disabled:opacity-25"
            >
              ←
            </button>
            <button
              type="button"
              aria-label="Scroll testimonials right"
              title="Next testimonials"
              disabled={!canScrollRight}
              onClick={() =>
                scrollRef.current?.scrollBy({
                  left: 320,
                  behavior: "smooth"
                })
              }
              className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-lg ring-1 ring-white/10 transition hover:bg-slate-800 disabled:cursor-default disabled:opacity-25"
            >
              →
            </button>
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-label="Nostr testimonials. Use the arrow buttons or swipe to read more."
      >
        {items.map((item) => {
          const author = item.author || {};
          const date = formatDate(item.createdAt);
          const timestamp = Number(item.createdAt);
          const validDate = Number.isFinite(timestamp) && timestamp > 0;
          const images = Array.isArray(item.images) ? item.images : [];

          return (
            <article
              key={item.id || item.identifier}
              className="flex w-[min(84vw,320px)] shrink-0 snap-start flex-col self-stretch overflow-hidden rounded-2xl bg-slate-900 p-4 ring-1 ring-white/10"
            >
              <div className="mb-3 flex min-w-0 items-center gap-2">
                {author.picture ? (
                  <img
                    src={author.picture}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-8 w-8 shrink-0 rounded-full bg-slate-800 object-cover"
                  />
                ) : (
                  <div
                    aria-hidden="true"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs text-white/80"
                  >
                    N
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-white/90">
                    {author.name || "Nostr user"}
                  </div>
                  {date && validDate ? (
                    <time
                      dateTime={new Date(timestamp * 1000).toISOString()}
                      className="text-xs text-white/60"
                    >
                      {date}
                    </time>
                  ) : null}
                </div>
              </div>

              <p
                className="whitespace-pre-wrap break-words text-sm leading-relaxed text-white/80"
                style={{
                  display: "-webkit-box",
                  WebkitBoxOrient: "vertical",
                  WebkitLineClamp: 5,
                  overflow: "hidden",
                  overflowWrap: "anywhere"
                }}
              >
                {renderContent(item.content, referencedProfiles)}
              </p>

              {images.length > 0 ? (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {images.slice(0, 2).map((url) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Open testimonial image"
                      className="block overflow-hidden rounded-xl bg-slate-800"
                    >
                      <img
                        src={url}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="h-24 w-full object-cover"
                      />
                    </a>
                  ))}
                </div>
              ) : null}

              <div className="mt-auto border-t border-white/10 pt-3">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-white/70 underline decoration-white/20 underline-offset-4 transition hover:text-white"
                >
                  Read original on Nostr ↗
                </a>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
