// server/lnurl.js
// LNURL-pay + LNURL-verify provider (e.g. Blitz, any LNURL service exposing LUD-21).
import { decode as decodeInvoice } from "light-bolt11-decoder";
import { decodeLnurl } from "./lnurl-utils.js";

// Fallback fetch for environments without global fetch (Node < 18)
if (typeof fetch === "undefined") {
  const { default: fetchFn } = await import("node-fetch");
  globalThis.fetch = fetchFn;
}

const LNURL_LIGHTNING_ADDRESS =
  process.env.LNURL_LIGHTNING_ADDRESS ||
  process.env.BLITZ_LIGHTNING_ADDRESS ||
  "";
const LNURL_BECH32 =
  process.env.LNURL_BECH32 ||
  process.env.BLITZ_LNURL ||
  "";
const LNURL_PAY_URL = process.env.LNURL_PAY_URL || "";

const LNURL_DEBUG = String(process.env.LNURL_DEBUG || "false").toLowerCase() === "true";
const log = (...args) => {
  if (LNURL_DEBUG) console.info("[LNURL]", ...args);
};

const invoiceStore = new Map(); // paymentHash -> { verifyUrl, paymentRequest, satoshis, expiresAt }

// --- Global rate-limited verify queue (e.g., Blitz limit is 12 calls/min; we stay under) ---
const VERIFY_MAX_CALLS_PER_MIN = 10;
const VERIFY_TICK_MS = Math.max(1000, Math.floor(60000 / VERIFY_MAX_CALLS_PER_MIN));
const verifyJobs = new Map(); // paymentHash -> { onStatus, verifyUrl, paymentRequest, expiresAt }
let verifyTimer = null;

async function processVerifyQueue() {
  if (!verifyJobs.size) return;
  const [paymentHash, job] = verifyJobs.entries().next().value;
  verifyJobs.delete(paymentHash);
  try {
    const status = await invoiceStatus({
      paymentHash,
      verifyUrl: job.verifyUrl,
      paymentRequest: job.paymentRequest,
      expiresAt: job.expiresAt
    });
    if (typeof job.onStatus === "function") job.onStatus(status);
    if (status === "PENDING") {
      verifyJobs.set(paymentHash, job);
    }
  } catch (e) {
    log("processVerifyQueue error", e?.message || e);
    verifyJobs.set(paymentHash, job); // retry later
  }
}

function ensureVerifyTimer() {
  if (verifyTimer) return;
  verifyTimer = setInterval(processVerifyQueue, VERIFY_TICK_MS);
}

function lightningAddressToLnurlp(address) {
  const [name, host] = String(address || "").trim().split("@");
  if (!name || !host) {
    throw new Error("Invalid lightning address; expected name@host");
  }
  return `https://${host}/.well-known/lnurlp/${encodeURIComponent(name)}`;
}

function getLnurlPayUrl() {
  if (LNURL_PAY_URL) return LNURL_PAY_URL;
  if (LNURL_BECH32) return decodeLnurl(LNURL_BECH32); // -> https://.../lnurlp/...
  if (LNURL_LIGHTNING_ADDRESS) return lightningAddressToLnurlp(LNURL_LIGHTNING_ADDRESS);
  throw new Error("LNURL_LIGHTNING_ADDRESS or LNURL_BECH32 or LNURL_PAY_URL must be set");
}

