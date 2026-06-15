import { sendJson } from "../http.js";
import { requireUser } from "../middleware/auth.js";
import {
  clearUserListings,
  deleteUserListing,
  getUserListings,
  importUserListings,
} from "../services/listingsService.js";

export async function handleListingRoutes(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/listings") {
    const user = requireUser(req);
    const data = getUserListings(user.id);
    sendJson(res, { ...data, user });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/import") {
    const user = requireUser(req);
    const mode = url.searchParams.get("mode") === "append" ? "append" : "replace";
    const result = await importUserListings(req, user.id, mode);
    sendJson(res, { ok: true, ...result });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/listings") {
    const user = requireUser(req);
    const result = clearUserListings(user.id);
    sendJson(res, { ok: true, ...result });
    return true;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/listings/")) {
    const user = requireUser(req);
    const listingId = decodeURIComponent(url.pathname.slice("/api/listings/".length));
    const result = deleteUserListing(user.id, listingId);
    sendJson(res, { ok: true, ...result });
    return true;
  }

  return false;
}
