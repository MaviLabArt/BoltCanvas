import fs from "fs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nip19 } from "nostr-tools";
import { DB_PATH } from "./helpers.js";

vi.mock("../nostr.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchNostrEventByNevent: vi.fn(),
    fetchProfile: vi.fn(async () => ({ name: "Test author" })),
    relaysFrom: vi.fn(() => [])
  };
});

async function loadApp() {
  if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);
  vi.resetModules();
  const mod = await import("../index.js");
  return mod.app;
}

describe("public Nostr testimonials", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns more than 12 configured testimonials", async () => {
    const app = await loadApp();
    const { Settings } = await import("../db.js");
    const nostr = await import("../nostr.js");

    const identifiers = Array.from({ length: 22 }, (_, index) =>
      nip19.neventEncode({
        id: (index + 1).toString(16).padStart(64, "0"),
        author: "a".repeat(64),
        kind: 1,
        relays: []
      })
    );

    Settings.setAll({ nostrTestimonials: identifiers.join("\n") });

    nostr.fetchNostrEventByNevent.mockImplementation(async (identifier) => {
      const decoded = nip19.decode(identifier);
      return {
        id: decoded.data.id,
        pubkey: "a".repeat(64),
        content: `Test testimonial ${decoded.data.id}`,
        created_at: 1,
        tags: []
      };
    });

    const res = await request(app).get("/api/public/nostr-testimonials");

    expect(res.status).toBe(200);
    expect(res.body.testimonials).toHaveLength(22);
    expect(nostr.fetchNostrEventByNevent).toHaveBeenCalledTimes(22);
  });
});
