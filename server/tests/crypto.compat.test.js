import { expect, it, vi } from "vitest";
import { createECDH } from "node:crypto";
import { deriveRefundKey } from "../boltz.js";
import { BIP32Factory } from "bip32";
import * as ecc from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";

it("serializes deterministic refund keys as usable hex", () => {
  const options = { mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" };
  const key = deriveRefundKey(0, options);
  expect(key.refundPrivateKey).toMatch(/^[0-9a-f]{64}$/);
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(key.refundPrivateKey, "hex"));
  expect(ecdh.getPublicKey("hex", "compressed")).toBe(key.refundPublicKey);
  expect(deriveRefundKey(0, options)).toEqual(key);
});

it("creates an XPUB payment with the expected derived address", async () => {
  const account = BIP32Factory(ecc).fromSeed(Buffer.alloc(32, 1)).neutered();
  vi.stubEnv("ONCHAIN_XPUB", account.toBase58());
  vi.stubEnv("ONCHAIN_XPUB_ADDRESS_TYPE", "p2pkh");
  vi.stubEnv("ONCHAIN_XPUB_NETWORK", "mainnet");
  try {
    const { createOnchainPayment } = await import("../onchain/xpub.js");
    const payment = await createOnchainPayment({ orderId: "compat", amountSats: 100000 });
    const expected = bitcoin.payments.p2pkh({ pubkey: account.derive(0).derive(payment.xpubIndex).publicKey }).address;
    expect(payment.onchainAddress).toBe(expected);
  } finally { vi.unstubAllEnvs(); }
});

it("signs comment proofs and rejects tampered product IDs", async () => {
  vi.stubEnv("SHOP_NOSTR_SECRET_HEX", "01".repeat(32));
  try {
    const { makeCommentProof, verifyCommentProof } = await import("../nostr.js");
    const proof = makeCommentProof({ productId: "compat-product" });
    expect(verifyCommentProof({ ...proof, productId: "compat-product" })).toBe(true);
    expect(verifyCommentProof({ ...proof, productId: "different" })).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});
