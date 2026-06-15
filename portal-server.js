import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PROBE_HOST = "127.0.0.1";
const MAX_PORT_ATTEMPTS = 10;

const services = {
  feed: {
    name: "Feed",
    port: Number(process.env.FEED_PORT || 5101),
    cwd: join(__dirname, "site_for_obv"),
    entry: "app.js",
  },
  filter: {
    name: "Filter",
    port: Number(process.env.FILTER_PORT || 5201),
    cwd: join(__dirname, "filter-site"),
    entry: "app.js",
  },
  worker: {
    name: "Worker API",
    port: Number(process.env.WORKER_PORT || 5301),
    cwd: join(__dirname, "worker-api"),
    entry: "server.js",
  },
};

const children = [];
for (const service of Object.values(services)) {
  children.push(await startService(service));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {

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

    if (url.pathname === "/login") {
      await proxy(req, res, services.feed, "/login" + url.search);
      return;
    }

    if (url.pathname === "/register") {
      await proxy(req, res, services.feed, "/register" + url.search);
      return;
    }

    if (url.pathname === "/merge") {
      await proxy(req, res, services.filter, "/merge" + url.search);
      return;
    }

    if (url.pathname === "/costs") {
      await proxy(req, res, services.filter, "/costs" + url.search);
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

    if (url.pathname === "/analytics") {
      await proxy(req, res, services.filter, "/analytics" + url.search);
      return;
    }

    if (url.pathname === "/analytics-admin") {
      await proxy(req, res, services.filter, "/analytics-admin" + url.search);
      return;
    }

    if (
      url.pathname === "/api/me" ||
      url.pathname === "/api/login" ||
      url.pathname === "/api/register" ||
      url.pathname === "/api/logout" ||
      url.pathname === "/api/listings" ||
      url.pathname.startsWith("/api/listings/") ||
      url.pathname === "/api/import"
    ) {
      await proxy(req, res, services.feed, url.pathname + url.search);
      return;
    }

    if (url.pathname === "/api/preview-images") {
      await proxy(req, res, services.filter, url.pathname + url.search);
      return;
    }

    if (url.pathname === "/api/filter-preview" || url.pathname === "/api/filter-run" || url.pathname === "/api/analytics-run") {
      await proxy(req, res, services.filter, url.pathname + url.search);
      return;
    }

    if (url.pathname === "/api/analytics-data") {
      await proxy(req, res, services.filter, url.pathname + url.search);
      return;
    }

    if (url.pathname === "/api/portal-summary") {
      sendJson(res, 200, await buildPortalSummary());
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
    const message = error?.message || "Server error";
    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 500, { error: message });
      return;
    }
    sendText(res, 500, message);
  }
});

const portalPort = await findFreePort(PORT);
if (portalPort !== PORT) {
  console.warn(`Port ${PORT} занят, использую ${portalPort}.`);
}

await new Promise((resolve, reject) => {
  const listener = server.listen(portalPort, HOST, () => {
    const address = listener.address();
    const boundPort = typeof address === "object" && address ? address.port : portalPort;
    console.log(`Portal: http://localhost:${boundPort}`);
    console.log(`Feed:   http://localhost:${boundPort}/feed`);
    console.log(`Admin:  http://localhost:${boundPort}/admin`);
    console.log(`Worker: http://localhost:${boundPort}/worker`);
    console.log(`Filter: http://localhost:${boundPort}/filter`);
    resolve();
  });

  listener.once("error", reject);
});

async function startService(service) {
  const port = await findFreePort(service.port);
  if (port !== service.port) {
    console.warn(`[${service.name}] Port ${service.port} занят, использую ${port}.`);
  }
  service.port = port;

  const child = spawn(process.execPath, [service.entry], {
    cwd: service.cwd,
    env: {
      ...process.env,
      PORT: String(port),
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

function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, attemptsLeft) => {
      const probe = createNetServer();
      probe.unref();

      probe.once("error", (error) => {
        probe.close();
        if (error?.code === "EADDRINUSE" && attemptsLeft > 0) {
          tryPort(port + 1, attemptsLeft - 1);
          return;
        }
        reject(error);
      });

      probe.listen(port, PROBE_HOST, () => {
        const address = probe.address();
        const boundPort = typeof address === "object" && address ? address.port : port;
        probe.close(() => resolve(boundPort));
      });
    };

    tryPort(startPort, MAX_PORT_ATTEMPTS);
  });
}

