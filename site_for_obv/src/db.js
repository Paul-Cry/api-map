import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { DATA_DIR, DB_PATH, UPLOADS_DIR } from "./config.js";

let db;

export async function initializeDatabase() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOADS_DIR, { recursive: true });

  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listing_meta (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      updated_at TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS listings (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      price TEXT,
      address TEXT,
      metro TEXT,
      terms TEXT,
      description TEXT,
      url TEXT,
      grade TEXT,
      score REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      monthly REAL NOT NULL DEFAULT 0,
      deposit REAL NOT NULL DEFAULT 0,
      commission REAL NOT NULL DEFAULT 0,
      utilities REAL NOT NULL DEFAULT 0,
      commute_home TEXT,
      commute_work TEXT,
      raw_json TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS favorite_listings (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      listing_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, listing_key)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_listings_user_id ON listings(user_id, position);
    CREATE INDEX IF NOT EXISTS idx_favorite_listings_user_id ON favorite_listings(user_id, created_at);
  `);
  db.exec(`
    DELETE FROM listings
    WHERE row_id NOT IN (
      SELECT MIN(row_id)
      FROM listings
      GROUP BY user_id, external_id
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_user_external_id
      ON listings(user_id, external_id);
  `);
}

export function getDb() {
  if (!db) throw new Error("Database is not initialized");
  return db;
}
