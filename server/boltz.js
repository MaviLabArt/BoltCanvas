// server/boltz.js
import fetch from "node-fetch";
import WebSocket from "ws";
import crypto from "crypto";
import * as bip39 from "bip39";
import BIP32Factory from "bip32";
import * as ecc from "tiny-secp256k1";
const bip32 = BIP32Factory(ecc);
import dns from "dns";
import http from "http";
import https from "https";

// Defaults are mainnet. Overridable via env for regtest/local.
export const BOLTZ_REST_URL = (process.env.BOLTZ_REST_URL || "https://api.boltz.exchange").replace(/\/+$/, "");
export const BOLTZ_WS_URL = process.env.BOLTZ_WS_URL || "wss://api.boltz.exchange/v2/ws";
const BOLTZ_FORCE_IPV4 = String(process.env.BOLTZ_FORCE_IPV4 || "0") === "1";

// Optional IPv4-only lookup to avoid IPv6 routing issues on some hosts.
const ipv4Lookup = BOLTZ_FORCE_IPV4
  ? (hostname, opts, cb) => dns.lookup(hostname, { ...opts, family: 4, all: false }, cb)
  : undefined;

const ipv4Agent = BOLTZ_FORCE_IPV4
  ? (url) => url.startsWith("https:")
    ? new https.Agent({ family: 4, lookup: ipv4Lookup })
    : new http.Agent({ family: 4, lookup: ipv4Lookup })
  : undefined;

function describeError(e) {
  if (!e) return "unknown error";
  const parts = [
    e.message || "",
    e.type ? `type=${e.type}` : "",
    e.code ? `code=${e.code}` : "",
    e.errno ? `errno=${e.errno}` : "",
    e.cause?.message ? `cause=${e.cause.message}` : "",
    e.cause?.code ? `causeCode=${e.cause.code}` : ""
  ].filter(Boolean);
  const joined = parts.join(" ").trim();
  return joined || "unknown error";
}

function shouldRetryIpv4(e) {
  const code = String(e?.code || e?.errno || "").toUpperCase();
  return ["ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET"].includes(code);
}

async function fetchWithFallback(url, init = {}) {
  // Apply IPv4 if forced
  if (ipv4Lookup) {
    init = { ...init, lookup: ipv4Lookup, agent: init.agent || ipv4Agent?.(url) };
  }

  const attempt = async (useIpv4) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), 10000);
    try {
      const opts = {
        ...init,
        signal: controller.signal,
        lookup: useIpv4 ? ipv4Lookup : init.lookup,
        agent: useIpv4 ? (init.agent || ipv4Agent?.(url)) : init.agent
      };
      return await fetch(url, opts);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await attempt(false);
  } catch (e) {
    // If not already forcing IPv4 and we hit a network error, retry with IPv4-only lookup.
    const alreadyForced = !!ipv4Lookup;
    if (!alreadyForced && shouldRetryIpv4(e)) {
      try {
        return await attempt(true);
      } catch (e2) {
        throw e2;
      }
    }
    throw e;
  }
}

function sanitize(msg) {
  const s = String(msg || "");
  return s.replace(/\b[0-9a-fA-F]{20,}\b/g, "[redacted]");
}

function requireRestUrl() {
  if (!BOLTZ_REST_URL) throw new Error("BOLTZ_REST_URL is not configured");
}

function generateRefundKeys() {
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.generateKeys();
  return {
    refundPrivateKey: ecdh.getPrivateKey("hex"),
    refundPublicKey: ecdh.getPublicKey("hex", "compressed")
  };
}

export function deriveRefundKey(index, {
  mnemonic = process.env.BOLTZ_RESCUE_MNEMONIC || "",
  pathBase = process.env.BOLTZ_RESCUE_PATH || "m/44/0/0/0"
} = {}) {
  if (!mnemonic) return { ...generateRefundKeys(), rescueIndex: null };
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = bip32.fromSeed(seed);
  const node = root.derivePath(`${pathBase}/${index}`);
  if (!node.privateKey) return { ...generateRefundKeys(), rescueIndex: null };
  const priv = node.privateKey;
  const pub = ecc.pointFromScalar(priv, true);
  return {
    rescueIndex: index,
    refundPrivateKey: priv.toString("hex"),
    refundPublicKey: Buffer.from(pub || []).toString("hex")
  };
}

