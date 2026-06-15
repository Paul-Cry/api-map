import { createServer } from "node:http";
import { join } from "node:path";
import { HOST, PORT, ROOT_DIR } from "./src/config.js";
import { initializeDatabase } from "./src/db.js";
import { sendFile, sendJson, sendText } from "./src/http.js";
import { handleApiRoutes } from "./src/routes/apiRouter.js";

const pages = new Map([
  ["/", join(ROOT_DIR, "index.html")],
  ["/login", join(ROOT_DIR, "auth.html")],
  ["/register", join(ROOT_DIR, "auth.html")],
  ["/admin", join(ROOT_DIR, "admin.html")],
  ["/admin.html", join(ROOT_DIR, "admin.html")],
]);

await initializeDatabase();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/") && await handleApiRoutes(req, res, url)) {
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && pages.has(url.pathname)) {
      await sendFile(res, pages.get(url.pathname), "text/html; charset=utf-8", req.method === "HEAD");
      return;
    }

    sendText(res, 404, "Страница не найдена");
  } catch (error) {
    console.error(error);
    sendJson(res, { ok: false, error: error.message || "Server error" }, error.statusCode || 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Listings site is running at http://${HOST}:${PORT}`);
});
