import { expect, it, vi } from "vitest";
import { createBufferCache } from "../buffer-cache.js";

it("shares concurrent work and caches successful results", async () => {
  const cache = createBufferCache(8);
  const produce = vi.fn(async () => Buffer.from("image"));
  const values = await Promise.all([cache("v1", produce), cache("v1", produce)]);
  expect(values[0]).toEqual(values[1]);
  await cache("v1", produce);
  expect(produce).toHaveBeenCalledTimes(1);
  await cache("v2", produce);
  await cache("v1", produce);
  expect(produce).toHaveBeenCalledTimes(3);
});

it("does not retain failures or buffers larger than its budget", async () => {
  const cache = createBufferCache(2);
  const produce = vi.fn().mockRejectedValueOnce(new Error("bad image")).mockResolvedValue(Buffer.from("large"));
  await expect(cache("x", produce)).rejects.toThrow("bad image");
  await cache("x", produce);
  await cache("x", produce);
  expect(produce).toHaveBeenCalledTimes(3);
});
