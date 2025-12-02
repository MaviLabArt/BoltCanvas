import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import api from "../services/api.js";

const SettingsContext = createContext({
  settings: null,
  loading: true,
  error: null,
  refresh: () => {}
});

const CACHE_KEY = "ls-public-settings";

function loadCachedSettings() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const DEFAULT_THEME_TOKENS = {
  accent: "#6366f1",
  accentSoft: "rgba(99, 102, 241, 0.16)",
  surface: "#0f172a",
  surfaceAlt: "#111827",
  text: "#e5e7eb",
  muted: "#94a3b8",
  border: "rgba(255, 255, 255, 0.08)"
};

function persistCachedSettings(val) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(val || {}));
  } catch {
    // ignore storage errors
  }
}

export function SettingsProvider({ children }) {
  const initialCacheRaw = loadCachedSettings();
  const mergeThemeTokens = useCallback((raw) => {
    const base = { ...DEFAULT_THEME_TOKENS };
    if (raw && typeof raw === "object") {
      Object.entries(raw).forEach(([k, v]) => {
        if (typeof v === "string" && v.trim() !== "") {
          base[k] = v;
        }
      });
    }
    return base;
  }, []);
  const initialCache = initialCacheRaw ? { ...initialCacheRaw, themeTokens: mergeThemeTokens(initialCacheRaw.themeTokens) } : null;
  const [settings, setSettings] = useState(initialCache);
  const [loading, setLoading] = useState(!initialCache);
  const [error, setError] = useState(null);
  const fallbackTitle = typeof document !== "undefined" ? document.title : "Lightning Shop";

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await api.get("/public-settings");
      const data = r.data || {};
      const merged = { ...data, themeTokens: mergeThemeTokens(data.themeTokens) };
      setSettings(merged);
      persistCachedSettings(merged);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [mergeThemeTokens]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    try {
      const nextTitle = String(settings?.storeName || fallbackTitle).trim() || fallbackTitle;
      if (typeof document !== "undefined" && document.title !== nextTitle) {
        document.title = nextTitle;
      }
    } catch {
      // ignore title update errors
    }
  }, [settings?.storeName]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const rels = ["icon", "shortcut icon"];
    const selector = rels.map((rel) => `link[rel="${rel}"][data-managed="ls-favicon"]`).join(",");
    const clearManagedIcons = () => {
      document.querySelectorAll(selector).forEach((el) => {
        try { el.remove(); } catch {}
      });
    };

    const href = typeof settings?.favicon === "string" ? settings.favicon.trim() : "";
    if (!href) {
      clearManagedIcons();
      return;
    }

    const ensureLink = (rel) => {
      const existing = document.querySelector(`link[rel="${rel}"][data-managed="ls-favicon"]`);
      if (existing) return existing;
      const el = document.createElement("link");
      el.setAttribute("rel", rel);
      el.setAttribute("data-managed", "ls-favicon");
      document.head.appendChild(el);
      return el;
    };

    try {
      rels.forEach((rel) => {
        const link = ensureLink(rel);
        if (link.getAttribute("href") !== href) {
          link.setAttribute("href", href);
        }
      });
    } catch {
      // ignore favicon update errors
    }
  }, [settings?.favicon]);

  const value = useMemo(
    () => ({
      settings,
      loading,
      error,
      refresh: load
    }),
    [settings, loading, error, load]
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
