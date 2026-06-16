import { readJsonPayload, sendJson } from "../http.js";
import { requireUser } from "../middleware/auth.js";
import {
  addUserFavorite,
  deleteUserFavorite,
  getUserFavorites,
  replaceUserFavorites,
} from "../services/favoritesService.js";

export async function handleFavoriteRoutes(req, res, url) {
  if (url.pathname !== "/api/favorites") return false;

  const user = requireUser(req);

  if (req.method === "GET") {
    sendJson(res, { ok: true, ...getUserFavorites(user.id) });
    return true;
  }

  if (req.method === "POST") {
    const input = await readJsonPayload(req);
    sendJson(res, { ok: true, ...addUserFavorite(user.id, input) });
    return true;
  }

  if (req.method === "PUT") {
    const input = await readJsonPayload(req);
    sendJson(res, { ok: true, ...replaceUserFavorites(user.id, input) });
    return true;
  }

  if (req.method === "DELETE") {
    const input = await readJsonPayload(req);
    sendJson(res, { ok: true, ...deleteUserFavorite(user.id, input) });
    return true;
  }

  return false;
}
