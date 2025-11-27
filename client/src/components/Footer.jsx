import React from "react";
import { useSettings } from "../store/settings.jsx";

export default function Footer() {
  const { settings: s } = useSettings();
  const name = s?.storeName || "";
  const note = s?.contactNote || "";
  const year = new Date().getFullYear();
  return (
    <footer className="mt-14 border-t border-white/10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 text-sm text-white/50">
        <div>
          © {year}{" "}
          {name ? (
            name
          ) : (
            <span className="inline-block h-3 w-16 bg-slate-800 rounded align-middle" aria-hidden />
          )}
        </div>
        {note && <div className="mt-1 text-white/40">{note}</div>}
      </div>
    </footer>
  );
}
