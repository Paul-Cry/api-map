import http from 'node:http';

const PORT = Number(globalThis.process?.env?.PORT || 4173);
const MAX_PORT_ATTEMPTS = 10;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function htmlResponse(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Слишком большой запрос.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getListingUrl(item) {
  const value = item?.url || item?.URL || item?.link || item?.href || item?.avitoUrl || '';
  if (typeof value !== 'string') return '';
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `https://www.avito.ru${value}`;
  return value;
}

function resolveUrl(value, baseUrl) {
  if (!value || typeof value !== 'string') return '';

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return '';
  }
}

function extractImageFromHtml(html, baseUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /"image"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/i,
    /"imageUrl"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return resolveUrl(match[1].replaceAll('\\/', '/'), baseUrl);
    }
  }

  return '';
}

async function fetchPreviewImage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  return extractImageFromHtml(html, response.url || url);
}

async function handlePreviewImages(req, res) {
  const body = await readBody(req);
  const payload = JSON.parse(body || '{}');
  const items = Array.isArray(payload.items) ? payload.items : [];
  const limit = Math.max(1, Math.min(Number(payload.limit || 40), 80));
  const urls = [...new Set(items.map(getListingUrl).filter(Boolean))].slice(0, limit);
  const results = {};

  await Promise.all(urls.map(async (url) => {
    try {
      results[url] = await fetchPreviewImage(url);
    } catch {
      results[url] = '';
    }
  }));

  jsonResponse(res, 200, { results });
}

