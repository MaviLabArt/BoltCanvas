import React from "react";
import { Link } from "react-router-dom";
import { useSettings } from "../store/settings.jsx";
import { renderMarkdown } from "../utils/markdown.js";

const DEFAULTS = {
  commissionTitle: "Commissions & Contact",
  commissionBody: "",
  commissionCtaLabel: "Contact me",
  commissionCtaHref: "/about",
};

export default function Commissions() {
  const { settings } = useSettings();

  if (!settings) {
    return (
      <section className="py-8" aria-busy="true">
        <div className="h-8 w-64 rounded bg-slate-800 animate-pulse" />
        <div className="mt-5 h-24 max-w-3xl rounded bg-slate-800/70 animate-pulse" />
      </section>
    );
  }

  const current = { ...DEFAULTS, ...settings };
  const href = String(current.commissionCtaHref || "/about").trim() || "/about";
  const label = current.commissionCtaLabel || "Contact me";
  const isInternalPath = href.startsWith("/") && !href.startsWith("//");
  const isAllowedExternal = /^(https?:\/\/|mailto:|tel:)/i.test(href);
  const isHashLink = href.startsWith("#");

  return (
    <section className="py-8">
      <div className="max-w-3xl mx-auto">
        <header className="mb-8">
          <h1 className="heading text-3xl sm:text-4xl font-semibold tracking-tight">
            {current.commissionTitle || "Commissions & Contact"}
          </h1>
        </header>

        {current.commissionBody && (
          <div
            className="space-y-3 leading-relaxed text-white/80 [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:opacity-80 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_code]:rounded [&_code]:bg-slate-900 [&_code]:px-1"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(current.commissionBody),
            }}
          />
        )}

        <div className="mt-8">
          {isInternalPath ? (
            <Link
              to={href}
              className="inline-flex items-center rounded-2xl bg-indigo-500/90 hover:bg-indigo-500 px-4 py-2 ring-1 ring-white/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              {label}
            </Link>
          ) : isAllowedExternal || isHashLink ? (
            <a
              href={href}
              className="inline-flex items-center rounded-2xl bg-indigo-500/90 hover:bg-indigo-500 px-4 py-2 ring-1 ring-white/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              {label}
            </a>
          ) : (
            <Link
              to="/about"
              className="inline-flex items-center rounded-2xl bg-indigo-500/90 hover:bg-indigo-500 px-4 py-2 ring-1 ring-white/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              {label}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