export async function createSubmarineSwap({ invoice, webhookUrl, refundKey }) {
  requireRestUrl();
  if (!invoice) throw new Error("invoice is required for Boltz swap");

  const keys = refundKey || generateRefundKeys();
  const body = {
    invoice,
    from: "BTC",
    to: "BTC",
    refundPublicKey: keys.refundPublicKey
  };

  if (webhookUrl) {
    body.webhook = {
      url: webhookUrl,
      hashSwapId: false,
      status: ["invoice.pending", "invoice.paid", "swap.expired", "transaction.mempool", "transaction.confirmed", "invoice.failedToPay"]
    };
  }

  let res;
  try {
    res = await fetchWithFallback(`${BOLTZ_REST_URL}/v2/swap/submarine`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error(`Boltz request failed: ${sanitize(describeError(e))}`);
  }

  if (!res?.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Boltz HTTP ${res.status} ${sanitize(text)}`);
  }

  const swap = await res.json().catch(() => null);
  if (!swap?.id) {
    throw new Error("Boltz response missing swap id");
  }

  return {
    swap,
    refundPrivateKey: keys.refundPrivateKey,
    refundPublicKey: keys.refundPublicKey,
    rescueIndex: keys.rescueIndex ?? null
  };
}

export async function getSwapStatus({ swapId }) {
  requireRestUrl();
  if (!swapId) throw new Error("swapId is required");
  let res;
  try {
    res = await fetchWithFallback(`${BOLTZ_REST_URL}/v2/swap/${encodeURIComponent(swapId)}`);
  } catch (e) {
    throw new Error(`Boltz request failed: ${sanitize(describeError(e))}`);
  }
  if (!res?.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Boltz HTTP ${res.status} ${sanitize(text)}`);
  }
  const data = await res.json().catch(() => null);
  if (!data) throw new Error("Invalid Boltz swap payload");
  return data;
}

// Map Boltz' detailed statuses to a simpler progression for the UI.
export function mapBoltzStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "invoice.paid") return "PAID";
  if (s === "invoice.pending" || s === "transaction.confirmed") return "CONFIRMED";
  if (s === "transaction.mempool" || s === "transaction.direct") return "MEMPOOL";
  if (s === "swap.expired") return "EXPIRED";
  if (s === "invoice.failedtopay" || s === "transaction.failed" || s === "transaction.lockupfailed") return "FAILED";
  return "PENDING";
}

export function buildBip21({ address, amountSats, label }) {
  const addr = String(address || "").trim();
  if (!addr) return "";
  const sats = Math.max(0, Math.floor(Number(amountSats || 0)));
  const params = [];
  if (sats > 0) params.push(`amount=${(sats / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`);
  if (label) params.push(`label=${encodeURIComponent(label)}`);
  const qs = params.length ? `?${params.join("&")}` : "";
  return `bitcoin:${addr}${qs}`;
}

/**
 * Subscribe to swap updates via Boltz WS + polling fallback.
 * Returns an unsubscribe function.
 */
export function subscribeSwapStatus({ swapId, onUpdate }) {
  if (!swapId) throw new Error("swapId is required for subscribeSwapStatus");

  let closed = false;
  let ws;
  let pollTimer;
  let hb;

  const emit = (swap) => {
    if (!swap) return;
    const rawStatus = swap.status || "";
    const mappedStatus = mapBoltzStatus(rawStatus);
    try { onUpdate?.({ swap, rawStatus, mappedStatus }); } catch {}
    if (mappedStatus === "PAID" || mappedStatus === "EXPIRED" || mappedStatus === "FAILED") {
      unsub();
    }
  };

  const stopPolling = () => { try { clearInterval(pollTimer); } catch {} };
  const stopHb = () => { try { clearInterval(hb); } catch {} };

  const unsub = () => {
    if (closed) return;
    closed = true;
    stopPolling();
    stopHb();
    try { ws?.close(); } catch {}
  };

  // Poll every 6s as a fallback.
  const startPolling = () => {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const swap = await getSwapStatus({ swapId });
        emit(swap);
      } catch {
        // swallow; SSE route logs if needed
      }
    }, 6000);
  };
  startPolling();

  // Best-effort WS stream
  try {
    if (BOLTZ_WS_URL) {
      ws = new WebSocket(BOLTZ_WS_URL);
      ws.on("open", () => {
        const msg = { op: "subscribe", channel: "swap.update", args: [swapId] };
        ws.send(JSON.stringify(msg));
        stopHb();
        hb = setInterval(() => {
          try { ws.send(JSON.stringify({ op: "ping" })); } catch {}
        }, 15000);
      });
      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg?.event !== "update" || !Array.isArray(msg.args)) return;
        for (const entry of msg.args) {
          if (entry?.id === swapId) {
            emit(entry);
          }
        }
      });
      ws.on("close", () => {});
      ws.on("error", () => {});
    }
  } catch {
    // ignore; polling is active
  }

  return unsub;
}
