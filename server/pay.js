// server/pay.js
import WebSocket from "ws";
import { EventEmitter } from "events";
import { Settings } from "./db.js";
import { deriveRefundKey } from "./satsrouting.js";
import * as satsrouting from "./satsrouting.js";

// Choose providers
// - Lightning: "blink" (default) | "lnd" | "btcpay" | "nwc" | "lnurl"
// - On-chain: "satsrouting" (default) | "btcpay" | "xpub"
export const LIGHTNING_PAYMENT_PROVIDER = String(
  process.env.LIGHTNING_PAYMENT_PROVIDER ||
  process.env.PAYMENT_PROVIDER || // backward compat
  "blink"
).toLowerCase();
const CONFIGURED_ONCHAIN_PROVIDER = String(
  process.env.ONCHAIN_PROVIDER ||
  process.env.ONCHAIN_PAYMENT_PROVIDER ||
  (String(process.env.PAYMENT_PROVIDER || "").toLowerCase() === "btcpay" ? "btcpay" : "satsrouting")
).toLowerCase();
// Treat the former "boltz" setting as SatsRouting for new swaps.
// Historical orders retain onchainProvider="boltz" and continue using the legacy adapter.
export const ONCHAIN_PROVIDER = CONFIGURED_ONCHAIN_PROVIDER === "boltz"
  ? "satsrouting"
  : ["satsrouting", "btcpay", "xpub"].includes(CONFIGURED_ONCHAIN_PROVIDER)
    ? CONFIGURED_ONCHAIN_PROVIDER
    : "satsrouting";
// Backward compat alias (used throughout codebase)
export const PAYMENT_PROVIDER = LIGHTNING_PAYMENT_PROVIDER;

// Blink driver (reuses your existing blink.js)
import * as blink from "./blink.js";

// LND driver
import * as lnd from "./lnd.js";

// NWC driver (NIP-47 via @getalby/sdk)
import * as nwc from "./nwc.js";

// LNURL driver (LNURL-pay + LNURL-verify)
import * as lnurl from "./lnurl.js";

// BTCPay Server driver
import * as btcpay from "./btcpay.js";

// Boltz (on-chain → Lightning Submarine swaps)
import * as boltz from "./boltz.js";

// On-chain XPUB provider (Esplora/mempool.space)
import * as xpubOnchain from "./onchain/xpub.js";

// Shared event bus for BTCPay webhook-driven updates
const btcpayEmitter = new EventEmitter();
btcpayEmitter.setMaxListeners(1000);

export function emitBtcpayStatus(invoiceId, status) {
  btcpayEmitter.emit(invoiceId, status);
}

/**
 * Ensure BTC wallet id (Blink needs it; LND returns a dummy).
 */
export async function ensureBtcWalletId(args = {}) {
  if (PAYMENT_PROVIDER === "blink") {
    const { url, apiKey, explicitWalletId } = args;
    return blink.ensureBtcWalletId({ url, apiKey, explicitWalletId });
  }
  if (PAYMENT_PROVIDER === "lnurl") {
    return lnurl.ensureBtcWalletId();
  }
  if (PAYMENT_PROVIDER === "nwc") {
    const { url, relayUrls } = args;
    return nwc.ensureBtcWalletId({ url, relayUrls });
  }
  if (PAYMENT_PROVIDER === "btcpay") {
    const { url, apiKey, explicitStoreId } = args;
    return btcpay.ensureBtcWalletId({ url, apiKey, explicitStoreId });
  }
  return "lnd-btc";
}

/**
 * Create invoice in satoshis.
 * Returns: { paymentRequest, paymentHash, satoshis }
 */
export async function createInvoiceSats(args) {
  if (PAYMENT_PROVIDER === "blink") {
    const { url, apiKey, walletId, amount, memo, expiresIn } = args || {};
    return blink.createInvoiceSats({ url, apiKey, walletId, amount, memo, expiresIn });
  }
  if (PAYMENT_PROVIDER === "lnurl") {
    const { amount, memo } = args || {};
    return lnurl.createInvoiceSats({ amount, memo });
  }
  if (PAYMENT_PROVIDER === "nwc") {
    const { url, relayUrls, amount, memo, expiresIn } = args || {};
    return nwc.createInvoiceSats({ url, relayUrls, amount, memo, expiresIn });
  }
  if (PAYMENT_PROVIDER === "btcpay") {
    const { url, apiKey, walletId, amount, memo, expiresIn } = args || {};
    // walletId is actually {storeId,...} for BTCPay driver
    const storeId = walletId?.storeId || walletId;
    return btcpay.createInvoiceSats({ url, apiKey, storeId, amount, memo, expiresIn });
  }
  // LND
  const { amount, memo, expiresIn } = args || {};
  return lnd.createInvoiceSats({ amount, memo, expiresIn });
}

