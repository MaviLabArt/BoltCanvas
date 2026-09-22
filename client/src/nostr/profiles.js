import { fetchEventsOnce } from "./comments-core.js";

const requests = new Map();
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 100;

export async function fetchProfilesForEvents(events, relays) {
  const pubkeys = [...new Set((events || []).map((e) => e.pubkey).filter(Boolean))].sort();
  if (!pubkeys.length) return {};
  const key = JSON.stringify([relays, pubkeys]);
  const cached = requests.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const entry = { expiresAt: Date.now() + CACHE_TTL_MS };
  entry.promise = loadProfiles(events, relays).catch((error) => {
    if (requests.get(key) === entry) requests.delete(key);
    throw error;
  });
  requests.delete(key);
  requests.set(key, entry);
  if (requests.size > MAX_CACHE_ENTRIES) requests.delete(requests.keys().next().value);
  return entry.promise;
}

async function loadProfiles(events, relays) {
  const pubkeys = Array.from(
    new Set((events || []).map((e) => e.pubkey).filter(Boolean))
  );
  if (!pubkeys.length) return {};

  const profileEvents = await fetchEventsOnce(
    relays,
    [{
      kinds: [0],
      authors: pubkeys,
      limit: pubkeys.length
    }]
  );

  const profiles = {};
  for (const ev of profileEvents) {
    try {
      const json = JSON.parse(ev.content || "{}");
      const existing = profiles[ev.pubkey];
      if (!existing || (ev.created_at || 0) > (existing._createdAt || 0)) {
        profiles[ev.pubkey] = { ...json, _createdAt: ev.created_at };
      }
    } catch {
      // ignore malformed metadata
    }
  }
  for (const pk of Object.keys(profiles)) {
    delete profiles[pk]._createdAt;
  }
  return profiles;
}
