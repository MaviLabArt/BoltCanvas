import fs from "fs";
import path from "path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

const SHOP_KEY_ENV = [
  "SHOP_NOSTR_NSEC",
  "NOSTR_NSEC",
  "SHOP_NOSTR_SECRET_HEX",
  "NOSTR_SECRET_HEX"
];
const TEST_DB_PATH = path.join(process.cwd(), ".tmp-nostr-comments-readonly-" + process.pid + ".sqlite");

async function runWithIsolatedApp(serverSecretHex, assertion) {
  const previousKeys = Object.fromEntries(SHOP_KEY_ENV.map((name) => [name, process.env[name]]));
  const previousDbFile = process.env.DB_FILE;
  for (const name of SHOP_KEY_ENV) delete process.env[name];
  if (serverSecretHex) process.env.SHOP_NOSTR_SECRET_HEX = serverSecretHex;
  process.env.DB_FILE = TEST_DB_PATH;

  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.rmSync(TEST_DB_PATH);
    vi.resetModules();
    const { app } = await import("../index.js");
    await assertion(app);
  } finally {
    for (const name of SHOP_KEY_ENV) {
      if (previousKeys[name] === undefined) delete process.env[name];
      else process.env[name] = previousKeys[name];
    }
    if (previousDbFile === undefined) delete process.env.DB_FILE;
    else process.env.DB_FILE = previousDbFile;
    if (fs.existsSync(TEST_DB_PATH)) fs.rmSync(TEST_DB_PATH);
  }
}

describe("public Nostr product comments", () => {
  it("resolves the configured public npub and marks comments read-only without a server key", async () => {
    const pubkey = getPublicKey(generateSecretKey());
    const npub = nip19.npubEncode(pubkey);

    await runWithIsolatedApp("", async (app) => {
      const { Settings } = await import("../db.js");
      Settings.setAll({ nostrNpub: npub, nostrCommentsEnabled: true });

      const res = await request(app).get("/api/public-settings");
      expect(res.status).toBe(200);
      expect(res.body.nostrNpub).toBe(npub);
      expect(res.body.nostrShopPubkey).toBe(pubkey);
      expect(res.body.nostrCommentsReadOnly).toBe(true);
    });
  });

  it("keeps comments writable when a valid server key is configured", async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const secretHex = Buffer.from(secretKey).toString("hex");

    await runWithIsolatedApp(secretHex, async (app) => {
      const res = await request(app).get("/api/public-settings");
      expect(res.status).toBe(200);
      expect(res.body.nostrShopPubkey).toBe(pubkey);
      expect(res.body.nostrCommentsReadOnly).toBe(false);
    });
  });
});
