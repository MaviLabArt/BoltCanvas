import { buildProductTags, PRODUCT_COMMENT_KIND } from "./comments-core.js";
import { validateEvent, verifyEvent } from "nostr-tools";
import { publishEvent } from "./pool.js";

export async function publishProductComment({
  content,
  productId,
  relays
} = {}) {
  if (!window?.nostr) throw new Error("Login with Nostr to post");

  const trimmed = String(content || "").trim();
  if (!trimmed) throw new Error("Comment is empty");
  const maxCommentLen = 600;
  const safeContent = trimmed.slice(0, maxCommentLen);

  const pubkey = await window.nostr.getPublicKey();

  const unsigned = {
    kind: PRODUCT_COMMENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: buildProductTags({ productId }),
    content: safeContent,
    pubkey
  };

  // Optional local validation before signing
  if (!validateEvent(unsigned)) throw new Error("Invalid comment payload");

  const signed = await window.nostr.signEvent(unsigned);
  if (!verifyEvent(signed)) throw new Error("Signature verification failed");

  await publishEvent(signed, relays);
  return { ok: true, eventId: signed.id };
}
