import fs from "fs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DB_PATH } from "./helpers.js";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

async function loadApp() {
  if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);
  vi.resetModules();
  const mod = await import("../index.js");
  return mod.app;
}

describe("http endpoints", () => {
  beforeEach(() => {
    vi.resetModules();
  });


  it("returns an empty list when no Nostr testimonials are configured", async () => {
    const app = await loadApp();
    const res = await request(app).get("/api/public/nostr-testimonials");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ testimonials: [] });
  });

  it("serves health", async () => {
    const app = await loadApp();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  }, 15000);

  it("removes catalog sync routes while retaining teasers and Nostr login", async () => {
    const app = await loadApp();
    for (const path of [
      "/api/admin/nostr/stall/publish",
      "/api/admin/nostr/import",
      "/api/admin/nostr/products/refresh",
      "/api/admin/products/example/nostr/publish"
    ]) {
      expect((await request(app).post(path)).status).toBe(404);
    }
    expect((await request(app).post("/api/admin/products/example/nostr/teaser/publish")).status).toBe(401);
    expect((await request(app).get("/api/nostr/login/challenge")).status).toBe(200);
  });

  it("returns isOwner false when no Nostr user is logged in", async () => {
    const previous = process.env.OWNER_NOSTR_PUBKEY;
    delete process.env.OWNER_NOSTR_PUBKEY;
    try {
      const app = await loadApp();
      const res = await request(app).get("/api/nostr/me");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ pubkey: "", isOwner: false });
    } finally {
      if (previous === undefined) delete process.env.OWNER_NOSTR_PUBKEY;
      else process.env.OWNER_NOSTR_PUBKEY = previous;
    }
  });

  it("identifies the configured Nostr owner after a valid login", async () => {
    const previous = process.env.OWNER_NOSTR_PUBKEY;
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    process.env.OWNER_NOSTR_PUBKEY = pubkey;
    try {
      const app = await loadApp();
      const agent = request.agent(app);
      const host = "shop.test";
      const challengeRes = await agent.get("/api/nostr/login/challenge").set("Host", host);
      expect(challengeRes.status).toBe(200);
      const event = finalizeEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["challenge", challengeRes.body.challenge],
          ["domain", host]
        ],
        content: ""
      }, secretKey);
      const loginRes = await agent.post("/api/nostr/login/verify").set("Host", host).send({ event });
      expect(loginRes.status).toBe(200);
      const me = await agent.get("/api/nostr/me");
      expect(me.status).toBe(200);
      expect(me.body).toEqual({ pubkey, isOwner: true });
    } finally {
      if (previous === undefined) delete process.env.OWNER_NOSTR_PUBKEY;
      else process.env.OWNER_NOSTR_PUBKEY = previous;
    }
  });

  it("denies access to the shipping alert without an owner Nostr session", async () => {
    const app = await loadApp();
    const res = await request(app).get("/api/nostr/shipping-alert");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("returns only the shipping count to the authenticated Nostr owner", async () => {
    const previous = process.env.OWNER_NOSTR_PUBKEY;
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    process.env.OWNER_NOSTR_PUBKEY = pubkey;
    try {
      const app = await loadApp();
      const agent = request.agent(app);
      const host = "shop.test";
      const challengeRes = await agent.get("/api/nostr/login/challenge").set("Host", host);
      expect(challengeRes.status).toBe(200);
      const event = finalizeEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["challenge", challengeRes.body.challenge],
          ["domain", host]
        ],
        content: ""
      }, secretKey);
      const loginRes = await agent.post("/api/nostr/login/verify").set("Host", host).send({ event });
      expect(loginRes.status).toBe(200);

      const res = await agent.get("/api/nostr/shipping-alert");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 0, language: expect.any(String) });
      expect(Object.keys(res.body).sort()).toEqual(["count", "language"]);
    } finally {
      if (previous === undefined) delete process.env.OWNER_NOSTR_PUBKEY;
      else process.env.OWNER_NOSTR_PUBKEY = previous;
    }
  });

  it("does not identify another logged-in Nostr user as the owner", async () => {
    const previous = process.env.OWNER_NOSTR_PUBKEY;
    const ownerPubkey = getPublicKey(generateSecretKey());
    const userSecretKey = generateSecretKey();
    const userPubkey = getPublicKey(userSecretKey);
    process.env.OWNER_NOSTR_PUBKEY = nip19.npubEncode(ownerPubkey);
    try {
      const app = await loadApp();
      const agent = request.agent(app);
      const host = "shop.test";
      const challengeRes = await agent.get("/api/nostr/login/challenge").set("Host", host);
      expect(challengeRes.status).toBe(200);
      const event = finalizeEvent({
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["challenge", challengeRes.body.challenge],
          ["domain", host]
        ],
        content: ""
      }, userSecretKey);
      const loginRes = await agent.post("/api/nostr/login/verify").set("Host", host).send({ event });
      expect(loginRes.status).toBe(200);
      const me = await agent.get("/api/nostr/me");
      expect(me.status).toBe(200);
      expect(me.body).toEqual({ pubkey: userPubkey, isOwner: false });
    } finally {
      if (previous === undefined) delete process.env.OWNER_NOSTR_PUBKEY;
      else process.env.OWNER_NOSTR_PUBKEY = previous;
    }
  });

  it("returns public products", async () => {
    const app = await loadApp();
    const { Products } = await import("../db.js");
    Products.create({
      title: "HTTP Product",
      description: "desc",
      priceSats: 1234,
      images: [PNG_DATA_URL]
    });
    const res = await request(app).get("/api/products");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].title).toBe("HTTP Product");
  });

  it("omits inline images only when URL-only details are requested", async () => {
    const app = await loadApp();
    const { Products } = await import("../db.js");
    const product = Products.create({ title: "Image product", priceSats: 1000, images: [PNG_DATA_URL] });
    const legacy = await request(app).get(`/api/products/${product.id}`);
    const compact = await request(app).get(`/api/products/${product.id}?images=urls`);
    expect(legacy.status).toBe(200);
    expect(legacy.body.images).toHaveLength(1);
    expect(compact.status).toBe(200);
    expect(compact.body.images).toBeUndefined();
    expect(compact.body.imageUrls).toHaveLength(1);
    const image = await request(app).get(compact.body.imageUrls[0]);
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
  });
});
