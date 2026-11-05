// server/satsrouting.js
// SatsRouting Submarine Swap adapter: customer BTC on-chain -> merchant Lightning.
import fetch from "node-fetch";
import WebSocket from "ws";
import dns from "dns";
import http from "http";
import https from "https";
import { deriveRefundKey } from "./boltz.js";

export { deriveRefundKey };

export const SATSROUTING_REST_URL = (
  process.env.SATSROUTING_REST_URL || "https://api.satsrouting.exchange"
).replace(/\/+$/, "");
export const SATSROUTING_WS_URL =
  process.env.SATSROUTING_WS_URL || "wss://api.satsrouting.exchange/v2/ws";
const SATSROUTING_FORCE_IPV4 = String(process.env.SATSROUTING_FORCE_IPV4 || "0") === "1";

const ipv4Lookup = SATSROUTING_FORCE_IPV4
  ? (hostname, opts, cb) => dns.lookup(hostname, { ...opts, family: 4, all: false }, cb)
  : undefined;
const ipv4Agent = SATSROUTING_FORCE_IPV4
  ? (url) => url.startsWith("https:")
    ? new https.Agent({ family: 4, lookup: ipv4Lookup })
    : new http.Agent({ family: 4, lookup: ipv4Lookup })
  : undefined;

function describeError(error) {
  if (!error) return "unknown error";
  return [
    error.message || "",
    error.type ? "type=" + error.type : "",
    error.code ? "code=" + error.code : "",
    error.errno ? "errno=" + error.errno : "",
    error.cause?.message ? "cause=" + error.cause.message : "",
    error.cause?.code ? "causeCode=" + error.cause.code : ""
  ].filter(Boolean).join(" ").trim() || "unknown error";
}

function sanitize(message) {
  return String(message || "").replace(/\b[0-9a-fA-F]{20,}\b/g, "[redacted]");
}

function shouldRetryIpv4(error) {
  const code = String(error?.code || error?.errno || "").toUpperCase();
  return ["ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET"].includes(code);
}

async function fetchWithFallback(url, init = {}) {
  // Mirror the former Boltz adapter when IPv4 is explicitly forced.
  if (ipv4Lookup) {
    init = { ...init, lookup: ipv4Lookup, agent: init.agent || ipv4Agent?.(url) };
  }
  const attempt = async (useIpv4) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), 10000);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
        agent: useIpv4 ? (init.agent || ipv4Agent?.(url)) : init.agent,
        lookup: useIpv4 ? ipv4Lookup : init.lookup
      });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    return await attempt(false);
  } catch (error) {
    // Match the previous Boltz adapter: retry network errors over IPv4 unless
    // IPv4 was explicitly forced for the first attempt already.
    const alreadyForced = !!ipv4Lookup;
    if (!alreadyForced && shouldRetryIpv4(error)) return await attempt(true);
    throw error;
  }
}

function requireRestUrl() {
  if (!SATSROUTING_REST_URL) throw new Error("SATSROUTING_REST_URL is not configured");
}

async function requestJson(url, init, context) {
  let response;
  try {
    response = await fetchWithFallback(url, init);
  } catch (error) {
    throw new Error("SatsRouting request failed: " + sanitize(describeError(error)));
  }
  if (!response?.ok) {
    const body = await response.text().catch(() => "");
    throw new Error("SatsRouting HTTP " + response.status + " " + sanitize(body));
  }
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== "object") throw new Error("Invalid SatsRouting " + context + " payload");
  return data;
}

/**
 * Resolve the live BTC -> BTC submarine pair.
 * Pair limits and fee hashes are dynamic and must never be hard-coded.
 */
export function resolveBtcSubmarinePair(payload) {
  const pair = payload?.BTC?.BTC || payload?.pairs?.BTC?.BTC || payload?.submarine?.BTC?.BTC;
  const hash = String(pair?.hash || "").trim();
  const minimal = Number(pair?.limits?.minimal);
  const minimalBatched = Number(pair?.limits?.minimalBatched);
  const maximal = Number(pair?.limits?.maximal);
  if (!hash || !Number.isFinite(minimal) || !Number.isFinite(maximal) || minimal <= 0 || maximal < minimal) {
    throw new Error("SatsRouting does not currently publish a valid BTC-to-BTC submarine pair");
  }
  return { ...pair, hash, limits: { ...pair.limits, minimal, minimalBatched, maximal } };
}

export async function getBtcSubmarinePair() {
  requireRestUrl();
  const payload = await requestJson(
    SATSROUTING_REST_URL + "/v2/swap/submarine",
    { method: "GET" },
    "submarine pairs"
  );
  return resolveBtcSubmarinePair(payload);
}

export function assertSubmarineAmount(amountSats, pair) {
  const amount = Number(amountSats);
  const minimal = Number(pair?.limits?.minimal);
  const minimalBatched = Number(pair?.limits?.minimalBatched);
  const maximal = Number(pair?.limits?.maximal);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Invalid submarine swap amount");
  if (!Number.isFinite(minimal) || !Number.isFinite(maximal) || minimal <= 0 || maximal < minimal) {
    throw new Error("SatsRouting BTC-to-BTC swap limits are unavailable");
  }
  // SatsRouting may accept a lower minimum when the swap is processed in a batch.
  const effectiveMinimum = Number.isFinite(minimalBatched) && minimalBatched > 0
    ? Math.min(minimal, minimalBatched)
    : minimal;
  if (amount < effectiveMinimum) {
    throw new Error("SatsRouting minimum on-chain swap invoice amount is " + effectiveMinimum + " sats");
  }
  if (amount > maximal) throw new Error("SatsRouting maximum on-chain swap invoice amount is " + maximal + " sats");
  return amount;
}

