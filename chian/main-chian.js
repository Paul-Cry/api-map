// ==UserScript==
// @name         Cian Listing Collector
// @namespace    cian
// @version      1.0.0
// @description  Cian diagnostics and collector.
// @match        https://www.cian.ru/*
// @match        https://cian.ru/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'codex_cian_collector_items';
  const PROCESSED_KEY = 'codex_cian_collector_processed_urls';
  const LOGS_KEY = 'codex_cian_collector_logs';
  const SESSION_KEY = 'codex_cian_collector_session';
  const RUN_ACTIVE_KEY = 'codex_cian_collector_run_active';
  const AUTO_SCROLL_DURATION_MS = 12000;
  const AUTO_SCROLL_STEP_MS = 400;
  const PAGINATION_ADVANCE_BUFFER_MS = 3000;

  let bootstrapStarted = false;
  let collectionInProgress = false;
  let navigationWatcher = null;
  let autoPageAdvanceInProgress = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\s+/g, ' ')
      .replace(/\u00a0/g, ' ')
      .trim();
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
      pageStartedAt: null,
      pageDurationsMs: [],
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

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
      return '0 сек';
    }

    const totalSeconds = Math.ceil(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];

    if (hours > 0) parts.push(`${hours} ч`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes} мин`);
    parts.push(`${seconds} сек`);
    return parts.join(' ');
  }

  function recordPageDuration(session, durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return session;
    }

    const durations = Array.isArray(session.pageDurationsMs) ? session.pageDurationsMs.slice() : [];
    durations.push(Math.round(durationMs));
    session.pageDurationsMs = durations.slice(-12);
    return session;
  }

  function getAveragePageDurationMs(session) {
    const durations = Array.isArray(session?.pageDurationsMs)
      ? session.pageDurationsMs.filter((value) => Number.isFinite(value) && value > 0)
      : [];

    if (durations.length === 0) {
      return null;
    }

    const sorted = durations.slice().sort((a, b) => a - b);
    const sample = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
    const total = sample.reduce((sum, value) => sum + value, 0);
    return total / sample.length;
  }

  function getPaginationProgress() {
    const nav = document.querySelector('nav[data-name="Pagination"], .x31de4314--bf4bd6--pagination nav');
    if (!nav) {
      return { currentPage: null, totalPages: null, remainingPages: null, currentProcessed: null };
    }

    const candidates = Array.from(
      nav.querySelectorAll('button, a, li, [aria-current="page"]')
    );

    const pages = candidates
      .map((node) => {
        const text = normalizeText(node.textContent);
        const page = Number.parseInt(text, 10);
        return Number.isFinite(page) ? { page, node } : null;
      })
      .filter(Boolean);

    const currentPageFromUrl = Number.parseInt(new URL(location.href).searchParams.get('p') || '', 10);
    let currentPage = Number.isFinite(currentPageFromUrl) ? currentPageFromUrl : 1;

    const currentNode = nav.querySelector('[aria-current="page"], button[disabled]');
    if (currentNode) {
      const currentText = normalizeText(currentNode.textContent);
      const parsed = Number.parseInt(currentText, 10);
      if (Number.isFinite(parsed)) {
        currentPage = parsed;
      }
    }

    if (!Number.isFinite(currentPage) || currentPage <= 0) {
      currentPage = null;
    }

    const totalPages = pages.reduce((max, entry) => Math.max(max, entry.page), 0) || null;
    if (currentPage == null || totalPages == null) {
      return { currentPage, totalPages, remainingPages: null, currentProcessed: null };
    }

    const currentProcessed = getProcessedUrls().includes(location.href);

    return {
      currentPage,
      totalPages,
      currentProcessed,
      remainingPages: Math.max(totalPages - currentPage + (currentProcessed ? 0 : 1), 0),
    };
  }

  function getPaginationRemainingEstimate(progress) {
    if (!progress || progress.currentPage == null || progress.totalPages == null || progress.remainingPages == null) {
      return null;
    }

    const session = getSession();
    const averagePageMs = getAveragePageDurationMs(session);
    const perPageMs = Number.isFinite(averagePageMs) && averagePageMs > 0
      ? averagePageMs
      : AUTO_SCROLL_DURATION_MS + PAGINATION_ADVANCE_BUFFER_MS;

    return progress.remainingPages * perPageMs;
  }

  function renderLogWindow() {
    const body = document.getElementById('codex-cian-log-body');
    const header = document.getElementById('codex-cian-log-header');

    if (header) {
      const session = getSession();
      const pagination = getPaginationProgress();
      const averagePageMs = getAveragePageDurationMs(session);
      const paginationText =
        pagination.currentPage != null && pagination.totalPages != null
          ? `, страницы: ${pagination.currentPage}/${pagination.totalPages}, осталось: ${pagination.remainingPages}${Number.isFinite(averagePageMs) ? `, среднее: ${formatDuration(averagePageMs)}/стр.` : ''}`
          : '';

      header.textContent = session.running
        ? `Сбор идет. Объектов собрано: ${getItems().length}${paginationText}`
        : `Сбор остановлен. Объектов собрано: ${getItems().length}${paginationText}`;
    }

    if (body) {
      body.textContent = getLogs().join('\n');
      body.scrollTop = body.scrollHeight;
    }
  }

  function ensureLogPanelVisible() {
    const panel = document.getElementById('codex-cian-log');
    if (panel) {
      panel.style.display = 'block';
      panel.classList.add('visible');
    }
    renderLogWindow();
  }

  function showStartupBanner() {
    if (document.getElementById('codex-cian-startup-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'codex-cian-startup-banner';
    banner.textContent = `Tampermonkey script active on Cian: ${location.hostname}`;
    banner.style.cssText = [
      'position: fixed',
      'top: 12px',
      'left: 50%',
      'transform: translateX(-50%)',
      'z-index: 2147483647',
      'background: #165dff',
      'color: #fff',
      'padding: 12px 18px',
      'border-radius: 999px',
      'font: 700 14px/1.2 Arial, sans-serif',
      'box-shadow: 0 12px 30px rgba(0,0,0,0.35)',
      'border: 2px solid rgba(255,255,255,0.15)',
      'pointer-events: none',
    ].join(';');
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 8000);
  }

  function log(message) {
    console.log(`[Cian Collector] ${message}`);
    appendLogLine(message);
    renderLogWindow();
    updateActionPanel();
  }

  function showToast(message) {
    let toast = document.getElementById('codex-cian-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'codex-cian-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(showToast.hideTimer);
    showToast.hideTimer = setTimeout(() => toast.classList.remove('visible'), 2000);
  }

  function isElementVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function getTextFromNode(node) {
    return normalizeText(node?.textContent);
  }

  function getPriceInfoText(card) {
    const selectors = [
      '[data-mark="PriceInfo"]',
      '.x31de4314--_1d8f5--main-price [data-name="ContentRow"] p',
      '.x31de4314--_1d8f5--main-price p',
      '[data-name="ContentRow"] p',
    ];

    for (const selector of selectors) {
      const node = card.querySelector(selector);
      const text = getTextFromNode(node);
      if (text) {
        return text;
      }
    }

    const priceWrapper = card.querySelector('.x31de4314--_1d8f5--main-price, [class*="_1d8f5--main-price"]');
    if (priceWrapper) {
      const texts = Array.from(priceWrapper.querySelectorAll('p, span'))
        .map((node) => getTextFromNode(node))
        .filter(Boolean);

      if (texts.length > 1) {
        return texts[1];
      }

      if (texts.length === 1 && !texts[0].includes('₽/мес') && !texts[0].includes('/мес')) {
        return texts[0];
      }
    }

    return '';
  }

  function getDescriptionText(card) {
    const roots = [];
    if (card) roots.push(card);
    const articleRoot = card?.closest?.('article[data-name="CardComponent"]');
    if (articleRoot && articleRoot !== card) {
      roots.push(articleRoot);
    }

    const selectors = [
      '[data-name="Description"]',
      '[data-name="Description"] p',
      '.x31de4314--_74dfe--description',
      '.x31de4314--_74dfe--description p',
    ];

    for (const root of roots) {
      for (const selector of selectors) {
        const node = root.querySelector(selector);
        const text = getTextFromNode(node);
        if (text) {
          return text;
        }
      }

      const descriptionBlocks = Array.from(root.querySelectorAll('div, p'))
        .filter((node) => {
          const name = node.getAttribute?.('data-name');
          const className = String(node.className || '');
          return name === 'Description' || className.includes('_74dfe--description');
        })
        .map((node) => getTextFromNode(node))
        .filter(Boolean);

      if (descriptionBlocks.length > 0) {
        return descriptionBlocks[0];
      }
    }

    return '';
  }

  function extractListingItem(card) {
    const root = card?.closest?.('article[data-name="CardComponent"]') || card;
    const titleNode = root.querySelector('[data-name="TitleComponent"] [data-mark="OfferTitle"], [data-mark="OfferTitle"], a[data-name="TitleComponent"]');
    const priceNode = root.querySelector('[data-mark="MainPrice"]');
    const linkNode = root.querySelector('a[data-name="TitleComponent"][href], a[data-name="Link"][href], a[href*="/rent/flat/"], a[href*="/sale/flat/"], a[href*="/buy/flat/"]');

    const geoLabels = Array.from(root.querySelectorAll('[data-name="GeoLabel"], [data-name="SpecialGeo"] [data-name="GeoLabel"]'))
      .map((node) => getTextFromNode(node))
      .filter(Boolean);

    const specialGeo = getTextFromNode(root.querySelector('[data-name="SpecialGeo"]'));
    const address = geoLabels.join(', ') || specialGeo;

    return {
      title: getTextFromNode(titleNode),
      price: getTextFromNode(priceNode),
      adress: address,
      dop: getPriceInfoText(root),
      description: getDescriptionText(root),
      url: linkNode?.href || null,
    };
  }

  async function waitForCards(timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const cards = document.querySelectorAll('article[data-name="CardComponent"], [data-testid="offer-card"]');
      if (cards.length > 0) return true;
      await sleep(1000);
    }
    return false;
  }

  async function collectVisibleListings() {
    const selectors = [
      'article[data-name="CardComponent"]',
      '[data-testid="offer-card"]',
    ];

    let cards = [];
    for (const selector of selectors) {
      cards = Array.from(document.querySelectorAll(selector)).filter(isElementVisible);
      if (cards.length > 0) break;
    }

    return cards.map((card) => extractListingItem(card));
  }

  function findNextPageElement() {
    const nav = document.querySelector('nav[data-name="Pagination"], .x31de4314--bf4bd6--pagination nav');
    const scope = nav || document;
    const selectors = [
      'a[rel="next"]',
      'button[aria-label*="далее" i]',
      'a[aria-label*="далее" i]',
      'button[title*="далее" i]',
      'a[title*="далее" i]',
      'button',
      'a',
    ];

    for (const selector of selectors) {
      const elements = Array.from(scope.querySelectorAll(selector));
      const matched = elements.find((element) => {
        if (!isElementVisible(element) || element.disabled) return false;
        const text = normalizeText(element.textContent).toLowerCase();
        const aria = normalizeText(element.getAttribute('aria-label')).toLowerCase();
        const title = normalizeText(element.getAttribute('title')).toLowerCase();
        return (
          text === 'далее' ||
          text === 'дальше' ||
          text === 'next' ||
          aria.includes('далее') ||
          aria === 'next' ||
          title.includes('далее') ||
          title.includes('дальше') ||
          title === 'next'
        );
      });

      if (matched) return matched;
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
    if (autoPageAdvanceInProgress) return;

    const session = getSession();
    if (!session.running) return;

    autoPageAdvanceInProgress = true;
    try {
      log(`Автопрокрутка страницы ${AUTO_SCROLL_DURATION_MS / 1000} секунд перед переходом дальше.`);
      await scrollPageForPagination(AUTO_SCROLL_DURATION_MS);

      if (!getSession().running) return;

      const clicked = await clickNextPage();
      if (clicked) {
        log('Нажал на следующую страницу.');
      } else {
        log('Не нашел кнопку следующей страницы. Останавливаю сессию.');
        stopSession();
      }
    } catch (error) {
      log(`Ошибка автоперехода: ${error?.message || error}`);
    } finally {
      autoPageAdvanceInProgress = false;
    }
  }

  async function collectCurrentPage() {
    if (collectionInProgress) return;

    collectionInProgress = true;
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
        log('Карточки не появились за отведенное время.');
        return;
      }

      const items = await collectVisibleListings();
      if (items.length === 0) {
        log('Карточки найдены, но извлечь данные не удалось.');
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

      if (session.running) {
        advanceToNextPage();
      }

      log(`Собрано ${items.length} объектов на странице. Добавлено новых: ${added}. Всего в массиве items: ${existing.length}.`);
      showToast(`Собрано ${items.length} объектов`);
    } finally {
      collectionInProgress = false;
    }
  }

  function downloadJson() {
    const items = getItems();
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const filename = `cian-listings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
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
      pageStartedAt: null,
      pageDurationsMs: [],
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
    session.pageStartedAt = Date.now();
    session.pageDurationsMs = Array.isArray(session.pageDurationsMs) ? session.pageDurationsMs : [];
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
      if (!currentSession.running) return;

      const currentUrl = location.href;
      if (currentSession.lastUrl !== currentUrl) {
        const pageStartedAt = Number(currentSession.pageStartedAt);
        if (Number.isFinite(pageStartedAt) && pageStartedAt > 0) {
          recordPageDuration(currentSession, Date.now() - pageStartedAt);
        }

        currentSession.lastUrl = currentUrl;
        currentSession.pageStartedAt = Date.now();
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
    const countNode = document.getElementById('codex-cian-count');
    const paginationNode = document.getElementById('codex-cian-pagination');
    const statusNode = document.getElementById('codex-cian-status');
    const session = getSession();
    const pagination = getPaginationProgress();
    const averagePageMs = getAveragePageDurationMs(session);

    if (countNode) {
      countNode.textContent = `Записей в массиве items: ${getItems().length}`;
    }

    if (paginationNode) {
      const remainingEstimateMs = getPaginationRemainingEstimate(pagination);
      paginationNode.textContent =
        pagination.currentPage != null && pagination.totalPages != null
          ? `Страница: ${pagination.currentPage}/${pagination.totalPages} | Осталось: ${pagination.remainingPages}${Number.isFinite(averagePageMs) ? ` | Среднее: ${formatDuration(averagePageMs)}/стр.` : ''}${remainingEstimateMs != null ? ` | Оценка: ${formatDuration(remainingEstimateMs)}` : ''}`
          : 'Пагинация: не определена';
    }

    if (statusNode) {
      statusNode.textContent = session.running ? 'Сессия запущена' : 'Сессия не запущена';
      statusNode.classList.toggle('active', session.running);
    }
  }

  function createPanel() {
    if (document.getElementById('codex-cian-panel')) return;

    GM_addStyle(`
      #codex-cian-panel {
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
      #codex-cian-panel .title {
        font: 700 14px/1.2 Arial, sans-serif;
        margin-bottom: 6px;
      }
      #codex-cian-panel .meta {
        opacity: 0.85;
        margin-top: 6px;
        word-break: break-word;
      }
      #codex-cian-panel .status {
        margin-top: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(255,255,255,0.08);
        display: inline-block;
      }
      #codex-cian-panel .status.active {
        background: rgba(44, 196, 115, 0.2);
        color: #8ef0b8;
      }
      #codex-cian-panel button {
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
      #codex-cian-panel button.secondary {
        background: #3d4a60;
      }
      #codex-cian-panel button.danger {
        background: #b45309;
      }
      #codex-cian-toast {
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
      #codex-cian-toast.visible {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      #codex-cian-log {
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
      #codex-cian-log.visible {
        display: flex;
        flex-direction: column;
      }
      #codex-cian-log .log-head {
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.12);
        background: linear-gradient(180deg, rgba(19,28,44,1), rgba(17,24,39,1));
      }
      #codex-cian-log .log-title {
        font: 700 14px/1.2 Arial, sans-serif;
        color: #fff;
        margin-bottom: 6px;
      }
      #codex-cian-log .log-header {
        color: #a6b3c7;
        font: 12px/1.4 Arial, sans-serif;
      }
      #codex-cian-log-body {
        margin: 0;
        padding: 12px 14px;
        flex: 1;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
    `);

    const panel = document.createElement('div');
    panel.id = 'codex-cian-panel';
    panel.innerHTML = `
      <div class="title">Cian Collector</div>
      <div class="meta">Страница: ${location.href}</div>
      <div class="meta" id="codex-cian-count">Записей в массиве items: ${getItems().length}</div>
      <div class="meta" id="codex-cian-pagination">Пагинация: не определена</div>
      <div class="status" id="codex-cian-status">Сессия не запущена</div>
      <button id="codex-cian-start">Запустить скрипт</button>
      <button id="codex-cian-open-log" class="secondary">Показать окно логов</button>
      <button id="codex-cian-download" class="secondary">Скачать JSON</button>
      <button id="codex-cian-stop" class="danger">Остановить</button>
      <button id="codex-cian-clear" class="secondary">Очистить данные</button>
    `;
    document.body.appendChild(panel);

    const logPanel = document.createElement('div');
    logPanel.id = 'codex-cian-log';
    logPanel.innerHTML = `
      <div class="log-head">
        <div class="log-title">Cian Log</div>
        <div class="log-header" id="codex-cian-log-header">Ожидание запуска...</div>
      </div>
      <pre id="codex-cian-log-body"></pre>
    `;
    document.body.appendChild(logPanel);

    panel.querySelector('#codex-cian-start').addEventListener('click', () => {
      startSession().catch((error) => {
        log(`Ошибка запуска: ${error?.message || error}`);
      });
    });

    panel.querySelector('#codex-cian-open-log').addEventListener('click', () => {
      ensureLogPanelVisible();
    });

    panel.querySelector('#codex-cian-download').addEventListener('click', () => {
      downloadJson();
    });

    panel.querySelector('#codex-cian-stop').addEventListener('click', () => {
      stopSession();
      updateActionPanel();
    });

    panel.querySelector('#codex-cian-clear').addEventListener('click', () => {
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
        console.error('[Cian Collector] Bootstrap error:', error);
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
