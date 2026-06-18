import { getDb } from "../db.js";

const listingSelect = `
  SELECT
    external_id AS id,
    title,
    price,
    address,
    metro,
    terms,
    description,
    url,
    grade,
    score,
    total,
    monthly,
    deposit,
    commission,
    utilities,
    commute_home AS commuteHome,
    commute_work AS commuteWork,
    raw_json AS rawJson
  FROM listings
  WHERE user_id = ?
  ORDER BY position ASC, row_id ASC
`;

export function getListingsBundle(userId) {
  const meta = getDb()
    .prepare("SELECT updated_at AS updatedAt, source_file AS sourceFile FROM listing_meta WHERE user_id = ?")
    .get(userId) || { updatedAt: null, sourceFile: null };

  const items = getDb().prepare(listingSelect).all(userId).map((item) => {
    const raw = JSON.parse(item.rawJson || "{}");
    return {
      ...item,
      addresses: normalizeAddresses(raw.addresses),
      raw,
      rawJson: undefined,
    };
  });

  return {
    updatedAt: meta.updatedAt || null,
    sourceFile: meta.sourceFile || null,
    items,
  };
}

export function getListingsMeta(userId) {
  const meta = getDb()
    .prepare("SELECT updated_at AS updatedAt, source_file AS sourceFile FROM listing_meta WHERE user_id = ?")
    .get(userId) || { updatedAt: null, sourceFile: null };
  const count = getDb()
    .prepare("SELECT COUNT(*) AS count FROM listings WHERE user_id = ?")
    .get(userId).count;

  return {
    updatedAt: meta.updatedAt || null,
    sourceFile: meta.sourceFile || null,
    count,
  };
}

export function replaceListings(userId, items, sourceFile, updatedAt) {
  const db = getDb();
  db.exec("BEGIN");
  try {
    deleteListings(userId);
    const result = insertListings(userId, items);
    setListingMeta(userId, sourceFile, updatedAt);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function appendListings(userId, items, sourceFile, updatedAt) {
  const db = getDb();
  const currentCount = countListings(userId);
  db.exec("BEGIN");
  try {
    const result = insertListings(userId, items, currentCount);
    setListingMeta(userId, sourceFile, updatedAt);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function addListing(userId, item, updatedAt) {
  const db = getDb();
  const position = countListings(userId);
  db.exec("BEGIN");
  try {
    const result = insertListings(userId, [item], position);
    touchListingMeta(userId, updatedAt);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function clearListings(userId, updatedAt) {
  const db = getDb();
  db.exec("BEGIN");
  try {
    deleteListings(userId);
    setListingMeta(userId, null, updatedAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteListing(userId, listingId, updatedAt) {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const result = getDb()
      .prepare("DELETE FROM listings WHERE user_id = ? AND external_id = ?")
      .run(userId, listingId);
    touchListingMeta(userId, updatedAt);
    db.exec("COMMIT");
    return result.changes;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function touchListingMeta(userId, updatedAt) {
  getDb()
    .prepare(`
      INSERT INTO listing_meta (user_id, updated_at, source_file)
      VALUES (?, ?, NULL)
      ON CONFLICT(user_id) DO UPDATE SET
        updated_at = excluded.updated_at
    `)
    .run(userId, updatedAt);
}

function countListings(userId) {
  return getDb()
    .prepare("SELECT COUNT(*) AS count FROM listings WHERE user_id = ?")
    .get(userId).count;
}

function deleteListings(userId) {
  getDb().prepare("DELETE FROM listings WHERE user_id = ?").run(userId);
}

function setListingMeta(userId, sourceFile, updatedAt) {
  getDb()
    .prepare(`
      INSERT INTO listing_meta (user_id, updated_at, source_file)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        source_file = excluded.source_file
    `)
    .run(userId, updatedAt, sourceFile);
}

function insertListings(userId, items, offset = 0) {
  const statement = getDb().prepare(`
    INSERT INTO listings (
      user_id, external_id, title, price, address, metro, terms, description, url,
      grade, score, total, monthly, deposit, commission, utilities,
      commute_home, commute_work, raw_json, position
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const existsStatement = getDb().prepare(
    "SELECT 1 FROM listings WHERE user_id = ? AND external_id = ? LIMIT 1",
  );
  const seen = new Set();
  let inserted = 0;
  let skipped = 0;

  items.forEach((item, index) => {
    const id = String(item.id || "").trim();
    if (!id || seen.has(id) || existsStatement.get(userId, id)) {
      skipped += 1;
      return;
    }
    seen.add(id);
    statement.run(
      userId,
      id,
      item.title,
      item.price,
      item.address,
      item.metro,
      item.terms,
      item.description,
      item.url,
      item.grade,
      item.score,
      item.total,
      item.monthly,
      item.deposit,
      item.commission,
      item.utilities,
      item.commuteHome,
      item.commuteWork,
      JSON.stringify(item.raw || {}),
      offset + inserted,
    );
    inserted += 1;
  });

  return { inserted, skipped };
}

function normalizeAddresses(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({
      name: String(entry.name || entry.title || entry.label || "").trim(),
      coords: Array.isArray(entry.coords) ? entry.coords : [],
      commuteTime: String(entry.commuteTime || entry.time || entry.duration || "").trim(),
    }))
    .filter((entry) => entry.name || entry.commuteTime || entry.coords.length);
}