/**
 * Poll invoice status: "PENDING" | "PAID" | "EXPIRED"
 */
export async function invoiceStatus(args) {
  if (PAYMENT_PROVIDER === "blink") {
    const { url, apiKey, paymentHash } = args || {};
    return blink.invoiceStatus({ url, apiKey, paymentHash });
  }
  if (PAYMENT_PROVIDER === "lnurl") {
    const { paymentHash, verifyUrl, paymentRequest, expiresAt } = args || {};
    return lnurl.invoiceStatus({ paymentHash, verifyUrl, paymentRequest, expiresAt });
  }
  if (PAYMENT_PROVIDER === "nwc") {
    const { url, relayUrls, paymentHash } = args || {};
    return nwc.invoiceStatus({ url, relayUrls, paymentHash });
  }
  if (PAYMENT_PROVIDER === "btcpay") {
    const { url, apiKey, paymentHash, walletId } = args || {};
    // In BTCPay we store invoiceId in paymentHash to avoid decoding BOLT11.
    return btcpay.invoiceStatus({ url, apiKey, storeId: walletId?.storeId || walletId, invoiceId: paymentHash });
  }
  const { paymentHash } = args || {};
  return lnd.invoiceStatus({ paymentHash });
}

// ---------------------------------------------------------------------
// On-chain via Boltz (Submarine swap: BTC on-chain -> pay LN invoice)
// ---------------------------------------------------------------------

function normalizeBoltzSwap(swap) {
  const onchainAddress = swap?.lockupAddress || swap?.address || "";
  const onchainAmountSats = Math.max(
    0,
    Math.floor(
      Number(swap?.expectedAmount ?? swap?.expected ?? swap?.onchainAmount ?? 0)
    )
  );
  const timeoutBlockHeight = Math.max(
    0,
    Math.floor(
      Number(swap?.timeoutBlockHeight ?? swap?.lockupTimeoutBlock ?? swap?.timeoutHeight ?? 0)
    )
  );
  const redeemScript = String(
    swap?.redeemScript || swap?.lockupScript || swap?.script || ""
  ).trim();
  let swapTree = "";
  if (swap?.swapTree) {
    swapTree = typeof swap.swapTree === "string"
      ? swap.swapTree
      : JSON.stringify(swap.swapTree);
  }
  return { onchainAddress, onchainAmountSats, timeoutBlockHeight, redeemScript, swapTree };
}

