import { readJsonPayload, sendJson } from "../http.js";
import { clearSessionCookie, getCurrentUser, getSessionId, setSessionCookie } from "../middleware/auth.js";
import { createSession, destroySession, loginUser, registerUser } from "../services/authService.js";

export async function handleAuthRoutes(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/me") {
    sendJson(res, { user: getCurrentUser(req) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/register") {
    const input = await readJsonPayload(req);
    const user = registerUser(input.email, input.password);
    const session = createSession(user.id);
    setSessionCookie(res, session.id);
    sendJson(res, { ok: true, user });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const input = await readJsonPayload(req);
    const user = loginUser(input.email, input.password);
    const session = createSession(user.id);
    setSessionCookie(res, session.id);
    sendJson(res, { ok: true, user });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    destroySession(getSessionId(req));
    clearSessionCookie(res);
    sendJson(res, { ok: true });
    return true;
  }

  return false;
}
