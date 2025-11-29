import React, { useEffect, useMemo, useState } from "react";
import ProductCard from "../components/ProductCard.jsx";
import api from "../services/api.js";
import { Link } from "react-router-dom";
import { useSettings } from "../store/settings.jsx";
import { stripMarkdown } from "../utils/markdown.js";
import RecentCommentsStrip from "../components/RecentCommentsStrip.jsx";

const DEFAULT_SETTINGS = {
  logo: "",
  logoDark: "",
  logoLight: "",
  storeName: "Your Shop Name",
  heroLine: "Quality pieces made for you and shipped with care.",
  radiusScale: "3xl",
  productsHeading: "Featured Products",
  // new editable settings used by the hero / teaser / story arc
  aboutTitle: "About Us",
  aboutBody: "Use this space to introduce who you are, what you create, and how you work. Update it with your story and what customers can expect.",
  aboutImage: "",
  heroCtaLabel: "Learn more",
  heroCtaHref: "/about",
  shippingTitle: "How shipping works",
  shippingBullet1: "Ships worldwide from Italy.",
  shippingBullet2: "Europe typically 3–7 days.",
  shippingBullet3: "Carefully packaged. Tracking provided.",
  commissionTitle: "Commissions & Contact",
  commissionBody: "Open to custom requests - share your idea and I will reply with options.",
  commissionCtaLabel: "Write to me",
  commissionCtaHref: "/about"
};

