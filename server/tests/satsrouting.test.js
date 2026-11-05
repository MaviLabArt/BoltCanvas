import { describe, expect, it } from "vitest";
import {
  assertSubmarineAmount,
  buildBip21,
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

  it("detects expired swaps whose on-chain lockup still needs refunding", () => {
    expect(hasSubmarineLockupTransaction({ transaction: { id: "txid" } })).toBe(true);
    expect(hasSubmarineLockupTransaction({ transaction: { hex: "020000..." } })).toBe(true);
    expect(hasSubmarineLockupTransaction({ status: "swap.expired" })).toBe(false);
  });
});