const page = String.raw`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Avito Transit</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #070b14;
      --bg-soft: #0b1220;
      --panel: rgba(15, 20, 33, 0.92);
      --panel-strong: #12192a;
      --panel-soft: rgba(18, 25, 42, 0.72);
      --text: #eef3fb;
      --muted: #9ea9bc;
      --line: #223046;
      --accent: #6ea8ff;
      --accent-strong: #8bbcff;
      --accent-warm: #f0b86a;
      --good: #57d6b0;
      --warn: #f2c36b;
      --bad: #ff8080;
      --shadow: 0 22px 50px rgba(0, 0, 0, 0.42);
      --radius: 16px;
    }

    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(110, 168, 255, 0.16), transparent 30%),
        radial-gradient(circle at top right, rgba(240, 184, 106, 0.08), transparent 24%),
        linear-gradient(180deg, #070b14 0%, #0b1220 100%);
      font-family: Inter, "Segoe UI", Arial, sans-serif;
    }

    button, input { font: inherit; }

    .app {
      width: min(1400px, calc(100vw - 24px));
      margin: 0 auto;
      padding: 18px 0 22px;
    }

    .hero {
      display: grid;
      gap: 10px;
      margin-bottom: 14px;
      padding: 18px 20px;
      border: 1px solid rgba(110, 168, 255, 0.18);
      border-radius: var(--radius);
      background: linear-gradient(180deg, rgba(18,25,42,0.96), rgba(12,18,31,0.96));
      box-shadow: var(--shadow);
    }

    .hero h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.1;
      letter-spacing: -0.02em;
    }

    .hero p {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      max-width: 820px;
    }

    .toolbar {
      display: grid;
      grid-template-columns: 1.4fr 0.95fr 0.75fr auto auto auto auto auto auto;
      gap: 10px;
      align-items: end;
      margin-bottom: 14px;
      padding: 14px;
      border: 1px solid rgba(110, 168, 255, 0.14);
      border-radius: var(--radius);
      background: var(--panel);
      box-shadow: var(--shadow);
    }

    .field {
      display: grid;
      gap: 6px;
      font-size: 13px;
      font-weight: 650;
      color: #c9d5e5;
    }

    input[type="file"], input[type="number"], select {
      width: 100%;
      min-height: 42px;
      border: 1px solid rgba(110, 168, 255, 0.16);
      border-radius: 12px;
      background: #0c1322;
      color: var(--text);
      outline: none;
      padding: 0 12px;
    }

    input[type="file"] {
      padding: 8px 10px;
      color: var(--muted);
    }

    select {
      padding: 0 12px;
      color: var(--text);
    }

    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(110, 168, 255, 0.16);
    }

    .button {
      min-height: 42px;
      padding: 0 14px;
      border: 1px solid rgba(110, 168, 255, 0.16);
      border-radius: 12px;
      background: #11192a;
      color: var(--text);
      font-weight: 750;
      cursor: pointer;
      white-space: nowrap;
    }

    .button.primary {
      background: var(--accent);
      color: #09111f;
      border-color: var(--accent);
    }

    .button.primary:hover { background: var(--accent-strong); }
    .button:hover { border-color: rgba(139, 188, 255, 0.55); }
    .button:disabled { opacity: 0.55; cursor: not-allowed; }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 14px;
    }

    .time-filters {
      display: none;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
      padding: 12px;
      border: 1px solid rgba(110, 168, 255, 0.14);
      border-radius: var(--radius);
      background: var(--panel-soft);
      box-shadow: var(--shadow);
    }

    .time-filters.visible {
      display: grid;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
      padding: 0 12px;
      border-radius: 999px;
      border: 1px solid rgba(110, 168, 255, 0.18);
      background: rgba(18, 25, 42, 0.86);
      box-shadow: var(--shadow);
      font-size: 13px;
      color: var(--text);
    }

    .pill strong {
      color: var(--text);
      font-weight: 800;
    }

    .panel {
      border: 1px solid rgba(110, 168, 255, 0.14);
      border-radius: var(--radius);
      overflow: hidden;
      background: var(--panel);
      box-shadow: var(--shadow);
    }

    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      background: var(--panel-strong);
      border-bottom: 1px solid var(--line);
    }

    .panel-title {
      margin: 0;
      font-size: 15px;
      font-weight: 800;
    }

    .status {
      font-size: 13px;
      color: var(--muted);
    }

    .status.ok { color: var(--good); }
    .status.warn { color: var(--warn); }
    .status.bad { color: var(--bad); }

    .feed {
      padding: 10px;
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
      min-height: 280px;
      align-content: start;
    }

    .feed.empty {
      display: grid;
      place-items: center;
      color: var(--muted);
      font-size: 14px;
      min-height: 340px;
    }

    .card {
      display: grid;
      grid-template-columns: 180px minmax(0, 1fr);
      gap: 8px;
      padding: 12px 14px;
      border: 1px solid rgba(110, 168, 255, 0.13);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(18,25,42,0.96), rgba(13,19,31,0.96));
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.26);
      transition: transform 150ms ease, box-shadow 150ms ease, border-color 150ms ease;
    }

    .card-photo {
      width: 100%;
      aspect-ratio: 4 / 3;
      border: 1px solid rgba(110, 168, 255, 0.13);
      border-radius: 12px;
      overflow: hidden;
      background: rgba(7, 11, 20, 0.72);
      display: grid;
      place-items: center;
      color: var(--muted);
      font-size: 12px;
      text-align: center;
      align-self: start;
    }

    .card-photo img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
    }

    .card:hover {
      transform: translateY(-1px);
      border-color: rgba(139, 188, 255, 0.34);
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.34);
    }

    .card-body {
      min-width: 0;
      display: grid;
      gap: 8px;
      align-content: start;
    }

    .title {
      margin: 0;
      font-size: 15px;
      line-height: 1.25;
      font-weight: 800;
      color: var(--text);
      text-decoration: none;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
    }

    .title:hover { color: var(--accent-strong); text-decoration: underline; }

    .price {
      font-size: 22px;
      line-height: 1;
      font-weight: 900;
      color: var(--accent-warm);
      letter-spacing: -0.02em;
    }

    .address,
    .description {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.42;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .address { -webkit-line-clamp: 1; }
    .description { -webkit-line-clamp: 3; }

    .time-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 10px 12px;
      border: 1px solid rgba(110, 168, 255, 0.16);
      border-radius: 12px;
      background: rgba(110, 168, 255, 0.08);
    }

    .time-pill {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      padding: 0 10px;
      border-radius: 999px;
      background: rgba(7, 11, 20, 0.8);
      border: 1px solid rgba(110, 168, 255, 0.2);
      color: #edf4ff;
      font-size: 12px;
      font-weight: 900;
      line-height: 1;
    }

    .time-pill.primary {
      background: linear-gradient(180deg, rgba(110, 168, 255, 0.24), rgba(110, 168, 255, 0.16));
      border-color: rgba(139, 188, 255, 0.38);
      color: #ffffff;
      font-size: 13px;
      padding: 0 12px;
    }

    .card-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 2px;
    }

    .link-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 32px;
      padding: 0 12px;
      border-radius: 999px;
      background: var(--accent);
      color: #09111f;
      text-decoration: none;
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
    }

    .link-btn:hover { background: var(--accent-strong); }
    .link-btn.disabled {
      background: #22304a;
      color: var(--muted);
      pointer-events: none;
    }

    .download-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      padding: 0 14px;
      border-radius: 12px;
      border: 1px solid rgba(112, 219, 179, 0.28);
      background: rgba(87, 214, 176, 0.12);
      color: #d9fff1;
      text-decoration: none;
      font-weight: 800;
      white-space: nowrap;
      cursor: pointer;
    }

    .download-btn:hover {
      border-color: rgba(112, 219, 179, 0.45);
      background: rgba(87, 214, 176, 0.18);
    }

    .download-btn.disabled {
      opacity: 0.45;
      pointer-events: none;
    }

    .log-panel {
      margin-top: 14px;
      border: 1px solid rgba(110, 168, 255, 0.14);
      border-radius: var(--radius);
      overflow: hidden;
      background: var(--panel);
      box-shadow: var(--shadow);
    }

    .log-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 16px;
      background: var(--panel-strong);
      border-bottom: 1px solid var(--line);
    }

    .log-body {
      max-height: 220px;
      overflow: auto;
      padding: 12px 16px;
      background: #0c1322;
      font-family: "Cascadia Code", Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #d7e2f2;
      white-space: pre-wrap;
    }

    .log-line { margin: 0 0 6px; }
    .log-line.info { color: #d7e2f2; }
    .log-line.ok { color: var(--good); }
    .log-line.warn { color: var(--warn); }
    .log-line.bad { color: var(--bad); }

    @media (max-width: 920px) {
      .app { width: min(100vw - 16px, 760px); padding-top: 10px; }
      .hero h1 { font-size: 24px; }
      .toolbar { grid-template-columns: 1fr; }
    }

    @media (max-width: 620px) {
      .hero { padding: 14px; }
      .panel-head { align-items: flex-start; flex-direction: column; }
      .button, .download-btn { width: 100%; }
      .card {
        grid-template-columns: 120px minmax(0, 1fr);
        padding: 10px;
      }
      .price { font-size: 18px; }
      .description { -webkit-line-clamp: 2; }
      .time-row { padding: 8px; }
    }

    @media (max-width: 430px) {
      .card { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="app">
    <section class="hero">
      <h1>Avito Transit</h1>
      <p>Загрузи JSON-файл, получи ленту карточек объявлений и отфильтруй их по времени в пути. Карточка показывает фото, название, цену, адрес, описание и ссылку на открытие объявления.</p>
      <div style="margin-top:12px;">
        <a class="button" href="/merge" style="display:inline-flex; text-decoration:none;">Объединить JSON</a>
      </div>
    </section>

    <section class="toolbar">
      <label class="field">
        JSON-файл
        <input id="fileInput" type="file" accept=".json,application/json">
      </label>
      <label class="field">
        Исключить по названию
        <input id="excludeTitle" type="text" placeholder="за сутки; без комиссии">
      </label>
      <label class="field">
        Сортировка
        <select id="sortMode">
          <option value="time">По времени</option>
          <option value="price">По цене</option>
        </select>
      </label>
      <button id="showButton" class="button primary" type="button">Показать карточки</button>
      <button id="filterButton" class="button" type="button" disabled>Фильтровать</button>
      <button id="resetButton" class="button" type="button" disabled>Сбросить</button>
      <button id="imageButton" class="button" type="button" disabled>Найти фото</button>
      <button id="downloadUrlsButton" class="download-btn" type="button" disabled>Ссылки</button>
      <button id="downloadButton" class="download-btn" type="button" disabled>Скачать JSON</button>
    </section>

    <section id="timeFilters" class="time-filters" aria-label="Фильтры по полям времени"></section>

    <section class="meta" aria-live="polite">
      <div class="pill">Файл: <strong id="fileName">не выбран</strong></div>
      <div class="pill">Карточек: <strong id="countInfo">0</strong></div>
      <div class="pill">Поля времени: <strong id="timeInfo">нет</strong></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title">Карточки</div>
        <div id="resultStatus" class="status">Выбери JSON-файл, чтобы увидеть список карточек</div>
      </div>
      <div id="feed" class="feed empty">Пока данных нет.</div>
    </section>

    <section class="log-panel">
      <div class="log-head">
        <div class="panel-title">Логи</div>
        <button id="clearLogs" class="button" type="button">Очистить</button>
      </div>
      <div id="logBody" class="log-body"></div>
    </section>
  </main>

  <script>
    const preferredTimeKeys = ['Родина', 'работа Оли'];
    const ignoredTimeKeyNames = new Set([
      'address', 'adress', 'адрес', 'description', 'desc', 'описание', 'dop',
      'title', 'name', 'название', 'price', 'цена', 'url', 'link', 'href', 'avitourl',
    ]);

    const els = {
      fileInput: document.querySelector('#fileInput'),
      excludeTitle: document.querySelector('#excludeTitle'),
      sortMode: document.querySelector('#sortMode'),
      showButton: document.querySelector('#showButton'),
      filterButton: document.querySelector('#filterButton'),
      resetButton: document.querySelector('#resetButton'),
      imageButton: document.querySelector('#imageButton'),
      downloadUrlsButton: document.querySelector('#downloadUrlsButton'),
      downloadButton: document.querySelector('#downloadButton'),
      timeFilters: document.querySelector('#timeFilters'),
      clearLogs: document.querySelector('#clearLogs'),
      feed: document.querySelector('#feed'),
      logBody: document.querySelector('#logBody'),
      resultStatus: document.querySelector('#resultStatus'),
      fileName: document.querySelector('#fileName'),
      countInfo: document.querySelector('#countInfo'),
      timeInfo: document.querySelector('#timeInfo'),
    };

    const state = {
      rawText: '',
      fileName: '',
      allItems: [],
      visibleItems: [],
      timeKeys: [],
      timeLimits: {},
      excludeTerms: [],
      sortMode: 'time',
      imageCache: new Map(),
      imageLoading: false,
      logs: [],
    };

    function esc(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function displayText(value) {
      const text = String(value ?? '');
      if (!/[РС][\u0400-\u04ff]/.test(text)) return text;

      try {
        const bytes = [];
        for (const char of text) {
          const code = char.codePointAt(0);
          const byte = windows1251Byte(code);
          if (byte === null) return text;
          bytes.push(byte);
        }

        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
        return decoded.includes('\uFFFD') ? text : decoded;
      } catch {
        return text;
      }
    }

    function windows1251Byte(code) {
      if (code <= 0x7f) return code;
      if (code === 0x0401) return 0xa8;
      if (code === 0x0451) return 0xb8;
      if (code >= 0x0410 && code <= 0x044f) return code - 0x0350;

      const extra = {
        0x0402: 0x80, 0x0403: 0x81, 0x201a: 0x82, 0x0453: 0x83,
        0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
        0x20ac: 0x88, 0x2030: 0x89, 0x0409: 0x8a, 0x2039: 0x8b,
        0x040a: 0x8c, 0x040c: 0x8d, 0x040b: 0x8e, 0x040f: 0x8f,
        0x0452: 0x90, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
        0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
        0x2122: 0x99, 0x0459: 0x9a, 0x203a: 0x9b, 0x045a: 0x9c,
        0x045c: 0x9d, 0x045b: 0x9e, 0x045f: 0x9f, 0x00a0: 0xa0,
        0x040e: 0xa1, 0x045e: 0xa2, 0x0408: 0xa3, 0x00a4: 0xa4,
        0x0490: 0xa5, 0x00a6: 0xa6, 0x00a7: 0xa7, 0x00a9: 0xa9,
        0x0404: 0xaa, 0x00ab: 0xab, 0x00ac: 0xac, 0x00ad: 0xad,
        0x00ae: 0xae, 0x0407: 0xaf, 0x00b0: 0xb0, 0x00b1: 0xb1,
        0x0406: 0xb2, 0x0456: 0xb3, 0x0491: 0xb4, 0x00b5: 0xb5,
        0x00b6: 0xb6, 0x00b7: 0xb7, 0x2116: 0xb9, 0x0454: 0xba,
        0x00bb: 0xbb, 0x0458: 0xbc, 0x0405: 0xbd, 0x0455: 0xbe,
        0x0457: 0xbf,
      };

      return extra[code] ?? null;
    }

    function log(message, tone = 'info') {
      const stamp = new Date().toLocaleTimeString('ru-RU', { hour12: false });
      state.logs.push({ stamp, message, tone });
      if (state.logs.length > 150) state.logs.shift();
      renderLogs();
    }

    function renderLogs() {
      els.logBody.innerHTML = state.logs.length
        ? state.logs.map((entry) => '<div class="log-line ' + entry.tone + '">[' + entry.stamp + '] ' + esc(entry.message) + '</div>').join('')
        : '<div class="log-line info">Лог пуст.</div>';
      els.logBody.scrollTop = els.logBody.scrollHeight;
    }

    function setStatus(text, tone = 'info') {
      els.resultStatus.textContent = text;
      els.resultStatus.classList.remove('ok', 'warn', 'bad');
      if (tone !== 'info') els.resultStatus.classList.add(tone);
    }

    function unwrapJson(value) {
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.result)) return value.result;
      if (Array.isArray(value?.items)) return value.items;
      if (Array.isArray(value?.data)) return value.data;
      throw new Error('JSON должен быть массивом объектов или объектом с result/items/data.');
    }

    function parseTransitMinutes(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;

      const text = String(value ?? '').toLowerCase().replace(',', '.');
      if (!text || text.includes('ошиб') || text.includes('не найден')) return Number.POSITIVE_INFINITY;

      const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:ч|час|С‡|С‡Р°СЃ)/);
      const minuteMatch = text.match(/(\d+)\s*(?:мин|м\b|РјРёРЅ|Рј\b)/);
      const numberOnly = text.match(/^\s*(\d+)\s*$/);
      const total =
        (hourMatch ? Number(hourMatch[1]) * 60 : 0) +
        (minuteMatch ? Number(minuteMatch[1]) : 0);

      if (total > 0) return Math.round(total);
      if (numberOnly) return Number(numberOnly[1]);
      return Number.POSITIVE_INFINITY;
    }

    function isTimeValue(value) {
      return Number.isFinite(parseTransitMinutes(value));
    }

    function isCompactTimeValue(value) {
      if (!isTimeValue(value)) return false;
      if (typeof value === 'number') return true;

      const text = String(value ?? '').trim();
      if (!text) return false;

      const words = text.split(/\s+/).filter(Boolean);
      return text.length <= 32 && words.length <= 6;
    }

    function canAutoDetectTimeKey(key) {
      const normalized = String(key ?? '').trim();
      if (!normalized) return false;
      if (preferredTimeKeys.includes(normalized)) return true;
      return !ignoredTimeKeyNames.has(normalized.toLowerCase());
    }

    function detectTimeKeys(items) {
      const keys = new Set(items.flatMap((item) => Object.keys(item)));
      const preferred = preferredTimeKeys.filter((key) => keys.has(key));

      const detected = [...keys].filter((key) => {
        if (!canAutoDetectTimeKey(key)) return false;
        const values = items
          .map((item) => item[key])
          .filter((value) => value !== undefined && value !== null);
        return values.length > 0 && values.some(isCompactTimeValue);
      });

      return [...new Set([...preferred, ...detected])];
    }

    function getAddress(item) {
      return item.adress || item.address || item.адрес || '';
    }

    function getDescription(item) {
      return item.description || item.desc || item.описание || item.dop || '';
    }

    function getTitle(item) {
      return item.title || item.name || item.название || 'Без названия';
    }

    function getPrice(item) {
      return item.price || item.цена || '';
    }

    function getImageCandidate(value) {
      if (!value) return '';
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) {
        for (const entry of value) {
          const candidate = getImageCandidate(entry);
          if (candidate) return candidate;
        }
      }
      if (typeof value === 'object') {
        return value.url || value.src || value.href || value.imageUrl || value.preview || '';
      }
      return '';
    }

    function getImageUrl(item) {
      const directKeys = ['image', 'imageUrl', 'img', 'photo', 'photoUrl', 'preview', 'thumbnail', 'cover'];
      const arrayKeys = ['images', 'imageUrls', 'photos', 'photoUrls', 'pictures'];

      for (const key of directKeys) {
        const candidate = getImageCandidate(item[key]);
        if (candidate) return candidate;
      }

      for (const key of arrayKeys) {
        const candidate = getImageCandidate(item[key]);
        if (candidate) return candidate;
      }

      return state.imageCache.get(getLink(item)) || '';
    }

    function parsePrice(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const text = String(value ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return Number.POSITIVE_INFINITY;

      const digits = text.replace(/[^\d,.-]/g, '').replace(',', '.');
      const number = Number(digits);
      if (Number.isFinite(number)) return number;

      const match = text.match(/(\d[\d\s]*)/);
      if (!match) return Number.POSITIVE_INFINITY;
      const compact = match[1].replace(/\s+/g, '');
      return Number(compact);
    }

    function getLink(item) {
      const value = item.url || item.URL || item.link || item.href || item.avitoUrl || '';
      if (typeof value !== 'string') return '';
      if (value.startsWith('//')) return 'https:' + value;
      if (value.startsWith('/')) return 'https://www.avito.ru' + value;
      return value;
    }

    function collectUrls(items) {
      return [...new Set(items.map(getLink).filter(Boolean))];
    }

    function getDefaultTimeLimit() {
      return 60;
    }

    function syncTimeLimits() {
      const next = {};
      const defaultLimit = getDefaultTimeLimit();
      for (const key of state.timeKeys) {
        const current = Number(state.timeLimits[key]);
        next[key] = Number.isFinite(current) && current > 0 ? current : defaultLimit;
      }
      state.timeLimits = next;
    }

    function renderTimeFilters() {
      syncTimeLimits();
      els.timeFilters.classList.toggle('visible', state.timeKeys.length > 0);

      if (!state.timeKeys.length) {
        els.timeFilters.innerHTML = '';
        return;
      }

      els.timeFilters.innerHTML = state.timeKeys.map((key, index) => (
        '<label class="field">' +
          esc(displayText(key)) +
          '<input class="time-limit-input" data-time-index="' + index + '" type="number" min="1" step="1" value="' + esc(state.timeLimits[key]) + '">' +
        '</label>'
      )).join('');
    }

    function readTimeLimitsFromInputs() {
      els.timeFilters.querySelectorAll('.time-limit-input').forEach((input) => {
        const key = state.timeKeys[Number(input.dataset.timeIndex)];
        if (!key) return;
        state.timeLimits[key] = Number(input.value || 0);
      });
    }

    function getInvalidTimeLimits() {
      readTimeLimitsFromInputs();
      return state.timeKeys.filter((key) => {
        const limit = Number(state.timeLimits[key]);
        return !Number.isFinite(limit) || limit <= 0;
      });
    }

    function getBestTimeMinutes(item) {
      if (!state.timeKeys.length) return Number.POSITIVE_INFINITY;
      let best = Number.POSITIVE_INFINITY;
      for (const key of state.timeKeys) {
        const minutes = parseTransitMinutes(item[key]);
        if (Number.isFinite(minutes) && minutes < best) best = minutes;
      }
      return best;
    }

    function sortItems(items) {
      const mode = state.sortMode || els.sortMode.value || 'time';
      const sorted = items.slice();

      sorted.sort((a, b) => {
        if (mode === 'price') {
          const priceDelta = parsePrice(getPrice(a)) - parsePrice(getPrice(b));
          if (priceDelta !== 0) return priceDelta;

          const timeDelta = getBestTimeMinutes(a) - getBestTimeMinutes(b);
          if (timeDelta !== 0) return timeDelta;
        } else {
          const timeDelta = getBestTimeMinutes(a) - getBestTimeMinutes(b);
          if (timeDelta !== 0) return timeDelta;

          const priceDelta = parsePrice(getPrice(a)) - parsePrice(getPrice(b));
          if (priceDelta !== 0) return priceDelta;
        }

        const titleA = String(getTitle(a)).toLowerCase();
        const titleB = String(getTitle(b)).toLowerCase();
        return titleA.localeCompare(titleB, 'ru');
      });

      return sorted;
    }

    function parseTerms(value) {
      return String(value ?? '')
        .split(/[\n,;]+/g)
        .map((term) => term.trim().toLowerCase())
        .filter(Boolean);
    }

    function matchesExcludedTitle(item) {
      if (!state.excludeTerms.length) return false;
      const title = String(getTitle(item)).toLowerCase();
      return state.excludeTerms.some((term) => title.includes(term));
    }

    function applyExclusions(items) {
      if (!state.excludeTerms.length) return items;
      return items.filter((item) => !matchesExcludedTitle(item));
    }

    function updateActionsState() {
      const hasItems = state.allItems.length > 0;
      const hasVisible = state.visibleItems.length > 0;
      const hasUrls = collectUrls(state.visibleItems).length > 0;
      els.filterButton.disabled = !hasItems || !state.timeKeys.length;
      els.resetButton.disabled = !hasItems;
      els.imageButton.disabled = !hasUrls || state.imageLoading;
      els.downloadUrlsButton.disabled = !hasUrls;
      els.downloadUrlsButton.classList.toggle('disabled', !hasUrls);
      els.downloadButton.disabled = !hasVisible;
      els.downloadButton.classList.toggle('disabled', !hasVisible);
    }

    function buildExportItems() {
      return sortItems(state.visibleItems).map((item) => ({ ...item }));
    }

    function downloadJsonFile() {
      if (!state.visibleItems.length) {
        setStatus('Нечего скачивать.', 'warn');
        log('Скачивание не выполнено: список пуст.', 'warn');
        return;
      }

      const payload = buildExportItems();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      anchor.href = url;
      anchor.download = (state.fileName ? state.fileName.replace(/\.json$/i, '') : 'filtered') + '-filtered-' + stamp + '.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('Файл JSON скачан: ' + payload.length + ' объектов.', 'ok');
      log('JSON экспортирован: ' + payload.length + ' объектов.', 'ok');
    }

    function downloadUrlsFile() {
      const urls = collectUrls(state.visibleItems);
      if (!urls.length) {
        setStatus('Ссылок для скачивания нет.', 'warn');
        log('Скачивание ссылок не выполнено: url не найдены.', 'warn');
        return;
      }

      const blob = new Blob([urls.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      anchor.href = url;
      anchor.download = (state.fileName ? state.fileName.replace(/\.json$/i, '') : 'filtered') + '-urls-' + stamp + '.txt';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('Ссылки скачаны: ' + urls.length + '.', 'ok');
      log('Ссылки экспортированы: ' + urls.length + '.', 'ok');
    }

    function readItemsFromText(text) {
      const parsed = unwrapJson(JSON.parse(text));
      if (!parsed.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
        throw new Error('В массиве должны быть только объекты объявлений.');
      }
      return parsed;
    }

    function applyFilter(items) {
      let filtered = items;
      if (state.timeKeys.length) {
        filtered = filtered.filter((item) => state.timeKeys.every((key) => {
          const limit = Number(state.timeLimits[key]);
          return parseTransitMinutes(item[key]) <= limit;
        }));
      }
      filtered = applyExclusions(filtered);
      return filtered;
    }

    function updateSummary() {
      els.fileName.textContent = state.fileName || 'не выбран';
      els.countInfo.textContent = String(state.visibleItems.length);
      els.timeInfo.textContent = state.timeKeys.length ? state.timeKeys.map(displayText).join(', ') : 'нет';
    }

    function renderCards(items) {
      const ordered = sortItems(items);

      if (!ordered.length) {
        els.feed.className = 'feed empty';
        els.feed.textContent = 'Ничего не найдено.';
        updateSummary();
        updateActionsState();
        return;
      }

      const timeKeys = state.timeKeys;
      els.feed.className = 'feed';
      els.feed.innerHTML = ordered.map((item) => {
        const title = displayText(getTitle(item));
        const price = displayText(getPrice(item));
        const address = displayText(getAddress(item));
        const description = displayText(getDescription(item));
        const link = getLink(item);
        const imageUrl = getImageUrl(item);
        const imageMarkup = imageUrl
          ? '<div class="card-photo"><img src="' + esc(imageUrl) + '" alt="' + esc(title) + '" loading="lazy" referrerpolicy="no-referrer"></div>'
          : '<div class="card-photo">Фото пока нет</div>';
        const titleMarkup = link
          ? '<a class="title" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + '</a>'
          : '<div class="title">' + esc(title) + '</div>';
        const timeMarkup = timeKeys.length
          ? '<div class="time-row">' +
              timeKeys.map((key) => '<span class="time-pill">' + esc(displayText(key)) + ': ' + esc(displayText(item[key] ?? '')) + '</span>').join('') +
            '</div>'
          : '';
        const linkMarkup = link
          ? '<a class="link-btn" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Открыть</a>'
          : '<span class="link-btn disabled">Ссылка не найдена</span>';

        return [
          '<article class="card">',
            imageMarkup,
            '<div class="card-body">',
              timeMarkup,
              titleMarkup,
              price ? '<div class="price">' + esc(price) + '</div>' : '',
              address ? '<div class="address">' + esc(address) + '</div>' : '',
              description ? '<div class="description">' + esc(description) + '</div>' : '',
              '<div class="card-actions">' + linkMarkup + '</div>',
            '</div>',
          '</article>',
        ].join('');
      }).join('');

      updateSummary();
      updateActionsState();
    }

    function renderAll(reason) {
      state.visibleItems = state.allItems.slice();
      renderCards(state.visibleItems);
      setStatus(reason + ' | карточек: ' + state.visibleItems.length, 'ok');
      log(reason + ' | показано карточек: ' + state.visibleItems.length, 'ok');
      updateActionsState();
    }

    function parseAndRender(rawText, label) {
      log('Разбор JSON: ' + label, 'info');
      const items = readItemsFromText(rawText);
      state.allItems = items;
      state.timeKeys = detectTimeKeys(items);
      renderTimeFilters();
      state.sortMode = els.sortMode.value;
      state.visibleItems = items.slice();
      updateSummary();
      renderCards(items);
      updateActionsState();
      const timeText = state.timeKeys.length ? 'Найдены поля времени: ' + state.timeKeys.map(displayText).join(', ') : 'Поля времени не найдены';
      setStatus('Загружено объектов: ' + items.length + '. ' + timeText, state.timeKeys.length ? 'ok' : 'warn');
      log('JSON распарсен: ' + items.length + ' объектов.', 'ok');
      log(timeText + '.', state.timeKeys.length ? 'ok' : 'warn');
    }

    async function loadPreviewImages(options = {}) {
      const urls = collectUrls(state.visibleItems);
      if (!urls.length) {
        if (!options.silent) setStatus('Ссылок для поиска фото нет.', 'warn');
        return;
      }

      const missingItems = state.visibleItems.filter((item) => getLink(item) && !getImageUrl(item));
      if (!missingItems.length) {
        if (!options.silent) {
          setStatus('Фото уже есть для текущих карточек.', 'ok');
          log('Поиск фото не нужен: в текущем списке уже есть изображения.', 'ok');
        }
        return;
      }

      state.imageLoading = true;
      updateActionsState();
      if (!options.silent) setStatus('Ищу фото по ссылкам Avito...', 'ok');
      log('Поиск фото по url: ' + missingItems.length + ' объявлений.', 'info');

      try {
        const response = await fetch('/api/preview-images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: missingItems, limit: 80 }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось получить фото.');

        let found = 0;
        Object.entries(data.results || {}).forEach(([url, imageUrl]) => {
          if (imageUrl) {
            state.imageCache.set(url, imageUrl);
            found += 1;
          }
        });

        renderCards(state.visibleItems);
        setStatus('Фото найдено: ' + found + ' из ' + missingItems.length + '.', found ? 'ok' : 'warn');
        log('Поиск фото завершён: найдено ' + found + ' из ' + missingItems.length + '.', found ? 'ok' : 'warn');
      } catch (error) {
        const message = error?.message || String(error);
        setStatus('Фото не удалось получить: ' + message, 'warn');
        log('Ошибка поиска фото: ' + message, 'warn');
      } finally {
        state.imageLoading = false;
        updateActionsState();
      }
    }

    async function loadFile(file) {
      state.fileName = file.name;
      els.fileName.textContent = file.name;
      log('Выбран файл: ' + file.name + ' (' + file.size + ' байт).', 'info');
      const text = await file.text();
      state.rawText = text;
      parseAndRender(text, 'файл ' + file.name);
    }

    async function handleFileInput() {
      const file = els.fileInput.files?.[0];
      if (!file) return;

      try {
        await loadFile(file);
      } catch (error) {
        const message = error?.message || String(error);
        setStatus('Не удалось прочитать файл: ' + message, 'bad');
        log('Ошибка чтения файла: ' + message, 'bad');
      }
    }

    function handleShow() {
      if (!state.rawText) {
        const file = els.fileInput.files?.[0];
        if (file) {
          handleFileInput();
          return;
        }
        setStatus('Сначала выбери JSON-файл.', 'warn');
        log('Нажата кнопка "Показать карточки", но файл не выбран.', 'warn');
        return;
      }

      try {
        parseAndRender(state.rawText, state.fileName || 'текущий JSON');
      } catch (error) {
        const message = error?.message || String(error);
        setStatus('JSON не загружен: ' + message, 'bad');
        log('Ошибка загрузки JSON: ' + message, 'bad');
      }
    }

    function handleFilter(options = {}) {
      state.excludeTerms = parseTerms(els.excludeTitle.value);
      if (!state.allItems.length) {
        setStatus('Сначала загрузи JSON.', 'warn');
        log('Фильтр не применён: данных ещё нет.', 'warn');
        return;
      }

      if (!state.timeKeys.length) {
        setStatus('Поля времени не найдены.', 'warn');
        log('Фильтр не применён: поля времени не найдены.', 'warn');
        return;
      }

      const invalidTimeKeys = getInvalidTimeLimits();
      if (invalidTimeKeys.length) {
        const names = invalidTimeKeys.map(displayText).join(', ');
        setStatus('Проверь лимиты времени для полей: ' + names, 'bad');
        log('Фильтр не применён: неверные лимиты для полей ' + names + '.', 'warn');
        return;
      }

      const filtered = applyFilter(state.allItems);
      state.visibleItems = filtered;
      state.sortMode = els.sortMode.value;
      renderCards(filtered);
      updateSummary();
      updateActionsState();
      const excludedText = state.excludeTerms.length ? ' исключения: ' + state.excludeTerms.join(', ') : '';
      const limitText = state.timeKeys
        .map((key) => displayText(key) + ' до ' + state.timeLimits[key] + ' мин')
        .join(', ');
      setStatus('Фильтр: ' + limitText + excludedText + ': ' + filtered.length + ' из ' + state.allItems.length, 'ok');
      log('Фильтр применён: ' + limitText + excludedText + ', осталось ' + filtered.length + ' из ' + state.allItems.length, 'ok');
      if (options.fetchImages) {
        void loadPreviewImages({ silent: true });
      }
    }

    function handleReset() {
      if (!state.allItems.length) return;
      state.visibleItems = state.allItems.slice();
      state.sortMode = els.sortMode.value;
      renderTimeFilters();
      renderCards(state.visibleItems);
      updateSummary();
      updateActionsState();
      setStatus('Показаны все объекты: ' + state.allItems.length, 'ok');
      log('Сброс фильтра, показаны все объекты.', 'info');
    }

    function clearLogs() {
      state.logs = [];
      renderLogs();
      log('Журнал очищен.', 'info');
    }

    els.fileInput.addEventListener('change', handleFileInput);
    els.showButton.addEventListener('click', handleShow);
    els.filterButton.addEventListener('click', () => handleFilter({ fetchImages: true }));
    els.resetButton.addEventListener('click', handleReset);
    els.imageButton.addEventListener('click', () => loadPreviewImages());
    els.downloadUrlsButton.addEventListener('click', downloadUrlsFile);
    els.downloadButton.addEventListener('click', downloadJsonFile);
    els.clearLogs.addEventListener('click', clearLogs);
    els.sortMode.addEventListener('change', () => {
      state.sortMode = els.sortMode.value;
      if (!state.allItems.length) return;
      renderCards(state.visibleItems);
      log('Сортировка изменена на "' + els.sortMode.value + '".', 'info');
    });
    els.excludeTitle.addEventListener('change', () => {
      if (state.allItems.length) handleFilter();
    });
    els.excludeTitle.addEventListener('keyup', (event) => {
      if (event.key === 'Enter' && state.allItems.length) handleFilter();
    });
    els.timeFilters.addEventListener('input', (event) => {
      if (!event.target.classList.contains('time-limit-input')) return;
      readTimeLimitsFromInputs();
      if (state.allItems.length) handleFilter();
    });

    log('Интерфейс готов.', 'ok');
    renderLogs();
    updateActionsState();
  </script>
</body>
</html>`;

