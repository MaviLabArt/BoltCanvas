import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import api from "../services/api.js";

const DEFAULT_LANG = "it";

function normalizeLang(raw) {
  const v = String(raw || "").toLowerCase();
  return v === "en" ? "en" : "it";
}

const AdminI18nContext = createContext({
  lang: DEFAULT_LANG,
  loading: true,
  t: (it, en) => it ?? "",
});

export function AdminI18nProvider({ children }) {
  const [lang, setLang] = useState(DEFAULT_LANG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/admin/config")
      .then((r) => {
        if (cancelled) return;
        setLang(normalizeLang(r?.data?.lang));
      })
      .catch(() => {
        // ignore errors, keep default language
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(
    () => ({
      lang,
      loading,
      t: (it, en) => (lang === "en" ? en ?? it ?? "" : it ?? en ?? ""),
    }),
    [lang, loading]
  );

  return (
    <AdminI18nContext.Provider value={value}>
      {children}
    </AdminI18nContext.Provider>
  );
}

export function useAdminI18n() {
  return useContext(AdminI18nContext);
}

