import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes } from "@noble/hashes/utils";
import { extractProductIdFromTags } from "./comments-core.js";

const HEX64 = /^[0-9a-f]{64}$/i;
const HEX128 = /^[0-9a-f]{128}$/i;

export function buildCommentProofMessage(storePubkey, productId, ts) {
  return `comment-proof:${storePubkey}:${productId}:${ts}`;
}

export function verifyCommentProof(ev, storePubkey) {
  const key = String(storePubkey || "").trim().toLowerCase();
  if (!HEX64.test(key)) return false;
  if (!ev || typeof ev !== "object") return false;
  const tags = Array.isArray(ev.tags) ? ev.tags : [];
  const proofTag = tags.find((t) => Array.isArray(t) && t[0] === "proof");
  if (!proofTag) return false;
  const sig = String(proofTag[1] || "");
  const ts = Number(proofTag[2] || 0);
  if (!HEX128.test(sig) || !Number.isFinite(ts) || ts <= 0) return false;
  const productId = extractProductIdFromTags(tags);
  if (!productId) return false;
  const msg = buildCommentProofMessage(key, productId, ts);
  try {
    return !!schnorr.verify(sig, sha256(utf8ToBytes(msg)), key);
  } catch {
    return false;
  }
}
