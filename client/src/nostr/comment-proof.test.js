import { expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { buildCommentProofMessage, verifyCommentProof } from "./comment-proof.js";

it("accepts a valid hex proof and rejects a modified signature", () => {
  const secret = new Uint8Array(32).fill(1);
  const pubkey = bytesToHex(schnorr.getPublicKey(secret));
  const ts = 1700000000;
  const msg = buildCommentProofMessage(pubkey, "product1", ts);
  const sig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(msg)), secret));
  const event = { tags: [["x", `${pubkey}:product:product1`], ["proof", sig, String(ts)]] };
  expect(verifyCommentProof(event, pubkey)).toBe(true);
  event.tags[1][1] = "00".repeat(64);
  expect(verifyCommentProof(event, pubkey)).toBe(false);
});
