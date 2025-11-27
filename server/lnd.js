// server/lnd.js
import fetch from "node-fetch";
import WebSocket from "ws";
import https from "https";
import fs from "fs";

// ─────────────────────────────────────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────────────────────────────────────
const LND_REST_URL = (process.env.LND_REST_URL || "").replace(/\/+$/, ""); // e.g. https://lnd.domain.com:8080
const LND_MACAROON_HEX = process.env.LND_MACAROON_HEX || "";               // admin/read-only macaroon in HEX
const LND_INVOICE_EXPIRES_IN = Number(process.env.LND_INVOICE_EXPIRES_IN || 900); // seconds
const LND_TLS_INSECURE = String(process.env.LND_TLS_INSECURE || "0") === "1";     // allow self-signed (dev)
const LND_TLS_CERT_PATH = process.env.LND_TLS_CERT_PATH || "";                    // optional CA cert (tls.cert)
const LND_PRIVATE_INVOICES = String(process.env.LND_PRIVATE_INVOICES || "true") === "true";
// Optional static route_hints JSON (advanced/rare). Must match LND's RouteHint shape.
const LND_ROUTE_HINTS_JSON = process.env.LND_ROUTE_HINTS_JSON || "";

// WebSocket endpoint (REST → WS)
const LND_WS_URL =
  process.env.LND_WS_URL ||
  (toWsUrl(LND_REST_URL) ? `${toWsUrl(LND_REST_URL)}/v1/invoices/subscribe?method=GET` : "");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: WS URL, HTTPS agent, sanitizers, safe fetch
