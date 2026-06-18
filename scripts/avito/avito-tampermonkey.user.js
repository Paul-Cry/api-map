// ==UserScript==
// @name         Avito Listing Collector
// @namespace    local.codex.avito
// @version      1.2.0
// @description  Avito diagnostics and collector.
// @match        https://www.avito.ru/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'codex_avito_collector_items';
  const PROCESSED_KEY = 'codex_avito_collector_processed_urls';
  const LOGS_KEY = 'codex_avito_collector_logs';
  const SESSION_KEY = 'codex_avito_collector_session';
  const RUN_ACTIVE_KEY = 'codex_avito_collector_run_active';
  const AUTO_SCROLL_DURATION_MS = 12000;
  const AUTO_SCROLL_STEP_MS = 400;
  let bootstrapStarted = false;
  let collectionInProgress = false;
  let navigationWatcher = null;
  let autoPageAdvanceInProgress = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/(\d)([A-Za-zА-Яа-яЁё])/g, '$1 $2')
      .replace(/([A-Za-zА-Яа-яЁё])(\d)/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isInsideCarousel(card) {
    return Boolean(
      card?.closest(
        '.index-carousel-3Fpgn, [class*="index-carousel"], [class*="carousel"]'
      )
    );
  }

  function isMetroOrTravelLine(value) {
    const text = normalizeText(value).toLowerCase();
    if (!text) return false;

    return text.includes('мин') || text.includes('метро') || /\b(?:от|до)\s*\d/i.test(text) || /\d+\s*[–-]\s*\d+/i.test(text);
  }

  function isRegionLine(value) {
    const text = normalizeText(value).trim();
    if (!text || isMetroOrTravelLine(text)) {
      return false;
    }

    if (/\d/.test(text)) {
      return false;
    }

    return /^[\p{L}\s.-]+$/u.test(text);
  }

  function extractAddressText(addressNode) {
    if (!addressNode) return '';

    const streetNode = addressNode.querySelector('[data-marker="street_link"]');
    const houseNode = addressNode.querySelector('[data-marker="house_link"]');
    const directLines = Array.from(addressNode.querySelectorAll(':scope > p'))
      .map((node) => normalizeText(node.textContent))
      .filter(Boolean);
    const lines = directLines.length > 0
      ? directLines
      : Array.from(addressNode.querySelectorAll('p')).map((node) => normalizeText(node.textContent)).filter(Boolean);

    const cityLine = isRegionLine(lines[1]) ? lines[1] : '';
    const streetText = normalizeText(streetNode?.textContent);
    const houseText = normalizeText(houseNode?.textContent);
    const streetHouseText = streetText && houseText
      ? `${streetText}, ${houseText}`
      : [streetText, houseText].filter(Boolean).join(' ');

    const base = streetHouseText || lines[0] || '';
    return [cityLine, base].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function normalizeListingUrl(url) {
    if (!url) return null;

    try {
      const parsed = new URL(url, location.origin);
      parsed.hash = '';
      parsed.search = '';
      return parsed.href;
    } catch {
      return String(url).split('#')[0].split('?')[0] || null;
    }
  }

  function extractListingIdFromUrl(url) {
    const cleanUrl = normalizeListingUrl(url);
    if (!cleanUrl) return null;

    try {
      const { pathname } = new URL(cleanUrl, location.origin);
      const match = pathname.match(/_(\d{6,})(?:\/)?$/) || pathname.match(/\/(\d{6,})(?:\/)?$/);
      return match?.[1] || null;
    } catch {
      const match = cleanUrl.match(/_(\d{6,})(?:\/)?(?:$|[?#])/);
      return match?.[1] || null;
    }
  }

  function extractListingId(card, url) {
    const attributeSources = [
      card,
      card?.querySelector('[data-item-id], [data-id], [id]'),
      card?.querySelector('[data-marker="item-title"], [data-marker="item-photo-sliderLink"]'),
    ];

    for (const node of attributeSources) {
      const id =
        node?.getAttribute?.('data-item-id') ||
        node?.getAttribute?.('data-id') ||
        node?.id;

      if (/^\d{6,}$/.test(String(id || ''))) {
        return String(id);
      }
    }

    return extractListingIdFromUrl(url);
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value || '');

    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(36);
  }

  function createFallbackListingId(item) {
    const source = [
      normalizeListingUrl(item.url),
      item.title,
      item.price,
      item.adress,
      item.dop,
    ].filter(Boolean).join('|');

    return source ? `fallback_${hashString(source)}` : null;
  }

  function ensureListingId(item) {
    if (!item || typeof item !== 'object') return null;
    if (item.id) return item.id;

    item.id = extractListingIdFromUrl(item.url) || createFallbackListingId(item);
    return item.id;
  }

  function getListingDedupKeys(item) {
    const id = ensureListingId(item);
    const fallbackKey = [item?.title, item?.price, item?.adress].filter(Boolean).join('|');
    return Array.from(new Set([
      id,
      extractListingIdFromUrl(item?.url),
      normalizeListingUrl(item?.url),
      fallbackKey || null,
    ].filter(Boolean)));
  }

  function getJsonValue(key, fallback) {
    try {
      const raw = GM_getValue(key, JSON.stringify(fallback));
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function setJsonValue(key, value) {
    GM_setValue(key, JSON.stringify(value));
  }

  function getItems() {
    const items = getJsonValue(STORE_KEY, []);
    return Array.isArray(items) ? items : [];
  }

  function setItems(items) {
    setJsonValue(STORE_KEY, items);
  }

  function getProcessedUrls() {
    const urls = getJsonValue(PROCESSED_KEY, []);
    return Array.isArray(urls) ? urls : [];
  }

  function setProcessedUrls(urls) {
    setJsonValue(PROCESSED_KEY, urls);
  }

  function getLogs() {
    const logs = getJsonValue(LOGS_KEY, []);
    return Array.isArray(logs) ? logs : [];
  }

  function setLogs(logs) {
    setJsonValue(LOGS_KEY, logs.slice(-300));
  }

  function getSession() {
    return getJsonValue(SESSION_KEY, {
      running: false,
      startedAt: null,
      lastUrl: null,
    });
  }

  function setSession(session) {
    setJsonValue(SESSION_KEY, session);
  }

  function resetCollectedData() {
    setItems([]);
    setProcessedUrls([]);
  }

  function isRunActiveInCurrentTab() {
    return GM_getValue(RUN_ACTIVE_KEY, false) === true;
  }

  function setRunActiveInCurrentTab(active) {
    GM_setValue(RUN_ACTIVE_KEY, active === true);
  }

  function timestamp() {
    return new Date().toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function appendLogLine(message) {
    const logs = getLogs();
    logs.push(`[${timestamp()}] ${message}`);
    setLogs(logs);
  }

  function renderLogWindow() {
    const body = document.getElementById('codex-avito-log-body');
    const header = document.getElementById('codex-avito-log-header');
    if (header) {
      const session = getSession();
      header.textContent = session.running
        ? `Сессия активна. Собрано записей: ${getItems().length}`
        : `Сессия остановлена. Собрано записей: ${getItems().length}`;
    }
    if (body) {
      body.textContent = getLogs().join('\n');
      body.scrollTop = body.scrollHeight;
    }
  }

  function ensureLogPanelVisible() {
    const panel = document.getElementById('codex-avito-log');
    if (panel) {
      panel.style.display = 'block';
      panel.classList.add('visible');
    }
    renderLogWindow();
  }

  function showStartupBanner() {
    if (document.getElementById('codex-avito-startup-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'codex-avito-startup-banner';
    banner.textContent = `Tampermonkey script active on Avito: ${location.hostname}`;
    banner.style.cssText = [
      'position: fixed',
      'top: 12px',
      'left: 50%',
      'transform: translateX(-50%)',
      'z-index: 2147483647',
      'background: #d7263d',
      'color: #fff',
      'padding: 12px 18px',
      'border-radius: 999px',
      'font: 700 14px/1.2 Arial, sans-serif',
      'box-shadow: 0 12px 30px rgba(0,0,0,0.35)',
      'border: 2px solid rgba(255,255,255,0.15)',
      'pointer-events: none',
    ].join(';');
    document.body.appendChild(banner);
    setTimeout(() => {
      banner.remove();
    }, 8000);
  }

  function log(message) {
    console.log(`[Avito Collector] ${message}`);
    appendLogLine(message);
    renderLogWindow();
    updateActionPanel();
  }

  function showToast(message) {
    let toast = document.getElementById('codex-avito-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'codex-avito-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(showToast.hideTimer);
    showToast.hideTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 2000);
  }

  function extractListingItem(card) {
    if (isInsideCarousel(card)) {
      return null;
    }

    const priceNode = card.querySelector('[data-marker="item-price-value"], .item-price-value, [class*="item-price-value"]');
    const titleNode = card.querySelector('.iva-item-title-KE8A9, [class*="iva-item-title"]');
    const addressNode = card.querySelector('[data-marker="item-location"]');
    const paramsNode = card.querySelector('[data-marker="item-specific-params"]');
    const descriptionNode = card.querySelector(
      '[data-name="Description"] p, [data-name="Description"], .iva-item-bottomBlock-VewGa p, .iva-item-bottomBlock-VewGa, [class*="iva-item-bottomBlock"] p, [class*="iva-item-bottomBlock"]'
    );
    const imageNode = card.querySelector(
      'img[src], img[data-src], img[data-url], img[data-img-src], picture source[srcset], source[srcset]'
    );
    const linkNode = card.querySelector('a[href]');
    const url = linkNode?.href || null;
    const id = extractListingId(card, url);
    const imageUrl =
      imageNode?.getAttribute('data-src') ||
      imageNode?.getAttribute('data-url') ||
      imageNode?.getAttribute('data-img-src') ||
      imageNode?.getAttribute('src') ||
      imageNode?.getAttribute('srcset')?.split(',')?.[0]?.trim()?.split(' ')?.[0] ||
      null;

    const item = {
      id,
      title: normalizeText(titleNode?.textContent),
      price: normalizeText(priceNode?.textContent),
      adress: extractAddressText(addressNode),
      dop: normalizeText(paramsNode?.textContent),
      description: normalizeText(descriptionNode?.textContent),
      image: imageUrl,
      url,
    };
    ensureListingId(item);
    return item;
  }

  async function collectVisibleListings() {
    const selectors = ['#bx_serp-item-list [data-marker="item"]', '[data-marker="item"]'];
    let cards = [];

    for (const selector of selectors) {
      cards = Array.from(document.querySelectorAll(selector)).filter((card) => !isInsideCarousel(card));
      if (cards.length > 0) break;
    }

    return cards.map((card) => extractListingItem(card)).filter(Boolean);
  }

  async function waitForCards(timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const cards = Array.from(document.querySelectorAll('#bx_serp-item-list [data-marker="item"], [data-marker="item"]')).filter(
        (card) => !isInsideCarousel(card)
      );
      if (cards.length > 0) return true;
      await sleep(1000);
    }
    return false;
  }

  function isElementVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function findNextPageElement() {
    const selectors = [
      'a[rel="next"]',
      '[data-marker="pagination-button/next"]',
      'button[aria-label*="следующ" i]',
      'a[aria-label*="следующ" i]',
      '[data-marker*="pagination"] a[href*="p="]',
      '[data-marker*="pagination"] button',
      'a[href*="p="]',
      'button',
      'a',
    ];

    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      const matched = elements.find((element) => {
        if (!isElementVisible(element)) return false;
        const text = normalizeText(element.textContent).toLowerCase();
        const aria = normalizeText(element.getAttribute('aria-label')).toLowerCase();
        const title = normalizeText(element.getAttribute('title')).toLowerCase();
        return (
          text.includes('следующ') ||
          aria.includes('следующ') ||
          title.includes('следующ') ||
          text === 'next' ||
          aria === 'next'
        );
      });

      if (matched) {
        return matched;
      }
    }

    return null;
  }

  function getPageNumberFromUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      return Number(parsed.searchParams.get('p') || '1') || 1;
    } catch {
      return 1;
    }
  }

  function findNextPageHrefByNumber() {
    const currentPage = getPageNumberFromUrl(location.href);
    const expectedPage = String(currentPage + 1);
    const currentPath = location.pathname;
    const links = Array.from(document.querySelectorAll('a[href*="p="]'));

    for (const link of links) {
      if (!isElementVisible(link)) continue;

      try {
        const parsed = new URL(link.href, location.origin);
        if (parsed.pathname === currentPath && parsed.searchParams.get('p') === expectedPage) {
          return parsed.href;
        }
      } catch {
        // Ignore malformed hrefs from widgets and ads.
      }
    }

    return null;
  }

  async function scrollPageForPagination(durationMs = AUTO_SCROLL_DURATION_MS) {
    const endAt = Date.now() + durationMs;
    while (Date.now() < endAt) {
      window.scrollBy({
        top: Math.max(450, Math.floor(window.innerHeight * 0.85)),
        left: 0,
        behavior: 'smooth',
      });
      await sleep(AUTO_SCROLL_STEP_MS);
    }
  }

  async function clickNextPage() {
    const element = findNextPageElement();
    const numericNextHref = findNextPageHrefByNumber();
    if (!element && !numericNextHref) {
      return false;
    }

    setRunActiveInCurrentTab(true);

    if (element) {
      const link = element.closest('a[href]') || element.querySelector?.('a[href]');
      const href = link?.href || (element.tagName === 'A' ? element.href : null);

      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      await sleep(300);

      if (href) {
        location.href = href;
      } else {
        element.click();
      }
    } else {
      location.href = numericNextHref;
    }

    return true;
  }

  async function advanceToNextPage() {
    if (autoPageAdvanceInProgress) {
      return;
    }

    const session = getSession();
    if (!session.running) {
      return;
    }

    autoPageAdvanceInProgress = true;
    try {
      log(`Автопрокрутка страницы ${AUTO_SCROLL_DURATION_MS / 1000} секунд перед переходом дальше.`);
      await scrollPageForPagination(AUTO_SCROLL_DURATION_MS);

      if (!getSession().running) {
        return;
      }

      const clicked = await clickNextPage();
      if (clicked) {
        log('Нажал на следующую страницу.');
      } else {
        log('Не нашёл кнопку следующей страницы. Останавливаю сессию.');
        stopSession();
      }
    } catch (error) {
      log(`Ошибка автоперехода: ${error?.message || error}`);
    } finally {
      autoPageAdvanceInProgress = false;
    }
  }

  async function collectCurrentPage() {
    if (collectionInProgress) {
      return;
    }

    collectionInProgress = true;
    try {
      const session = getSession();
      const url = location.href;
      const processedUrls = getProcessedUrls();
      if (processedUrls.includes(url)) {
        if (session.running) {
          advanceToNextPage();
        }
        log(`Страница уже собрана: ${url}`);
        return;
      }

      log(`Жду карточки на странице: ${url}`);
      const hasCards = await waitForCards();
      if (!hasCards) {
        log('Карточки не появились за отведённое время.');
        return;
      }

      const items = await collectVisibleListings();
      if (items.length === 0) {
        log('Карточки найдены, но извлечь данные не удалось.');
        return;
      }

      const existing = getItems();
      const seen = new Set();
      for (const item of existing) {
        for (const key of getListingDedupKeys(item)) {
          seen.add(key);
        }
      }
      let added = 0;

      for (const item of items) {
        const keys = getListingDedupKeys(item);
        if (!keys.some((key) => seen.has(key))) {
          existing.push(item);
          for (const key of keys) {
            seen.add(key);
          }
          added += 1;
        }
      }

      setItems(existing);
      processedUrls.push(url);
      setProcessedUrls(processedUrls);
      if (session.running) {
        advanceToNextPage();
      }

      log(`Собрано ${items.length} объявлений на странице. Добавлено новых: ${added}. Всего в массиве items: ${existing.length}.`);
      showToast(`Собрано ${items.length} объявлений`);
    } finally {
      collectionInProgress = false;
    }
  }

  function downloadJson() {
    const items = getItems();
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const filename = `avito-listings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log(`Скачивание файла начато: ${filename}`);
  }

  function clearData() {
    setItems([]);
    setProcessedUrls([]);
    setLogs([]);
    setSession({
      running: false,
      startedAt: null,
      lastUrl: null,
    });
    setRunActiveInCurrentTab(false);
    renderLogWindow();
    updateActionPanel();
    log('Локальное хранилище очищено.');
  }

  function stopSession() {
    const session = getSession();
    session.running = false;
    setSession(session);
    setRunActiveInCurrentTab(false);
    if (navigationWatcher) {
      clearInterval(navigationWatcher);
      navigationWatcher = null;
      autoPageAdvanceInProgress = false;
    }
    autoPageAdvanceInProgress = false;
    log('Сессия остановлена.');
  }

  async function startSession({ resetData = true } = {}) {
    if (resetData) {
      resetCollectedData();
    }

    setRunActiveInCurrentTab(true);

    const session = getSession();
    session.running = true;
    session.startedAt = new Date().toISOString();
    session.lastUrl = location.href;
    setSession(session);

    ensureLogPanelVisible();
    renderLogWindow();
    updateActionPanel();

    if (navigationWatcher) {
      clearInterval(navigationWatcher);
      navigationWatcher = null;
    }

    navigationWatcher = setInterval(() => {
      const currentSession = getSession();
      if (!currentSession.running) {
        return;
      }

      const currentUrl = location.href;
      if (currentSession.lastUrl !== currentUrl) {
        currentSession.lastUrl = currentUrl;
        setSession(currentSession);
        log(`Обнаружена новая страница: ${currentUrl}`);
        collectCurrentPage().catch((error) => {
          log(`Ошибка при сборе страницы: ${error?.message || error}`);
        });
      }
    }, 1500);

    log('Скрипт запущен. Панель логов открыта.');
    await collectCurrentPage();
    updateActionPanel();
  }

  function updateActionPanel() {
    const countNode = document.getElementById('codex-avito-count');
    const statusNode = document.getElementById('codex-avito-status');
    const session = getSession();

    if (countNode) {
      countNode.textContent = `Записей в массиве items: ${getItems().length}`;
    }

    if (statusNode) {
      statusNode.textContent = session.running ? 'Сессия активна' : 'Сессия не запущена';
      statusNode.classList.toggle('active', session.running);
    }
  }

  function createPanel() {
    if (document.getElementById('codex-avito-panel')) return;

    GM_addStyle(`
      #codex-avito-panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        background: rgba(12, 16, 24, 0.94);
        color: #fff;
        font: 13px/1.4 Arial, sans-serif;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 14px;
        padding: 14px;
        width: 280px;
        box-shadow: 0 14px 44px rgba(0,0,0,0.35);
        backdrop-filter: blur(10px);
      }
      #codex-avito-panel .title {
        font: 700 14px/1.2 Arial, sans-serif;
        margin-bottom: 6px;
      }
      #codex-avito-panel .meta {
        opacity: 0.85;
        margin-top: 6px;
        word-break: break-word;
      }
      #codex-avito-panel .status {
        margin-top: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(255,255,255,0.08);
        display: inline-block;
      }
      #codex-avito-panel .status.active {
        background: rgba(44, 196, 115, 0.2);
        color: #8ef0b8;
      }
      #codex-avito-panel button {
        display: block;
        width: 100%;
        margin-top: 8px;
        padding: 10px 12px;
        border: 0;
        border-radius: 10px;
        background: #2d7ff9;
        color: white;
        cursor: pointer;
        font-weight: 700;
      }
      #codex-avito-panel button.secondary {
        background: #3d4a60;
      }
      #codex-avito-panel button.danger {
        background: #b45309;
      }
      #codex-avito-toast {
        position: fixed;
        left: 50%;
        top: 18px;
        transform: translateX(-50%) translateY(-10px);
        z-index: 2147483647;
        background: rgba(20, 20, 20, 0.95);
        color: #fff;
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 999px;
        padding: 10px 16px;
        font: 600 13px/1.2 Arial, sans-serif;
        box-shadow: 0 10px 24px rgba(0,0,0,0.28);
        opacity: 0;
        transition: opacity 0.2s ease, transform 0.2s ease;
        pointer-events: none;
      }
      #codex-avito-toast.visible {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      #codex-avito-log {
        position: fixed;
        left: 16px;
        top: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: 380px;
        background: rgba(12, 16, 24, 0.94);
        color: #e5eefc;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 14px;
        box-shadow: 0 14px 44px rgba(0,0,0,0.35);
        backdrop-filter: blur(10px);
        display: none;
        overflow: hidden;
        font: 12px/1.5 Consolas, Monaco, monospace;
      }
      #codex-avito-log.visible {
        display: flex;
        flex-direction: column;
      }
      #codex-avito-log .log-head {
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.12);
        background: linear-gradient(180deg, rgba(19,28,44,1), rgba(17,24,39,1));
      }
      #codex-avito-log .log-title {
        font: 700 14px/1.2 Arial, sans-serif;
        color: #fff;
        margin-bottom: 6px;
      }
      #codex-avito-log .log-header {
        color: #a6b3c7;
        font: 12px/1.4 Arial, sans-serif;
      }
      #codex-avito-log-body {
        margin: 0;
        padding: 12px 14px;
        flex: 1;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
    `);

    const panel = document.createElement('div');
    panel.id = 'codex-avito-panel';
    panel.innerHTML = `
      <div class="title">Avito Collector</div>
      <div class="meta">Страница: ${location.href}</div>
      <div class="meta" id="codex-avito-count">Записей в массиве items: ${getItems().length}</div>
      <div class="status" id="codex-avito-status">Сессия не запущена</div>
      <button id="codex-avito-start">Запустить скрипт</button>
      <button id="codex-avito-open-log" class="secondary">Показать окно логов</button>
      <button id="codex-avito-download" class="secondary">Скачать JSON</button>
      <button id="codex-avito-stop" class="danger">Остановить</button>
      <button id="codex-avito-clear" class="secondary">Очистить данные</button>
    `;

    document.body.appendChild(panel);

    const logPanel = document.createElement('div');
    logPanel.id = 'codex-avito-log';
    logPanel.innerHTML = `
      <div class="log-head">
        <div class="log-title">Avito Log</div>
        <div class="log-header" id="codex-avito-log-header">Ожидание запуска...</div>
      </div>
      <pre id="codex-avito-log-body"></pre>
    `;
    document.body.appendChild(logPanel);

    panel.querySelector('#codex-avito-start').addEventListener('click', () => {
      startSession().catch((error) => {
        log(`Ошибка запуска: ${error?.message || error}`);
      });
    });

    panel.querySelector('#codex-avito-open-log').addEventListener('click', () => {
      ensureLogPanelVisible();
    });

    panel.querySelector('#codex-avito-download').addEventListener('click', () => {
      downloadJson();
    });

    panel.querySelector('#codex-avito-stop').addEventListener('click', () => {
      stopSession();
      updateActionPanel();
    });

    panel.querySelector('#codex-avito-clear').addEventListener('click', () => {
      clearData();
    });

    updateActionPanel();
  }

  async function bootstrap() {
    if (bootstrapStarted) return;
    if (!document.body) return;
    bootstrapStarted = true;

    const shouldResumeRun = isRunActiveInCurrentTab();
    if (!shouldResumeRun) {
      resetCollectedData();
    }

    showStartupBanner();
    createPanel();

    const session = getSession();
    if (session.running && !shouldResumeRun) {
      session.running = false;
      setSession(session);
    }

    renderLogWindow();
    updateActionPanel();

    if (shouldResumeRun) {
      await startSession({ resetData: false });
    }
  }

  GM_registerMenuCommand('Открыть окно логов', () => {
    ensureLogPanelVisible();
  });

  GM_registerMenuCommand('Запустить сбор', () => {
    startSession().catch((error) => {
      log(`Ошибка запуска: ${error?.message || error}`);
    });
  });

  GM_registerMenuCommand('Скачать собранный JSON', downloadJson);
  GM_registerMenuCommand('Остановить скрипт', stopSession);

  function scheduleBootstrap() {
    setTimeout(() => {
      bootstrap().catch((error) => {
        console.error('[Avito Collector] Bootstrap error:', error);
      });
    }, 500);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    scheduleBootstrap();
  } else {
    window.addEventListener('DOMContentLoaded', scheduleBootstrap, { once: true });
    window.addEventListener('load', scheduleBootstrap, { once: true });
  }
})();
