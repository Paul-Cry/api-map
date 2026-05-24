// ==UserScript==
// @name         Avito Transit Time via Yandex Maps
// @namespace    local.codex.avito.yandex.transit
// @version      1.1.1
// @description  По очереди строит маршруты в Яндекс.Картах и добавляет время до "Родина" и "работа Оли" в JSON-объекты Avito.
// @match        *://yandex.kz/maps/*
// @match        *://yandex.ru/maps/*
// @match        *://yandex.com/maps/*
// @match        *://*.yandex.kz/maps/*
// @match        *://*.yandex.ru/maps/*
// @match        *://*.yandex.com/maps/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'codex_avito_yandex_transit_state_v1';
  const SCRIPT_VERSION = '1.1.1';
  const DEBUG_STOP_KEY = 'codex_avito_yandex_transit_debug_stop_v1';
  const WORKER_ENABLED_KEY = 'codex_avito_yandex_worker_enabled_v1';
  const WORKER_ID_KEY = 'codex_avito_yandex_worker_id_v1';
  const API_URL_KEY = 'codex_avito_yandex_api_url_v1';
  const ROUTE_WAIT_MS = 1500;
  const POLL_MS = 100;
  const ROUTE_REQUEST_DELAY_MS = 250;
  const WORKER_POLL_MS = 5000;

  let isProcessing = false;
  let isWorkerPolling = false;
  let workerTimer = null;
  let currentJobTimer = null;
  let navigationTimer = null;
  let stopSequence = 0;

  const DESTINATIONS = [
    {
      key: 'Родина',
      label: 'Родина',
      coords: '55.764323,37.556119',
    },
    {
      key: 'работа Оли',
      label: 'работа Оли',
      coords: '55.661195,37.508398',
    },
  ];

  const emptyState = {
    running: false,
    items: [],
    jobs: [],
    currentJob: null,
    remoteJob: null,
    done: 0,
    total: 0,
    lastError: '',
    logs: [],
  };

  function readState() {
    try {
      const parsed = JSON.parse(GM_getValue(STORAGE_KEY, JSON.stringify(emptyState)));
      return { ...emptyState, ...parsed };
    } catch {
      return { ...emptyState };
    }
  }

  function writeState(state) {
    GM_setValue(STORAGE_KEY, JSON.stringify(state));
  }

  function resetState() {
    GM_deleteValue(STORAGE_KEY);
  }

  function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function getAddress(item) {
    return normalizeText(item?.adress || item?.address || item?.адрес || '');
  }

  function cleanRouteAddress(address) {
    let text = normalizeText(address);
    if (!text) return '';

    text = text
      .replace(/\s*,?\s*(?:от\s*)?\d+\s*[–-]\s*\d+\s*мин(?:\.|ут)?\.?.*$/iu, '')
      .replace(/\s*,?\s*(?:от\s*)?\d+\s*мин(?:\.|ут)?\.?.*$/iu, '')
      .replace(/\s*,\s*,+/g, ', ')
      .replace(/[.,;:\s]+$/g, '')
      .trim();

    if (/\d/.test(text)) {
      text = text.replace(/\s+[^\d,][^,]*$/u, '').trim();
    }

    return text;
  }

  function withMoscowHint(address) {
    const text = cleanRouteAddress(address);
    if (!text) return '';
    if (/москв|moscow/i.test(text)) return text;
    return `${text}, Москва`;
  }

  function now() {
    return new Date().toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function log(message) {
    const state = readState();
    state.logs = [...(state.logs || []), `[${now()}] ${message}`].slice(-180);
    writeState(state);
    render();
    console.log(`[Avito Transit Yandex] ${message}`);
  }

  function logError(message, error) {
    const details = error?.message || String(error || '');
    log(details ? `${message}: ${details}` : message);
  }

  function isDebugStopEnabled() {
    return GM_getValue(DEBUG_STOP_KEY, '0') === '1';
  }

  function setDebugStopEnabled(value) {
    GM_setValue(DEBUG_STOP_KEY, value ? '1' : '0');
  }

  function isWorkerEnabled() {
    return GM_getValue(WORKER_ENABLED_KEY, '0') === '1';
  }

  function setWorkerEnabled(value) {
    GM_setValue(WORKER_ENABLED_KEY, value ? '1' : '0');
  }

  function getWorkerId() {
    let workerId = GM_getValue(WORKER_ID_KEY, '');
    if (!workerId) {
      workerId = `worker-${Math.random().toString(36).slice(2, 10)}`;
      GM_setValue(WORKER_ID_KEY, workerId);
    }
    return workerId;
  }

  function setWorkerId(value) {
    GM_setValue(WORKER_ID_KEY, normalizeText(value));
  }

  function getApiUrl() {
    return String(GM_getValue(API_URL_KEY, 'http://127.0.0.1:8787')).replace(/\/+$/g, '');
  }

  function setApiUrl(value) {
    GM_setValue(API_URL_KEY, normalizeText(value).replace(/\/+$/g, ''));
  }

  function apiRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: `${getApiUrl()}${path}`,
        headers: {
          'Content-Type': 'application/json',
        },
        data: body === undefined ? undefined : JSON.stringify(body),
        timeout: 30000,
        onload(response) {
          let payload = null;
          try {
            payload = response.responseText ? JSON.parse(response.responseText) : null;
          } catch (error) {
            reject(new Error(`Bad API JSON response: ${error.message}`));
            return;
          }

          if (response.status < 200 || response.status >= 300) {
            reject(new Error(payload?.error || `API HTTP ${response.status}`));
            return;
          }

          resolve(payload);
        },
        ontimeout() {
          reject(new Error('API request timeout'));
        },
        onerror() {
          reject(new Error('API request failed'));
        },
      });
    });
  }

  function getWorkerProgress() {
    const state = readState();
    const items = Array.isArray(state.items) ? state.items : [];
    const pendingIndexes = new Set();
    if (state.currentJob) pendingIndexes.add(state.currentJob.itemIndex);
    for (const job of state.jobs || []) {
      pendingIndexes.add(job.itemIndex);
    }

    const objectsTotal = items.length;
    const objectsRemaining = state.running ? pendingIndexes.size : 0;
    const routesTotal = Number(state.total || 0);
    const routesDone = Number(state.done || 0);
    const routesRemaining = state.running ? Math.max(0, routesTotal - routesDone) : 0;

    return {
      objectsDone: Math.max(0, objectsTotal - objectsRemaining),
      objectsTotal,
      objectsRemaining,
      routesDone,
      routesTotal,
      routesRemaining,
      currentObjectIndex: state.currentJob ? state.currentJob.itemIndex + 1 : null,
    };
  }

  function formatDurationLabel(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';

    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours} ч ${minutes} мин`;
    }

    if (minutes > 0) {
      return `${minutes} мин ${seconds} сек`;
    }

    return `${seconds} сек`;
  }

  function estimateRemainingTime(state) {
    const totalRoutes = Number(state.total || 0);
    const doneRoutes = Number(state.done || 0);
    const remainingRoutes = state.running ? Math.max(0, totalRoutes - doneRoutes) : 0;

    if (!remainingRoutes) {
      return null;
    }

    const startedAt = Number(state.startedAt || 0);
    const elapsedMs = startedAt > 0 ? Date.now() - startedAt : 0;
    let averageRouteMs = 0;

    if (startedAt > 0 && doneRoutes > 0) {
      averageRouteMs = elapsedMs / doneRoutes;
    } else if (startedAt > 0 && doneRoutes === 0 && elapsedMs < 15000) {
      return {
        message: 'Идёт первый маршрут, оценка появится после него.',
        remainingRoutes,
        remainingObjects: Math.max(1, Math.ceil(remainingRoutes / DESTINATIONS.length)),
      };
    } else if (startedAt > 0 && doneRoutes === 0) {
      averageRouteMs = Math.max(elapsedMs, ROUTE_WAIT_MS + ROUTE_REQUEST_DELAY_MS);
    }

    if (!Number.isFinite(averageRouteMs) || averageRouteMs <= 0) {
      averageRouteMs = Math.max(ROUTE_WAIT_MS + ROUTE_REQUEST_DELAY_MS, ROUTE_REQUEST_DELAY_MS + 1000);
    }

    const remainingMs = Math.max(0, Math.round(averageRouteMs * remainingRoutes));
    const remainingObjects = Math.max(1, Math.ceil(remainingRoutes / DESTINATIONS.length));

    return {
      remainingMs,
      remainingRoutes,
      remainingObjects,
    };
  }

  function buildEtaText(state) {
    const estimate = estimateRemainingTime(state);
    if (!estimate) {
      return '';
    }

    if (estimate.message) {
      return estimate.message;
    }

    const timeText = formatDurationLabel(estimate.remainingMs);
    return `Осталось примерно: ${timeText} (${estimate.remainingObjects} объектов, ${estimate.remainingRoutes} маршрутов)`;
  }

  async function heartbeat(status, currentJobId = null) {
    return apiRequest('POST', '/api/workers/heartbeat', {
      workerId: getWorkerId(),
      name: navigator.userAgent,
      status,
      currentJobId,
      progress: getWorkerProgress(),
    });
  }

  function buildJobs(items) {
    const jobs = [];

    items.forEach((item, itemIndex) => {
      const address = getAddress(item);
      if (!address) {
        item['Родина'] = 'адрес не найден';
        item['работа Оли'] = 'адрес не найден';
        return;
      }

      for (const destination of DESTINATIONS) {
        jobs.push({
          itemIndex,
          destinationKey: destination.key,
          destinationLabel: destination.label,
          origin: withMoscowHint(address),
          destination: destination.coords,
        });
      }
    });

    return jobs;
  }

  function findRouteInput(label) {
    const wanted = normalizeText(label).toLowerCase();
    const inputs = [...document.querySelectorAll('input')];
    return inputs.find((input) => {
      const haystack = normalizeText([
        input.placeholder,
        input.getAttribute('aria-label'),
        input.title,
      ].filter(Boolean).join(' ')).toLowerCase();
      return haystack.includes(wanted);
    }) || null;
  }

  function setNativeInputValue(input, value) {
    if (!input) return;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const setter = descriptor?.set;
    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEnter(input) {
    if (!input) return;
    const options = { bubbles: true, cancelable: true, composed: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
    input.dispatchEvent(new KeyboardEvent('keydown', options));
    input.dispatchEvent(new KeyboardEvent('keypress', options));
    input.dispatchEvent(new KeyboardEvent('keyup', options));
  }

  async function fillRouteOnCurrentPage(job) {
    const originInput = findRouteInput('Откуда');
    const destinationInput = findRouteInput('Куда');
    if (!originInput || !destinationInput) {
      throw new Error('Не найдены поля "Откуда" и "Куда" на странице.');
    }

    log(`Заполняю маршрут: объект ${job.itemIndex + 1}, ${job.destinationLabel}`);
    setNativeInputValue(originInput, job.origin);
    originInput.focus();
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    pressEnter(originInput);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    setNativeInputValue(destinationInput, job.destination);
    destinationInput.focus();
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    pressEnter(destinationInput);
  }

  function navigateToJob(job) {
    const url = new URL('https://yandex.ru/maps/213/moscow/');
    url.searchParams.set('ll', '37.617700,55.755863');
    url.searchParams.set('mode', 'routes');
    url.searchParams.set('rtext', `${job.origin}~${job.destination}`);
    url.searchParams.set('rtt', 'mt');
    url.searchParams.set('z', '10');
    log(`Открываю маршрут: объект ${job.itemIndex + 1}, ${job.destinationLabel}`);
    window.location.assign(url.toString());
  }

  function scheduleCurrentJobProcessing(delayMs = 0) {
    if (delayMs > 0) {
      log(`Планирую чтение маршрута через ${Math.round(delayMs / 1000)} сек.`);
    }
    if (currentJobTimer) window.clearTimeout(currentJobTimer);
    const sequence = stopSequence;
    currentJobTimer = window.setTimeout(() => {
      currentJobTimer = null;
      if (sequence !== stopSequence) return;
      processCurrentJob().catch((error) => {
        logError('Ошибка обработки маршрута', error);
        const nextState = readState();
        nextState.lastError = error?.message || String(error);
        nextState.running = false;
        writeState(nextState);
        if (nextState.remoteJob?.jobId) {
          apiRequest('POST', `/api/jobs/${encodeURIComponent(nextState.remoteJob.jobId)}/fail`, {
            workerId: getWorkerId(),
            error: nextState.lastError,
          }).catch(() => { });
        }
        render();
      });
    }, delayMs);
  }

  function createJobsFromInput(text) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error('Нужен JSON-массив объектов.');
    }

    const items = parsed.map((item) => ({ ...item }));
    const jobs = buildJobs(items);

    if (!jobs.length) {
      throw new Error('Не нашел объектов с полем adress, address или адрес.');
    }

    return { items, jobs };
  }

  async function loadJsonFile(file, textarea) {
    if (!file) return;

    const text = await file.text();
    textarea.value = text;

    const { items } = createJobsFromInput(text);
    setFileSummary(`\u0424\u0430\u0439\u043b: ${file.name}. \u041e\u0431\u044a\u0435\u043a\u0442\u043e\u0432: ${items.length}.`);
    setStatus(`\u0424\u0430\u0439\u043b ${file.name}: ${items.length} \u043e\u0431\u044a\u0435\u043a\u0442\u043e\u0432 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043d\u043e. \u041c\u043e\u0436\u043d\u043e \u043d\u0430\u0436\u0438\u043c\u0430\u0442\u044c \u0421\u0442\u0430\u0440\u0442.`);
    log(`JSON file loaded: ${file.name}, items=${items.length}`);
  }

  function setFileSummary(text) {
    const node = document.querySelector('#codex-yandex-transit-file-summary');
    if (node) node.textContent = text;
  }

  function start(text) {
    const { items, jobs } = createJobsFromInput(text);
    const [firstJob, ...restJobs] = jobs;
    stopSequence += 1;
    if (currentJobTimer) window.clearTimeout(currentJobTimer);
    if (navigationTimer) window.clearTimeout(navigationTimer);
    currentJobTimer = null;
    navigationTimer = null;
    const state = {
      ...emptyState,
      running: true,
      startedAt: Date.now(),
      items,
      jobs: restJobs,
      currentJob: firstJob,
      done: 0,
      total: jobs.length,
      logs: [`[${now()}] Старт: ${items.length} объектов, ${jobs.length} маршрутов.`],
    };
    writeState(state);
    log(`Первый маршрут: объект ${firstJob.itemIndex + 1}, ${firstJob.destinationLabel}. Осталось после него: ${restJobs.length}.`);
    setStatus(`Пауза ${Math.round(ROUTE_REQUEST_DELAY_MS / 1000)} сек перед запросом маршрута...`);
    const firstSequence = stopSequence;
    navigationTimer = setTimeout(() => {
      navigationTimer = null;
      if (firstSequence !== stopSequence) return;
      navigateToJob(firstJob);
      scheduleCurrentJobProcessing(ROUTE_REQUEST_DELAY_MS);
    }, ROUTE_REQUEST_DELAY_MS);
  }

  function startRemoteJob(job) {
    const items = Array.isArray(job?.items) ? job.items : [];
    const { jobs } = createJobsFromInput(JSON.stringify(items));
    const [firstJob, ...restJobs] = jobs;
    stopSequence += 1;
    if (currentJobTimer) window.clearTimeout(currentJobTimer);
    if (navigationTimer) window.clearTimeout(navigationTimer);
    currentJobTimer = null;
    navigationTimer = null;
    const state = {
      ...emptyState,
      running: true,
      startedAt: Date.now(),
      remoteJob: {
        jobId: job.jobId,
        batchId: job.batchId,
      },
      items: items.map((item) => ({ ...item })),
      jobs: restJobs,
      currentJob: firstJob,
      done: 0,
      total: jobs.length,
      logs: [`[${now()}] Worker job ${job.jobId}: ${items.length} items, ${jobs.length} routes.`],
    };
    writeState(state);
    log(`Worker accepted API job ${job.jobId}. Items: ${items.length}.`);
    heartbeat('busy', job.jobId).catch((error) => logError('Worker heartbeat failed', error));
    setStatus(`Worker job: ${items.length} items`);
    const remoteSequence = stopSequence;
    navigationTimer = setTimeout(() => {
      navigationTimer = null;
      if (remoteSequence !== stopSequence) return;
      navigateToJob(firstJob);
      scheduleCurrentJobProcessing(ROUTE_REQUEST_DELAY_MS);
    }, ROUTE_REQUEST_DELAY_MS);
  }

  async function stop() {
    stopSequence += 1;
    if (currentJobTimer) window.clearTimeout(currentJobTimer);
    if (navigationTimer) window.clearTimeout(navigationTimer);
    currentJobTimer = null;
    navigationTimer = null;
    setWorkerEnabled(false);
    const workerEnabledInput = document.querySelector('#codex-yandex-worker-enabled');
    if (workerEnabledInput) workerEnabledInput.checked = false;
    const state = readState();
    state.running = false;
    state.currentJob = null;
    state.lastError = 'Остановлено вручную';
    writeState(state);
    log('Очередь остановлена вручную.');
    try {
      await apiRequest('POST', `/api/workers/${encodeURIComponent(getWorkerId())}/stop`);
      log('Worker stop sent to API.');
    } catch (error) {
      logError('Не удалось отправить stop в API', error);
    }
    render();
  }

  function requestLocalStop(reason = 'Остановлено вручную') {
    stopSequence += 1;
    if (currentJobTimer) window.clearTimeout(currentJobTimer);
    if (navigationTimer) window.clearTimeout(navigationTimer);
    currentJobTimer = null;
    navigationTimer = null;
    const state = readState();
    state.running = false;
    state.currentJob = null;
    state.lastError = reason;
    writeState(state);
    render();
  }

  function requestLocalReset(reason = 'Удалено через API') {
    stopSequence += 1;
    if (currentJobTimer) window.clearTimeout(currentJobTimer);
    if (navigationTimer) window.clearTimeout(navigationTimer);
    currentJobTimer = null;
    navigationTimer = null;
    const state = readState();
    state.running = false;
    state.items = [];
    state.jobs = [];
    state.currentJob = null;
    state.remoteJob = null;
    state.done = 0;
    state.total = 0;
    state.lastError = reason;
    writeState(state);
    render();
  }

  function handleWorkerControl(payload) {
    const status = payload?.worker?.status || '';
    if (payload?.command === 'delete' || status === 'deleted') {
      requestLocalReset('Удалено через API');
      return true;
    }
    if (payload?.command === 'stop' || status === 'stopping' || status === 'stopped') {
      requestLocalStop('Остановлено через API');
      setWorkerEnabled(false);
      const workerEnabledInput = document.querySelector('#codex-yandex-worker-enabled');
      if (workerEnabledInput) workerEnabledInput.checked = false;
      return true;
    }
    return false;
  }

  async function resumeWorker() {
    try {
      await apiRequest('POST', `/api/workers/${encodeURIComponent(getWorkerId())}/resume`);
      log('Worker resumed via API.');
    } catch (error) {
      logError('Не удалось resume worker', error);
    }
  }

  async function syncWorkerNow() {
    const state = readState();
    try {
      const currentJobId = state.remoteJob?.jobId || null;
      const status = state.running || currentJobId ? 'busy' : 'ready';
      const heartbeatPayload = await heartbeat(status, currentJobId);
      if (handleWorkerControl(heartbeatPayload)) return;

      const payload = await apiRequest('GET', `/api/workers/${encodeURIComponent(getWorkerId())}/job`);
      if (handleWorkerControl(payload)) return;

      if (payload?.job) {
        startRemoteJob(payload.job);
        return;
      }

      log('Worker synchronised manually.');
    } catch (error) {
      logError('Не удалось синхронизировать worker', error);
    }
  }

  async function submitRemoteResult(state) {
    if (!state.remoteJob?.jobId) return;

    const jobId = state.remoteJob.jobId;
    try {
      await apiRequest('POST', `/api/jobs/${encodeURIComponent(jobId)}/result`, {
        workerId: getWorkerId(),
        items: state.items || [],
      });
      log(`Worker submitted API job ${jobId}.`);
      const nextState = readState();
      nextState.remoteJob = null;
      writeState(nextState);
      heartbeat('ready')
        .then((payload) => handleWorkerControl(payload))
        .catch((error) => logError('Worker heartbeat failed', error));
      scheduleWorkerPoll(1000);
    } catch (error) {
      logError(`Worker failed to submit API job ${jobId}`, error);
      if (/deleted|410/i.test(String(error?.message || ''))) {
        requestLocalReset('Удалено через API');
        heartbeat('ready').catch(() => { });
        scheduleWorkerPoll(WORKER_POLL_MS);
        return;
      }
      const nextState = readState();
      nextState.lastError = error?.message || String(error);
      writeState(nextState);
      heartbeat('ready').catch(() => { });
      scheduleWorkerPoll(WORKER_POLL_MS);
    }
  }

  async function pollWorkerJob() {
    if (!isWorkerEnabled() || isWorkerPolling) return;

    const state = readState();
    if (state.running || state.remoteJob) {
      if (state.remoteJob?.jobId) {
        heartbeat('busy', state.remoteJob.jobId)
          .then((payload) => handleWorkerControl(payload))
          .catch((error) => logError('Worker heartbeat failed', error));
      }
      return;
    }

    isWorkerPolling = true;
    try {
      const heartbeatPayload = await heartbeat('ready');
      if (handleWorkerControl(heartbeatPayload)) return;
      const payload = await apiRequest('GET', `/api/workers/${encodeURIComponent(getWorkerId())}/job`);
      if (handleWorkerControl(payload)) return;
      if (payload?.job) {
        startRemoteJob(payload.job);
      } else {
        setStatus(`Worker ready: ${getWorkerId()}`);
      }
    } catch (error) {
      logError('Worker poll failed', error);
      setStatus(`Worker API error: ${error?.message || error}`);
    } finally {
      isWorkerPolling = false;
    }
  }

  function scheduleWorkerPoll(delayMs = WORKER_POLL_MS) {
    if (workerTimer) clearTimeout(workerTimer);
    if (!isWorkerEnabled()) return;

    workerTimer = setTimeout(async () => {
      await pollWorkerJob();
      scheduleWorkerPoll(WORKER_POLL_MS);
    }, delayMs);
  }

  function getResultJson() {
    return JSON.stringify(readState().items || [], null, 2);
  }

  function copyResult() {
    GM_setClipboard(getResultJson(), 'text');
    log('Результат скопирован в буфер обмена.');
  }

  function downloadResult() {
    const blob = new Blob([getResultJson()], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'avito-transit-yandex-result.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  function extractDurationFromText(text) {
    const normalized = normalizeText(text).toLowerCase();
    const routePattern = /(?:(\d+)\s*д\s*)?(?:(\d+)\s*ч\s*)?(\d+)\s*мин\b/iu;
    const hourOnlyPattern = /(?:(\d+)\s*д\s*)?(\d+)\s*ч\b/iu;

    const routeMatch = normalized.match(routePattern);
    if (routeMatch) {
      const days = Number(routeMatch[1] || 0);
      const hours = Number(routeMatch[2] || 0);
      const minutes = Number(routeMatch[3] || 0);
      const parts = [];
      if (days) parts.push(`${days} д`);
      if (hours) parts.push(`${hours} ч`);
      parts.push(`${minutes} мин`);
      return parts.join(' ');
    }

    const hourOnlyMatch = normalized.match(hourOnlyPattern);
    if (hourOnlyMatch) {
      const days = Number(hourOnlyMatch[1] || 0);
      const hours = Number(hourOnlyMatch[2] || 0);
      const parts = [];
      if (days) parts.push(`${days} д`);
      parts.push(`${hours} ч`);
      return parts.join(' ');
    }

    return '';
  }

  function extractExactDurationFromText(text) {
    const normalized = normalizeText(text).toLowerCase();
    const exactPattern = /^(?:(\d+)\s*д\s*)?(?:(\d+)\s*ч\s*)?(\d+)\s*мин$/iu;
    const exactHourPattern = /^(?:(\d+)\s*д\s*)?(\d+)\s*ч$/iu;

    if (exactPattern.test(normalized) || exactHourPattern.test(normalized)) {
      return extractDurationFromText(normalized);
    }

    return '';
  }

  function describeDurationSource(source) {
    if (!source) return '';
    return `${source.value} | ${source.method} | ${source.selector || 'no selector'} | ${source.text || 'no text'}`;
  }

  function clearDurationHighlights() {
    document.querySelectorAll('[data-codex-duration-highlight="1"]').forEach((node) => {
      node.style.outline = '';
      node.style.outlineOffset = '';
      node.style.boxShadow = '';
      node.style.backgroundColor = '';
      node.removeAttribute('data-codex-duration-highlight');
    });
  }

  function highlightDurationNode(node, color = '#ff1744') {
    if (!node || !(node instanceof HTMLElement)) return;
    node.setAttribute('data-codex-duration-highlight', '1');
    node.style.outline = `4px solid ${color}`;
    node.style.outlineOffset = '3px';
    node.style.boxShadow = `0 0 0 8px rgba(255, 23, 68, 0.22)`;
    node.style.backgroundColor = 'rgba(255, 23, 68, 0.12)';
    node.scrollIntoView({ block: 'center', inline: 'center' });
  }

  function highlightAllDurationNodes() {
    clearDurationHighlights();
    const nodes = [...document.querySelectorAll('.masstransit-route-snippet-view__route-duration')];
    nodes.forEach((node) => highlightDurationNode(node, '#ff1744'));
    return nodes.map((node, index) => `${index + 1}: "${normalizeText(node.textContent || '')}"`).join('; ');
  }

  function highlightDurationSource(source) {
    clearDurationHighlights();
    if (source?.node) {
      highlightDurationNode(source.node);
      return;
    }
    highlightAllDurationNodes();
  }

  function isVisibleElement(element) {
    if (!element || !(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  }

  function isRouteSegmentElement(element) {
    const blocked = element.closest(
      [
        '[class*="legend"]',
        '[class*="segment"]',
        '[class*="walk"]',
        '[class*="pedestrian"]',
        '[aria-label*="Пешком"]',
        '[aria-label*="пешком"]',
        '[aria-label*="Проезд"]',
      ].join(',')
    );
    return Boolean(blocked);
  }

  function findDurationFromVisibleElements() {
    const nodes = document.querySelectorAll([
      '.route-snippet-view .masstransit-route-snippet-view__route-duration',
      '.route-snippet-view[aria-label*="На общественном транспорте"]',
      '.route-list-view [aria-label*="На общественном транспорте"]',
      '[aria-label*="На общественном транспорте"] .masstransit-route-snippet-view__route-duration',
    ].join(','));

    for (const node of nodes) {
      if (!isVisibleElement(node) || isRouteSegmentElement(node)) continue;

      const ownText = normalizeText(node.textContent || '');
      if (!ownText || ownText.length > 20) continue;

      const duration = extractExactDurationFromText(ownText);
      if (duration) return duration;
    }

    return '';
  }

  function findDurationFromSidebarText() {
    const roots = [
      document.querySelector('[class*="sidebar"]'),
      document.querySelector('[class*="route-panel"]'),
      document.querySelector('[class*="routes"]'),
      document.querySelector('main'),
      document.body,
    ].filter(Boolean);

    for (const root of roots) {
      const lines = String(root.innerText || '')
        .split('\n')
        .map(normalizeText)
        .filter(Boolean);

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const duration = extractExactDurationFromText(line);
        if (!duration) continue;

        const around = [lines[index - 1], line, lines[index + 1], lines[index + 2]]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        if (around.includes('пешком') || around.includes('проезд')) continue;
        return duration;
      }
    }

    return '';
  }

  function readDurationFromRouteCard(card) {
    if (!card) return '';

    const durationNode = card.querySelector('.masstransit-route-snippet-view__route-duration');
    const durationFromNode = extractDurationFromText(durationNode?.textContent || '');
    if (durationFromNode) return durationFromNode;

    const ariaLabel = card.getAttribute('aria-label') || '';
    const durationFromLabel = extractDurationFromText(ariaLabel);
    if (durationFromLabel) return durationFromLabel;

    return '';
  }

  function findActiveRouteDurationSource() {
    const selectors = [
      '.route-snippet-view._active._type_masstransit[aria-hidden="false"] .masstransit-route-snippet-view__route-duration',
      '.route-snippet-view._active._type_masstransit .masstransit-route-snippet-view__route-duration',
      '.route-snippet-view._type_masstransit[aria-current="step"] .masstransit-route-snippet-view__route-duration',
      '.route-snippet-view._type_masstransit[aria-hidden="false"] .masstransit-route-snippet-view__route-duration',
      '.route-list-view._travel-mode_masstransit .route-snippet-view._active .masstransit-route-snippet-view__route-duration',
    ];

    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = normalizeText(node?.textContent || '');
      const duration = extractDurationFromText(text);
      if (duration) {
        highlightDurationNode(node);
        return {
          value: duration,
          method: 'active route duration node',
          selector,
          text,
          node,
        };
      }
    }

    return null;
  }

  function findRouteDurationSource() {
    const activeDuration = findActiveRouteDurationSource();
    if (activeDuration) return activeDuration;

    const exactSelectors = [
      '.route-snippet-view._active._type_masstransit[aria-hidden="false"]',
      '.route-snippet-view._type_masstransit[aria-current="step"]',
      '.route-snippet-view._active._type_masstransit',
      '.route-snippet-view._type_masstransit[aria-hidden="false"]',
      '.route-snippet-view._type_masstransit',
    ];

    for (const selector of exactSelectors) {
      const card = document.querySelector(selector);
      const duration = readDurationFromRouteCard(card);
      if (duration) {
        highlightDurationNode(card);
        return {
          value: duration,
          method: 'route card',
          selector,
          text: normalizeText(card?.textContent || card?.getAttribute('aria-label') || '').slice(0, 180),
          node: card,
        };
      }
    }

    const durationNodes = document.querySelectorAll('.masstransit-route-snippet-view__route-duration');
    for (const node of durationNodes) {
      const card = node.closest('.route-snippet-view');
      if (card && card.getAttribute('aria-hidden') === 'true') continue;

      const text = normalizeText(node.textContent || '');
      const duration = extractDurationFromText(text);
      if (duration) {
        highlightDurationNode(node);
        return {
          value: duration,
          method: 'first visible duration node',
          selector: '.masstransit-route-snippet-view__route-duration',
          text,
          node,
        };
      }
    }

    const activeCards = document.querySelectorAll('[aria-label*="На общественном транспорте"]');
    for (const card of activeCards) {
      if (card.getAttribute('aria-hidden') === 'true') continue;

      const text = normalizeText(card.getAttribute('aria-label') || '');
      const duration = extractDurationFromText(text);
      if (duration) {
        highlightDurationNode(card);
        return {
          value: duration,
          method: 'transport aria-label',
          selector: '[aria-label*="На общественном транспорте"]',
          text,
          node: card,
        };
      }
    }

    const visibleDuration = findDurationFromVisibleElements();
    if (visibleDuration) {
      return {
        value: visibleDuration,
        method: 'visible exact text fallback',
        selector: 'visible div/span/button/a/[role=listitem]',
        text: visibleDuration,
      };
    }

    const sidebarDuration = findDurationFromSidebarText();
    if (sidebarDuration) {
      return {
        value: sidebarDuration,
        method: 'sidebar text fallback',
        selector: 'sidebar/main/body innerText lines',
        text: sidebarDuration,
      };
    }

    const bodyText = normalizeText(document.body?.innerText || '');
    const bodyDuration = extractDurationFromText(bodyText);
    return bodyDuration
      ? {
        value: bodyDuration,
        method: 'body text fallback',
        selector: 'document.body.innerText',
        text: bodyText.slice(0, 180),
      }
      : null;
  }

  function findRouteDuration() {
    return findRouteDurationSource()?.value || '';
  }

  function debugCheckCurrentDuration() {
    const source = findRouteDurationSource();
    const activeCount = document.querySelectorAll('.route-snippet-view._active._type_masstransit').length;
    const durationCount = document.querySelectorAll('.masstransit-route-snippet-view__route-duration').length;

    if (source) {
      highlightDurationSource(source);
      log(`Ручная проверка времени: ${describeDurationSource(source)}`);
    } else {
      const nodeTexts = highlightAllDurationNodes();
      log(`Ручная проверка времени: не найдено. active routes=${activeCount}, duration nodes=${durationCount}. duration texts: ${nodeTexts || 'empty'}`);
    }
  }

  function isRouteErrorVisible() {
    const text = normalizeText(document.body?.innerText || '').toLowerCase();
    return (
      text.includes('маршрут не найден') ||
      text.includes('не удалось построить') ||
      text.includes('ничего не найдено')
    );
  }

  async function waitForDuration() {
    const duration = await new Promise((resolve) => {
      let settled = false;
      let intervalId = null;
      let timerId = null;
      let observer = null;

      function finish(value) {
        if (settled) return;
        settled = true;
        if (intervalId) window.clearInterval(intervalId);
        if (timerId) window.clearTimeout(timerId);
        if (observer) observer.disconnect();
        resolve(value);
      }

      function check() {
        const source = findRouteDurationSource();
        if (source) {
          finish(source);
          return;
        }

        if (isRouteErrorVisible()) {
          finish({
            value: 'маршрут не найден',
            method: 'route error text',
            selector: 'document.body.innerText',
            text: 'маршрут не найден',
          });
        }
      }

      observer = new MutationObserver(check);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      intervalId = window.setInterval(check, POLL_MS);
      timerId = window.setTimeout(() => finish(''), ROUTE_WAIT_MS);
      check();
    });

    if (duration?.value) {
      if (duration.value === 'маршрут не найден') {
        log('Яндекс показал ошибку: маршрут не найден.');
      } else {
        highlightDurationSource(duration);
        log(`Время найдено: ${describeDurationSource(duration)}`);
      }
      return duration;
    }

    const activeCount = document.querySelectorAll('.route-snippet-view._active._type_masstransit').length;
    const durationCount = document.querySelectorAll('.masstransit-route-snippet-view__route-duration').length;
    const nodeTexts = highlightAllDurationNodes();
    log(`Диагностика: active routes=${activeCount}, duration nodes=${durationCount}. duration texts: ${nodeTexts || 'empty'}`);
    log(`Таймаут ${Math.round(ROUTE_WAIT_MS / 1000)} сек: время не найдено.`);
    return {
      value: 'время не найдено',
      method: 'timeout',
      selector: '',
      text: '',
    };
  }

  async function processCurrentJob() {
    if (isProcessing) {
      log('Обработчик уже запущен, повторный запуск пропущен.');
      return;
    }

    const state = readState();
    if (!state.running || !state.currentJob) {
      log('Нет активного маршрута для обработки.');
      return;
    }

    isProcessing = true;
    const job = state.currentJob;
    try {
      log(`Начинаю обработку: ${Number(state.done || 0) + 1}/${state.total || 0}, объект ${job.itemIndex + 1}, ${job.destinationLabel}.`);
      log(`Откуда: ${job.origin}`);
      log(`Куда: ${job.destination}`);
      setStatus(`Считаю: ${job.origin} -> ${job.destinationLabel}`);
      const durationSource = await waitForDuration();
      const duration = durationSource.value;

      const nextState = readState();
      const item = nextState.items?.[job.itemIndex];
      if (item) item[job.destinationKey] = duration;
      if (!item) log(`Предупреждение: объект ${job.itemIndex + 1} не найден в текущем состоянии.`);

      if (isDebugStopEnabled() && duration !== 'время не найдено' && duration !== 'маршрут не найден') {
        nextState.running = false;
        nextState.currentJob = null;
        nextState.lastError = 'Остановлено режимом отладки после найденного времени';
        nextState.logs = [
          ...(nextState.logs || []),
          `[${now()}] DEBUG STOP: ${describeDurationSource(durationSource)}`,
        ].slice(-180);
        writeState(nextState);
        render();
        setStatus('Отладка: остановлено после найденного времени.');
        log('Отладка остановила очередь после найденного времени.');
        return;
      }

      nextState.done = Number(nextState.done || 0) + 1;
      nextState.logs = [
        ...(nextState.logs || []),
        `[${now()}] ${job.itemIndex + 1}. ${job.destinationLabel}: ${duration}`,
      ].slice(-180);

      const [nextJob, ...restJobs] = nextState.jobs || [];
      nextState.currentJob = nextJob || null;
      nextState.jobs = restJobs;
      nextState.running = Boolean(nextJob);
      writeState(nextState);
      render();
      if (nextState.remoteJob?.jobId) {
        heartbeat('busy', nextState.remoteJob.jobId).catch((error) => logError('Worker heartbeat failed', error));
      }

      if (nextJob) {
        setStatus(`Пауза ${Math.round(ROUTE_REQUEST_DELAY_MS / 1000)} сек перед следующим запросом маршрута...`);
        log(`Готово ${nextState.done}/${nextState.total}. Следующий: объект ${nextJob.itemIndex + 1}, ${nextJob.destinationLabel}. Пауза ${Math.round(ROUTE_REQUEST_DELAY_MS / 1000)} сек.`);
        setTimeout(() => {
          navigateToJob(nextJob);
          scheduleCurrentJobProcessing(ROUTE_REQUEST_DELAY_MS);
        }, ROUTE_REQUEST_DELAY_MS);
      } else {
        setStatus('Готово. Можно копировать или скачать JSON.');
        log('Все маршруты обработаны.');
        if (nextState.remoteJob?.jobId) {
          submitRemoteResult(nextState);
        }
      }
    } finally {
      isProcessing = false;
    }
  }

  function setStatus(text) {
    const node = document.querySelector('#codex-yandex-transit-status');
    if (node) node.textContent = text;
  }

  function ensureUi() {
    if (document.querySelector('#codex-yandex-transit-root')) return;

    const style = document.createElement('style');
    style.textContent = `
      #codex-yandex-transit-root {
        position: fixed;
        top: 72px;
        right: 16px;
        z-index: 2147483647;
        width: 380px;
        max-height: calc(100vh - 96px);
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px;
        color: #172033;
        background: rgba(255,255,255,0.96);
        border: 1px solid rgba(16,24,40,0.16);
        border-radius: 8px;
        box-shadow: 0 18px 50px rgba(16,24,40,0.20);
        font: 13px/1.35 Arial, sans-serif;
      }
      #codex-yandex-transit-root * { box-sizing: border-box; }
      .codex-yandex-title {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: center;
        font-weight: 700;
      }
      .codex-yandex-muted { color: #667085; font-size: 12px; }
      #codex-yandex-transit-input {
        width: 100%;
        min-height: 150px;
        resize: vertical;
        border: 1px solid #ccd5e1;
        border-radius: 6px;
        padding: 8px;
        font: 12px/1.35 Consolas, monospace;
      }
      .codex-yandex-file-row {
        display: grid;
        gap: 6px;
      }
      #codex-yandex-transit-file {
        width: 100%;
        color: #344054;
        font: 12px/1.35 Arial, sans-serif;
      }
      #codex-yandex-transit-file::file-selector-button {
        margin-right: 8px;
        border: 0;
        border-radius: 6px;
        padding: 8px 10px;
        background: #475467;
        color: #fff;
        font-weight: 700;
        cursor: pointer;
      }
      #codex-yandex-transit-file-summary {
        color: #1849a9;
        font-size: 12px;
      }
      .codex-yandex-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .codex-yandex-btn {
        border: 0;
        border-radius: 6px;
        padding: 9px 10px;
        background: #1f6feb;
        color: white;
        font-weight: 700;
        cursor: pointer;
      }
      .codex-yandex-btn.secondary { background: #475467; }
      .codex-yandex-btn.danger { background: #b42318; }
      .codex-yandex-btn:disabled { opacity: 0.55; cursor: default; }
      .codex-yandex-check {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #344054;
        font-size: 12px;
      }
      .codex-yandex-worker-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }
      .codex-yandex-worker-grid input {
        width: 100%;
        border: 1px solid #ccd5e1;
        border-radius: 6px;
        padding: 7px;
        font: 12px/1.35 Consolas, monospace;
      }
      #codex-yandex-transit-status {
        padding: 8px;
        border-radius: 6px;
        background: #eef4ff;
        color: #1849a9;
      }
      #codex-yandex-transit-eta {
        min-height: 18px;
        margin-top: -4px;
        padding: 0 8px;
      }
      #codex-yandex-transit-log {
        min-height: 70px;
        max-height: 150px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
        padding: 8px;
        border-radius: 6px;
        background: #101828;
        color: #e4e7ec;
        font: 12px/1.35 Consolas, monospace;
      }
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'codex-yandex-transit-root';
    root.innerHTML = `
      <div class="codex-yandex-title">
        <span>Avito Transit v${SCRIPT_VERSION}</span>
        <span class="codex-yandex-muted">Яндекс.Карты</span>
      </div>
      <div id="codex-yandex-transit-status">Готов к запуску</div>
      <div id="codex-yandex-transit-eta" class="codex-yandex-muted"></div>
      <label class="codex-yandex-check">
        <input id="codex-yandex-worker-enabled" type="checkbox">
        <span>Worker mode</span>
      </label>
      <div class="codex-yandex-worker-grid">
        <input id="codex-yandex-worker-id" placeholder="worker id">
        <input id="codex-yandex-api-url" placeholder="http://127.0.0.1:8787">
      </div>
      <textarea id="codex-yandex-transit-input" placeholder='Вставь JSON-массив Avito. Например: [{"title":"...","adress":"Москва, ..."}]'></textarea>
      <div class="codex-yandex-row">
        <button id="codex-yandex-start" class="codex-yandex-btn">Старт</button>
        <button id="codex-yandex-stop" class="codex-yandex-btn danger">Стоп</button>
      </div>
      <div class="codex-yandex-row">
        <button id="codex-yandex-sync" class="codex-yandex-btn secondary">Sync now</button>
        <button id="codex-yandex-resume" class="codex-yandex-btn secondary">Resume worker</button>
      </div>
      <div class="codex-yandex-row">
        <button id="codex-yandex-copy" class="codex-yandex-btn secondary">Копировать JSON</button>
        <button id="codex-yandex-download" class="codex-yandex-btn secondary">Скачать JSON</button>
      </div>
      <label class="codex-yandex-check">
        <input id="codex-yandex-debug-stop" type="checkbox">
        <span>Стоп на найденном времени</span>
      </label>
      <button id="codex-yandex-clear" class="codex-yandex-btn secondary">Очистить прогресс</button>
      <pre id="codex-yandex-transit-log"></pre>
    `;
    document.body.appendChild(root);

    const textarea = root.querySelector('#codex-yandex-transit-input');
    const fileRow = document.createElement('div');
    fileRow.className = 'codex-yandex-file-row';

    const fileInput = document.createElement('input');
    fileInput.id = 'codex-yandex-transit-file';
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';

    const fileHint = document.createElement('span');
    fileHint.className = 'codex-yandex-muted';
    fileHint.textContent = '\u041c\u043e\u0436\u043d\u043e \u0432\u044b\u0431\u0440\u0430\u0442\u044c .json \u0444\u0430\u0439\u043b \u0432\u043c\u0435\u0441\u0442\u043e \u0440\u0443\u0447\u043d\u043e\u0439 \u0432\u0441\u0442\u0430\u0432\u043a\u0438 JSON.';

    const fileSummary = document.createElement('span');
    fileSummary.id = 'codex-yandex-transit-file-summary';
    fileSummary.textContent = '\u0424\u0430\u0439\u043b \u0435\u0449\u0435 \u043d\u0435 \u0432\u044b\u0431\u0440\u0430\u043d.';

    fileRow.appendChild(fileInput);
    fileRow.appendChild(fileHint);
    fileRow.appendChild(fileSummary);
    textarea.insertAdjacentElement('afterend', fileRow);

    const workerEnabledInput = root.querySelector('#codex-yandex-worker-enabled');
    const workerIdInput = root.querySelector('#codex-yandex-worker-id');
    const apiUrlInput = root.querySelector('#codex-yandex-api-url');
    workerEnabledInput.checked = isWorkerEnabled();
    workerIdInput.value = getWorkerId();
    apiUrlInput.value = getApiUrl();

    workerEnabledInput.addEventListener('change', async () => {
      setWorkerEnabled(workerEnabledInput.checked);
      log(workerEnabledInput.checked ? `Worker enabled: ${getWorkerId()}` : 'Worker disabled.');
      if (workerEnabledInput.checked) {
        await resumeWorker();
        scheduleWorkerPoll(100);
      } else if (workerTimer) {
        clearTimeout(workerTimer);
        workerTimer = null;
      }
    });

    workerIdInput.addEventListener('change', () => {
      setWorkerId(workerIdInput.value);
      workerIdInput.value = getWorkerId();
      log(`Worker id set: ${getWorkerId()}`);
    });

    apiUrlInput.addEventListener('change', () => {
      setApiUrl(apiUrlInput.value);
      apiUrlInput.value = getApiUrl();
      log(`API url set: ${getApiUrl()}`);
    });

    root.querySelector('#codex-yandex-start').addEventListener('click', () => {
      try {
        start(textarea.value);
      } catch (error) {
        setStatus(error?.message || String(error));
      }
    });

    root.querySelector('#codex-yandex-sync').addEventListener('click', () => {
      syncWorkerNow();
    });

    root.querySelector('#codex-yandex-resume').addEventListener('click', async () => {
      setWorkerEnabled(true);
      workerEnabledInput.checked = true;
      await resumeWorker();
      scheduleWorkerPoll(100);
      log('Worker mode resumed manually.');
    });

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      try {
        await loadJsonFile(file, textarea);
      } catch (error) {
        setFileSummary('\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c JSON-\u0444\u0430\u0439\u043b.');
        setStatus(error?.message || String(error));
        logError(`Failed to load JSON file ${file.name}`, error);
      } finally {
        fileInput.value = '';
      }
    });

    root.querySelector('#codex-yandex-stop').addEventListener('click', stop);
    root.querySelector('#codex-yandex-copy').addEventListener('click', copyResult);
    root.querySelector('#codex-yandex-download').addEventListener('click', downloadResult);
    const debugStopInput = root.querySelector('#codex-yandex-debug-stop');
    debugStopInput.checked = isDebugStopEnabled();
    debugStopInput.addEventListener('change', () => {
      setDebugStopEnabled(debugStopInput.checked);
      log(debugStopInput.checked ? 'Отладка включена: остановка на найденном времени.' : 'Отладка выключена.');
    });
    root.querySelector('#codex-yandex-clear').addEventListener('click', () => {
      resetState();
      setFileSummary('\u0424\u0430\u0439\u043b \u0435\u0449\u0435 \u043d\u0435 \u0432\u044b\u0431\u0440\u0430\u043d.');
      render();
      setStatus('Прогресс очищен.');
    });
  }

  function render() {
    ensureUi();
    const state = readState();
    const textarea = document.querySelector('#codex-yandex-transit-input');
    const logNode = document.querySelector('#codex-yandex-transit-log');

    if (textarea && state.items?.length && !textarea.value.trim()) {
      textarea.value = JSON.stringify(state.items, null, 2);
    }

    if (logNode) {
      logNode.textContent = (state.logs || []).join('\n');
      logNode.scrollTop = logNode.scrollHeight;
    }

    const status = state.running
      ? `В работе: ${state.done || 0}/${state.total || 0}`
      : state.items?.length
        ? `Готово или остановлено: ${state.done || 0}/${state.total || 0}`
        : 'Готов к запуску';
    setStatus(status);
    const etaNode = document.querySelector('#codex-yandex-transit-eta');
    if (etaNode) {
      etaNode.textContent = buildEtaText(state);
    }
  }

  function bootstrap() {
    render();
    const state = readState();

    if (state.running && state.currentJob) {
      scheduleCurrentJobProcessing(0);
    } else if (isWorkerEnabled()) {
      scheduleWorkerPoll(500);
    }
  }

  bootstrap();
})();
