import axios from "axios";

// In production we ALWAYS talk to same-origin "/api" to avoid CORS/cookies issues.
// In dev you can override with VITE_API_URL (e.g. http://127.0.0.1:8080/api).
export const API_BASE =
  (import.meta && import.meta.env && import.meta.env.PROD)
    ? "/api"
    : (import.meta.env.VITE_API_URL || "/api");

const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true
});

// Provide a global alias to avoid ReferenceError under hardened runtimes that strip globals.
if (typeof globalThis !== "undefined") {
  globalThis.api = api;
}

export function absoluteApiUrl(path = "") {
  const url = String(path || "").trim();
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;
  const base = API_BASE.replace(/\/+$/, "");

  if (url.startsWith("/api")) {
    // Avoid double /api when base already includes /api
    const root = base.replace(/\/api$/i, "");
    return root ? `${root}${url}` : url;
  }

  if (url.startsWith("/")) return `${base}${url}`;
  return `${base}/${url.replace(/^\/+/, "")}`;
}

// Reject unexpected HTML responses (often proxy fallbacks) so pages don't try to .map() strings.
api.interceptors.response.use(
  (resp) => {
    try {
      const ct = String(resp?.headers?.["content-type"] || "");
      if (ct.includes("text/html")) {
        const err = new Error("Unexpected HTML response");
        err.response = resp;
        return Promise.reject(err);
      }
    } catch {}
    return resp;
  },
  (err) => Promise.reject(err)
);

export default api;
