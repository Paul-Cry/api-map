import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const services = {
  feed: {
    name: "Feed",
    port: Number(process.env.FEED_PORT || 5101),
    cwd: join(__dirname, "site_for_obv"),
    entry: "app.js",
  },
  filter: {
    name: "Filter",
    port: Number(process.env.FILTER_PORT || 5102),
    cwd: join(__dirname, "filter-site"),
    entry: "app.js",
  },
  worker: {
    name: "Worker API",
    port: Number(process.env.WORKER_PORT || 5103),
    cwd: join(__dirname, "worker-api"),
    entry: "server.js",
  },
};

const children = Object.values(services).map(startService);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      sendHtml(res, dashboardPage());
      return;
    }

    if (url.pathname === "/feed") {
      await proxy(req, res, services.feed, "/");
      return;
    }

    if (url.pathname.startsWith("/feed/")) {
      await proxy(req, res, services.feed, url.pathname.slice("/feed".length) + url.search);
      return;
    }

    if (url.pathname === "/admin") {
      await proxy(req, res, services.feed, "/admin" + url.search);
      return;
    }

    if (url.pathname === "/admin.html") {
      await proxy(req, res, services.feed, "/admin.html" + url.search);
      return;
    }

    if (url.pathname === "/api/listings" || url.pathname === "/api/import") {
      await proxy(req, res, services.feed, url.pathname + url.search);
      return;
    }

    if (url.pathname === "/filter") {
      await proxy(req, res, services.filter, "/");
      return;
    }

    if (url.pathname.startsWith("/filter/")) {
      await proxy(req, res, services.filter, url.pathname.slice("/filter".length) + url.search);
      return;
    }

    if (url.pathname === "/merge") {
      await proxy(req, res, services.filter, "/merge" + url.search);
      return;
    }

    if (url.pathname === "/api/preview-images") {
      await proxy(req, res, services.filter, url.pathname + url.search);
      return;
    }

    if (url.pathname === "/worker") {
      await proxy(req, res, services.worker, "/");
      return;
    }

    if (url.pathname.startsWith("/worker/")) {
      await proxy(req, res, services.worker, url.pathname.slice("/worker".length) + url.search);
      return;
    }

    if (
      url.pathname === "/api/status" ||
      url.pathname === "/api/run" ||
      url.pathname.startsWith("/api/workers/") ||
      url.pathname.startsWith("/api/jobs/") ||
      url.pathname.startsWith("/api/batches/")
    ) {
      await proxy(req, res, services.worker, url.pathname + url.search);
      return;
    }

    sendText(res, 404, "Route not found");
  } catch (error) {
    console.error(error);
    sendText(res, 500, error.message || "Server error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Portal: http://localhost:${PORT}`);
  console.log(`Feed:   http://localhost:${PORT}/feed`);
  console.log(`Admin:  http://localhost:${PORT}/admin`);
  console.log(`Worker: http://localhost:${PORT}/worker`);
  console.log(`Filter: http://localhost:${PORT}/filter`);
});

function startService(service) {
  const child = spawn(process.execPath, [service.entry], {
    cwd: service.cwd,
    env: {
      ...process.env,
      PORT: String(service.port),
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${service.name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${service.name}] ${chunk}`);
  });
  child.on("exit", (code, signal) => {
    console.warn(`[${service.name}] stopped: ${signal || code}`);
  });

  return child;
}

async function proxy(req, res, service, targetPath) {
  const target = `http://127.0.0.1:${service.port}${targetPath}`;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["content-length"];

  const body = await readRequestBody(req);
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: body.length ? body : undefined,
    redirect: "manual",
  });

  const responseHeaders = {};
  upstream.headers.forEach((value, key) => {
    if (!["connection", "content-encoding", "transfer-encoding"].includes(key.toLowerCase())) {
      responseHeaders[key] = value;
    }
  });

  res.writeHead(upstream.status, responseHeaders);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function dashboardPage() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Портал объявлений</title>
  <style>
    :root{--bg:#f4f6f8;--panel:#fff;--text:#17202a;--muted:#667789;--line:#dce4ee;--accent:#0f6fde;--shadow:0 10px 24px rgba(26,39,58,.07)}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,Segoe UI,Arial,sans-serif}
    header{background:#fff;border-bottom:1px solid var(--line)}
    .wrap{max-width:1120px;margin:0 auto;padding:24px}
    h1{margin:0 0 6px;font-size:30px;letter-spacing:0}
    p{margin:0;color:var(--muted);line-height:1.5}
    main{max-width:1120px;margin:0 auto;padding:20px 24px 40px}
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
    a.card{display:block;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);padding:18px;text-decoration:none;color:var(--text);min-height:150px}
    a.card:hover{border-color:#b8cbe3;transform:translateY(-1px)}
    .label{display:inline-flex;align-items:center;height:26px;padding:0 9px;border-radius:999px;background:#edf5ff;color:#164f91;font-weight:800;font-size:12px}
    h2{margin:14px 0 8px;font-size:20px}
    .path{margin-top:14px;color:var(--muted);font-size:13px}
    @media(max-width:980px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:620px){.grid{grid-template-columns:1fr}.wrap,main{padding-left:14px;padding-right:14px}}
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>Портал объявлений</h1>
      <p>Один сервер для ленты, базы объявлений, worker API и фильтра.</p>
    </div>
  </header>
  <main>
    <div class="grid">
      <a class="card" href="/feed">
        <span class="label">Лента</span>
        <h2>Лента объявлений</h2>
        <p>Просмотр объектов, цены, условия и время в дороге.</p>
        <div class="path">/feed</div>
      </a>
      <a class="card" href="/admin">
        <span class="label">База</span>
        <h2>Панель базы</h2>
        <p>Загрузка JSON-файлов и управление базой объявлений.</p>
        <div class="path">/admin</div>
      </a>
      <a class="card" href="/worker">
        <span class="label">Worker</span>
        <h2>Worker API</h2>
        <p>Панель управления worker-обработкой и очередями задач.</p>
        <div class="path">/worker</div>
      </a>
      <a class="card" href="/filter">
        <span class="label">Фильтр</span>
        <h2>Фильтр объявлений</h2>
        <p>Фильтрация объектов, превью картинок и экспорт результата.</p>
        <div class="path">/filter</div>
      </a>
    </div>
  </main>
</body>
</html>`;
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
