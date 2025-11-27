import React, { useEffect, useState, useRef } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useCart } from "../store/cart.jsx";
import api from "../services/api.js";
import { useSettings } from "../store/settings.jsx";
import { loadNip19 } from "../utils/loadNip19.js";

let nostrLoginInitialized = false;

export default function Header() {
  const nav = useNavigate();
  const loc = useLocation();
  const { count } = useCart();

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

  // Nostr session state
  const [nostrPk, setNostrPk] = useState("");
  const [npubState, setNpubState] = useState({ npubFull: "", npubShort: "" });

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

  // Nostr: fetch session pk if present
  useEffect(() => {
    api.get("/nostr/me")
      .then(r => {
        const pk = r.data?.pubkey ? String(r.data.pubkey) : "";
        if (pk) {
          setNostrPk(pk);
          try { window.dispatchEvent(new CustomEvent("nostr:session", { detail: { pubkey: pk } })); } catch {}
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!nostrPk) {
      setNpubState({ npubFull: "", npubShort: "" });
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

  // Wait briefly for a nostr provider (handles fast clicks after init)
  async function ensureNostrProvider(timeoutMs = 3000) {
    const started = Date.now();
    while (!(window.nostr && typeof window.nostr.signEvent === "function")) {
      if (Date.now() - started > timeoutMs) return false;
      await new Promise(r => setTimeout(r, 50));
    }
    return true;
  }

  async function signInWithNostr() {
    try {
      // First try: extension or nostr-login provider is ready?
      let ok = await ensureNostrProvider(1200);

      // If not, try to trigger nostr-login modal (if present)
      if (!ok) {
        try {
          if (!nostrLoginInitialized) {
            const { init } = await import("nostr-login");
            const isLight = document.documentElement.getAttribute("data-theme") === "light";
            init({
              theme: "default",
              darkMode: !isLight,
              perms: "sign_event:1",
              noBanner: true
            });
            nostrLoginInitialized = true;
          }
        } catch {
          // ignore - user might rely on browser extension only
        }
        try { document.dispatchEvent(new CustomEvent("nlLaunch", { detail: "login" })); } catch {}
        ok = await ensureNostrProvider(2500);
      }

      // Final fallback: classic message if no provider at all
      if (!ok || !window.nostr?.signEvent) {
        alert("Nostr signer not available. Install a NIP-07 extension (Alby, nos2x) or enable Nostr Login.");
        return;
      }

      const ch = await api.get("/nostr/login/challenge").then(r => r.data.challenge);
      const ev = {
        kind: 27235, // "sign in" (custom; any verified event is fine)
        created_at: Math.floor(Date.now()/1000),
        tags: [["challenge", ch], ["domain", window.location.host]],
        content: `Login to ${(storeLabel || "Shop")}, ${ch}`
      };
      const signed = await window.nostr.signEvent(ev);
      await api.post("/nostr/login/verify", { event: signed });
      const pk = signed.pubkey || "";
      setNostrPk(pk);
      try { window.dispatchEvent(new CustomEvent("nostr:session", { detail: { pubkey: pk } })); } catch {}
      alert("Signed in with Nostr");
    } catch {
      alert("Nostr sign-in failed");
    }
  }

  async function signOutNostr() {
    try {
      await api.post("/nostr/logout");
      setNostrPk("");
      // If nostr-login is present, ask it to clear local connection as well
      try { document.dispatchEvent(new Event("nlLogout")); } catch {}
      try {
        window.dispatchEvent(new Event("nostr:logout"));
        window.dispatchEvent(new CustomEvent("nostr:session", { detail: { pubkey: "" } }));
      } catch {}
    } catch {}
  }

  // Render a short npub derived from the hex pubkey (or show the existing npub if provided)
  const { npubFull, npubShort } = npubState;
  const hideHomeButton =
    loc.pathname.startsWith("/product/") ||
    loc.pathname === "/cart" ||
    loc.pathname === "/checkout" ||
    loc.pathname === "/orders";

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
                className="text-left flex items-center gap-3"
                title="Home"
              >
                {/* No small logo on Home; keep it on other pages */}
                {s.logo && loc.pathname !== "/" ? (
                  <img
                    src={s.logo}
                    alt="logo"
                    className="h-8 w-8 rounded-lg object-cover ring-1 ring-white/10"
                  />
                ) : null}
                {/* Store name removed from header as requested */}
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

              {/* Nostr auth (text updated) */}
              {nostrPk ? (
                <div className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900 ring-1 ring-white/10">
                  <span title={npubFull || nostrPk}>Signed: {npubShort}</span>
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
                  className="inline-flex items-center px-3 py-2 rounded-xl bg-indigo-500/90 hover:bg-indigo-500 ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-indigo-400"
                  title="Login with Nostr"
                >
                  Login with Nostr
                </button>
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
