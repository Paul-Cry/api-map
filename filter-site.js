import http from 'node:http';

const PORT = Number(process.env.PORT || 4173);
const MAX_PORT_ATTEMPTS = 10;

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
      grid-template-columns: 1.5fr 0.7fr 1fr 0.8fr auto auto auto auto;
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
      gap: 8px;
      padding: 12px 14px;
      border: 1px solid rgba(110, 168, 255, 0.13);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(18,25,42,0.96), rgba(13,19,31,0.96));
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.26);
      transition: transform 150ms ease, box-shadow 150ms ease, border-color 150ms ease;
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
  </style>
</head>
<body>
  <main class="app">
    <section class="hero">
      <h1>Avito Transit</h1>
      <p>Загрузи JSON-файл, получи ленту карточек объявлений и отфильтруй их по времени в пути. Карточка показывает название, цену, адрес, описание и ссылку на открытие объявления.</p>
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
        До, минут
        <input id="filterMinutes" type="number" min="1" step="1" value="60">
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
      <button id="downloadButton" class="download-btn" type="button" disabled>Скачать JSON</button>
    </section>

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

    const els = {
      fileInput: document.querySelector('#fileInput'),
      filterMinutes: document.querySelector('#filterMinutes'),
      excludeTitle: document.querySelector('#excludeTitle'),
      sortMode: document.querySelector('#sortMode'),
      showButton: document.querySelector('#showButton'),
      filterButton: document.querySelector('#filterButton'),
      resetButton: document.querySelector('#resetButton'),
      downloadButton: document.querySelector('#downloadButton'),
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
      excludeTerms: [],
      sortMode: 'time',
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

      const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:ч|час)/);
      const minuteMatch = text.match(/(\d+)\s*(?:мин|м\b)/);
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

    function detectTimeKeys(items) {
      const keys = new Set(items.flatMap((item) => Object.keys(item)));
      const preferred = preferredTimeKeys.filter((key) => keys.has(key));
      if (preferred.length) return preferred;

      return [...keys].filter((key) => {
        const values = items
          .map((item) => item[key])
          .filter((value) => value !== undefined && value !== null);
        return values.length > 0 && values.some(isTimeValue);
      });
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

    function getPrimaryTimeMinutes(item) {
      return getBestTimeMinutes(item);
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
      return item.url || '';
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
      els.filterButton.disabled = !hasItems || !state.timeKeys.length;
      els.resetButton.disabled = !hasItems;
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

    function readItemsFromText(text) {
      const parsed = unwrapJson(JSON.parse(text));
      if (!parsed.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
        throw new Error('В массиве должны быть только объекты объявлений.');
      }
      return parsed;
    }

    function applyFilter(items, maxMinutes) {
      let filtered = items;
      if (state.timeKeys.length) {
        filtered = filtered.filter((item) => state.timeKeys.every((key) => parseTransitMinutes(item[key]) <= maxMinutes));
      }
      filtered = applyExclusions(filtered);
      return filtered;
    }

    function updateSummary() {
      els.fileName.textContent = state.fileName || 'не выбран';
      els.countInfo.textContent = String(state.visibleItems.length);
      els.timeInfo.textContent = state.timeKeys.length ? state.timeKeys.join(', ') : 'нет';
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

      const timeKeys = state.timeKeys.slice(0, 2);
      els.feed.className = 'feed';
      els.feed.innerHTML = ordered.map((item) => {
        const title = getTitle(item);
        const price = getPrice(item);
        const address = getAddress(item);
        const description = getDescription(item);
        const link = getLink(item);
        const primaryTime = getPrimaryTimeMinutes(item);
        const titleMarkup = link
          ? '<a class="title" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + '</a>'
          : '<div class="title">' + esc(title) + '</div>';
        const timeMarkup = timeKeys.length
          ? '<div class="time-row">' +
              (Number.isFinite(primaryTime)
                ? '<span class="time-pill primary">Время: ' + esc(primaryTime) + ' мин</span>'
                : '<span class="time-pill primary">Время: нет данных</span>') +
              timeKeys.map((key) => '<span class="time-pill">' + esc(key) + ': ' + esc(item[key] ?? '') + '</span>').join('') +
            '</div>'
          : '';
        const linkMarkup = link
          ? '<a class="link-btn" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Открыть</a>'
          : '<span class="link-btn disabled">Ссылка не найдена</span>';

        return [
          '<article class="card">',
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
      state.sortMode = els.sortMode.value;
      state.visibleItems = items.slice();
      updateSummary();
      renderCards(items);
      updateActionsState();
      const timeText = state.timeKeys.length ? 'Найдены поля времени: ' + state.timeKeys.join(', ') : 'Поля времени не найдены';
      setStatus('Загружено объектов: ' + items.length + '. ' + timeText, state.timeKeys.length ? 'ok' : 'warn');
      log('JSON распарсен: ' + items.length + ' объектов.', 'ok');
      log(timeText + '.', state.timeKeys.length ? 'ok' : 'warn');
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

    function handleFilter() {
      const maxMinutes = Number(els.filterMinutes.value || 0);
      state.excludeTerms = parseTerms(els.excludeTitle.value);
      if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
        setStatus('Укажи лимит времени больше 0 минут.', 'bad');
        log('Фильтр не применён: неверный лимит "' + els.filterMinutes.value + '".', 'warn');
        return;
      }

      if (!state.allItems.length) {
        setStatus('Сначала загрузи JSON.', 'warn');
        log('Фильтр не применён: данных ещё нет.', 'warn');
        return;
      }

      const filtered = applyFilter(state.allItems, maxMinutes);
      state.visibleItems = filtered;
      state.sortMode = els.sortMode.value;
      renderCards(filtered);
      updateSummary();
      updateActionsState();
      const excludedText = state.excludeTerms.length ? ' исключения: ' + state.excludeTerms.join(', ') : '';
      setStatus('Фильтр до ' + maxMinutes + ' мин' + excludedText + ': ' + filtered.length + ' из ' + state.allItems.length, 'ok');
      log('Фильтр применён: до ' + maxMinutes + ' мин' + excludedText + ', осталось ' + filtered.length + ' из ' + state.allItems.length, 'ok');
    }

    function handleReset() {
      if (!state.allItems.length) return;
      state.visibleItems = state.allItems.slice();
      state.sortMode = els.sortMode.value;
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
    els.filterButton.addEventListener('click', handleFilter);
    els.resetButton.addEventListener('click', handleReset);
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
    els.filterMinutes.addEventListener('input', () => {
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
  return http.createServer((req, res) => {
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