async function fetchJson(url) {
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function decodeBolt11(invoice) {
  const decoded = decodeInvoice(invoice);
  const sections = decoded?.sections || [];

  const paymentHash = sections.find((s) => s.name === "payment_hash")?.value || "";
  const amountStr = sections.find((s) => s.name === "amount")?.value;
  const millisatoshis = Number.isFinite(Number(amountStr)) ? Number(amountStr) : undefined;

  const timestampSec = Number(sections.find((s) => s.name === "timestamp")?.value || 0);
  const expirySec = Number(decoded?.expiry ?? 3600);

  return {
    paymentHash,
    millisatoshis,
    timestampSec,
    expirySec
  };
}

async function getLnurlPayInfo() {
  const url = getLnurlPayUrl();
  log("LNURL-pay info GET", url);
  const info = await fetchJson(url);
  if (info.status && String(info.status).toUpperCase() === "ERROR") {
    throw new Error(`LNURL-pay error: ${info.reason || "unknown"}`);
  }
  if (info.tag !== "payRequest" || !info.callback) {
    throw new Error("LNURL-pay info missing 'payRequest' tag or 'callback'");
  }
  return {
    callback: info.callback,
    minSendable: Number(info.minSendable || 0), // msats
    maxSendable: Number(info.maxSendable || 0), // msats
    metadata: info.metadata,
    commentAllowed: Number(info.commentAllowed || 0)
  };
}

export async function ensureBtcWalletId() {
  const info = await getLnurlPayInfo();
  const id = LNURL_LIGHTNING_ADDRESS || LNURL_BECH32 || info.callback;
  log("ensureBtcWalletId OK", { id });
  return id;
}

export async function createInvoiceSats({ amount, memo } = {}) {
  const sats = Math.max(0, Math.floor(Number(amount || 0)));
  if (!sats) throw new Error("amount must be > 0");

  const payInfo = await getLnurlPayInfo();
  const msats = BigInt(sats) * 1000n;
  if (msats < BigInt(payInfo.minSendable) || msats > BigInt(payInfo.maxSendable)) {
    throw new Error(
      `amount ${sats} sats is outside LNURL range ${payInfo.minSendable / 1000} - ${payInfo.maxSendable / 1000} sats`
    );
  }

  const callbackUrl = new URL(payInfo.callback);
  callbackUrl.searchParams.set("amount", msats.toString());
  if (memo && payInfo.commentAllowed > 0) {
    const trimmed = memo.slice(0, payInfo.commentAllowed);
    callbackUrl.searchParams.set("comment", trimmed);
  }

  log("LNURL callback", callbackUrl.toString());
  const resp = await fetchJson(callbackUrl);
  if (resp.status && String(resp.status).toUpperCase() === "ERROR") {
    throw new Error(`LNURL-pay callback error: ${resp.reason || "unknown"}`);
  }

  const paymentRequest = resp.pr || resp.invoice || "";
  const verifyUrl = resp.verify || "";
  if (!paymentRequest) {
    throw new Error("LNURL-pay callback missing 'pr' (BOLT11 invoice)");
  }

  const decoded = decodeBolt11(paymentRequest);
  if (!decoded.paymentHash) {
    throw new Error("BOLT11 invoice missing payment_hash");
  }

  const satoshis = decoded.millisatoshis
    ? Math.floor(decoded.millisatoshis / 1000)
    : sats;
  const createdAt = decoded.timestampSec ? decoded.timestampSec * 1000 : Date.now();
  const expiresAt = decoded.expirySec ? (decoded.timestampSec + decoded.expirySec) * 1000 : 0;

  invoiceStore.set(decoded.paymentHash, {
    verifyUrl: verifyUrl || "",
    paymentRequest,
    satoshis,
    createdAt,
    expiresAt
  });

  log("createInvoiceSats OK", {
    paymentHash: decoded.paymentHash.slice(0, 12),
    satoshis,
    hasVerify: !!verifyUrl
  });

  return {
    paymentRequest,
    paymentHash: decoded.paymentHash,
    satoshis,
    invoiceId: decoded.paymentHash,
    verifyUrl: verifyUrl || "",
    expiresAt
  };
}

function mapStatusFromVerify(verifyResp, stored, paymentRequest) {
  if (!verifyResp) return "FAILED";
  if (verifyResp.status && String(verifyResp.status).toUpperCase() === "ERROR") {
    const reason = String(verifyResp.reason || "").toLowerCase();
    if (reason.includes("not found") || reason.includes("unknown invoice")) {
      return "EXPIRED";
    }
    return "FAILED";
  }
  if (verifyResp.settled === true) return "PAID";

  let expiresAt = stored?.expiresAt || 0;
  if (!expiresAt && paymentRequest) {
    try {
      const decoded = decodeBolt11(paymentRequest);
      if (decoded.timestampSec && decoded.expirySec) {
        expiresAt = (decoded.timestampSec + decoded.expirySec) * 1000;
      }
    } catch {
      // ignore
    }
  }
  if (expiresAt && Date.now() > expiresAt) return "EXPIRED";
  return "PENDING";
}

export async function invoiceStatus({ paymentHash, verifyUrl, paymentRequest, expiresAt } = {}) {
  if (!paymentHash) throw new Error("paymentHash is required");
  const stored = invoiceStore.get(paymentHash);
  const url = verifyUrl || stored?.verifyUrl || "";
  const pr = paymentRequest || stored?.paymentRequest || "";
  const exp = Number(expiresAt || stored?.expiresAt || 0);

  // Cache provided verify data so a restart doesn't lose LNURL-verify context.
  if (url) {
    invoiceStore.set(paymentHash, {
      verifyUrl: url,
      paymentRequest: pr || (stored?.paymentRequest ?? ""),
      satoshis: stored?.satoshis,
      createdAt: stored?.createdAt,
      expiresAt: exp || stored?.expiresAt || 0
    });
  }

  if (!url) {
    if (exp && Date.now() > exp) return "EXPIRED";
    return "PENDING";
  }

  log("LNURL-verify GET", { paymentHash: paymentHash.slice(0, 12) });
  const verifyResp = await fetchJson(url);
  const status = mapStatusFromVerify(verifyResp, { expiresAt: exp }, pr);
  log("LNURL-verify result", {
    paymentHash: paymentHash.slice(0, 12),
    status,
    settled: verifyResp?.settled,
    respStatus: verifyResp?.status
  });
  return status;
}

export function subscribeInvoiceStatus({ paymentHash, onStatus, verifyUrl, paymentRequest, expiresAt, pollIntervalMs = 5000 } = {}) {
  if (!paymentHash) throw new Error("paymentHash is required");
  const stored = invoiceStore.get(paymentHash);
  const job = {
    onStatus,
    verifyUrl: verifyUrl || stored?.verifyUrl || "",
    paymentRequest: paymentRequest || stored?.paymentRequest || "",
    expiresAt: Number(expiresAt || stored?.expiresAt || 0)
  };

  log("subscribeInvoiceStatus queued", { paymentHash: paymentHash.slice(0, 12) });
  verifyJobs.set(paymentHash, job);
  ensureVerifyTimer();

  return () => {
    verifyJobs.delete(paymentHash);
  };
}

export function startPaymentWatcher() {
  // No push notifications in LNURL land; polling handled by subscribe & sweeper.
  return;
}
