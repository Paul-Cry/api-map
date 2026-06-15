import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = dirname(fileURLToPath(new URL("../app.js", import.meta.url)));
export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || "0.0.0.0";
export const DATA_DIR = join(ROOT_DIR, "data");
export const UPLOADS_DIR = join(ROOT_DIR, "uploads");
export const DB_PATH = process.env.DB_PATH || join(DATA_DIR, "app.sqlite");
export const MAX_BODY_SIZE = 25 * 1024 * 1024;
export const SESSION_COOKIE = "listing_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