export default function Home() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const { settings: remoteSettings } = useSettings();
  const settings = useMemo(() => {
    if (!remoteSettings) return null;
    return { ...DEFAULT_SETTINGS, ...(remoteSettings || {}) };
  }, [remoteSettings]);

  useEffect(() => {
    api.get("/products")
      .then(r => { setProducts(r.data); setLoadError(false); })
      .catch(()=>{ setProducts([]); setLoadError(true); })
      .finally(()=> setLoading(false));
  }, []);

  // Preserve server-provided order (already respects availability + manual displayOrder)
  const ordered = useMemo(() => products.slice(), [products]);
  const available = useMemo(() => ordered.filter((p) => p.available), [ordered]);
  const sold = useMemo(() => ordered.filter((p) => !p.available), [ordered]);

  const teaserText = useMemo(() => {
    if (!settings) return "";
    const body = stripMarkdown(settings.aboutBody || "");
    if (!body) return "";
    const words = body.split(/\s+/);
    const short = words.slice(0, 28).join(" ");
    return words.length > 28 ? `${short}…` : short;
  }, [settings]);

  const heroLogo = useMemo(() => {
    if (!settings) return "";
    const logoDark = settings.logoDark || settings.logo;
    const logoLight = settings.logoLight;
    const choice = settings.themeChoice || "dark";

    // Resolve effective theme similar to Header (auto -> system preference)
    let effective = choice;
    if (choice === "auto") {
      if (typeof window !== "undefined" && window.matchMedia) {
        effective = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      } else {
        effective = "dark";
      }
    }

    if (effective === "light") {
      return logoLight || logoDark || "";
    }
    // Dark Ink + Ember Night both use the dark logo
    return logoDark || logoLight || "";
  }, [settings]);

  if (!settings) {
    return (
      <section className="pt-8">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="h-6 w-32 bg-slate-800 rounded mb-2" />
          <div className="h-4 w-48 bg-slate-800/80 rounded" />
        </div>
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-5">
          {Array.from({length:8}).map((_,i)=>(
            <div key={i} className="skel">
              <div className="skel-img skel-anim" />
              <div className="p-4 grid gap-2">
                <div className="skel-line skel-anim w-3/4" />
                <div className="skel-line skel-anim w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="pt-8">
      {/* --- HERO / Masthead (big logo only + optional subheading) --- */}
      <div className="mb-8 text-center">
        {heroLogo ? (
          <div className="mb-4 flex justify-center">
            <img
              src={heroLogo}
              alt="logo"
              className="max-h-32 w-auto sm:max-h-40 rounded-none object-contain"
            />
          </div>
        ) : null}
        {/* ⬇️ Store name removed from Home per request */}
        {settings.heroLine && (
          <p className="text-white/80">{settings.heroLine}</p>
        )}
        {/* ⬇️ Removed hero CTA buttons */}
      </div>

      {/* --- About teaser (Option A: Text-first on phones) --- */}
      {settings && (settings.aboutImage || settings.aboutBody) && (
        <div className="mb-8 max-w-3xl mx-auto rounded-3xl p-4 sm:p-5 bg-slate-900 ring-1 ring-white/10">
          <div className="flex flex-col sm:flex-row sm:items-center sm:gap-4">
            {/* Text block first (keeps copy breathing room) */}
            <div className="flex-1 text-left">
              <div className="font-semibold">
          {settings.aboutTitle || "About Us"}
              </div>
              {teaserText && (
                <div className="text-sm text-white/70 mt-1 max-w-[60ch]">
                  {teaserText}
                </div>
              )}
              <div className="mt-2">
                <Link
                  to="/about"
                  className="inline-block underline underline-offset-4 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  Read more →
                </Link>
              </div>
            </div>

            {/* Image as a SMALL SQUARE, shown entirely (no crop), placed BELOW on phone */}
            {settings.aboutImage ? (
              <div className="mt-4 sm:mt-0 flex justify-center sm:block">
                <img
                  src={settings.aboutImage}
                  alt="About"
                  className="h-14 w-14 rounded-xl object-contain bg-slate-800 ring-1 ring-white/10 order-last sm:order-none"
                />
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* --- Gallery heading --- */}
      <div id="gallery" className="mb-2 text-center">
        <h2 className="heading text-2xl sm:text-3xl font-semibold tracking-tight">
          {settings.productsHeading || "Featured Products"}
        </h2>
      </div>

      {(loading || loadError || ordered.length === 0) ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-5">
          {Array.from({length:8}).map((_,i)=>(
            <div key={i} className="skel">
              <div className="skel-img skel-anim" />
              <div className="p-4 grid gap-2">
                <div className="skel-line skel-anim w-3/4" />
                <div className="skel-line skel-anim w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-5">
          {available.map(p => (
            <ProductCard
              key={p.id}
              p={p}
              radiusScale={settings.radiusScale}
            />
          ))}
        </div>
      )}

      {/* Recently Sold (optional) */}
      {sold.length > 0 && (
        <>
          <div className="mt-10 mb-3 text-center">
            <h3 className="heading text-xl font-semibold opacity-90">Recently Sold</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {sold.slice(0,8).map(p => (
              <ProductCard key={p.id} p={p} radiusScale={settings.radiusScale} />
            ))}
          </div>
        </>
      )}

      {/* --- Story arc: shipping bullets --- */}
      {settings && (settings.shippingBullet1 || settings.shippingBullet2 || settings.shippingBullet3) && (
        <div className="mt-12 rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10 max-w-3xl mx-auto">
          <div className="text-lg font-semibold mb-3 text-center">
            {settings.shippingTitle || "How shipping works"}
          </div>
          <ul className="grid gap-2 list-disc pl-6 text-white/80">
            {settings.shippingBullet1 ? <li>{settings.shippingBullet1}</li> : null}
            {settings.shippingBullet2 ? <li>{settings.shippingBullet2}</li> : null}
            {settings.shippingBullet3 ? <li>{settings.shippingBullet3}</li> : null}
          </ul>
        </div>
      )}

      {/* --- Story arc: commission / contact callout --- */}
      {settings && (settings.commissionTitle || settings.commissionBody) && (
        <div className="mt-6 rounded-3xl p-6 bg-slate-900 ring-1 ring-white/10 max-w-3xl mx-auto text-center">
          <div className="text-lg font-semibold">{settings.commissionTitle || "Commissions & Contact"}</div>
          {settings.commissionBody && (
            <p className="mt-2 text-white/80 whitespace-pre-wrap">{settings.commissionBody}</p>
          )}
          <div className="mt-4">
            <Link
              to={settings.commissionCtaHref || "/about"}
              className="px-4 py-2 rounded-2xl bg-indigo-500/90 hover:bg-indigo-500 ring-1 ring-white/10"
            >
              {settings.commissionCtaLabel || "Write to me"}
            </Link>
          </div>
        </div>
      )}

      <RecentCommentsStrip products={ordered} />
    </section>
  );
}
