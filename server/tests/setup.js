import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, vi } from "vitest";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "boltcanvas-tests-"));
process.env.DB_FILE = path.join(tmpRoot, "shop.sqlite");
process.env.NODE_ENV = "test";
process.env.ADMIN_PIN = "0000";
process.env.SESSION_SECRET = "test-session-secret";
process.env.ENABLE_WEBHOOKS = "false";

afterEach(() => {
  vi.clearAllMocks();
});
