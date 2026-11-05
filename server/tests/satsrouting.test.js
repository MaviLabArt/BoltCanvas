import { describe, expect, it, vi } from "vitest";
import {
  assertSubmarineAmount,
  assertRecoverableRefundKey,
  fetchWithFallback,
  dispatchSwapStatusUpdate,
  buildBip21,
  canRetryWithIpv4,
  isSatsRoutingOrder,
  resolveSatsRoutingWebhookSecret,
  hasSubmarineLockupTransaction,
  mapSatsRoutingStatus,
  resolveBtcSubmarinePair,
  resolveSatsRoutingRescueMnemonic
} from "../satsrouting.js";

describe("SatsRouting Submarine swap adapter", () => {
  const pairPayload = {
    BTC: {
      BTC: {
        hash: "pair-hash",
        rate: 1,
        limits: { minimal: 50000, minimalBatched: 25000, maximal: 25000000 },
        fees: { percentage: 0.1, minerFees: 4379 }
      }
    }
  };

  it("resolves the live BTC-to-BTC pair and its dynamic limits", () => {
    const pair = resolveBtcSubmarinePair(pairPayload);
    expect(pair.hash).toBe("pair-hash");
    expect(pair.limits.minimal).toBe(50000);
    expect(pair.limits.maximal).toBe(25000000);
  });

  it("accepts the wrapped pair response shape too", () => {
    const pair = resolveBtcSubmarinePair({ pairs: pairPayload.BTC });
    expect(pair.hash).toBe("pair-hash");
  });

  it("rejects a missing or malformed BTC-to-BTC pair", () => {
    expect(() => resolveBtcSubmarinePair({})).toThrow(/valid BTC-to-BTC/);
    expect(() => resolveBtcSubmarinePair({
      BTC: { BTC: { hash: "x", limits: { minimal: 100, maximal: 10 } } }
    })).toThrow(/valid BTC-to-BTC/);
  });

  it("checks invoice amount against the current pair limits", () => {
    const pair = resolveBtcSubmarinePair(pairPayload);
    expect(assertSubmarineAmount(25000, pair)).toBe(25000);
    expect(assertSubmarineAmount(50000, pair)).toBe(50000);
    expect(assertSubmarineAmount(25000000, pair)).toBe(25000000);
    expect(() => assertSubmarineAmount(24999, pair)).toThrow(/minimum.*25000/);
    expect(() => assertSubmarineAmount(25000001, pair)).toThrow(/maximum.*25000000/);
    expect(() => assertSubmarineAmount(0, pair)).toThrow(/Invalid submarine/);
  });

  it.each([
    ["invoice.paid", "PAID"],
    ["invoice.pending", "CONFIRMED"],
    ["transaction.confirmed", "CONFIRMED"],
    ["transaction.mempool", "MEMPOOL"],
    ["transaction.direct", "MEMPOOL"],
    ["swap.expired", "EXPIRED"],
    ["invoice.failedToPay", "FAILED"],
    ["transaction.failed", "FAILED"],
    ["unknown.status", "PENDING"]
  ])("maps SatsRouting status %s to %s", (raw, expected) => {
    expect(mapSatsRoutingStatus(raw)).toBe(expected);
  });

  it("builds the on-chain BIP21 URI from the swap amount", () => {
    expect(buildBip21({
      address: "bc1qexample",
      amountSats: 125000,
      label: "Art order 42"
    })).toBe("bitcoin:bc1qexample?amount=0.00125&label=Art%20order%2042");
  });

  it("requires a valid recoverable BIP39 rescue phrase", () => {
    const validMnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(resolveSatsRoutingRescueMnemonic({
      satsroutingMnemonic: validMnemonic,
      legacyBoltzMnemonic: ""
    })).toBe(validMnemonic);
    expect(resolveSatsRoutingRescueMnemonic({
      satsroutingMnemonic: "",
      legacyBoltzMnemonic: validMnemonic
    })).toBe(validMnemonic);
    expect(() => resolveSatsRoutingRescueMnemonic({
      satsroutingMnemonic: "",
      legacyBoltzMnemonic: ""
    })).toThrow(/SATSROUTING_RESCUE_MNEMONIC/);
    expect(() => resolveSatsRoutingRescueMnemonic({
      satsroutingMnemonic: "word1 word2 word3",
      legacyBoltzMnemonic: ""
    })).toThrow(/valid BIP39/);
  });

  it("does not retry ambiguous failures for non-idempotent POST requests", () => {
    expect(canRetryWithIpv4({ method: "GET" }, { code: "ECONNRESET" })).toBe(true);
    expect(canRetryWithIpv4({ method: "POST" }, { code: "ECONNRESET" })).toBe(false);
    expect(canRetryWithIpv4({ method: "POST" }, { code: "ETIMEDOUT" })).toBe(false);
    expect(canRetryWithIpv4({ method: "POST" }, { code: "EAI_AGAIN" })).toBe(true);
    expect(canRetryWithIpv4({ method: "POST" }, { code: "ECONNREFUSED" })).toBe(true);
  });

  it("keeps webhook callbacks disabled without a generated high-entropy secret", () => {
    expect(resolveSatsRoutingWebhookSecret("")).toBe("");
    expect(resolveSatsRoutingWebhookSecret("replace-with-long-random-string")).toBe("");
    expect(resolveSatsRoutingWebhookSecret("too-short")).toBe("");
    const generatedSecret = "ab".repeat(32);
    expect(resolveSatsRoutingWebhookSecret(generatedSecret)).toBe(generatedSecret);
  });

  it("applies webhook lookup only to SatsRouting orders", () => {
    expect(isSatsRoutingOrder({ onchainProvider: "satsrouting" })).toBe(true);
    expect(isSatsRoutingOrder({ onchainProvider: " SATSROUTING " })).toBe(true);
    expect(isSatsRoutingOrder({ onchainProvider: "SAT SROUTING" })).toBe(false);
    expect(isSatsRoutingOrder({ onchainProvider: "boltz" })).toBe(false);
    expect(isSatsRoutingOrder({})).toBe(false);
    expect(isSatsRoutingOrder(null)).toBe(false);
  });

  it("requires recoverable refund key material before creating a swap", () => {
    expect(() => assertRecoverableRefundKey()).toThrow(/recoverable SatsRouting refundKey/);
    expect(() => assertRecoverableRefundKey({
      refundPublicKey: "02".repeat(33),
      rescueIndex: null
    })).toThrow(/recoverable SatsRouting refundKey/);
    expect(() => assertRecoverableRefundKey({
      refundPublicKey: "02".repeat(33),
      rescueIndex: -1
    })).toThrow(/recoverable SatsRouting refundKey/);

    const refundKey = {
      refundPublicKey: "02".repeat(33),
      rescueIndex: 0
    };
    expect(assertRecoverableRefundKey(refundKey)).toBe(refundKey);
  });

  it("keeps the request timeout active while reading the response body", async () => {
    vi.useFakeTimers();
    const timeoutMs = 25;
    let markBodyStarted;
    const bodyStarted = new Promise((resolve) => { markBodyStarted = resolve; });
    const fetchImpl = vi.fn(async (_url, init) => ({ signal: init.signal }));
    const readResponse = vi.fn(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      markBodyStarted();
    }));

    try {
      const pendingRequest = fetchWithFallback(
        "https://satsrouting.example/v2/swap/submarine",
        { method: "GET" },
        readResponse,
        { fetchImpl, timeoutMs }
      );
      // Attach the rejection handler before advancing fake timers to avoid a transient unhandled rejection.
      const requestRejection = expect(pendingRequest).rejects.toThrow("timeout");

      await bodyStarted;
      await vi.advanceTimersByTimeAsync(timeoutMs);
      await requestRejection;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(readResponse).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains rejected asynchronous status callbacks", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await dispatchSwapStatusUpdate(
        () => Promise.reject(new Error("database write failed")),
        { mappedStatus: "PAID" }
      );
      expect(warning).toHaveBeenCalledWith(
        "[satsrouting] status update failed:",
        "database write failed"
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("contains synchronous status callback exceptions", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        dispatchSwapStatusUpdate(() => {
          throw new Error("synchronous callback failure");
        }, {})
      ).resolves.toBeUndefined();
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("detects expired swaps whose on-chain lockup still needs refunding", () => {
    expect(hasSubmarineLockupTransaction({ transaction: { id: "txid" } })).toBe(true);
    expect(hasSubmarineLockupTransaction({ transaction: { hex: "020000..." } })).toBe(true);
    expect(hasSubmarineLockupTransaction({ status: "swap.expired" })).toBe(false);
  });
});
