import { fetchEventsOnce } from "./comments-core.js";

export async function fetchProfilesForEvents(events, relays) {
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