function withWebhookToken(webhookUrl) {
  const secret = String(process.env.SATSROUTING_WEBHOOK_SECRET || "").trim();
  if (!webhookUrl || !secret) return undefined;
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new Error("SATSROUTING_WEBHOOK_URL must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") throw new Error("SatsRouting webhooks require HTTPS");
  parsed.searchParams.set("token", secret);
  return {
    url: parsed.toString(),
    hashSwapId: false,
    status: [
      "invoice.pending",
      "invoice.paid",
      "swap.expired",
      "transaction.mempool",
      "transaction.confirmed",
      "invoice.failedToPay"
    ]
  };
}

export async function createSubmarineSwap({ invoice, webhookUrl, refundKey, pairHash } = {}) {
  requireRestUrl();
  if (!invoice) throw new Error("invoice is required for SatsRouting swap");
  if (!pairHash) throw new Error("SatsRouting pair hash is required; refresh the live pair limits");

  const keys = refundKey || deriveRefundKey(0, { mnemonic: "" });
  const body = {
    invoice,
    from: "BTC",
    to: "BTC",
    refundPublicKey: keys.refundPublicKey,
    pairHash
  };
  const webhook = withWebhookToken(webhookUrl);
  if (webhook) body.webhook = webhook;

  const swap = await requestJson(
    SATSROUTING_REST_URL + "/v2/swap/submarine",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    "swap"
  );
  if (!swap?.id) throw new Error("SatsRouting response is missing the swap id");
  return {
    swap,
    refundPrivateKey: keys.refundPrivateKey,
    refundPublicKey: keys.refundPublicKey,
    rescueIndex: keys.rescueIndex ?? null
  };
}

export async function getSwapStatus({ swapId } = {}) {
  requireRestUrl();
  if (!swapId) throw new Error("swapId is required");
  return await requestJson(
    SATSROUTING_REST_URL + "/v2/swap/" + encodeURIComponent(swapId),
    { method: "GET" },
    "swap status"
  );
}

export function mapSatsRoutingStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value === "invoice.paid") return "PAID";
  if (value === "invoice.pending" || value === "transaction.confirmed") return "CONFIRMED";
  if (value === "transaction.mempool" || value === "transaction.direct") return "MEMPOOL";
  if (value === "swap.expired") return "EXPIRED";
  if (
    value === "invoice.failedtopay" ||
    value === "transaction.failed" ||
    value === "transaction.lockupfailed"
  ) return "FAILED";
  return "PENDING";
}

export function buildBip21({ address, amountSats, label } = {}) {
  const addr = String(address || "").trim();
  if (!addr) return "";
  const sats = Math.max(0, Math.floor(Number(amountSats || 0)));
  const params = [];
  if (sats > 0) params.push("amount=" + (sats / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, ""));
  if (label) params.push("label=" + encodeURIComponent(label));
  return "bitcoin:" + addr + (params.length ? "?" + params.join("&") : "");
}

/** WebSocket updates with a six-second REST polling fallback. */
export function subscribeSwapStatus({ swapId, onUpdate } = {}) {
  if (!swapId) throw new Error("swapId is required for SatsRouting subscription");
  let closed = false;
  let ws;
  let pollTimer;
  let heartbeat;

  const stopPolling = () => { try { clearInterval(pollTimer); } catch {} };
  const stopHeartbeat = () => { try { clearInterval(heartbeat); } catch {} };
  const unsubscribe = () => {
    if (closed) return;
    closed = true;
    stopPolling();
    stopHeartbeat();
    try { ws?.close(); } catch {}
  };
  const emit = (swap) => {
    if (!swap) return;
    const rawStatus = swap.status || "";
    const mappedStatus = mapSatsRoutingStatus(rawStatus);
    try { onUpdate?.({ swap, rawStatus, mappedStatus }); } catch {}
    if (["PAID", "EXPIRED", "FAILED"].includes(mappedStatus)) unsubscribe();
  };

  pollTimer = setInterval(async () => {
    try { emit(await getSwapStatus({ swapId })); } catch {}
  }, 6000);

  try {
    ws = new WebSocket(SATSROUTING_WS_URL);
    ws.on("open", () => {
      ws.send(JSON.stringify({ op: "subscribe", channel: "swap.update", args: [swapId] }));
      stopHeartbeat();
      heartbeat = setInterval(() => {
        try { ws.send(JSON.stringify({ op: "ping" })); } catch {}
      }, 15000);
    });
    ws.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.event !== "update" || !Array.isArray(message.args)) return;
      for (const entry of message.args) {
        if (entry?.id === swapId) emit(entry);
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => stopHeartbeat());
  } catch {
    // REST polling remains active when WebSocket is unavailable.
  }
  return unsubscribe;
}
