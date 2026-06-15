import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { UPLOADS_DIR } from "../config.js";
import { readImportPayload, sanitizeFileName } from "../listings/importParser.js";
import { normalizeListing } from "../listings/normalizeListing.js";
import {
  appendListings,
  clearListings,
  deleteListing,
  getListingsBundle,
  replaceListings,
} from "../repositories/listingsRepository.js";
import { HttpError } from "../errors.js";

export function getUserListings(userId) {
  return getListingsBundle(userId);
}

export async function importUserListings(req, userId, mode) {
  const importResult = await readImportPayload(req);
  const normalizedItems = importResult.items.map(normalizeListing);
  const updatedAt = new Date().toISOString();

  await saveUploadedFile(userId, importResult.fileName, importResult.rawText);
  if (mode === "append") {
    appendListings(userId, normalizedItems, importResult.fileName, updatedAt);
  } else {
    replaceListings(userId, normalizedItems, importResult.fileName, updatedAt);
  }

  return {
    count: getUserListings(userId).items.length,
    imported: normalizedItems.length,
    mode,
    sourceFile: importResult.fileName,
    updatedAt,
  };
}

export function clearUserListings(userId) {
  const updatedAt = new Date().toISOString();
  clearListings(userId, updatedAt);
  return { count: 0, updatedAt };
}

export function deleteUserListing(userId, listingId) {
  const updatedAt = new Date().toISOString();
  const changes = deleteListing(userId, listingId, updatedAt);
  if (!changes) throw new HttpError("Listing not found", 404);
  return { count: getUserListings(userId).items.length, updatedAt };
}

async function saveUploadedFile(userId, fileName, text) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const userUploadsDir = join(UPLOADS_DIR, userId);
  const safeName = `${stamp}-${sanitizeFileName(fileName)}`;
  const target = join(userUploadsDir, safeName);

  await mkdir(userUploadsDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(target, { encoding: "utf8" });
    stream.on("finish", resolve);
    stream.on("error", reject);
    stream.end(text);
  });
}