export async function createOnchainSwapViaBoltz(args = {}) {
  const { webhookUrl, memo } = args;
  const amount = Number(args.amount || 0);

  // BTCPay: create native on-chain invoice, skip Boltz entirely
  if (ONCHAIN_PROVIDER === "btcpay") {
    const invoice = await btcpay.createOnchainInvoice({
      url: args.url,
      apiKey: args.apiKey,
      storeId: args.walletId?.storeId || args.walletId,
      amount,
      memo,
      expiresIn: args.expiresIn
    });
    const onchainId = invoice.invoiceId || invoice.paymentHash || "";
    return {
      ...invoice,
      paymentMethod: "onchain",
      onchainId,
      boltzSwapId: "",
      boltzStatus: "",
      boltzRefundPrivKey: "",
      boltzRefundPubKey: "",
      onchainAddress: invoice.onchainAddress,
      onchainAmountSats: invoice.onchainAmountSats,
      timeoutBlockHeight: 0,
      bip21: invoice.bip21 || ""
    };
  }

  // Blink or LND: create standard LN invoice, then a Boltz swap
  const invoice =
    PAYMENT_PROVIDER === "blink"
      ? await blink.createInvoiceSats({
          url: args.url,
          apiKey: args.apiKey,
          walletId: args.walletId,
          amount,
          memo,
          expiresIn: args.expiresIn
        })
      : PAYMENT_PROVIDER === "lnurl"
        ? await lnurl.createInvoiceSats({
            amount,
            memo
          })
      : PAYMENT_PROVIDER === "nwc"
        ? await nwc.createInvoiceSats({
            url: args.url,
            relayUrls: args.relayUrls,
            amount,
            memo,
            expiresIn: args.expiresIn
          })
          : await lnd.createInvoiceSats({
              amount,
              memo,
              expiresIn: args.expiresIn
            });

  // 2) Create Submarine swap at Boltz (deterministic refund key if rescue mnemonic is set)
  const rescueMnemonic = String(process.env.BOLTZ_RESCUE_MNEMONIC || "").trim();
  const rescuePath = process.env.BOLTZ_RESCUE_PATH || undefined;
  let rescueIndex = null;
  let refundKey = null;

  if (rescueMnemonic) {
    try {
      rescueIndex = Settings.nextRescueIndex();
      refundKey = deriveRefundKey(rescueIndex, {
        mnemonic: rescueMnemonic,
        pathBase: rescuePath
      });
    } catch {
      rescueIndex = null;
      refundKey = null;
    }
  }
  // Fallback to ad-hoc keys if no rescue mnemonic is configured
  if (!refundKey) {
    refundKey = deriveRefundKey(0, { mnemonic: "" });
  }

  const { swap, refundPrivateKey, refundPublicKey, rescueIndex: derivedIndex } = await boltz.createSubmarineSwap({
    invoice: invoice.paymentRequest,
    webhookUrl,
    refundKey: refundKey || undefined
  });

  const { onchainAddress, onchainAmountSats, timeoutBlockHeight, redeemScript, swapTree } = normalizeBoltzSwap(swap);
  const bip21 = boltz.buildBip21({
    address: onchainAddress,
    amountSats: onchainAmountSats,
    label: memo || undefined
  });

  return {
    ...invoice,
    paymentMethod: "onchain",
    boltzSwapId: swap?.id || "",
    boltzStatus: swap?.status || "",
    boltzRefundPrivKey: "",
    boltzRefundPubKey: refundPublicKey || "",
    boltzRescueIndex: derivedIndex ?? rescueIndex,
    boltzRedeemScript: "",
    boltzSwapTree: "",
    onchainAddress,
    onchainAmountSats,
    timeoutBlockHeight,
    bip21
  };
}


export async function createOnchainSwapViaSatsRouting(args = {}) {
  const amount = Number(args.amount || 0);

  // Preflight against the live BTC -> BTC pair before issuing a Lightning invoice.
  const pair = await satsrouting.getBtcSubmarinePair();
  satsrouting.assertSubmarineAmount(amount, pair);

  const invoice = await createInvoiceSats({
    url: args.url,
    apiKey: args.apiKey,
    walletId: args.walletId,
    relayUrls: args.relayUrls,
    amount,
    memo: args.memo,
    expiresIn: args.expiresIn
  });

  const rescueMnemonic = String(
    process.env.SATSROUTING_RESCUE_MNEMONIC || process.env.BOLTZ_RESCUE_MNEMONIC || ""
  ).trim();
  const rescuePath =
    process.env.SATSROUTING_RESCUE_PATH || process.env.BOLTZ_RESCUE_PATH || undefined;
  let rescueIndex = null;
  let refundKey = null;

  if (rescueMnemonic) {
    try {
      // Keep the existing database sequence key so rescue derivation never reuses an old index.
      rescueIndex = Settings.nextRescueIndex();
      refundKey = deriveRefundKey(rescueIndex, {
        mnemonic: rescueMnemonic,
        pathBase: rescuePath
      });
    } catch {
      rescueIndex = null;
      refundKey = null;
    }
  }
  if (!refundKey) refundKey = deriveRefundKey(0, { mnemonic: "" });

  const { swap, refundPublicKey, rescueIndex: derivedIndex } = await satsrouting.createSubmarineSwap({
    invoice: invoice.paymentRequest,
    webhookUrl: args.webhookUrl,
    refundKey,
    pairHash: pair.hash
  });

  const onchainAddress = String(swap?.lockupAddress || swap?.address || "").trim();
  const onchainAmountSats = Math.max(
    0,
    Math.floor(Number(swap?.expectedAmount ?? swap?.expected ?? swap?.onchainAmount ?? 0))
  );
  const timeoutBlockHeight = Math.max(
    0,
    Math.floor(Number(swap?.timeoutBlockHeight ?? swap?.lockupTimeoutBlock ?? swap?.timeoutHeight ?? 0))
  );
  if (!onchainAddress || onchainAmountSats <= 0) {
    throw new Error("SatsRouting returned an incomplete on-chain payment request");
  }
  const bip21 = satsrouting.buildBip21({
    address: onchainAddress,
    amountSats: onchainAmountSats,
    label: args.memo || undefined
  });

  return {
    ...invoice,
    paymentMethod: "onchain",
    swapId: swap.id,
    onchainSwapId: swap.id,
    swapStatus: swap.status || "",
    satsroutingRefundPubKey: refundPublicKey || "",
    satsroutingRescueIndex: derivedIndex ?? rescueIndex,
    onchainAddress,
    onchainAmountSats,
    timeoutBlockHeight,
    bip21
  };
}

