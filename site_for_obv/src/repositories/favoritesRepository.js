import { getDb } from "../db.js";

export function getFavoriteKeys(userId) {
  return getDb()
    .prepare(`
      SELECT listing_key AS key
      FROM favorite_listings
      WHERE user_id = ?
      ORDER BY created_at ASC
    `)
    .all(userId)
    .map((row) => row.key);
}

export function addFavoriteKey(userId, key, createdAt) {
  getDb()
    .prepare(`
      INSERT INTO favorite_listings (user_id, listing_key, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, listing_key) DO NOTHING
    `)
    .run(userId, key, createdAt);
  return getFavoriteKeys(userId);
}

export function deleteFavoriteKey(userId, key) {
  getDb()
    .prepare("DELETE FROM favorite_listings WHERE user_id = ? AND listing_key = ?")
    .run(userId, key);
  return getFavoriteKeys(userId);
}

export function replaceFavoriteKeys(userId, keys, createdAt) {
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM favorite_listings WHERE user_id = ?").run(userId);
    const statement = db.prepare(`
      INSERT INTO favorite_listings (user_id, listing_key, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, listing_key) DO NOTHING
    `);
    for (const key of keys) {
      statement.run(userId, key, createdAt);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getFavoriteKeys(userId);
}