async function proxy(req, res, service, targetPath) {
  const target = `http://127.0.0.1:${service.port}${targetPath}`;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["content-length"];
  delete headers.expect;

  const method = (req.method || "GET").toUpperCase();
  const canHaveBody = method !== "GET" && method !== "HEAD";
  const body = canHaveBody ? await readRequestBody(req) : Buffer.alloc(0);
  const upstream = await fetch(target, {
    method,
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

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function buildPortalSummary() {
  const [feed, filter, worker] = await Promise.all([
    readServiceSnapshot(services.feed, "/api/listings"),
    readServiceSnapshot(services.filter, "/api/analytics-data"),
    readServiceSnapshot(services.worker, "/api/status"),
  ]);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    services: {
      feed: {
        name: services.feed.name,
        baseUrl: `http://127.0.0.1:${services.feed.port}`,
        route: "/feed",
        ...feed,
      },
      filter: {
        name: services.filter.name,
        baseUrl: `http://127.0.0.1:${services.filter.port}`,
        route: "/filter",
        ...filter,
      },
      worker: {
        name: services.worker.name,
        baseUrl: `http://127.0.0.1:${services.worker.port}`,
        route: "/worker",
        ...worker,
      },
    },
  };
}

async function readServiceSnapshot(service, path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(`http://127.0.0.1:${service.port}${path}`, {
      signal: controller.signal,
      redirect: "manual",
    });

    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    return {
      ok: response.ok,
      status: response.status,
      payload: summarizePayload(payload, service.name),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error?.name === "AbortError" ? "timeout" : (error?.message || "unavailable"),
      payload: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizePayload(payload, serviceName) {
  if (serviceName === "Feed" && payload && typeof payload === "object") {
    const items = Array.isArray(payload.items) ? payload.items.length : 0;
    return {
      items,
      updatedAt: payload.updatedAt || null,
      sourceFile: payload.sourceFile || null,
    };
  }

  if (serviceName === "Filter" && payload && typeof payload === "object") {
    const items = Array.isArray(payload.items) ? payload.items.length : 0;
    return {
      items,
      count: typeof payload.count === "number" ? payload.count : items,
      updatedAt: payload.updatedAt || null,
    };
  }

  if (serviceName === "Worker API" && payload && typeof payload === "object") {
    return {
      workersConnected: payload.workersConnected ?? 0,
      workersReady: payload.workersReady ?? 0,
      queuedJobs: payload.queuedJobs ?? 0,
      workers: Array.isArray(payload.workers) ? payload.workers.length : 0,
      batches: Array.isArray(payload.batches) ? payload.batches.length : 0,
    };
  }

  return payload;
}

function dashboardPage() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Портал объявлений</title>
  <style>
    :root{
      --bg:#08111f;
      --panel:rgba(15,22,37,.92);
      --text:#eef4ff;
      --muted:#94a3b8;
      --line:#223046;
      --accent:#6ea8ff;
      --accent-strong:#93c3ff;
      --good:#5ce0b0;
      --bad:#ff8a8a;
      --shadow:0 24px 60px rgba(0,0,0,.35);
    }
    *{box-sizing:border-box}
    html,body{min-height:100%}
    body{
      margin:0;
      color:var(--text);
      background:
        radial-gradient(circle at top left, rgba(110,168,255,.16), transparent 28%),
        radial-gradient(circle at top right, rgba(92,224,176,.08), transparent 24%),
        linear-gradient(180deg, #07101d 0%, #0c1526 100%);
      font-family:Inter,"Segoe UI",Arial,sans-serif;
    }
    a{color:inherit}
    .shell{max-width:1220px;margin:0 auto;padding:20px 18px 36px}
    .hero{
      padding:22px 22px 20px;
      border:1px solid rgba(110,168,255,.15);
      border-radius:20px;
      background:linear-gradient(180deg, rgba(18,29,49,.96), rgba(12,21,38,.96));
      box-shadow:var(--shadow);
    }
    .hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
    .eyebrow{
      display:inline-flex;
      align-items:center;
      min-height:28px;
      padding:0 10px;
      border-radius:999px;
      background:rgba(110,168,255,.12);
      color:#dcecff;
      font-size:12px;
      font-weight:800;
      margin-bottom:10px;
    }
    h1{margin:0;font-size:34px;line-height:1.05;letter-spacing:-.03em}
    .hero p{margin:10px 0 0;max-width:820px;color:var(--muted);line-height:1.55}
    .hero-actions{display:flex;gap:10px;flex-wrap:wrap}
    .button{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-height:40px;
      padding:0 14px;
      border-radius:12px;
      border:1px solid rgba(110,168,255,.18);
      background:#111a2b;
      color:var(--text);
      text-decoration:none;
      font-weight:800;
      white-space:nowrap;
      cursor:pointer;
    }
    .button.primary{background:var(--accent);color:#07101d;border-color:var(--accent)}
    .button:hover{border-color:rgba(147,195,255,.45)}
    .button.primary:hover{background:var(--accent-strong)}
    .section{margin-top:16px}
    .section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px}
    .section-head h2{margin:0;font-size:18px;letter-spacing:-.01em}
    .section-head p{margin:0;color:var(--muted);font-size:13px}
    .status-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .status-card{
      min-height:168px;
      padding:16px;
      border:1px solid rgba(110,168,255,.14);
      border-radius:18px;
      background:linear-gradient(180deg, rgba(18,29,49,.94), rgba(13,22,38,.94));
      box-shadow:var(--shadow);
    }
    .status-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .status-label{font-size:12px;font-weight:800;color:#cfe0ff;text-transform:uppercase;letter-spacing:.08em}
    .status-pill{
      display:inline-flex;
      align-items:center;
      min-height:28px;
      padding:0 10px;
      border-radius:999px;
      background:rgba(92,224,176,.12);
      color:#d8fff3;
      font-size:12px;
      font-weight:800;
    }
    .status-pill.bad{background:rgba(255,132,132,.12);color:#ffdada}
    .metric{margin-top:14px;font-size:28px;font-weight:900;letter-spacing:-.03em}
    .status-meta{margin-top:10px;color:var(--muted);font-size:13px;line-height:1.5;display:grid;gap:6px}
    .route-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
    .card{
      display:block;
      min-height:162px;
      padding:18px;
      border:1px solid rgba(110,168,255,.13);
      border-radius:18px;
      background:linear-gradient(180deg, rgba(18,29,49,.96), rgba(13,22,38,.96));
      box-shadow:var(--shadow);
      text-decoration:none;
      color:var(--text);
      transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease;
    }
    .card:hover{transform:translateY(-1px);border-color:rgba(147,195,255,.38)}
    .label{display:inline-flex;align-items:center;min-height:26px;padding:0 10px;border-radius:999px;background:rgba(110,168,255,.12);color:#dcecff;font-size:12px;font-weight:800}
    .card h3{margin:14px 0 8px;font-size:20px;line-height:1.15}
    .card p{margin:0;color:var(--muted);font-size:13px;line-height:1.5}
    .path{margin-top:16px;color:#b9cae4;font-size:12px}
    .timestamp{color:var(--muted);font-size:12px}
    @media(max-width:1020px){.status-grid,.route-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:680px){
      .shell{padding:12px}
      .hero{padding:16px}
      h1{font-size:28px}
      .status-grid,.route-grid{grid-template-columns:1fr}
      .hero-actions{width:100%}
      .hero-actions .button{flex:1}
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="hero-top">
        <div>
          <div class="eyebrow">Full stack control center</div>
          <h1>Портал объявлений</h1>
          <p>Один вход в ленту, базу объявлений, фильтр, аналитику и worker API. Главная страница показывает живой статус backend-сервисов и ведет в рабочие разделы проекта.</p>
        </div>
        <div class="hero-actions">
          <button id="refreshBtn" class="button primary" type="button">Обновить статус</button>
          <a class="button" href="/feed">Открыть ленту</a>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Живой статус backend</h2>
          <p>Данные приходят напрямую с внутренних API сервисов.</p>
        </div>
        <div id="updatedAt" class="timestamp">Обновление: ...</div>
      </div>
      <div id="statusGrid" class="status-grid">
        <div class="status-card">Загрузка данных...</div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Маршруты приложения</h2>
          <p>Все ключевые разделы собраны в одном месте.</p>
        </div>
      </div>
      <div class="route-grid">
        <a class="card" href="/feed">
          <span class="label">Лента</span>
          <h3>Просмотр объявлений</h3>
          <p>Карточки, цены, адреса, время в пути и экспорт данных.</p>
          <div class="path">/feed</div>
        </a>
        <a class="card" href="/admin">
          <span class="label">База</span>
          <h3>Панель базы</h3>
          <p>Загрузка JSON-файлов и хранение списка объявлений на сервере.</p>
          <div class="path">/admin</div>
        </a>
        <a class="card" href="/filter">
          <span class="label">Фильтр</span>
          <h3>Фильтрация и экспорт</h3>
          <p>Отбор объектов, сравнение маршрутов и скачивание результата.</p>
          <div class="path">/filter</div>
        </a>
        <a class="card" href="/worker">
          <span class="label">Worker</span>
          <h3>Worker API</h3>
          <p>Мониторинг подключённых воркеров, задач и batch-процессов.</p>
          <div class="path">/worker</div>
        </a>
        <a class="card" href="/merge">
          <span class="label">JSON</span>
          <h3>Объединение файлов</h3>
          <p>Склейка двух JSON-файлов в один массив без лишней возни.</p>
          <div class="path">/merge</div>
        </a>
        <a class="card" href="/costs">
          <span class="label">Расходы</span>
          <h3>Расходы за 3 месяца</h3>
          <p>Показывает итоговую нагрузку по объекту и сопутствующим платежам.</p>
          <div class="path">/costs</div>
        </a>
        <a class="card" href="/analytics">
          <span class="label">Аналитика</span>
          <h3>Арендная аналитика</h3>
          <p>Статистика по рынку, средние значения, медиана и входные метрики.</p>
          <div class="path">/analytics</div>
        </a>
        <a class="card" href="/analytics-admin">
          <span class="label">Admin</span>
          <h3>Панель аналитики</h3>
          <p>Сохранение и загрузка аналитического JSON с ключом администратора.</p>
          <div class="path">/analytics-admin</div>
        </a>
      </div>
    </section>
  </main>

  <script>
    const statusGrid = document.querySelector('#statusGrid');
    const updatedAt = document.querySelector('#updatedAt');
    const refreshBtn = document.querySelector('#refreshBtn');

    function fmtDate(value) {
      if (!value) return 'нет данных';
      try {
        return new Date(value).toLocaleString('ru-RU');
      } catch {
        return String(value);
      }
    }

    function fmtMetric(value) {
      if (value === null || value === undefined || value === '') return '0';
      return String(value);
    }

    function serviceTone(service) {
      return service.ok ? 'ok' : 'bad';
    }

    function serviceLabel(service) {
      if (!service.ok) return service.error || ('HTTP ' + (service.status || 0));
      return 'HTTP ' + (service.status || 200);
    }

    function renderServiceCard(title, subtitle, service, metricRows) {
      return '' +
        '<article class="status-card">' +
          '<div class="status-top">' +
            '<div class="status-label">' + title + '</div>' +
            '<div class="status-pill ' + serviceTone(service) + '">' + serviceLabel(service) + '</div>' +
          '</div>' +
          '<div class="metric">' + subtitle + '</div>' +
          '<div class="status-meta">' +
            metricRows.map(function(row) {
              return '<div>' + row.label + ': <strong>' + row.value + '</strong></div>';
            }).join('') +
            '<div>Маршрут: <a href="' + service.route + '">' + service.route + '</a></div>' +
            '<div>Источник: ' + service.baseUrl + '</div>' +
          '</div>' +
        '</article>';
    }

    async function loadSummary() {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Обновляю...';
      try {
        const response = await fetch('/api/portal-summary', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data || !data.ok) {
          throw new Error((data && data.error) || 'Не удалось загрузить статус.');
        }

        const feed = data.services.feed || {};
        const filter = data.services.filter || {};
        const worker = data.services.worker || {};

        statusGrid.innerHTML = [
          renderServiceCard('Feed', fmtMetric(feed.payload && feed.payload.items) + ' объявлений', feed, [
            { label: 'Обновлено', value: fmtDate(feed.payload && feed.payload.updatedAt) },
            { label: 'Файл', value: (feed.payload && feed.payload.sourceFile) || 'нет' },
          ]),
          renderServiceCard('Filter', fmtMetric(filter.payload && filter.payload.count) + ' объектов', filter, [
            { label: 'Обновлено', value: fmtDate(filter.payload && filter.payload.updatedAt) },
            { label: 'Items', value: fmtMetric(filter.payload && filter.payload.items) },
          ]),
          renderServiceCard('Worker API', fmtMetric(worker.payload && worker.payload.workersConnected) + ' workers', worker, [
            { label: 'Готово', value: fmtMetric(worker.payload && worker.payload.workersReady) },
            { label: 'Очередь', value: fmtMetric(worker.payload && worker.payload.queuedJobs) },
          ]),
        ].join('');

        updatedAt.textContent = 'Обновление: ' + fmtDate(data.generatedAt);
      } catch (error) {
        statusGrid.innerHTML = '<div class="status-card">Ошибка загрузки: ' + (error && error.message ? error.message : String(error)) + '</div>';
        updatedAt.textContent = 'Обновление: не удалось загрузить статус';
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Обновить статус';
      }
    }

    refreshBtn.addEventListener('click', loadSummary);
    loadSummary();
  </script>
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
