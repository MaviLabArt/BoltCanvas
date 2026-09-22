import fs from "fs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DB_PATH } from "./helpers.js";

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
