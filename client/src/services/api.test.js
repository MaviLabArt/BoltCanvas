import { describe, expect, it } from "vitest";
import api, { API_BASE, absoluteApiUrl } from "./api.js";

describe("API_BASE", () => {
  it("defaults to /api in tests", () => {
    expect(API_BASE).toBe("/api");
  });
});

describe("absoluteApiUrl", () => {
  it("leaves absolute URLs untouched", () => {
    expect(absoluteApiUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(absoluteApiUrl("data:image/png;base64,aaa")).toBe("data:image/png;base64,aaa");
  });

  it("prepends the API base for relative paths", () => {
    expect(absoluteApiUrl("/hello")).toBe("/api/hello");
    expect(absoluteApiUrl("hello/world")).toBe("/api/hello/world");
  });

  it("avoids duplicating /api prefix", () => {
    expect(absoluteApiUrl("/api/health")).toBe("/api/health");
  });
});

describe("api client", () => {
  it("is configured with the API base and credentials", () => {
    expect(api.defaults.baseURL).toBe(API_BASE);
    expect(api.defaults.withCredentials).toBe(true);
  });
});