const mergePage = String.raw`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JSON Merger</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #070b14;
      --panel: rgba(15, 20, 33, 0.92);
      --panel-strong: #12192a;
      --text: #eef3fb;
      --muted: #9ea9bc;
      --line: #223046;
      --accent: #6ea8ff;
      --accent-strong: #8bbcff;
      --good: #57d6b0;
      --warn: #f2c36b;
      --shadow: 0 22px 50px rgba(0, 0, 0, 0.42);
      --radius: 16px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(110, 168, 255, 0.16), transparent 30%),
        radial-gradient(circle at top right, rgba(87, 214, 176, 0.08), transparent 24%),
        linear-gradient(180deg, #070b14 0%, #0b1220 100%);
      font-family: Inter, "Segoe UI", Arial, sans-serif;
    }
    .app {
      width: min(1100px, calc(100vw - 24px));
      margin: 0 auto;
      padding: 18px 0 22px;
    }
    .hero, .panel {
      border: 1px solid rgba(110, 168, 255, 0.14);
      border-radius: var(--radius);
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .hero {
      padding: 18px 20px;
      margin-bottom: 14px;
      background: linear-gradient(180deg, rgba(18,25,42,0.96), rgba(12,18,31,0.96));
    }
    .hero-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    h1 { margin: 0; font-size: 28px; letter-spacing: -0.02em; }
    p { margin: 10px 0 0; color: var(--muted); line-height: 1.55; max-width: 840px; }
    .back-link, .action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      padding: 0 14px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 800;
      white-space: nowrap;
    }
    .back-link {
      border: 1px solid rgba(110, 168, 255, 0.18);
      background: rgba(17, 25, 42, 0.9);
      color: var(--text);
    }
    .back-link:hover { border-color: rgba(139, 188, 255, 0.55); }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 16px;
      background: var(--panel-strong);
      border-bottom: 1px solid var(--line);
    }
    .panel-title { font-size: 15px; font-weight: 800; }
    .status { color: var(--muted); font-size: 13px; }
    .body {
      display: grid;
      gap: 12px;
      padding: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .field {
      display: grid;
      gap: 6px;
      font-size: 13px;
      font-weight: 700;
      color: #c9d5e5;
    }
    input[type="file"] {
      width: 100%;
      min-height: 42px;
      padding: 8px 10px;
      border: 1px solid rgba(110, 168, 255, 0.16);
      border-radius: 12px;
      background: #0c1322;
      color: var(--muted);
    }
    .row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .action-btn {
      border: 1px solid rgba(110, 168, 255, 0.16);
      background: var(--accent);
      color: #09111f;
      cursor: pointer;
    }
    .action-btn:hover { background: var(--accent-strong); }
    .action-btn.secondary {
      background: #11192a;
      color: var(--text);
    }
    .action-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      padding: 0 12px;
      border-radius: 999px;
      background: rgba(18, 25, 42, 0.86);
      border: 1px solid rgba(110, 168, 255, 0.18);
      color: var(--text);
      font-size: 13px;
      box-shadow: var(--shadow);
    }
    textarea {
      width: 100%;
      min-height: 280px;
      resize: vertical;
      border: 1px solid rgba(110, 168, 255, 0.16);
      border-radius: 14px;
      background: #0c1322;
      color: var(--text);
      padding: 14px;
      font: 12px/1.5 "Cascadia Code", Consolas, monospace;
      outline: none;
      white-space: pre;
    }
    textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(110, 168, 255, 0.16);
    }
    .small {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    @media (max-width: 920px) {
      .app { width: min(100vw - 16px, 760px); padding-top: 10px; }
      h1 { font-size: 24px; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="app">
    <section class="hero">
      <div class="hero-top">
        <div>
          <h1>Объединение JSON</h1>
          <p>Выбери два JSON-файла, извлеки из них массивы и получи один объединённый массив для скачивания.</p>
        </div>
        <a class="back-link" href="/">На главный сайт</a>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title">Файлы</div>
        <div id="mergeStatus" class="status">Выбери два JSON-файла</div>
      </div>
      <div class="body">
        <div class="grid">
          <label class="field">
            Первый JSON
            <input id="fileA" type="file" accept=".json,application/json">
          </label>
          <label class="field">
            Второй JSON
            <input id="fileB" type="file" accept=".json,application/json">
          </label>
        </div>
        <div class="row">
          <button id="mergeBtn" class="action-btn" type="button" disabled>Объединить и скачать</button>
          <button id="clearBtn" class="action-btn secondary" type="button">Сбросить</button>
        </div>
        <div class="pill-row">
          <div class="pill">Файл 1: <strong id="fileAInfo" style="margin-left:6px;">не выбран</strong></div>
          <div class="pill">Файл 2: <strong id="fileBInfo" style="margin-left:6px;">не выбран</strong></div>
          <div class="pill">Итог объектов: <strong id="totalInfo" style="margin-left:6px;">0</strong></div>
        </div>
        <textarea id="preview" readonly placeholder="Здесь появится объединённый JSON..."></textarea>
        <div class="small">Поддерживается JSON-массив, а также объекты с полями <code>result</code>, <code>items</code> или <code>data</code>.</div>
      </div>
    </section>
  </main>

  <script>
    const els = {
      fileA: document.querySelector('#fileA'),
      fileB: document.querySelector('#fileB'),
      mergeBtn: document.querySelector('#mergeBtn'),
      clearBtn: document.querySelector('#clearBtn'),
      mergeStatus: document.querySelector('#mergeStatus'),
      fileAInfo: document.querySelector('#fileAInfo'),
      fileBInfo: document.querySelector('#fileBInfo'),
      totalInfo: document.querySelector('#totalInfo'),
      preview: document.querySelector('#preview'),
    };

    const state = {
      files: [null, null],
      arrays: [[], []],
      merged: [],
    };

    function escText(value) {
      return String(value ?? '');
    }

    function setStatus(text, tone = 'info') {
      els.mergeStatus.textContent = text;
      els.mergeStatus.style.color = tone === 'ok' ? 'var(--good)' : tone === 'warn' ? 'var(--warn)' : 'var(--muted)';
    }

    function unwrapJson(value) {
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.result)) return value.result;
      if (Array.isArray(value?.items)) return value.items;
      if (Array.isArray(value?.data)) return value.data;
      throw new Error('JSON должен быть массивом или объектом с result/items/data.');
    }

    async function readFile(file) {
      const text = await file.text();
      return unwrapJson(JSON.parse(text));
    }

    function updateUi() {
      els.fileAInfo.textContent = state.files[0]?.name || 'не выбран';
      els.fileBInfo.textContent = state.files[1]?.name || 'не выбран';
      els.totalInfo.textContent = String(state.merged.length);
      els.preview.value = state.merged.length ? JSON.stringify(state.merged, null, 2) : '';
      els.mergeBtn.disabled = !(state.arrays[0].length && state.arrays[1].length);
    }

    async function handleFileInput(index) {
      const file = index === 0 ? els.fileA.files?.[0] : els.fileB.files?.[0];
      state.files[index] = file || null;
      if (!file) {
        state.arrays[index] = [];
        updateUi();
        return;
      }

      try {
        setStatus('Читаю ' + file.name + '...', 'info');
        state.arrays[index] = await readFile(file);
        setStatus('Файл ' + (index + 1) + ' загружен: ' + state.arrays[index].length + ' объектов.', 'ok');
      } catch (error) {
        state.arrays[index] = [];
        const message = error?.message || String(error);
        setStatus('Ошибка: ' + message, 'warn');
      }

      updateUi();
    }

    function mergeFiles() {
      const merged = [...state.arrays[0], ...state.arrays[1]];
      state.merged = merged;
      updateUi();

      const blob = new Blob([JSON.stringify(merged, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'merged-json-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('Объединено объектов: ' + merged.length + '.', 'ok');
    }

    function resetAll() {
      state.files = [null, null];
      state.arrays = [[], []];
      state.merged = [];
      els.fileA.value = '';
      els.fileB.value = '';
      setStatus('Выбери два JSON-файла', 'info');
      updateUi();
    }

    els.fileA.addEventListener('change', () => handleFileInput(0));
    els.fileB.addEventListener('change', () => handleFileInput(1));
    els.mergeBtn.addEventListener('click', mergeFiles);
    els.clearBtn.addEventListener('click', resetAll);

    updateUi();
  </script>
</body>
</html>`;

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/') {
        htmlResponse(res, page);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/merge') {
        htmlResponse(res, mergePage);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/preview-images') {
        await handlePreviewImages(req, res);
        return;
      }

      jsonResponse(res, 404, { error: 'Not found' });
    } catch (error) {
      jsonResponse(res, 500, { error: error?.message || String(error) });
    }
  });
}

function listenWithFallback(startPort, attemptsLeft = MAX_PORT_ATTEMPTS) {
  const server = createServer();

  server.once('error', (error) => {
    if (error?.code === 'EADDRINUSE' && attemptsLeft > 0) {
      const nextPort = startPort + 1;
      console.warn(`Port ${startPort} занят, пробую ${nextPort}...`);
      listenWithFallback(nextPort, attemptsLeft - 1);
      return;
    }

    throw error;
  });

  server.listen(startPort, () => {
    console.log(`Avito Transit site: http://localhost:${startPort}`);
  });
}

listenWithFallback(PORT);

