import {
  dedupeAndSort,
  fetchEventsOnce,
  productCommentsFilters,
  recentProductCommentsFilters,
  subscribeEvents
} from "./comments-core.js";
import { verifyCommentProof } from "./comment-proof.js";

function filterForStore(events, storePubkey) {
  if (!storePubkey) return events || [];
  return (events || []).filter((ev) => verifyCommentProof(ev, storePubkey));
}

export async function fetchProductComments({ productId, relays, storePubkey, limit = 50, since, until } = {}) {
  const filters = productCommentsFilters({ productId, storePubkey, limit, since, until });
  // eslint-disable-next-line no-console
  console.debug("[comments] fetchProductComments", { productId, relays, filters });
  const events = await fetchEventsOnce(relays, filters);
  return dedupeAndSort(filterForStore(events, storePubkey));
}

export async function fetchRecentProductComments({ relays, storePubkey, limit = 10, since } = {}) {
  const filters = recentProductCommentsFilters({ storePubkey, limit, since });
  const events = await fetchEventsOnce(relays, filters);
  return dedupeAndSort(filterForStore(events, storePubkey));
}

export function subscribeToProductComments({ productId, relays, storePubkey, since, onEvent, onEose } = {}) {
  const filters = productCommentsFilters({ productId, storePubkey, since });
  // eslint-disable-next-line no-console
  console.debug("[comments] subscribeToProductComments", { productId, relays, filters });
  return subscribeEvents(relays, filters, {
    onEvent: (ev, url) => {
      if (storePubkey && !verifyCommentProof(ev, storePubkey)) return;
      onEvent?.(ev, url);
    },
    onEose
  });
}
