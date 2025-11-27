// server/pay.js
import WebSocket from "ws";

// Choose provider: "blink" (default) or "lnd"
export const PAYMENT_PROVIDER = String(process.env.PAYMENT_PROVIDER || "blink").toLowerCase();

// Blink driver (reuses your existing blink.js)
import * as blink from "./blink.js";

// LND driver
import * as lnd from "./lnd.js";

// Boltz (on-chain → Lightning Submarine swaps)
import * as boltz from "./boltz.js";

/**
 * Ensure BTC wallet id (Blink needs it; LND returns a dummy).
 */
export async function ensureBtcWalletId(args = {}) {
  if (PAYMENT_PROVIDER === "blink") {
    const { url, apiKey, explicitWalletId } = args;
    return blink.ensureBtcWalletId({ url, apiKey, explicitWalletId });
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
  return { onchainAddress, onchainAmountSats, timeoutBlockHeight };
}

export async function createOnchainSwapViaBoltz(args = {}) {
  const { webhookUrl, memo } = args;
  const amount = Number(args.amount || 0);

  // 1) Create standard LN invoice via chosen provider
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
      : await lnd.createInvoiceSats({
          amount,
          memo,
          expiresIn: args.expiresIn
        });

  // 2) Create Submarine swap at Boltz
  const { swap, refundPrivateKey, refundPublicKey } = await boltz.createSubmarineSwap({
    invoice: invoice.paymentRequest,
    webhookUrl
  });

  const { onchainAddress, onchainAmountSats, timeoutBlockHeight } = normalizeBoltzSwap(swap);
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
    boltzRefundPrivKey: refundPrivateKey || "",
    boltzRefundPubKey: refundPublicKey || "",
    onchainAddress,
    onchainAmountSats,
    timeoutBlockHeight,
    bip21
  };
}

export async function boltzSwapStatus({ swapId }) {
  const swap = await boltz.getSwapStatus({ swapId });
  const mappedStatus = boltz.mapBoltzStatus(swap?.status);
  const { onchainAddress, onchainAmountSats, timeoutBlockHeight } = normalizeBoltzSwap(swap);
  return { swap, mappedStatus, onchainAddress, onchainAmountSats, timeoutBlockHeight };
}

export function subscribeBoltzSwapStatus({ swapId, onUpdate }) {
  return boltz.subscribeSwapStatus({ swapId, onUpdate });
}

/**
 * Subscribe to a single invoice status updates.
 * Returns an unsubscribe function.
 */
export function subscribeInvoiceStatus({ paymentHash, onStatus }) {
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

  // LND mode
  lnd.startPaymentWatcher({ onPaid });
}
