import { afterEach, expect, it, vi } from "vitest";
import { fetchEventsOnce } from "./comments-core.js";
import { fetchProfilesForEvents } from "./profiles.js";

vi.mock("./comments-core.js", () => ({ fetchEventsOnce: vi.fn() }));
afterEach(() => vi.useRealTimers());

it("shares concurrent requests, caches results, and refreshes after a minute", async () => {
  vi.useFakeTimers();
  fetchEventsOnce.mockResolvedValue([{ pubkey: "alice", content: '{"name":"Alice"}', created_at: 1 }]);
  const events = [{ pubkey: "alice" }];
  const results = await Promise.all([
    fetchProfilesForEvents(events, ["wss://one"]),
    fetchProfilesForEvents(events, ["wss://one"])
  ]);
  expect(results[0].alice.name).toBe("Alice");
  expect(fetchEventsOnce).toHaveBeenCalledTimes(1);
  await fetchProfilesForEvents(events, ["wss://one"]);
  expect(fetchEventsOnce).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60_001);
  await fetchProfilesForEvents(events, ["wss://one"]);
  expect(fetchEventsOnce).toHaveBeenCalledTimes(2);
  await fetchProfilesForEvents(events, ["wss://two"]);
  expect(fetchEventsOnce).toHaveBeenCalledTimes(3);
});
