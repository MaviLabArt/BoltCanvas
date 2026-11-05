// server/satsrouting.js
// SatsRouting Submarine Swap adapter: customer BTC on-chain -> merchant Lightning.
import fetch from "node-fetch";
import * as bip39 from "bip39";
import WebSocket from "ws";
import dns from "dns";
import http from "http";
import https from "https";
import { deriveRefundKey } from "./boltz.js";

export { deriveRefundKey };

/**
 * Submarine swaps need a recoverable refund key. Never create a random key
 * that cannot be reconstructed after the server loses process memory.
 * Keep the old Boltz variable as a migration fallback for existing stores.
 */
export function resolveSatsRoutingRescueMnemonic({
  satsroutingMnemonic = process.env.SATSROUTING_RESCUE_MNEMONIC,
  legacyBoltzMnemonic = process.env.BOLTZ_RESCUE_MNEMONIC
} = {}) {
  const mnemonic = String(satsroutingMnemonic || legacyBoltzMnemonic || "").trim();
  if (!mnemonic) {
    throw new Error(
      "Set SATSROUTING_RESCUE_MNEMONIC (or the existing BOLTZ_RESCUE_MNEMONIC) to a valid BIP39 recovery phrase before accepting on-chain Submarine swaps"
    );
  }
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error("SatsRouting rescue phrase is not a valid BIP39 mnemonic");
  }
  return mnemonic;
}

/** A Submarine lockup that reached chain needs an active user refund on expiry. */
export function hasSubmarineLockupTransaction(swap) {
  return Boolean(
    String(swap?.transaction?.id || "").trim() ||
    String(swap?.transaction?.hex || "").trim()
  );
}

export const SATSROUTING_REST_URL = (
  process.env.SATSROUTING_REST_URL || "https://api.satsrouting.exchange"
).replace(/\/+$/, "");
/**
 * Identify persisted orders that belong to SatsRouting, not a legacy swap
 * provider whose identifiers may share the generic on-chain lookup columns.
 */
export function isSatsRoutingOrder(order) {
  return String(order?.onchainProvider || "").trim().toLowerCase() === "satsrouting";
}

export const SATSROUTING_WS_URL =
  process.env.SATSROUTING_WS_URL || "wss://api.satsrouting.exchange/v2/ws";

/** Return only a generated webhook secret; empty or example values keep callbacks disabled. */
export function resolveSatsRoutingWebhookSecret(secret = process.env.SATSROUTING_WEBHOOK_SECRET) {
  const value = String(secret || "").trim();
  if (value.length < 32 || value.toLowerCase() === "replace-with-long-random-string") return "";
  return value;
}

const SATSROUTING_FORCE_IPV4 = String(process.env.SATSROUTING_FORCE_IPV4 || "0") === "1";

// Keep an IPv4-only resolver available for both explicit IPv4 mode and
// automatic retry after a transient IPv6/network routing failure.
const ipv4Lookup = (hostname, opts, cb) =>
  dns.lookup(hostname, { ...opts, family: 4, all: false }, cb);
const ipv4Agent = (url) => url.startsWith("https:")
  ? new https.Agent({ family: 4, lookup: ipv4Lookup })
  : new http.Agent({ family: 4, lookup: ipv4Lookup });

/** Format provider/network failures into a compact diagnostic string without exposing request secrets. */
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

/** Redact long hexadecimal identifiers before including remote error text in logs. */
function sanitize(message) {
  return String(message || "").replace(/\b[0-9a-fA-F]{20,}\b/g, "[redacted]");
}

/** Identify network errors for which a second address-family attempt may help. */
function shouldRetryIpv4(error) {
  const code = String(error?.code || error?.errno || "").toUpperCase();
  return ["ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET"].includes(code);
}

/**
 * Decide whether an IPv4 retry is safe for this request.
 * GET requests are repeatable; other methods retry only when connection
 * errors establish that the request could not have reached the server.
 */
export function canRetryWithIpv4(init = {}, error) {
  if (!shouldRetryIpv4(error)) return false;
  const method = String(init.method || "GET").toUpperCase();
  if (method === "GET") return true;
  const code = String(error?.code || error?.errno || "").toUpperCase();
  return ["ENETUNREACH", "EAI_AGAIN", "ECONNREFUSED"].includes(code);
}

