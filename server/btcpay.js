// server/btcpay.js
// BTCPay Server (Greenfield API) driver for the provider-agnostic payment layer.
import fetch from "node-fetch";

const DEFAULT_URL = (process.env.BTCPAY_URL || "").replace(/\/+$/, "");
const DEFAULT_STORE_ID = process.env.BTCPAY_STORE_ID || "";
const DEFAULT_API_KEY = process.env.BTCPAY_API_KEY || "";

// Allow method id overrides; will auto-detect otherwise.
const LN_METHOD_OVERRIDE = process.env.BTCPAY_LN_METHOD_ID || "";
const CHAIN_METHOD_OVERRIDE = process.env.BTCPAY_CHAIN_METHOD_ID || "";
const METHOD_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const methodCache = new Map(); // key: storeId -> { lnId, chainId, enabledIds, allIds, ts }

async function api({ url = DEFAULT_URL, apiKey = DEFAULT_API_KEY, path, method = "GET", body }) {
  if (!url) throw new Error("BTCPAY_URL is missing");
  if (!apiKey) throw new Error("BTCPAY_API_KEY is missing");
  const res = await fetch(`${url}/api/v1${path}`, {
    method,
    headers: {
      authorization: `token ${apiKey}`,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`BTCPay HTTP ${res.status} ${text}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

function satsToBtcString(amount) {
  const n = Math.max(0, Number(amount || 0));
  return (n / 1e8).toFixed(8);
}

function buildBip21({ address, amountSats, label }) {
  const sats = Math.max(0, Number(amountSats || 0));
  const btc = (sats / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  const params = [];
  if (btc && btc !== "0") params.push(`amount=${btc}`);
  if (label) params.push(`label=${encodeURIComponent(label)}`);
  const qs = params.length ? `?${params.join("&")}` : "";
  return `bitcoin:${address}${qs}`;
}

function stringifyIds(arr) {
  return Array.isArray(arr) && arr.length ? arr.join(", ") : "none";
}

function friendlyError(err, context) {
  const raw = String(err?.message || err || "");
  const lc = raw.toLowerCase();
  if (lc.includes("dust threshold")) {
    return "On-chain amount too low; increase amount or use Lightning.";
  }
  if (lc.includes("payment method unavailable")) {
    return "Requested payment method is unavailable. Check BTCPay payment methods.";
  }
  if (lc.includes("no lightning payment method")) {
    return "Lightning payment method is not enabled in BTCPay.";
  }
  if (lc.includes("no on-chain payment method")) {
    return "On-chain payment method is not enabled in BTCPay.";
  }
  return context ? `BTCPay: failed to ${context}` : "BTCPay: request failed";
}

function mapStatus(status) {
  const st = String(status || "").toLowerCase();
  if (st === "settled") return "PAID";
  if (st === "expired" || st === "invalid") return "EXPIRED";
  return "PENDING"; // New, Processing, any unknown future states
}

async function listPaymentMethods({ url, apiKey, storeId, onlyEnabled = true }) {
  const q = onlyEnabled ? "?onlyEnabled=true" : "";
  return api({
    url,
    apiKey,
    path: `/stores/${storeId}/payment-methods${q}`,
    method: "GET"
  });
}

function pickMethodId(methods = [], kind = "ln") {
  const lowerMatches = (pred) =>
    methods.find((m) => {
      const id = String(m?.paymentMethodId || m?.paymentMethod || "").toLowerCase();
      return pred(id);
    });

  if (kind === "ln") {
    const m =
      lowerMatches((id) => id.endsWith("-ln")) ||
      lowerMatches((id) => id.includes("lightning"));
    return m?.paymentMethodId || m?.paymentMethod || "";
  }

  const m =
    lowerMatches((id) => id.endsWith("-chain")) ||
    lowerMatches((id) => id.includes("onchain")) ||
    lowerMatches((id) => id === "btc");
  return m?.paymentMethodId || m?.paymentMethod || "";
}

async function resolveMethodIds({ url, apiKey, storeId }) {
  const now = Date.now();
  const cached = methodCache.get(storeId);
  if (cached && now - cached.ts < METHOD_CACHE_TTL_MS) {
    return { ...cached };
  }

  const enabled = (await listPaymentMethods({ url, apiKey, storeId, onlyEnabled: true })) || [];
  const all = (await listPaymentMethods({ url, apiKey, storeId, onlyEnabled: false })) || [];
  const lnId =
    LN_METHOD_OVERRIDE ||
    pickMethodId(enabled, "ln") ||
    pickMethodId(all, "ln");
  const chainId =
    CHAIN_METHOD_OVERRIDE ||
    pickMethodId(enabled, "chain") ||
    pickMethodId(all, "chain");
  const enabledIds = enabled.map((m) => m.paymentMethodId || m.paymentMethod).filter(Boolean);
  const allIds = all.map((m) => m.paymentMethodId || m.paymentMethod).filter(Boolean);
  const result = { lnId, chainId, enabledIds, allIds, ts: now };
  methodCache.set(storeId, result);
  return result;
}

async function fetchPaymentMethods({ url, apiKey, storeId, invoiceId }) {
  return api({
    url,
    apiKey,
    path: `/stores/${storeId}/invoices/${invoiceId}/payment-methods`,
    method: "GET"
  });
}

async function ensureStoreId({ url = DEFAULT_URL, apiKey = DEFAULT_API_KEY, explicitStoreId } = {}) {
  if (explicitStoreId) return explicitStoreId;
  const stores = await api({ url, apiKey, path: "/stores", method: "GET" });
  if (Array.isArray(stores) && stores.length) return stores[0].id;
  throw new Error("No BTCPay store available for this API key. Set BTCPAY_STORE_ID.");
}

/**
 * Resolve store id and expose the payment method ids we use.
 */
export async function ensureBtcWalletId({ url, apiKey, explicitStoreId } = {}) {
  const storeId = await ensureStoreId({ url, apiKey, explicitStoreId });
  const { lnId, chainId } = await resolveMethodIds({ url, apiKey, storeId });
  return {
    storeId,
    lightningMethodId: lnId,
    onchainMethodId: chainId
  };
}

/**
 * Create a Lightning invoice (BOLT11). Returns paymentRequest (BOLT11), paymentHash (invoiceId), satoshis, invoiceId.
 */
export async function createInvoiceSats({ url, apiKey, storeId, amount, memo, expiresIn, orderRef } = {}) {
  const targetStoreId = storeId || (await ensureStoreId({ url, apiKey }));
  const expirationMinutes = Math.max(1, Math.round((Number(expiresIn) || 900) / 60));
  const { lnId, enabledIds, allIds } = await resolveMethodIds({ url, apiKey, storeId: targetStoreId });
  if (!lnId) {
    throw new Error(
      `BTCPay: no Lightning payment method enabled. Enabled: ${stringifyIds(enabledIds)}; All: ${stringifyIds(allIds)}`
    );
  }

  let invoice;
  try {
    invoice = await api({
      url,
      apiKey,
      path: `/stores/${targetStoreId}/invoices`,
      method: "POST",
      body: {
        amount: satsToBtcString(amount),
        currency: "BTC",
        metadata: {
          ...(memo ? { memo } : {}),
          ...(orderRef ? { orderId: orderRef } : {})
        },
        checkout: {
          paymentMethods: [lnId],
          defaultPaymentMethod: lnId,
          expirationMinutes
        }
      }
    });
  } catch (e) {
    console.warn("[btcpay] create ln invoice failed:", e?.message || e);
    throw new Error(friendlyError(e, "create Lightning invoice"));
  }

  const pm = await fetchPaymentMethods({
    url,
    apiKey,
    storeId: targetStoreId,
    invoiceId: invoice?.id
  });
  const ln = Array.isArray(pm)
    ? pm.find((x) => {
        const id = String(x.paymentMethod || x.paymentMethodId || "").toLowerCase();
        return id === String(lnId).toLowerCase() || id.includes("lightning") || id.endsWith("-ln");
      })
    : null;
  if (!ln?.destination) {
    const available = Array.isArray(pm) ? pm.map((x) => x.paymentMethod).join(", ") : "none";
    throw new Error(`BTCPay: missing Lightning destination for invoice (available methods: ${available})`);
  }

  return {
    paymentRequest: ln.destination, // BOLT11
    paymentHash: invoice?.id || "", // we use invoiceId as our unique key
    satoshis: Math.max(0, Math.floor(Number(amount || 0))),
    invoiceId: invoice?.id || "",
    checkoutLink: invoice?.checkoutLink || ""
  };
}

/**
 * Create an on-chain payment request (BIP21).
 */
export async function createOnchainInvoice({ url, apiKey, storeId, amount, memo, expiresIn, orderRef } = {}) {
  const targetStoreId = storeId || (await ensureStoreId({ url, apiKey }));
  const expirationMinutes = Math.max(1, Math.round((Number(expiresIn) || 3600) / 60));
  const { chainId, enabledIds, allIds } = await resolveMethodIds({ url, apiKey, storeId: targetStoreId });
  if (!chainId) {
    throw new Error(
      `BTCPay: no on-chain payment method enabled. Enabled: ${stringifyIds(enabledIds)}; All: ${stringifyIds(allIds)}`
    );
  }

  let invoice;
  try {
    invoice = await api({
      url,
      apiKey,
      path: `/stores/${targetStoreId}/invoices`,
      method: "POST",
      body: {
        amount: satsToBtcString(amount),
        currency: "BTC",
        metadata: {
          ...(memo ? { memo } : {}),
          ...(orderRef ? { orderId: orderRef } : {})
        },
        checkout: {
          paymentMethods: [chainId],
          defaultPaymentMethod: chainId,
          expirationMinutes
        }
      }
    });
  } catch (e) {
    console.warn("[btcpay] create on-chain invoice failed:", e?.message || e);
    throw new Error(friendlyError(e, "create on-chain request"));
  }

  const pm = await fetchPaymentMethods({
    url,
    apiKey,
    storeId: targetStoreId,
    invoiceId: invoice?.id
  });
  const chain = Array.isArray(pm)
    ? pm.find((x) => {
        const id = String(x.paymentMethod || x.paymentMethodId || "").toLowerCase();
        return (
          id === String(chainId).toLowerCase() ||
          id.endsWith("-chain") ||
          id.includes("onchain") ||
          id === "btc"
        );
      })
    : null;
  if (!chain?.destination) {
    const available = Array.isArray(pm) ? pm.map((x) => x.paymentMethod).join(", ") : "none";
    throw new Error(`BTCPay: missing on-chain destination for invoice (available methods: ${available})`);
  }

  const sats = Math.max(0, Math.floor(Number(amount || 0)));
  const bip21 = buildBip21({
    address: chain.destination,
    amountSats: sats,
    label: memo || undefined
  });
  return {
    paymentMethod: "onchain",
    paymentRequest: bip21, // sanitized BIP21 (no backend host)
    paymentHash: invoice?.id || "",
    satoshis: sats,
    invoiceId: invoice?.id || "",
    onchainAddress: chain.destination,
    onchainAmountSats: sats,
    bip21,
    checkoutLink: invoice?.checkoutLink || ""
  };
}

/**
 * Poll invoice status by invoiceId (we pass paymentHash as invoiceId in the rest of the app).
 */
export async function invoiceStatus({ url, apiKey, storeId, invoiceId }) {
  const targetStoreId = storeId || (await ensureStoreId({ url, apiKey }));
  const inv = await api({
    url,
    apiKey,
    path: `/stores/${targetStoreId}/invoices/${invoiceId}`,
    method: "GET"
  });
  return mapStatus(inv?.status);
}

/**
 * Map BTCPay webhook event type to status.
 */
export function statusFromEventType(type) {
  const t = String(type || "").toLowerCase();
  if (t === "invoicesettled") return "PAID";
  if (t === "invoiceexpired" || t === "invoiceinvalid") return "EXPIRED";
  if (t === "invoiceprocessing" || t === "invoicereceivedpayment") return "PENDING";
  return "PENDING";
}

/**
 * Fetch full invoice payload (used for on-chain detail/status).
 */
export async function getInvoice({ url, apiKey, storeId, invoiceId }) {
  const targetStoreId = storeId || (await ensureStoreId({ url, apiKey }));
  return api({
    url,
    apiKey,
    path: `/stores/${targetStoreId}/invoices/${invoiceId}`,
    method: "GET"
  });
}
