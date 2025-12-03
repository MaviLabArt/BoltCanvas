// Minimal LNURL bech32 helpers (encode/decode).
import { bech32 } from "bech32";

export function encodeLnurl(url) {
  const words = bech32.toWords(Buffer.from(String(url || ""), "utf8"));
  return bech32.encode("lnurl", words, 1023).toUpperCase();
}

export function decodeLnurl(lnurlStr) {
  const { words } = bech32.decode(String(lnurlStr || "").toLowerCase());
  return Buffer.from(bech32.fromWords(words)).toString("utf8");
}