/** Perform a SatsRouting request, using IPv4 only for safe network retries. */
async function fetchWithFallback(url, init = {}) {
  const attempt = async (useIpv4) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), 10000);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
        agent: useIpv4 ? ipv4Agent(url) : init.agent
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await attempt(SATSROUTING_FORCE_IPV4);
  } catch (error) {
    if (!SATSROUTING_FORCE_IPV4 && canRetryWithIpv4(init, error)) {
      return await attempt(true);
    }
    throw error;
  }
}

/** Fail early when the SatsRouting API base URL is unavailable. */
function requireRestUrl() {
  if (!SATSROUTING_REST_URL) throw new Error("SATSROUTING_REST_URL is not configured");
}

/** Fetch and validate one JSON response from the SatsRouting API. */
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
/** Parse the provider's live BTC-to-BTC pair and its dynamic limits. */
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

/** Retrieve the current BTC-to-BTC Submarine pair from SatsRouting. */
export async function getBtcSubmarinePair() {
  requireRestUrl();
  const payload = await requestJson(
    SATSROUTING_REST_URL + "/v2/swap/submarine",
    { method: "GET" },
    "submarine pairs"
  );
  return resolveBtcSubmarinePair(payload);
}

/** Reject swap amounts outside the limits currently advertised by the provider. */
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

/** Add the configured high-entropy callback token to a valid HTTPS webhook URL. */
function withWebhookToken(webhookUrl) {
  const secret = resolveSatsRoutingWebhookSecret();
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

/** Create one BTC-on-chain to Lightning Submarine swap using the live pair hash. */
export async function createSubmarineSwap({ invoice, webhookUrl, refundKey, pairHash } = {}) {
  requireRestUrl();
  if (!invoice) throw new Error("invoice is required for SatsRouting swap");
  if (!pairHash) throw new Error("SatsRouting pair hash is required; refresh the live pair limits");

  const keys = assertRecoverableRefundKey(refundKey);
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

/** Read the authoritative provider state for a known SatsRouting swap ID. */
export async function getSwapStatus({ swapId } = {}) {
  requireRestUrl();
  if (!swapId) throw new Error("swapId is required");
  return await requestJson(
    SATSROUTING_REST_URL + "/v2/swap/" + encodeURIComponent(swapId),
    { method: "GET" },
    "swap status"
  );
}

/** Normalize a SatsRouting lifecycle status to BoltCanvas's internal status vocabulary. */
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

/** Build the Bitcoin payment URI shown to the customer at checkout. */
export function buildBip21({ address, amountSats, label } = {}) {
  const addr = String(address || "").trim();
  if (!addr) return "";
  const sats = Math.max(0, Math.floor(Number(amountSats || 0)));
  const params = [];
  if (sats > 0) params.push("amount=" + (sats / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, ""));
  if (label) params.push("label=" + encodeURIComponent(label));
  return "bitcoin:" + addr + (params.length ? "?" + params.join("&") : "");
}

/** Require a deterministic refund key that can be restored from the rescue mnemonic and index. */
export function assertRecoverableRefundKey(refundKey) {
  const publicKey = String(refundKey?.refundPublicKey || "").trim();
  const rescueIndex = refundKey?.rescueIndex;
  if (!publicKey || !Number.isSafeInteger(rescueIndex) || rescueIndex < 0) {
    throw new Error(
      "A recoverable SatsRouting refundKey with refundPublicKey and a non-negative rescueIndex is required"
    );
  }
  return refundKey;
}

/** Dispatch one swap update without allowing callback failures to become unhandled rejections. */
export function dispatchSwapStatusUpdate(onUpdate, update) {
  let result;
  try {
    result = onUpdate?.(update);
  } catch {
    return Promise.resolve();
  }
  return Promise.resolve(result).catch((error) => {
    console.warn("[satsrouting] status update failed:", error?.message || error);
  });
}

/** Subscribe to WebSocket updates and retain REST polling as a fallback. */
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
    void dispatchSwapStatusUpdate(onUpdate, { swap, rawStatus, mappedStatus });
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
