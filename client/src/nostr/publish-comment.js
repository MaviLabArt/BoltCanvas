import { buildProductTags, PRODUCT_COMMENT_KIND } from "./comments-core.js";
import { validateEvent, verifyEvent } from "nostr-tools";
import { publishEvent } from "./pool.js";
import api from "../services/api.js";

export async function publishProductComment({
  content,
  productId,
  relays,
  storePubkey,
  coordinates = ""
} = {}) {
  if (!window?.nostr) throw new Error("Login with Nostr to post");
  if (!storePubkey) throw new Error("Store Nostr key missing; comments are disabled");

  const trimmed = String(content || "").trim();
  if (!trimmed) throw new Error("Comment is empty");
  const maxCommentLen = 600;
  const safeContent = trimmed.slice(0, maxCommentLen);

  let proof = null;
  let storeKey = String(storePubkey || "").trim().toLowerCase();
  try {
    const resp = await api.get("/nostr/comment-proof", { params: { productId } });
    if (resp?.data?.ok && resp.data?.proof?.sig && resp.data?.proof?.ts) {
      proof = { sig: resp.data.proof.sig, ts: resp.data.proof.ts };
      storeKey = String(resp.data.storePubkey || storeKey || "").trim().toLowerCase();
    } else {
      throw new Error("No proof");
    }
  } catch (err) {
    throw new Error(err?.response?.data?.error || "Unable to authorize comment for this store");
  }

  const pubkey = await window.nostr.getPublicKey();

  const unsigned = {
    kind: PRODUCT_COMMENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: buildProductTags({ productId, storePubkey: storeKey, proof, coordinates }),
    content: safeContent,
    pubkey
  };

  // Optional local validation before signing
  if (!validateEvent(unsigned)) throw new Error("Invalid comment payload");

  const signed = await window.nostr.signEvent(unsigned);
  if (!verifyEvent(signed)) throw new Error("Signature verification failed");

  await publishEvent(signed, relays);
  // Fire-and-forget server notify (ntfy) if available.
  try { api.post("/nostr/comment/notify", { event: signed }).catch(() => {}); } catch {}
  return { ok: true, eventId: signed.id };
}
