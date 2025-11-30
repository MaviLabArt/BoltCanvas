import { describe, expect, it } from "vitest";
import { formatSats } from "./format.js";

describe("formatSats", () => {
  it("formats integers with grouping", () => {
    expect(formatSats(1234567)).toBe("1,234,567");
    expect(formatSats("9999")).toBe("9,999");
  });

  it("returns empty string for non-numeric input", () => {
    expect(formatSats("abc")).toBe("");
    expect(formatSats(undefined)).toBe("");
  });
});
