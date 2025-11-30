import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../blink.js", () => {
  return {
    ensureBtcWalletId: vi.fn(async ({ explicitWalletId }) => explicitWalletId || "blink-wallet"),
    createInvoiceSats: vi.fn(async ({ amount }) => ({
      paymentRequest: "lnbc1...",
      paymentHash: `hash-${amount}`,
      satoshis: amount
    })),
    invoiceStatus: vi.fn(async ({ paymentHash }) => (paymentHash === "paid-hash" ? "PAID" : "PENDING")),
    subscribeInvoiceStatus: vi.fn()
  };
});
vi.mock("../lnd.js", () => ({ createInvoiceSats: vi.fn(), invoiceStatus: vi.fn(), subscribeInvoiceStatus: vi.fn(), startPaymentWatcher: vi.fn() }));
vi.mock("../btcpay.js", () => ({ ensureBtcWalletId: vi.fn(), createInvoiceSats: vi.fn(), invoiceStatus: vi.fn() }));

vi.mock("ws", () => {
  class FakeWS {
    constructor() {
      this.handlers = {};
      setTimeout(() => {
        this.emit("open");
        // connection ack
        this.emit("message", JSON.stringify({ type: "connection_ack" }));
        // payment update
        this.emit("message", JSON.stringify({
          type: "next",
          id: "U1",
          payload: {
            data: {
              myUpdates: {
                update: {
                  transaction: {
                    direction: "RECEIVE",
                    initiationVia: { paymentHash: "paid-hash" }
                  }
                }
              }
            }
          }
        }));
      }, 0);
    }
    on(event, handler) {
      this.handlers[event] = handler;
    }
    send() {}
    close() {}
    emit(event, payload) {
      const handler = this.handlers[event];
      if (handler) handler(payload);
    }
  }
  return { default: FakeWS };
});

async function loadPay() {
  process.env.PAYMENT_PROVIDER = "blink";
  process.env.BLINK_API_KEY = "test-key";
  process.env.BLINK_WS_URL = "wss://example.test";
  vi.resetModules();
  return import("../pay.js");
}

describe("pay abstraction (blink)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates ensureBtcWalletId and createInvoiceSats to blink driver", async () => {
    const pay = await loadPay();
    const blink = await import("../blink.js");

    const walletId = await pay.ensureBtcWalletId({ explicitWalletId: "explicit-wallet" });
    expect(walletId).toBe("explicit-wallet");
    expect(blink.ensureBtcWalletId).toHaveBeenCalled();

    const invoice = await pay.createInvoiceSats({ amount: 123 });
    expect(invoice.paymentHash).toBe("hash-123");
    expect(blink.createInvoiceSats).toHaveBeenCalledWith(expect.objectContaining({ amount: 123 }));
  });

  it("returns invoice status from blink driver", async () => {
    const pay = await loadPay();
    const blink = await import("../blink.js");
    const status = await pay.invoiceStatus({ paymentHash: "paid-hash" });
    expect(status).toBe("PAID");
    expect(blink.invoiceStatus).toHaveBeenCalledWith(expect.objectContaining({ paymentHash: "paid-hash" }));
  });

  it("invokes onPaid when websocket receives payment updates", async () => {
    const pay = await loadPay();
    const onPaid = vi.fn();
    pay.startPaymentWatcher({ onPaid });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onPaid).toHaveBeenCalledWith("paid-hash");
  });
});
