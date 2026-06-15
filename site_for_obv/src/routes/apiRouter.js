import { handleAuthRoutes } from "./authRoutes.js";
import { handleListingRoutes } from "./listingRoutes.js";

export async function handleApiRoutes(req, res, url) {
  return await handleAuthRoutes(req, res, url) || await handleListingRoutes(req, res, url);
}
