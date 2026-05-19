// ==UserScript==
// @name         Avito Listing Collector
// @namespace    local.codex.avito
// @version      1.1.0
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
  const COLLECTION_STATS_KEY = 'codex_avito_collector_collection_stats';
  const RUN_ACTIVE_KEY = 'codex_avito_collector_run_active';
  const AUTO_SCROLL_DURATION_MS = 12000;
  const AUTO_SCROLL_STEP_MS = 400;
  let bootstrapStarted = false;
  let collectionInProgress = false;
  let navigationWatcher = null;
  let autoPageAdvanceInProgress = false;
  let panelRefreshTimer = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function normalizeText(value) {
    return String(value ?? '')
      .replace(/(\d)([A-Za-z\u0410-\u042F\u0430-\u044F\u0401\u0451])/g, '$1 $2')
      .replace(/([A-Za-z\u0410-\u042F\u0430-\u044F\u0401\u0451])(\d)/g, '$1 $2')
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

    return text.includes('\u043C\u0438\u043D') || text.includes('\u043C\u0435\u0442\u0440\u043E') || /\b(?:\u043E\u0442|\u0434\u043E)\s*\d/i.test(text) || /\d+\s*[?-]\s*\d+/i.test(text);
  }

  function isRegionLine(value) {
    const text = normalizeText(value).trim();
    if (!text || isMetroOrTravelLine(text)) {
      return false;
    }

    return /[A-Za-z\u0410-\u042F\u0430-\u044F\u0401\u0451]/.test(text) && !/\d/.test(text);
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

  function getCollectionStats() {
    const stats = getJsonValue(COLLECTION_STATS_KEY, []);
    return Array.isArray(stats) ? stats : [];
  }

  function setCollectionStats(stats) {
    setJsonValue(COLLECTION_STATS_KEY, stats.slice(-20));
  }

  function getTotalListingsCount() {
    const node = document.querySelector('[data-marker="page-title/count"]');
    const raw = normalizeText(node?.textContent);
    const value = Number.parseInt(raw.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(value) ? value : null;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';

    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours} ч ${minutes} мин ${seconds} сек`;
    }

    if (minutes > 0) {
      return `${minutes} мин ${seconds} сек`;
    }

    return `${seconds} сек`;
  }

  function getCollectionAnalytics() {
    const total = getTotalListingsCount();
    const collected = getItems().length;
    const remaining = total === null ? null : Math.max(total - collected, 0);
    const stats = getCollectionStats().filter(
      (entry) => Number.isFinite(entry?.durationMs) && Number.isFinite(entry?.itemsCount) && entry.itemsCount > 0
    );
    const recentStats = stats.slice(-5);

    let averageItemsPerPage = null;
    let averagePageCycleMs = null;
    if (recentStats.length > 0) {
      const totalDuration = recentStats.reduce((sum, entry) => sum + entry.durationMs, 0);
      const totalItems = recentStats.reduce((sum, entry) => sum + entry.itemsCount, 0);
      const pageCount = recentStats.length;
      if (totalItems > 0 && pageCount > 0) {
        averageItemsPerPage = totalItems / pageCount;
        averagePageCycleMs = (totalDuration / pageCount) + AUTO_SCROLL_DURATION_MS;
      }
    }

    if ((averageItemsPerPage === null || averagePageCycleMs === null) && collected > 0) {
      const session = getSession();
      if (session.startedAt) {
        const elapsedMs = Date.now() - new Date(session.startedAt).getTime();
        if (Number.isFinite(elapsedMs) && elapsedMs > 0) {
          averageItemsPerPage = collected;
          averagePageCycleMs = Math.max(elapsedMs, AUTO_SCROLL_DURATION_MS);
        }
      }
    }

    const etaMs =
      total !== null && averageItemsPerPage !== null && averagePageCycleMs !== null && averageItemsPerPage > 0
        ? (remaining / averageItemsPerPage) * averagePageCycleMs
        : null;

    return {
      total,
      collected,
      remaining,
      averageItemsPerPage,
      averagePageCycleMs,
      etaMs,
    };
  }

  function resetCollectedData() {
    setItems([]);
    setProcessedUrls([]);
    setCollectionStats([]);
  }

  function isRunActiveInCurrentTab() {
    return sessionStorage.getItem(RUN_ACTIVE_KEY) === '1';
  }

  function setRunActiveInCurrentTab(active) {
    if (active) {
      sessionStorage.setItem(RUN_ACTIVE_KEY, '1');
    } else {
      sessionStorage.removeItem(RUN_ACTIVE_KEY);
    }
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
        ? `Сессия активна. Записей в массиве: ${getItems().length}`
        : `Сессия не запущена. Записей в массиве: ${getItems().length}`;
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
    banner.textContent = `Скрипт Tampermonkey активен на Avito: ${location.hostname}`;
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
    console.log(`[Сборщик Avito] ${message}`);
    appendLogLine(message);
    renderLogWindow();
    updateActionPanel();
    if (!panelRefreshTimer) {
      panelRefreshTimer = setInterval(() => {
        updateActionPanel();
      }, 1000);
    }
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
    const imageUrl =
      imageNode?.getAttribute('data-src') ||
      imageNode?.getAttribute('data-url') ||
      imageNode?.getAttribute('data-img-src') ||
      imageNode?.getAttribute('src') ||
      imageNode?.getAttribute('srcset')?.split(',')?.[0]?.trim()?.split(' ')?.[0] ||
      null;

    return {
      title: normalizeText(titleNode?.textContent),
      price: normalizeText(priceNode?.textContent),
      adress: extractAddressText(addressNode),
      dop: normalizeText(paramsNode?.textContent),
      description: normalizeText(descriptionNode?.textContent),
      image: imageUrl,
      url: linkNode?.href || null,
    };
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
      `a[rel="next"]`,
      `[data-marker="pagination-button/next"]`,
      `a[aria-label*="следующ" i]`,
      `[data-marker*="pagination"] button`,
      `a[href*="p="]`,
      `button`,
      `a`,
    ];

    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      const matched = elements.find((element) => {
        if (!isElementVisible(element)) return false;
        const text = normalizeText(element.textContent).toLowerCase();
        const aria = normalizeText(element.getAttribute(`aria-label`)).toLowerCase();
        const title = normalizeText(element.getAttribute(`title`)).toLowerCase();
        return (
          text.includes(`следующ`) ||
          aria.includes(`следующ`) ||
          title.includes(`следующ`) ||
          title.includes(`следующ`) ||
          aria === `next`
        );
      });

      if (matched) {
        return matched;
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
    if (!element) {
      return false;
    }

    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    await sleep(300);
    element.click();
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
        log(`Нажал на следующую страницу.`);
      } else {
        log(`Не нашёл кнопку следующей страницы. Останавливаю сессию.`);
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
    const pageStartedAt = Date.now();
    try {
      const session = getSession();
      const url = location.href;
      const processedUrls = getProcessedUrls();
      if (processedUrls.includes(url)) {
        log(`Страница уже собрана: ${url}`);
        return;
      }

      log(`Жду карточки на странице: ${url}`);
      const hasCards = await waitForCards();
      if (!hasCards) {
        log(`Карточки не появились за отведённое время.`);
        return;
      }

      const items = await collectVisibleListings();
      if (items.length === 0) {
        log(`Карточки найдены, но извлечь данные не удалось.`);
        return;
      }

      const existing = getItems();
      const seen = new Set(existing.map((item) => item.url || `${item.title}|${item.price}|${item.adress}`));
      let added = 0;

      for (const item of items) {
        const key = item.url || `${item.title}|${item.price}|${item.adress}`;
        if (!seen.has(key)) {
          existing.push(item);
          seen.add(key);
          added += 1;
        }
      }

      setItems(existing);
      processedUrls.push(url);
      setProcessedUrls(processedUrls);

      const currentStats = getCollectionStats();
      currentStats.push({
        url,
        durationMs: Date.now() - pageStartedAt,
        itemsCount: items.length,
        addedCount: added,
        collectedAt: new Date().toISOString(),
      });
      setCollectionStats(currentStats);

      if (session.running) {
        advanceToNextPage();
      }

      log(`Собрано ${items.length} объявлений на странице. Добавлено новых: ${added}. Всего в items: ${existing.length}.`);
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
      log(`Скачивание файла начато: ${filename}`);
  }

  function clearData() {
    setItems([]);
    setProcessedUrls([]);
    setCollectionStats([]);
    setLogs([]);
    setSession({
      running: false,
      startedAt: null,
      lastUrl: null,
    });
    setRunActiveInCurrentTab(false);
    renderLogWindow();
      log(`Локальное хранилище очищено.`);
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
      log(`Сессия остановлена.`);
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

    log(`Скрипт запущен. Панель логов открыта.`);
    await collectCurrentPage();
    updateActionPanel();
  }
  function updateActionPanel() {
    const countNode = document.getElementById('codex-avito-count');
    const totalNode = document.getElementById('codex-avito-total');
    const remainingNode = document.getElementById('codex-avito-remaining');
    const etaNode = document.getElementById('codex-avito-eta');
    const statusNode = document.getElementById('codex-avito-status');
    const session = getSession();
    const analytics = getCollectionAnalytics();

    if (countNode) {
      countNode.textContent = `Записей в массиве: ${getItems().length}`;
    }

    if (totalNode) {
      totalNode.textContent = `Всего на странице: ${analytics.total ?? '—'}`;
    }

    if (remainingNode) {
      remainingNode.textContent = `Осталось: ${analytics.remaining ?? '—'}`;
    }

    if (etaNode) {
      etaNode.textContent = `Примерно времени: ${analytics.etaMs !== null ? formatDuration(analytics.etaMs) : '—'}`;
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
      <div class="title">Сборщик Avito</div>
      <div class="meta">Страница: ${location.href}</div>
      <div class="meta" id="codex-avito-count">Записей в массиве: ${getItems().length}</div>
      <div class="status" id="codex-avito-status">Сессия не запущена</div>
      <button id="codex-avito-start">Запустить скрипт</button>
      <button id="codex-avito-open-log" class="secondary">Показать окно логов</button>
      <button id="codex-avito-download" class="secondary">Скачать JSON</button>
      <button id="codex-avito-stop" class="danger">Остановить</button>
      <button id="codex-avito-clear" class="secondary">Очистить данные</button>
    `;

    document.body.appendChild(panel);
    const statusNode = panel.querySelector('#codex-avito-status');
    if (statusNode) {
      const totalNode = document.createElement('div');
      totalNode.className = 'meta';
      totalNode.id = 'codex-avito-total';
      totalNode.textContent = 'Всего на странице: ?';

      const remainingNode = document.createElement('div');
      remainingNode.className = 'meta';
      remainingNode.id = 'codex-avito-remaining';
      remainingNode.textContent = 'Осталось: ?';

      const etaNode = document.createElement('div');
      etaNode.className = 'meta';
      etaNode.id = 'codex-avito-eta';
      etaNode.textContent = 'Примерно времени: ?';

      panel.insertBefore(totalNode, statusNode);
      panel.insertBefore(remainingNode, statusNode);
      panel.insertBefore(etaNode, statusNode);
    }

    const logPanel = document.createElement('div');
    logPanel.id = 'codex-avito-log';
    logPanel.innerHTML = `
      <div class="log-head">
        <div class="log-title">Журнал Avito</div>
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
  GM_registerMenuCommand('Показать окно логов', () => {
    ensureLogPanelVisible();
  });

  GM_registerMenuCommand('Запустить скрипт', () => {
    startSession().catch((error) => {
      log(`Ошибка запуска: ${error?.message || error}`);
    });
  });

  GM_registerMenuCommand('Скачать JSON', downloadJson);
  GM_registerMenuCommand('Остановить скрипт', stopSession);
  
  function scheduleBootstrap() {
    setTimeout(() => {
      bootstrap().catch((error) => {
        console.error('[Сборщик Avito] Bootstrap error:', error);
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
