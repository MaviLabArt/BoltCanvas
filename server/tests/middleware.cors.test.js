import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeCors } from "../middleware.js";

const allowedOrigin = "https://isolabellart.it.com";

function createApp() {
  const app = express();
  app.use(makeCors([
    allowedOrigin,
    "https://shop.isolabellart.it.com"
  ]));
  app.get("/test", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("CORS origin allowlist", () => {
  it("allows a configured origin with credentials", async () => {
    const response = await request(createApp())
      .get("/test")
      .set("Origin", allowedOrigin)
      .expect(200);

    expect(response.headers["access-control-allow-origin"])
      .toBe(allowedOrigin);
    expect(response.headers["access-control-allow-credentials"])
      .toBe("true");
  });

  it("does not grant CORS access to an unconfigured origin", async () => {
    const response = await request(createApp())
      .get("/test")
      .set("Origin", "https://untrusted.example")
      .expect(200);

    expect(response.headers["access-control-allow-origin"])
      .toBeUndefined();
  });

  it("continues to serve requests without an Origin header", async () => {
    const response = await request(createApp())
      .get("/test")
      .expect(200);

    expect(response.body).toEqual({ ok: true });
    expect(response.headers["access-control-allow-origin"])
      .toBeUndefined();
  });
});
