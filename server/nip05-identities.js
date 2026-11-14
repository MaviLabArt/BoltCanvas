const USERNAME_RE = /^[a-z0-9._-]{1,64}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/i;

export function normalizeNip05Username(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const localPart = raw.includes("@") ? raw.slice(0, raw.indexOf("@")) : raw;
  const username = localPart.trim().toLowerCase();
  return USERNAME_RE.test(username) ? username : "";
}

function parseAdditionalIdentities(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeRelays(value) {
  const relays = Array.isArray(value) ? value : [];
  return Array.from(new Set(
    relays
      .map((relay) => String(relay || "").trim())
      .filter((relay) => /^wss?:\/\//i.test(relay))
  ));
}

export async function buildNip05Response({
  settings = {},
  requestedName = "",
  resolvePubkey,
  relays = []
} = {}) {
  const s = settings && typeof settings === "object" ? settings : {};
  const requestedValue = String(requestedName ?? "").trim();
  const hasRequestedName = requestedValue.length > 0;
  const requested = normalizeNip05Username(requestedValue);
  const resolve = typeof resolvePubkey === "function" ? resolvePubkey : async () => "";
  const entries = [];
  const seenNames = new Set();

  const addIdentity = async (rawName, rawKey) => {
    const name = normalizeNip05Username(rawName);
    const identifier = String(rawKey || "").trim();
    if (!name || !identifier || seenNames.has(name)) return;

    let pubkey = "";
    try {
      pubkey = String(await resolve(identifier) || "").trim().toLowerCase();
    } catch {
      return;
    }
    if (!PUBKEY_RE.test(pubkey)) return;

    seenNames.add(name);
    entries.push({ name, pubkey });
  };

  // Preserve the existing single-identity settings and fallback behavior.
  const primaryName = normalizeNip05Username(s.nostrNip05) || (!String(s.nostrNip05 || "").trim() ? requested : "");
  await addIdentity(primaryName, s.nostrNpub);

  // Aliases are resolved only for explicit name lookups.
  if (hasRequestedName) {
    for (const identity of parseAdditionalIdentities(s.nostrAdditionalNip05Identities)) {
      if (!identity || typeof identity !== "object") continue;
      const name = identity.name ?? identity.username ?? identity.nip05 ?? "";
      const key = identity.npub ?? identity.pubkey ?? identity.publicKey ?? "";
      await addIdentity(name, key);
    }
  }

  // Without ?name=, preserve the legacy single-primary response.
  const selected = hasRequestedName
    ? (requested ? entries.filter((entry) => entry.name === requested) : [])
    : entries.filter((entry) => entry.name === normalizeNip05Username(s.nostrNip05));

  const names = Object.fromEntries(selected.map(({ name, pubkey }) => [name, pubkey]));
  const relayUrls = normalizeRelays(relays);
  const relayMap = {};
  if (relayUrls.length) {
    for (const { pubkey } of selected) relayMap[pubkey] = relayUrls;
  }

  return Object.keys(relayMap).length ? { names, relays: relayMap } : { names };
}
