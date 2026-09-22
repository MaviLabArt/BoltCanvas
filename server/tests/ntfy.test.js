import { expect, it, vi } from "vitest";
import { createNtfySender } from "../ntfy.js";

const message = { key: "paid:order1", title: "Payment received ✅", tags: "receipt", body: "Order paid" };
function sender(fetchImpl) {
  return createNtfySender({ url: "https://example.com", topic: "shop", priority: "high", fetchImpl });
}

it("detects HTTP errors, permits retry, and remembers successful delivery", async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }).mockResolvedValue({ ok: true });
  const send = sender(fetchImpl);
  expect(await send(message)).toBe(false);
  expect(await send(message)).toBe(true);
  expect(await send(message)).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const options = fetchImpl.mock.calls[0][1];
  expect(JSON.parse(options.body)).toMatchObject({ topic: "shop", title: message.title, priority: 4 });
  expect(options.signal).toBeInstanceOf(AbortSignal);
});

it("shares concurrent requests and permits retry after a network failure", async () => {
  const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true });
  const send = sender(fetchImpl);
  expect(await Promise.all([send(message), send(message)])).toEqual([false, false]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(await send(message)).toBe(true);
});
