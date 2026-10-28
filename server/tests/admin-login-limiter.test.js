import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminLoginLimiter } from "../admin-login-limiter.js";

describe("admin login rate limiter", () => {
  let app;
  let clock;
  let limiter;

  beforeEach(() => {
    clock = 1_800_000_000_000;
    limiter = createAdminLoginLimiter({
      now: () => clock,
      getClientKey: (req) => req.get("x-test-client") || "client-a",
      maxAttempts: 5,
      windowMs: 15 * 60 * 1000,
      blockMs: 15 * 60 * 1000,
    });

    app = express();
    app.use(express.json());

    app.post("/login", limiter.middleware, (req, res) => {
      if (req.body?.pin !== "0000") {
        limiter.recordFailure(req);
        return res.status(401).json({ ok: false, error: "Invalid PIN" });
      }

      limiter.reset(req);
      return res.json({ ok: true });
    });
  });

  it("blocks after five incorrect PIN attempts", async () => {
    for (let i = 0; i < 5; i += 1) {
      const response = await request(app)
        .post("/login")
        .send({ pin: "wrong" });

      expect(response.status).toBe(401);
    }

    const blocked = await request(app)
      .post("/login")
      .send({ pin: "0000" });

    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("900");
  });

  it("allows login again after the block expires", async () => {
    for (let i = 0; i < 5; i += 1) {
      await request(app).post("/login").send({ pin: "wrong" });
    }

    clock += 15 * 60 * 1000;

    const response = await request(app)
      .post("/login")
      .send({ pin: "0000" });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it("tracks clients independently", async () => {
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post("/login")
        .set("x-test-client", "client-a")
        .send({ pin: "wrong" });
    }

    const otherClient = await request(app)
      .post("/login")
      .set("x-test-client", "client-b")
      .send({ pin: "0000" });

    expect(otherClient.status).toBe(200);
  });

  it("clears failures after a successful login", async () => {
    for (let i = 0; i < 4; i += 1) {
      await request(app).post("/login").send({ pin: "wrong" });
    }

    const successful = await request(app)
      .post("/login")
      .send({ pin: "0000" });

    expect(successful.status).toBe(200);

    for (let i = 0; i < 4; i += 1) {
      const response = await request(app)
        .post("/login")
        .send({ pin: "wrong" });

      expect(response.status).toBe(401);
    }
  });
});
