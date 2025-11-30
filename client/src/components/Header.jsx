import React, { useEffect, useMemo, useState, useRef } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useCart } from "../store/cart.jsx";
import api from "../services/api.js";
import { useSettings } from "../store/settings.jsx";
import { loadNip19 } from "../utils/loadNip19.js";
import { fetchProfilesForEvents } from "../nostr/profiles.js";
import { useNostr } from "../providers/NostrProvider.jsx";

export default function Header() {
  const nav = useNavigate();
  const loc = useLocation();
  const { count } = useCart();
  const { pubkey: nostrPk, startLogin, logout } = useNostr();

  const { settings: rawSettings } = useSettings();
  const baseTitle = typeof document !== "undefined" ? document.title : "";
  const s = {
    storeName: "",
    logo: "",
    logoDark: "",
    logoLight: "",
    ...(rawSettings || {})
  };
  const storeLabel = s.storeName || baseTitle || "";
  const [hasOrders, setHasOrders] = useState(false);

  const [npubState, setNpubState] = useState({ npubFull: "", npubShort: "" });
  const [nostrProfile, setNostrProfile] = useState(null);
  const [mobileNostrMenuOpen, setMobileNostrMenuOpen] = useState(false);

  // For cart “flash” animation when an item is added
  const [flashCart, setFlashCart] = useState(false);
  const prevCountRef = useRef(count);
  useEffect(() => {
    const previous = prevCountRef.current;
    prevCountRef.current = count;
    if (count > previous) {
      setFlashCart(true);
      const t = setTimeout(() => setFlashCart(false), 1400);
      return () => clearTimeout(t);
    }
  }, [count]);

  useEffect(() => {
    try {
      const root = document.documentElement;
      const df = s.displayFont || "space-grotesk";
      const bf = s.bodyFont || "inter";
      root.style.setProperty(
        "--font-display",
        df === "fraunces"
          ? '"Fraunces", serif'
          : df === "space-grotesk"
            ? '"Space Grotesk", sans-serif'
            : "system-ui"
      );
      root.style.setProperty(
        "--font-body",
        bf === "geist"
          ? '"Geist", system-ui'
          : bf === "inter"
            ? '"Inter", sans-serif'
            : "system-ui"
      );
    } catch {}
  }, [s.displayFont, s.bodyFont]);

  useEffect(() => {
    let cleanup = () => {};
    try {
      const applyTheme = (choice) => {
        const resolved =
          choice === "auto"
            ? (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
            : (choice || "dark");
        document.documentElement.setAttribute("data-theme", resolved);
      };
      applyTheme(s.themeChoice || "dark");

      if ((s.themeChoice || "dark") === "auto" && window.matchMedia) {
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const handler = () => applyTheme("auto");
        mq.addEventListener?.("change", handler);
        cleanup = () => mq.removeEventListener?.("change", handler);
      }
    } catch {}
    return () => cleanup();
  }, [s.themeChoice]);

  useEffect(() => {
    // Show "Orders" only if there is at least one order for this session (or linked nostr)
    api.get("/orders/mine")
      .then(r => {
        const arr = Array.isArray(r.data) ? r.data : [];
        setHasOrders(arr.length > 0);
      })
      .catch(() => {
        setHasOrders(false);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!nostrPk) {
      setNpubState({ npubFull: "", npubShort: "" });
      setNostrProfile(null);
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      try {
        const { npubEncode } = await loadNip19();
        const full = nostrPk.startsWith("npub1") ? nostrPk : npubEncode(nostrPk);
        const short = full.length <= 16 ? full : `${full.slice(0, 8)}…${full.slice(-6)}`;
        if (!cancelled) setNpubState({ npubFull: full, npubShort: short });
      } catch {
        const hex = String(nostrPk);
        const short = `npub…${hex.slice(-6)}`;
        if (!cancelled) setNpubState({ npubFull: hex, npubShort: short });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nostrPk]);

  const relays = useMemo(() => s?.nostrRelays, [s?.nostrRelays]);

  // Fetch Nostr profile for greeting/avatar
  useEffect(() => {
    let cancelled = false;
    if (!nostrPk) {
      setNostrProfile(null);
      return () => { cancelled = true; };
    }
    (async () => {
      try {
        const profiles = await fetchProfilesForEvents([{ pubkey: nostrPk }], relays);
        const profile = profiles?.[nostrPk];
        if (!cancelled) {
          setNostrProfile(profile ? {
            name: profile.display_name || profile.name || "",
            picture: profile.picture || ""
          } : null);
        }
      } catch {
        if (!cancelled) setNostrProfile(null);
      }
    })();
    return () => { cancelled = true; };
  }, [nostrPk, relays]);

  async function signInWithNostr() {
    startLogin();
  }

  async function signOutNostr() {
    try {
      await logout();
    } catch {
      alert("Logout failed");
    }
  }

  // Render a short npub derived from the hex pubkey (or show the existing npub if provided)
  const { npubFull, npubShort } = npubState;
  const hideHomeButton =
    loc.pathname.startsWith("/product/") ||
    loc.pathname === "/cart" ||
    loc.pathname === "/checkout" ||
    loc.pathname === "/orders" ||
    loc.pathname === "/";

  return (
    <>
      <header className="sticky top-0 z-20 backdrop-blur supports-[backdrop-filter]:bg-white/5 bg-black/20 border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Left: Home button (logo only; hidden on detail/cart/checkout/orders) */}
            {hideHomeButton ? (
              <div className="h-8 w-8" />
            ) : (
              <button
                onClick={() => nav("/")}
                className="text-left flex items-center justify-center h-10 w-10 rounded-xl bg-slate-900 ring-1 ring-white/10 hover:ring-indigo-400/60 transition"
                title="Home"
                aria-label="Home"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-6 w-6 text-white/90"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4.5 11.5 12 4l7.5 7.5" />
                  <path d="M6.5 10.5v8a1 1 0 0 0 1 1H10a1 1 0 0 0 1-1v-4h2v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-8" />
                </svg>
              </button>
            )}

            {/* Right controls */}
            <div className="flex items-center gap-3">
              {/* About removed from header */}

              {hasOrders && (
                <Link
                  to="/orders"
                  className="inline-flex items-center px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-indigo-400"
                  title="My Orders"
                >
                  Orders
                </Link>
              )}

              <Link
                to="/cart"
                className={`relative inline-flex items-center px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-indigo-400 transition-transform duration-300 ease-out ${
                  flashCart
                    ? "scale-110 ring-2 ring-indigo-400 shadow-[0_8px_30px_rgba(99,102,241,0.45)]"
                    : ""
                }`}
                title="Cart"
              >
                Cart ({count})
                {flashCart && (
                  <span
                    className="pointer-events-none absolute -top-1.5 -right-1.5 inline-flex h-4 w-4 rounded-full bg-indigo-300/90 animate-ping"
                    aria-hidden
                  />
                )}
              </Link>

              {/* Nostr auth (desktop) */}
              {nostrPk ? (
                <div className="hidden sm:inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10">
                  <div className="h-8 w-8 rounded-full overflow-hidden bg-slate-800 ring-1 ring-white/10 flex items-center justify-center text-xs font-semibold">
                    {nostrProfile?.picture ? (
                      <img src={nostrProfile.picture} alt={nostrProfile.name || "avatar"} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <span>{(nostrProfile?.name || npubShort || "Hi").slice(0, 2)}</span>
                    )}
                  </div>
                  <div className="text-sm" title={npubFull || nostrPk}>
                    Hi {nostrProfile?.name || npubShort || "there"}!
                  </div>
                  <button
                    onClick={signOutNostr}
                    className="text-xs px-2 py-1 rounded-lg bg-slate-800 ring-1 ring-white/10"
                    title="Sign out of Nostr"
                  >
                    Sign out
                  </button>
                </div>
              ) : (
                <button
                  onClick={signInWithNostr}
                  className="hidden sm:inline-flex items-center px-3 py-2 rounded-xl bg-indigo-500/90 hover:bg-indigo-500 ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-indigo-400"
                  title="Login with Nostr"
                >
                  Login with Nostr
                </button>
              )}

              {/* Nostr auth (mobile) */}
              {/* Mobile: when Orders exists, use compact avatar + popover; else keep default */}
              {hasOrders ? (
                nostrPk ? (
                  <div className="relative sm:hidden">
                    <button
                      onClick={() => setMobileNostrMenuOpen((v) => !v)}
                      className="h-10 w-10 rounded-full overflow-hidden bg-slate-900 ring-1 ring-white/10 flex items-center justify-center text-xs font-semibold"
                      title="Account menu"
                      aria-label="Account menu"
                    >
                      {nostrProfile?.picture ? (
                        <img src={nostrProfile.picture} alt={nostrProfile.name || "avatar"} className="h-full w-full object-cover" loading="lazy" />
                      ) : (
                        <span>{(nostrProfile?.name || npubShort || "Hi").slice(0, 2)}</span>
                      )}
                    </button>
                    {mobileNostrMenuOpen && (
                      <div className="absolute right-0 mt-2 w-48 rounded-xl bg-slate-900 ring-1 ring-white/10 shadow-lg p-3 z-30">
                        <div className="text-sm font-medium truncate" title={npubFull || nostrPk}>
                          {nostrProfile?.name || npubShort || "You"}
                        </div>
                        <button
                          onClick={() => { setMobileNostrMenuOpen(false); signOutNostr(); }}
                          className="mt-2 w-full text-left text-xs px-3 py-2 rounded-lg bg-slate-800 ring-1 ring-white/10"
                        >
                          Sign out
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={signInWithNostr}
                    className="sm:hidden inline-flex items-center px-3 py-2 rounded-xl bg-indigo-500/90 hover:bg-indigo-500 ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-indigo-400 text-xs font-medium"
                    title="Nostr Login"
                    aria-label="Nostr Login"
                  >
                    Nostr Login
                  </button>
                )
              ) : (
                nostrPk ? (
                  <div className="sm:hidden inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10">
                    <div className="h-8 w-8 rounded-full overflow-hidden bg-slate-800 ring-1 ring-white/10 flex items-center justify-center text-xs font-semibold">
                      {nostrProfile?.picture ? (
                        <img src={nostrProfile.picture} alt={nostrProfile.name || "avatar"} className="h-full w-full object-cover" loading="lazy" />
                      ) : (
                        <span>{(nostrProfile?.name || npubShort || "Hi").slice(0, 2)}</span>
                      )}
                    </div>
                    <div className="text-sm" title={npubFull || nostrPk}>
                      Hi {nostrProfile?.name || npubShort || "there"}!
                    </div>
                    <button
                      onClick={signOutNostr}
                      className="text-xs px-2 py-1 rounded-lg bg-slate-800 ring-1 ring-white/10"
                      title="Sign out of Nostr"
                    >
                      Sign out
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={signInWithNostr}
                    className="sm:hidden inline-flex items-center px-3 py-2 rounded-xl bg-indigo-500/90 hover:bg-indigo-500 ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-indigo-400"
                    title="Nostr Login"
                  >
                    Nostr Login
                  </button>
                )
              )}
              {/* No admin link here on purpose */}
            </div>
          </div>
        </div>
      </header>

      {/* Home title (only when there is no logo at all) */}
      {loc.pathname === "/" && !s.logo && !s.logoDark && !s.logoLight && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-6">
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight">
            {storeLabel ? (
              storeLabel
            ) : (
              <span className="inline-block h-4 w-16 bg-slate-800 rounded" aria-hidden />
            )}
          </h1>
        </div>
      )}
    </>
  );
}
