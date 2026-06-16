import { HttpError } from "../errors.js";
import {
  addFavoriteKey,
  deleteFavoriteKey,
  getFavoriteKeys,
  replaceFavoriteKeys,
} from "../repositories/favoritesRepository.js";

function normalizeKey(value) {
  const key = String(value ?? "").trim();
  if (!key) throw new HttpError("Favorite key is required", 400);
  if (key.length > 1200) throw new HttpError("Favorite key is too long", 400);
  return key;
}

function normalizeKeys(values) {
  if (!Array.isArray(values)) throw new HttpError("Favorite keys must be an array", 400);
  return [...new Set(values.map(normalizeKey))];
}

export function getUserFavorites(userId) {
  return { keys: getFavoriteKeys(userId) };
}

export function addUserFavorite(userId, input) {
  const key = normalizeKey(input?.key);
  return { keys: addFavoriteKey(userId, key, new Date().toISOString()) };
}

export function deleteUserFavorite(userId, input) {
  const key = normalizeKey(input?.key);
  return { keys: deleteFavoriteKey(userId, key) };
}

export function replaceUserFavorites(userId, input) {
  const keys = normalizeKeys(input?.keys);
  return { keys: replaceFavoriteKeys(userId, keys, new Date().toISOString()) };
}