// ─────────────────────────────────────────────────────────────────────────────
function toWsUrl(httpUrl) {
  if (!httpUrl) return "";
  return httpUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

// HTTPS/TLS agent for fetch & ws
let httpsAgent = undefined;
try {
  if (LND_REST_URL.startsWith("https:")) {
    if (LND_TLS_CERT_PATH && fs.existsSync(LND_TLS_CERT_PATH)) {
      httpsAgent = new https.Agent({ ca: fs.readFileSync(LND_TLS_CERT_PATH) });
    } else if (LND_TLS_INSECURE) {
      httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }
  }
} catch {}

function sanitize(msg) {
  const s = String(msg || "");
  return s
    .replace(/https?:\/\/[^\s'")]+/gi, "[redacted-url]")   // redact URLs
    .replace(/\b[0-9a-fA-F]{20,}\b/g, "[redacted]");       // redact long hex blobs
}

// Ensure we never leak the LND endpoint to callers
async function safeFetch(url, init) {
  try {
    const res = await fetch(url, { ...(init || {}), agent: httpsAgent });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LND HTTP ${res.status} ${sanitize(text)}`);
    }
    return res;
  } catch (e) {
    throw new Error(`LND request failed: ${sanitize(e?.message || e)}`);
  }
}

function baseHeaders() {
  if (!LND_MACAROON_HEX) {
    throw new Error("LND_MACAROON_HEX is required for LND REST calls.");
  }
  return {
    "content-type": "application/json",
    "Grpc-Metadata-macaroon": LND_MACAROON_HEX
  };
}

// utils
function b64ToHex(b64) {
  const buf = Buffer.from(b64, "base64");
  return buf.toString("hex");
}

function mapLndStateToGeneric(inv) {
  const st = String(inv?.state || "").toUpperCase();
  if (st === "SETTLED" || inv?.settled === true) return "PAID";
  if (st === "CANCELED") return "EXPIRED";
  return "PENDING"; // OPEN / ACCEPTED
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API (mirrors blink.js surface where relevant)
// ─────────────────────────────────────────────────────────────────────────────

export async function createInvoiceSats({ amount, memo, expiresIn }) {
  if (!LND_REST_URL) throw new Error("LND is not configured.");
  const expiry = Number.isFinite(Number(expiresIn)) && Number(expiresIn) > 0
    ? Number(expiresIn)
    : LND_INVOICE_EXPIRES_IN;

  // Include routing hints for private channels
  const body = {
    value: Math.floor(amount || 0), // sats
    memo: memo || "",
    expiry,
    private: !!LND_PRIVATE_INVOICES
  };

  // Optional: force specific route_hints via env JSON (advanced/optional)
  if (LND_ROUTE_HINTS_JSON) {
    try {
      const parsed = JSON.parse(LND_ROUTE_HINTS_JSON);
      if (Array.isArray(parsed)) body.route_hints = parsed;
    } catch {
      // ignore bad JSON; don't break invoice creation
    }
  }

  const res = await safeFetch(`${LND_REST_URL}/v1/invoices`, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  const pr = data?.payment_request || "";
  const rHashB64 = data?.r_hash || "";
  if (!pr || !rHashB64) throw new Error("LND response missing payment_request or r_hash.");
  const paymentHash = b64ToHex(rHashB64);
  return { paymentRequest: pr, paymentHash, satoshis: Math.floor(amount || 0) };
}

export async function invoiceStatus({ paymentHash }) {
  if (!LND_REST_URL) throw new Error("LND is not configured.");
  if (!paymentHash) throw new Error("paymentHash is required.");
  const res = await safeFetch(`${LND_REST_URL}/v1/invoice/${paymentHash}`, {
    method: "GET",
    headers: baseHeaders()
  });
  const inv = await res.json().catch(() => ({}));
  return mapLndStateToGeneric(inv);
}

/**
 * Subscribe to updates for a single invoice.
 * - Tries WebSocket stream first.
 * - Also starts a POLLING fallback (every 2s) so we never miss "PAID"/"EXPIRED".
 * Returns an unsubscribe function.
 */
export function subscribeInvoiceStatus({ paymentHash, onStatus }) {
  if (!paymentHash) throw new Error("paymentHash is required for subscribeInvoiceStatus");

  let closed = false;
  let ws;
  let pollTimer;

  const stopPolling = () => { try { clearInterval(pollTimer); } catch {} };
  const stopWs = () => { try { ws?.close(); } catch {} };

  const unsub = () => {
    if (closed) return;
    closed = true;
    stopPolling();
    stopWs();
  };

  // —— Polling fallback (always on) ——————————————————————
  // If WS never fires (TLS/infra constraints), this still flips the UI.
  const startPolling = () => {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const st = await invoiceStatus({ paymentHash });
        if (typeof onStatus === "function") onStatus(st);
        if (st === "PAID" || st === "EXPIRED") unsub();
      } catch {
        // swallow to keep polling; errors are logged by the REST route if needed
      }
    }, 2000);
  };
  startPolling();

  // —— WebSocket (best-effort) ————————————————————————————
  try {
    if (LND_WS_URL) {
      ws = new WebSocket(LND_WS_URL, {
        headers: { "Grpc-Metadata-macaroon": LND_MACAROON_HEX },
        rejectUnauthorized: !(LND_TLS_INSECURE === true),
        ca: (LND_TLS_CERT_PATH && fs.existsSync(LND_TLS_CERT_PATH))
          ? fs.readFileSync(LND_TLS_CERT_PATH)
          : undefined
      });

      ws.on("message", (raw) => {
        let inv;
        try { inv = JSON.parse(raw.toString()); } catch { return; }
        const b64 = inv?.r_hash || "";
        if (!b64) return;
        const hex = b64ToHex(b64);
        if (hex !== paymentHash) return;

        const mapped = mapLndStateToGeneric(inv);
        if (typeof onStatus === "function") onStatus(mapped);
        if (mapped === "PAID" || mapped === "EXPIRED") unsub();
      });

      ws.on("error", () => { /* ignore; polling keeps us alive */ });
      ws.on("close", () => { /* ignore; polling keeps us alive */ });
    }
  } catch {
    // ignore; polling keeps us alive
  }

  return unsub;
}

/**
 * Long-lived watcher: calls onPaid(paymentHashHex) for every settled invoice.
 * WebSocket best-effort; sweeping in index.js already handles periodic checks.
 */
export function startPaymentWatcher({ onPaid }) {
  if (!LND_REST_URL) {
    console.warn("[LND Watcher] Skipped: LND_REST_URL not set.");
    return;
  }
  if (!LND_MACAROON_HEX) {
    console.warn("[LND Watcher] Skipped: LND_MACAROON_HEX not set.");
    return;
  }

  let ws;
  let reconnectTimer;
  let backoffMs = 1000;

  const connect = () => {
    clearTimeout(reconnectTimer);
    try {
      ws = new WebSocket(LND_WS_URL, {
        headers: { "Grpc-Metadata-macaroon": LND_MACAROON_HEX },
        rejectUnauthorized: !(LND_TLS_INSECURE === true),
        ca: (LND_TLS_CERT_PATH && fs.existsSync(LND_TLS_CERT_PATH))
          ? fs.readFileSync(LND_TLS_CERT_PATH)
          : undefined
      });

      ws.on("message", (raw) => {
        let inv;
        try { inv = JSON.parse(raw.toString()); } catch { return; }
        if (inv?.settled === true || String(inv?.state || "").toUpperCase() === "SETTLED") {
          const b64 = inv?.r_hash || "";
          if (!b64) return;
          const hex = b64ToHex(b64);
          try { onPaid?.(hex); } catch {}
        }
      });

      const scheduleReconnect = () => {
        try { ws.close(); } catch {}
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, Math.min(backoffMs, 15000));
        backoffMs = Math.min(backoffMs * 2, 15000);
      };

      ws.on("error", scheduleReconnect);
      ws.on("close", scheduleReconnect);
    } catch {
      // If WS altogether is unavailable, the background sweeper in index.js
      // (already in your app) still marks orders as PAID via polling.
    }
  };

  connect();
}