export async function satsroutingSwapStatus({ swapId }) {
  const swap = await satsrouting.getSwapStatus({ swapId });
  const mappedStatus = satsrouting.mapSatsRoutingStatus(swap?.status);
  const onchainAddress = String(swap?.lockupAddress || swap?.address || "").trim();
  const onchainAmountSats = Math.max(
    0,
    Math.floor(Number(swap?.expectedAmount ?? swap?.expected ?? swap?.onchainAmount ?? 0))
  );
  const timeoutBlockHeight = Math.max(
    0,
    Math.floor(Number(swap?.timeoutBlockHeight ?? swap?.lockupTimeoutBlock ?? swap?.timeoutHeight ?? 0))
  );
  return { swap, mappedStatus, onchainAddress, onchainAmountSats, timeoutBlockHeight };
}

export function subscribeSatsRoutingSwapStatus({ swapId, onUpdate }) {
  return satsrouting.subscribeSwapStatus({ swapId, onUpdate });
}

export async function boltzSwapStatus({ swapId }) {
  const swap = await boltz.getSwapStatus({ swapId });
  const mappedStatus = boltz.mapBoltzStatus(swap?.status);
  const { onchainAddress, onchainAmountSats, timeoutBlockHeight, redeemScript, swapTree } = normalizeBoltzSwap(swap);
  return { swap, mappedStatus, onchainAddress, onchainAmountSats, timeoutBlockHeight, redeemScript, swapTree };
}

export function subscribeBoltzSwapStatus({ swapId, onUpdate }) {
  return boltz.subscribeSwapStatus({ swapId, onUpdate });
}

function resolveOnchainProvider(preferred) {
  const provider = (preferred || ONCHAIN_PROVIDER || "satsrouting").toLowerCase();
  if (provider === "xpub") return "xpub";
  if (provider === "btcpay") return "btcpay";
  if (provider === "boltz") return "boltz"; // historical orders only
  return "satsrouting";
}

export async function createOnchainPaymentForOrder({
  order,
  amountSats,
  memo,
  webhookUrl,
  expiresIn,
  url,
  apiKey,
  walletId,
  relayUrls
} = {}) {
  const provider = resolveOnchainProvider(order?.onchainProvider);
  const sats = Math.max(0, Number(amountSats ?? order?.totalSats ?? 0));
  if (!order?.id) throw new Error("order.id is required for on-chain payments");

  if (provider === "xpub") {
    return xpubOnchain.createOnchainPayment({
      orderId: order.id,
      amountSats: sats,
      memo
    });
  }

  if (provider === "btcpay") {
    const invoice = await btcpay.createOnchainInvoice({
      url,
      apiKey,
      storeId: walletId?.storeId || walletId,
      amount: sats,
      memo,
      expiresIn
    });
    const onchainId = invoice?.invoiceId || invoice?.paymentHash || `btcpay-${order.id}`;
    return {
      ...invoice,
      paymentMethod: "onchain",
      onchainId,
      onchainAddress: invoice?.onchainAddress,
      onchainAmountSats: invoice?.onchainAmountSats,
      onchainBip21: invoice?.bip21 || invoice?.paymentRequest || ""
    };
  }

  if (provider === "satsrouting") {
    return createOnchainSwapViaSatsRouting({
      url, apiKey, walletId, relayUrls, amount: sats, memo, webhookUrl, expiresIn
    });
  }

  // Historical Boltz orders/configuration only.
  return createOnchainSwapViaBoltz({
    url,
    apiKey,
    walletId,
    relayUrls,
    amount: sats,
    memo,
    webhookUrl,
    expiresIn
  });
}

