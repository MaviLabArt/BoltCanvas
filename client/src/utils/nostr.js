// client/src/utils/nostr.js
// Lightweight helpers to analyze/format user-provided Nostr identifiers for UI/UX.
// NOTE: This is format checking only (no network lookups). Security/verification is out of scope.

import { nip19 } from "nostr-tools";

const HEX64 = /^[0-9a-f]{64}$/i;
const NIP05_RE = /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/**
 * Analyze a Nostr identifier string that may be npub, nprofile, 64-hex, or NIP-05 (name@domain).
 * Returns an object suitable for driving form UX.
 */
export function analyzeNostrIdentifier(value) {
  const s = String(value || "").trim();
  if (!s) {
    return { valid: false, type: "empty", normalized: "", display: "", reason: "Empty" };
  }

  // npub / nprofile (bech32)
  if (s.startsWith("npub") || s.startsWith("nprofile")) {
    try {
      const dec = nip19.decode(s);
      const type = dec.type;
      let pubkey = "";
      if (type === "npub") pubkey = String(dec.data || "");
      else if (type === "nprofile") {
        if (typeof dec.data === "string") pubkey = dec.data;
               else if (dec.data && dec.data.pubkey) pubkey = String(dec.data.pubkey);
      }
      if (pubkey && HEX64.test(pubkey)) {
        const npub = s.startsWith("npub") ? s : nip19.npubEncode(pubkey);
        return { valid: true, type, pubkey, normalized: npub, display: shortNpub(npub) };
      }
      return { valid: false, type, normalized: "", display: "", reason: "Invalid bech32 payload" };
    } catch {
      return { valid: false, type: "bech32", normalized: "", display: "", reason: "Invalid npub/nprofile" };
    }
  }

  // NIP-05 name@domain
  if (s.includes("@")) {
    const ok = NIP05_RE.test(s);
    return {
      valid: ok,
      type: "nip05",
      normalized: s.toLowerCase(),
      display: s.toLowerCase(),
      reason: ok ? "" : "Invalid NIP-05 format",
    };
  }

  // 64-hex
  if (HEX64.test(s)) {
    const hex = s.toLowerCase();
    const npub = safeEncode(hex);
    return { valid: true, type: "hex", pubkey: hex, normalized: npub, display: shortNpub(npub) };
  }

  return { valid: false, type: "unknown", normalized: "", display: "", reason: "Unrecognized format" };
}

function safeEncode(hex) {
  try {
    return nip19.npubEncode(hex);
  } catch {
    return "";
  }
}

export function shortNpub(npub) {
  const f = String(npub || "");
  if (!f) return "";
  if (f.length <= 16) return f;
  return `${f.slice(0, 8)}…${f.slice(-6)}`;
}
