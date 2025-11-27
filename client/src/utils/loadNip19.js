let cachedPromise = null;

export function loadNip19() {
  if (!cachedPromise) {
    cachedPromise = import("nostr-tools/nip19");
  }
  return cachedPromise;
}
