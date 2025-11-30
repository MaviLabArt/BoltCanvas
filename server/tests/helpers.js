import fs from "fs";
import path from "path";
import { vi } from "vitest";

export const DB_PATH = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(process.cwd(), "test-shop.sqlite");

export async function freshDb() {
  if (fs.existsSync(DB_PATH)) {
    fs.rmSync(DB_PATH);
  }
  vi.resetModules();
  return import("../db.js");
}
