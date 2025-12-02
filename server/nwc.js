// server/nwc.js
// Nostr Wallet Connect (NIP-47) provider via @getalby/sdk.
import { NWCClient } from "@getalby/sdk";
import WebSocket from "ws";

// Ensure WebSocket is available for the SDK in Node environments
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = WebSocket;
}

const NWC_DEBUG = String(process.env.NWC_DEBUG || "false").toLowerCase() === "true";
const log = (...args) => {
  if (NWC_DEBUG) console.info("[NWC]", ...args);
};

const DEFAULT_NWC_URL = process.env.NWC_URL || process.env.NWC_WALLET_CONNECT_URL || "";
const DEFAULT_RELAYS = parseCsv(process.env.NWC_RELAYS_CSV || process.env.NWC_RELAYS || "");
const DEFAULT_EXPIRES_IN_SECONDS = Number(process.env.NWC_INVOICE_EXPIRES_IN || process.env.BLINK_INVOICE_EXPIRES_IN || 900);

function parseCsv(raw = "") {
  return String(raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function msatsToSats(msats) {
  const n = Number(msats || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n / 1000);
}

function mapInvoiceState(payload = {}) {
  const state = String(payload.state || payload.status || "").toLowerCase();
  const settledAt = Number(payload.settled_at || payload.settledAt || 0);
  const expiresAt = Number(payload.expires_at || payload.expiresAt || 0);
  const now = Date.now() / 1000;
  const hasPreimage = !!payload.preimage;
  const explicitSettled =
    payload.is_settled === true ||
    payload.settled === true ||
    payload.paid === true ||
    payload.is_paid === true;

  // 1) Trust explicit state
  if (state === "settled" || state === "paid" || state === "complete") return "PAID";
  if (state === "expired" || state === "canceled") return "EXPIRED";
  if (state === "failed") return "FAILED";

  // 2) Infer settlement from preimage/flags/timestamps
  if (explicitSettled || hasPreimage || settledAt > 0) return "PAID";

  // 3) Infer expiry from expires_at
  if (expiresAt && now > expiresAt) return "EXPIRED";

  return "PENDING";
}

async function makeClient({ url, relayUrl, relayUrls } = {}) {
  const nostrWalletConnectUrl = url || DEFAULT_NWC_URL;
  if (!nostrWalletConnectUrl) {
    throw new Error("NWC_URL is not configured.");
  }
  const fromArray = Array.isArray(relayUrls) && relayUrls.length ? relayUrls[0] : undefined;
  const envRelay = DEFAULT_RELAYS && DEFAULT_RELAYS.length ? DEFAULT_RELAYS[0] : undefined;
  const urlRelay = parseRelayFromNwcUrl(nostrWalletConnectUrl);
  const finalRelay = relayUrl || fromArray || envRelay || urlRelay || undefined;
  const client = new NWCClient({
    nostrWalletConnectUrl,
    relayUrl: finalRelay
  });
  // Compatibility/info-event handling is internal to the SDK; we can't skip it here.
  log("makeClient", { relayUrl: finalRelay || urlRelay || "from-url", walletPubkey: client.walletPubkey?.slice(0, 12) });
  return client;
}

function parseWalletPubkey(nwcUrl = "") {
  try {
    const url = nwcUrl
      .replace(/^nostr\+walletconnect:\/\//i, "http://")
      .replace(/^nostrwalletconnect:\/\//i, "http://")
      .replace(/^nostr\+walletconnect:/i, "http://")
      .replace(/^nostrwalletconnect:/i, "http://");
    const parsed = new URL(url);
    return parsed.host || "";
  } catch {
    return "";
  }
}

function parseRelayFromNwcUrl(nwcUrl = "") {
  try {
    const url = nwcUrl
      .replace(/^nostr\+walletconnect:\/\//i, "http://")
      .replace(/^nostrwalletconnect:\/\//i, "http://")
      .replace(/^nostr\+walletconnect:/i, "http://")
      .replace(/^nostrwalletconnect:/i, "http://");
    const parsed = new URL(url);
    return parsed.searchParams.get("relay") || "";
  } catch {
    return "";
  }
}

export async function ensureBtcWalletId({ url, relayUrls } = {}) {
  const client = await makeClient({ url, relayUrls });
  const pubkey = client.walletPubkey || parseWalletPubkey(url || DEFAULT_NWC_URL);
  if (!pubkey) {
    throw new Error("NWC walletPubkey missing from connection URL");
  }
  log("ensureBtcWalletId", { pubkey: pubkey.slice(0, 12) });
  return pubkey;
}

export async function createInvoiceSats({ url, relayUrls, amount, memo, expiresIn } = {}) {
  const client = await makeClient({ url, relayUrls });
  const sats = Math.max(0, Math.floor(Number(amount || 0)));
  const expirySeconds =
    Number.isFinite(Number(expiresIn)) && Number(expiresIn) > 0
      ? Math.floor(Number(expiresIn))
      : DEFAULT_EXPIRES_IN_SECONDS;

  log("makeInvoice start", { sats, expirySeconds, memo: memo ? memo.slice(0, 60) : "" });
  const res = await client.makeInvoice({
    amount: sats * 1000, // msats (number)
    description: memo || undefined,
    expiry: expirySeconds
  });
  const r = res || {};
  const paymentRequest = r.invoice || r.payment_request || "";
  const paymentHash = r.payment_hash || r.paymentHash || "";
  if (!paymentRequest || !paymentHash) {
    throw new Error("NWC make_invoice missing invoice or payment_hash");
  }
  log("makeInvoice ok", { paymentHash: paymentHash.slice(0, 12), sats: msatsToSats(r.amount) });
  return {
    paymentRequest,
    paymentHash,
    satoshis: msatsToSats(r.amount),
    invoiceId: paymentHash
  };
}

export async function invoiceStatus({ url, relayUrls, paymentHash } = {}) {
  if (!paymentHash) throw new Error("paymentHash is required");
  const client = await makeClient({ url, relayUrls });
  log("lookupInvoice start", { paymentHash: paymentHash.slice(0, 12) });
  const res = await client.lookupInvoice({ payment_hash: paymentHash });
  log("lookupInvoice raw", res);
  const r = res || {};
  const status = mapInvoiceState(r);
  log("lookupInvoice ok", { paymentHash: paymentHash.slice(0, 12), status, state: r.state || r.status, settled_at: r.settled_at, preimage: r.preimage ? "[present]" : undefined });
  return status;
}

/**
 * Subscribe to a single invoice status (polling over NWC lookup_invoice).
 * Returns an unsubscribe function.
 */
export function subscribeInvoiceStatus({ paymentHash, onStatus, url, relayUrls, pollIntervalMs = 3000 } = {}) {
  if (!paymentHash) throw new Error("paymentHash is required");
  let stopped = false;
  let timer = null;

  log("subscribeInvoiceStatus", { paymentHash: paymentHash.slice(0, 12), pollIntervalMs });

  const poll = async () => {
    if (stopped) return;
    try {
      const status = await invoiceStatus({ url, relayUrls, paymentHash });
      if (typeof onStatus === "function") onStatus(status);
      if (status === "PAID" || status === "EXPIRED" || status === "FAILED") {
        stopped = true;
        clearInterval(timer);
      }
    } catch {
      // swallow errors; keep polling
    }
  };

  poll();
  timer = setInterval(poll, pollIntervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Subscribe to NWC payment_received notifications and call onPaid(paymentHash).
 * Returns an unsubscribe function (best-effort). Self-bootstraps async and keeps interface sync for pay.js.
 */
export function startPaymentWatcher({ url, relayUrls, onPaid } = {}) {
  let unsubscribe = () => {};
  let client = null;

  (async () => {
    try {
      client = await makeClient({ url, relayUrls });
      log("notifications: subscribing", { relayUrl: client.relayUrl, walletPubkey: client.walletPubkey?.slice(0, 12) });
      unsubscribe = await client.subscribeNotifications((n) => {
        try {
          if (!n || n.notification_type !== "payment_received") return;
          const tx = n.notification || {};
          const hash = tx.payment_hash || tx.paymentHash || "";
          log("notifications: payment_received", { paymentHash: hash.slice(0, 12) });
          if (hash && typeof onPaid === "function") onPaid(hash);
        } catch (e) {
          log("notifications: handler error", e?.message || e);
        }
      }, ["payment_received"]);
    } catch (e) {
      log("notifications: subscribe failed", e?.message || e);
    }
  })();

  return () => {
    try { unsubscribe?.(); } catch {}
    try { client?.close?.(); } catch {}
  };
}
