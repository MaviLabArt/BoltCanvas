import { describe, expect, it } from "vitest";

describe("utils", () => {
  it("makeId returns unique, non-empty values", async () => {
    const { makeId } = await import("../utils.js");
    const a = makeId();
    const b = makeId();
    expect(a).toBeTypeOf("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it("simpleHash is deterministic", async () => {
    const { simpleHash } = await import("../utils.js");
    const one = simpleHash("hello");
    const two = simpleHash("hello");
    const other = simpleHash("world");
    expect(one).toBe(two);
    expect(other).not.toBe(one);
  });

  it("now approximates Date.now", async () => {
    const { now } = await import("../utils.js");
    const before = Date.now();
    const value = now();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });
});