export async function getOnchainStatus(paymentRow, { btcpayConfig } = {}) {
  if (!paymentRow) return { status: "FAILED" };
  const providerHint = paymentRow?.onchainProvider || (paymentRow?.boltzSwapId ? "boltz" : undefined);
  const provider = resolveOnchainProvider(providerHint);
  if (provider === "xpub") {
    // xpub provider already returns the full status payload; just forward it.
    return await xpubOnchain.getOnchainStatus(paymentRow);
  }

  if (provider === "btcpay") {
    const url = btcpayConfig?.url || process.env.BTCPAY_URL || "";
    const apiKey = btcpayConfig?.apiKey || process.env.BTCPAY_API_KEY || "";
    const storeId = btcpayConfig?.storeId || process.env.BTCPAY_STORE_ID || "";
    const invoiceId =
      paymentRow.onchainId ||
      paymentRow.paymentHash;
    const inv = await btcpay.getInvoice({
      url,
      apiKey,
      storeId,
      invoiceId
    });
    const raw = String(inv?.status || "");
    const mapped = (() => {
      const st = raw.toLowerCase();
      if (st === "settled") return "CONFIRMED";
      if (st === "processing") return "MEMPOOL";
      if (st === "expired" || st === "invalid") return "EXPIRED";
      return "PENDING";
    })();
    return {
      status: mapped,
      rawStatus: raw,
      onchainAddress: paymentRow.onchainAddress || paymentRow.boltzAddress || "",
      onchainAmountSats: paymentRow.onchainAmountSats || paymentRow.boltzExpectedAmountSats || 0
    };
  }

  const swapId = provider === "boltz"
    ? (paymentRow.boltzSwapId || paymentRow.onchainSwapId || paymentRow.onchainId)
    : (paymentRow.onchainSwapId || paymentRow.onchainId || paymentRow.boltzSwapId);
  const result = provider === "boltz"
    ? await boltzSwapStatus({ swapId })
    : await satsroutingSwapStatus({ swapId });
  const { swap, mappedStatus, onchainAddress, onchainAmountSats, timeoutBlockHeight } = result;

  return {
    status: mappedStatus,
    rawStatus: swap?.status || "",
    onchainAddress: onchainAddress || paymentRow.onchainAddress || paymentRow.boltzAddress || "",
    onchainAmountSats: onchainAmountSats || paymentRow.onchainAmountSats || paymentRow.boltzExpectedAmountSats || 0,
    timeoutBlockHeight: timeoutBlockHeight || paymentRow.boltzTimeoutBlockHeight || 0
  };
}

/**
 * Subscribe to a single invoice status updates.
 * Returns an unsubscribe function.
 */
