import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { Relay } from "nostr-tools/relay";
import { resolveRelays } from "./config.js";

const RELAY_TIMEOUT_MS = 10000;

// WebSocket logger to trace REQ/EVENT frames (helpful when the UI shows no comments).
function LoggingWebSocket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  const origSend = ws.send.bind(ws);
  ws.send = (data) => {
    try {
      const parsed = JSON.parse(data);
      // eslint-disable-next-line no-console
      console.debug("[nostr WS SEND]", url, parsed);
    } catch {
      // eslint-disable-next-line no-console
      console.debug("[nostr WS SEND RAW]", url, data);
    }
    return origSend(data);
  };
  ws.addEventListener("message", (ev) => {
    try {
      const parsed = JSON.parse(ev.data);
      // eslint-disable-next-line no-console
      console.debug("[nostr WS RECV]", url, parsed);
    } catch {
      // eslint-disable-next-line no-console
      console.debug("[nostr WS RECV RAW]", url, ev.data);
    }
  });
  return ws;
}

// Ensure nostr-tools uses our logging wrapper (avoids monkey-patching races).
useWebSocketImplementation(LoggingWebSocket);

function createNostrPool(options = {}) {
  const pool = new SimplePool({ enableReconnect: true, ...options });

  async function fetchEventsOnce(relays, filters) {
    const filterArray = Array.isArray(filters) ? filters : [filters];
    // eslint-disable-next-line no-console
    console.debug("[nostr fetchEventsOnce]", { relays, filters: filterArray });

    // Prefer querySync; if multiple filters, fetch each and merge.
    if (typeof pool.querySync === "function") {
      if (filterArray.length === 1) {
        return pool.querySync(relays, filterArray[0]);
      }
      const results = await Promise.all(
        filterArray.map((f) => pool.querySync(relays, f).catch(() => []))
      );
      return Array.from(new Map(results.flat().map((ev) => [ev.id, ev])).values());
    }
    // Fallback to list if available
    if (typeof pool.list === "function") {
      return pool.list(relays, filterArray);
    }
    return fetchEventsOnceFallback(relays, filterArray);
  }

  function subscribeEvents(relays, filters, { onEvent, onEose } = {}) {
    const filterArray = Array.isArray(filters) ? filters : [filters];
    // eslint-disable-next-line no-console
    console.debug("[nostr subscribeEvents]", { relays, filters: filterArray });

    if (typeof pool.subscribeMany === "function" && filterArray.length > 1) {
      const sub = pool.subscribeMany(relays, filterArray, {
        onevent: (ev, url) => onEvent?.(ev, url),
        oneose: (url) => onEose?.(url)
      });
      return { close: () => sub.close() };
    }

    if (typeof pool.subscribe === "function") {
      const targetFilter = filterArray.length === 1 ? filterArray[0] : filterArray;
      const sub = pool.subscribe(relays, targetFilter, {
        onevent: (ev, url) => onEvent?.(ev, url),
        oneose: (url) => onEose?.(url)
      });
      return { close: () => sub.close() };
    }

    return subscribeEventsFallback(relays, filterArray, { onEvent, onEose });
  }

  async function publishEvent(relays, event) {
    if (typeof pool.publish === "function") {
      const result = pool.publish(relays, event);

      if (result && typeof result[Symbol.iterator] === "function") {
        const promises = Array.from(result);
        const settled = await Promise.allSettled(promises);
        const ok = [];
        const failed = [];
        settled.forEach((r, i) => {
          const relay = relays[i];
          if (r.status === "fulfilled") ok.push(relay);
          else failed.push({ relay, error: r.reason });
        });
        if (!ok.length) throw new Error("Publish failed on all relays");
        return { ok, failed };
      }

      if (result && typeof result.on === "function") {
        return new Promise((resolve, reject) => {
          const ok = [];
          const failed = [];
          let resolved = false;
          const timer = setTimeout(() => {
            if (!resolved) reject(new Error("Publish timed out"));
          }, RELAY_TIMEOUT_MS);
          result.on("ok", (relay) => {
            if (resolved) return;
            ok.push(relay);
            resolved = true;
            clearTimeout(timer);
            resolve({ ok, failed });
          });
          result.on("failed", (relay, reason) => {
            failed.push({ relay, error: reason });
          });
        });
      }
    }
    return publishEventFallback(relays, event);
  }

  return { fetchEventsOnce, subscribeEvents, publishEvent };
}

async function fetchEventsOnceFallback(relays, filters) {
  const eventsById = new Map();
  await Promise.all(
    relays.map(async (url) => {
      try {
        const relay = await Relay.connect(url);
        await new Promise((resolve) => {
          const sub = relay.subscribe(filters, {
            onevent(ev) {
              eventsById.set(ev.id, ev);
            },
            oneose() {
              sub.close();
              relay.close();
              resolve();
            }
          });
          setTimeout(() => {
            sub.close();
            relay.close();
            resolve();
          }, RELAY_TIMEOUT_MS);
        });
      } catch (err) {
        console.warn("[nostr] fetch fallback relay error", url, err);
      }
    })
  );
  return Array.from(eventsById.values());
}

function subscribeEventsFallback(relays, filters, { onEvent, onEose } = {}) {
  const subs = [];
  let closed = false;
  (async () => {
    for (const url of relays) {
      try {
        const relay = await Relay.connect(url);
        const sub = relay.subscribe(filters, {
          onevent(ev) {
            onEvent?.(ev, relay.url);
          },
          oneose() {
            onEose?.(relay.url);
          }
        });
        subs.push({ relay, sub });
      } catch (err) {
        console.warn("[nostr] subscribe fallback relay error", url, err);
      }
    }
  })();

  return {
    close() {
      if (closed) return;
      closed = true;
      subs.forEach(({ relay, sub }) => {
        try { sub.close(); } catch {}
        try { relay.close(); } catch {}
      });
    }
  };
}

async function publishEventFallback(relays, event) {
  const results = await Promise.allSettled(
    relays.map(async (url) => {
      const relay = await Relay.connect(url);
      await relay.publish(event);
      try { relay.close(); } catch {}
      return url;
    })
  );
  const ok = [];
  const failed = [];
  results.forEach((r, i) => {
    const relay = relays[i];
    if (r.status === "fulfilled") ok.push(relay);
    else failed.push({ relay, error: r.reason });
  });
  if (!ok.length) throw new Error("Publish failed on all relays");
  return { ok, failed };
}

const internalPool = createNostrPool();

export function fetchEventsOnce(relays, filters) {
  return internalPool.fetchEventsOnce(resolveRelays(relays), filters);
}

export function subscribeEvents(relays, filters, opts) {
  return internalPool.subscribeEvents(resolveRelays(relays), filters, opts);
}

export function publishEvent(event, relays) {
  return internalPool.publishEvent(resolveRelays(relays), event);
}

export { resolveRelays };
