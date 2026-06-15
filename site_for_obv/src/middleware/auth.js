import { SESSION_COOKIE } from "../config.js";
import { HttpError } from "../errors.js";
import { parseCookies, setCookie } from "../http.js";
import { getUserBySession } from "../services/authService.js";

export function getSessionId(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies[SESSION_COOKIE] || "";
}

export function getCurrentUser(req) {
  return getUserBySession(getSessionId(req));
}

export function requireUser(req) {
  const user = getCurrentUser(req);
  if (!user) throw new HttpError("Auth required", 401);
  return user;
}

export function setSessionCookie(res, sessionId) {
  setCookie(res, `${SESSION_COOKIE}=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
}

export function clearSessionCookie(res) {
  setCookie(res, `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}
