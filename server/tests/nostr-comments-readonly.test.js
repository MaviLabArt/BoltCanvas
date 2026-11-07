import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

const SHOP_KEY_ENV = [
  "SHOP_NOSTR_NSEC",
  "NOSTR_NSEC",
  "SHOP_NOSTR_SECRET_HEX",
  "NOSTR_SECRET_HEX"
];
const EMPTY_DOTENV_PATH = path.join(os.tmpdir(), "boltcanvas-nostr-comments-empty-" + process.pid + ".env");
const previousDotenvConfigPath = process.env.DOTENV_CONFIG_PATH;
fs.writeFileSync(EMPTY_DOTENV_PATH, "");
process.env.DOTENV_CONFIG_PATH = EMPTY_DOTENV_PATH;
let testDbCounter = 0;

afterAll(() => {
  if (previousDotenvConfigPath === undefined) delete process.env.DOTENV_CONFIG_PATH;
  else process.env.DOTENV_CONFIG_PATH = previousDotenvConfigPath;
  if (fs.existsSync(EMPTY_DOTENV_PATH)) fs.rmSync(EMPTY_DOTENV_PATH);
});

async function runWithIsolatedApp(serverSecretHex, assertion) {
  const previousKeys = Object.fromEntries(SHOP_KEY_ENV.map((name) => [name, process.env[name]]));
  const previousDbFile = process.env.DB_FILE;
  const testDbPath = path.join(os.tmpdir(), "boltcanvas-nostr-comments-" + process.pid + "-" + (++testDbCounter) + ".sqlite");

  for (const name of SHOP_KEY_ENV) process.env[name] = "";
  if (serverSecretHex) process.env.SHOP_NOSTR_SECRET_HEX = serverSecretHex;
  process.env.DB_FILE = testDbPath;

  try {
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
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = testDbPath + suffix;
      if (fs.existsSync(file)) fs.rmSync(file);
    }
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
