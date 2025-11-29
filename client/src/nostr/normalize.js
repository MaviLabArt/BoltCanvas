import { nip19 } from "nostr-tools";
import { extractProductIdFromTags } from "./comments-core.js";

export function normalizeComments(events, profiles = {}) {
  return (events || []).map((ev) => {
    const profile = profiles[ev.pubkey] || null;
    let npub = "";
    try {
      npub = nip19.npubEncode(ev.pubkey);
    } catch {}
    const shortNpub = npub
      ? `${npub.slice(0, 8)}…${npub.slice(-6)}`
      : `${(ev.pubkey || "").slice(0, 8)}…${(ev.pubkey || "").slice(-6)}`;

    return {
      id: ev.id,
      pubkey: ev.pubkey,
      npub,
      shortNpub,
      content: ev.content,
      createdAt: ev.created_at,
      tags: ev.tags || [],
      productId: extractProductIdFromTags(ev.tags),
      profile: profile ? {
        name: profile.display_name || profile.name || "",
        picture: profile.picture || "",
        nip05: profile.nip05 || ""
      } : null
    };
  });
}
