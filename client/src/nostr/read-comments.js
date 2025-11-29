import {
  dedupeAndSort,
  fetchEventsOnce,
  productCommentsFilters,
  recentProductCommentsFilters,
  subscribeEvents
} from "./comments-core.js";

export async function fetchProductComments({ productId, relays, limit = 50, since, until } = {}) {
  const filters = productCommentsFilters({ productId, limit, since, until });
  // eslint-disable-next-line no-console
  console.debug("[comments] fetchProductComments", { productId, relays, filters });
  const events = await fetchEventsOnce(relays, filters);
  return dedupeAndSort(events);
}

export async function fetchRecentProductComments({ relays, limit = 10, since } = {}) {
  const filters = recentProductCommentsFilters({ limit, since });
  const events = await fetchEventsOnce(relays, filters);
  return dedupeAndSort(events);
}

export function subscribeToProductComments({ productId, relays, since, onEvent, onEose } = {}) {
  const filters = productCommentsFilters({ productId, since });
  // eslint-disable-next-line no-console
  console.debug("[comments] subscribeToProductComments", { productId, relays, filters });
  return subscribeEvents(relays, filters, { onEvent, onEose });
}