export function subscribeInvoiceStatus({ paymentHash, onStatus, ...rest }) {
  if (PAYMENT_PROVIDER === "blink") {
    const BLINK_WS_URL = process.env.BLINK_WS_URL || "wss://ws.blink.sv/graphql";
    const BLINK_API_KEY = process.env.BLINK_API_KEY || "";
    const ws = new WebSocket(BLINK_WS_URL, "graphql-transport-ws");

    let hb;
    const unsub = () => {
      try { clearInterval(hb); } catch {}
      try { ws.close(); } catch {}
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "connection_init",
        payload: { "X-API-KEY": BLINK_API_KEY }
      }));
    });

    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "connection_ack") {
        const query = `
          subscription S($input: LnInvoicePaymentStatusByHashInput!) {
            lnInvoicePaymentStatusByHash(input: $input) {
              status
              paymentHash
              errors { message }
            }
          }`;
        ws.send(JSON.stringify({
          id: "1",
          type: "subscribe",
          payload: { query, variables: { input: { paymentHash } } }
        }));
        hb = setInterval(() => { try { ws.ping?.(); } catch {} }, 20000);
        return;
      }
      if (msg.type === "next") {
        const st = msg?.payload?.data?.lnInvoicePaymentStatusByHash?.status;
        if (st && typeof onStatus === "function") onStatus(st);
        if (st === "PAID" || st === "EXPIRED") unsub();
      }
      if (msg.type === "error" || msg.type === "complete") unsub();
    });

    ws.on("close", () => unsub());
    ws.on("error", () => unsub());
    return unsub;
  }

  if (PAYMENT_PROVIDER === "lnurl") {
    const { verifyUrl, paymentRequest, expiresAt } = rest || {};
    return lnurl.subscribeInvoiceStatus({
      paymentHash,
      onStatus,
      verifyUrl,
      paymentRequest,
      expiresAt
    });
  }

  if (PAYMENT_PROVIDER === "btcpay") {
    const BTCPAY_URL = process.env.BTCPAY_URL || "";
    const BTCPAY_API_KEY = process.env.BTCPAY_API_KEY || "";
    const BTCPAY_STORE_ID = process.env.BTCPAY_STORE_ID || "";
    let stopped = false;
    let timer;
    const handler = (st) => {
      if (typeof onStatus === "function") onStatus(st);
      if (st === "PAID" || st === "EXPIRED") {
        stopped = true;
        clearInterval(timer);
        btcpayEmitter.removeListener(paymentHash, handler);
      }
    };
    btcpayEmitter.on(paymentHash, handler);

    const poll = async () => {
      try {
        const status = await btcpay.invoiceStatus({
          url: BTCPAY_URL,
          apiKey: BTCPAY_API_KEY,
          storeId: BTCPAY_STORE_ID,
          invoiceId: paymentHash
        });
        if (typeof onStatus === "function") onStatus(status);
        if (status === "PAID" || status === "EXPIRED") {
          clearInterval(timer);
          stopped = true;
        }
      } catch {
        // swallow errors; keep polling
      }
    };

    // prime + interval
    poll();
    timer = setInterval(() => {
      if (!stopped) poll();
    }, 5000);

    return () => {
      stopped = true;
      clearInterval(timer);
      btcpayEmitter.removeListener(paymentHash, handler);
    };
  }

  // LND: subscribe all invoices and filter by this hash
  if (PAYMENT_PROVIDER === "nwc") {
    const NWC_URL = process.env.NWC_URL || process.env.NWC_WALLET_CONNECT_URL || "";
    const RELAYS = String(process.env.NWC_RELAYS_CSV || process.env.NWC_RELAYS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    return nwc.subscribeInvoiceStatus({
      url: NWC_URL,
      relayUrls: RELAYS,
      paymentHash,
      onStatus
    });
  }

  // LND: subscribe all invoices and filter by this hash
  return lnd.subscribeInvoiceStatus({ paymentHash, onStatus });
}

/**
 * Long-lived server-side watcher to mark orders PAID.
 * Calls onPaid(paymentHash) when money arrives.
 */
export function startPaymentWatcher({ onPaid }) {
  if (PAYMENT_PROVIDER === "blink") {
    const BLINK_WS_URL = process.env.BLINK_WS_URL || "wss://ws.blink.sv/graphql";
    const BLINK_API_KEY = process.env.BLINK_API_KEY || "";
    let ws;
    let reconnectTimer;
    let backoffMs = 1000;

    const SUB_MY_UPDATES = `
      subscription {
        myUpdates {
          update {
            ... on LnUpdate {
              transaction {
                direction
                initiationVia { ... on InitiationViaLn { paymentHash } }
              }
            }
          }
        }
      }`;

    function connect() {
      clearTimeout(reconnectTimer);
      ws = new WebSocket(BLINK_WS_URL, "graphql-transport-ws");

      ws.on("open", () => {
        backoffMs = 1000;
        ws.send(JSON.stringify({
          type: "connection_init",
          payload: { "X-API-KEY": BLINK_API_KEY }
        }));
      });

      ws.on("message", (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === "connection_ack") {
          ws.send(JSON.stringify({
            id: "U1",
            type: "subscribe",
            payload: { query: SUB_MY_UPDATES, variables: {} }
          }));
          return;
        }
        if (msg.type === "next" && msg.id === "U1") {
          const upd = msg?.payload?.data?.myUpdates?.update;
          const dir = upd?.transaction?.direction;
          const hash = upd?.transaction?.initiationVia?.paymentHash;
          if (hash && (dir === "RECEIVE" || dir === "RECEIVED" || dir === "INCOMING")) {
            try { onPaid?.(hash); } catch {}
          }
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
    }
    connect();
    return;
  }

  if (PAYMENT_PROVIDER === "btcpay") {
    // We rely on webhooks and the background sweeper for BTCPay.
    return;
  }

  if (PAYMENT_PROVIDER === "lnurl") {
    // Polling/sweeper handle LNURL verify; no push channel.
    lnurl.startPaymentWatcher();
    return;
  }

  if (PAYMENT_PROVIDER === "nwc") {
    // Notifications (payment_received) + polling/sweeper handle updates for NWC.
    nwc.startPaymentWatcher({ onPaid });
    return;
  }

  // LND mode
  lnd.startPaymentWatcher({ onPaid });
}
