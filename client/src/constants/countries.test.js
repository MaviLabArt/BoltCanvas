import { describe, expect, it } from "vitest";
import { COUNTRIES, isEurope } from "./countries.js";

describe("countries constants", () => {
  it("includes expected ISO codes", () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(codes).toContain("IT");
    expect(codes).toContain("US");
  });
});

describe("isEurope", () => {
  it("matches European ISO codes", () => {
    expect(isEurope("it")).toBe(true);
    expect(isEurope("GB")).toBe(true);
    expect(isEurope("us")).toBe(false);
  });
});
