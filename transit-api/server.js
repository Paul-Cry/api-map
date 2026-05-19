import http from 'node:http';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

const PORT = Number(process.env.PORT || process.env.TRANSIT_API_PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const WORKER_TTL_MS = Number(process.env.WORKER_TTL_MS || 45000);

const workers = new Map();
const batches = new Map();
const jobs = new Map();
const queue = [];

function nowIso() {
  return new Date().toISOString();
}

function localIpAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve(null);
        return;
      }

      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400, cause: error }));
      }
    });
    req.on('error', reject);
  });
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, error: message });
}

function sendDownload(res, filename, payload) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function splitIntoChunks(items, count) {
  const chunks = Array.from({ length: count }, () => []);
  items.forEach((item, index) => {
    chunks[index % count].push(item);
  });
  return chunks.filter((chunk) => chunk.length > 0);
}

function activeWorkers() {
  const threshold = Date.now() - WORKER_TTL_MS;
  return [...workers.values()].filter((worker) => worker.lastSeenMs >= threshold);
}

function workerEffectiveStatus(worker) {
  if (!worker) return 'ready';
  if (worker.stopRequestedAt) {
    return worker.currentJobId ? 'stopping' : 'stopped';
  }
  return worker.status || 'ready';
}

function workerView(worker) {
  const status = workerEffectiveStatus(worker);
  return {
    workerId: worker.workerId,
    name: worker.name || '',
    status,
    currentJobId: worker.currentJobId || null,
    lastSeenAt: worker.lastSeenAt,
    ready: status === 'ready',
    stopped: status === 'stopped' || status === 'stopping',
    stopRequestedAt: worker.stopRequestedAt || null,
    stopReason: worker.stopReason || '',
    progress: {
      objectsDone: Number(worker.progress?.objectsDone || 0),
      objectsTotal: Number(worker.progress?.objectsTotal || 0),
      objectsRemaining: Number(worker.progress?.objectsRemaining || 0),
      routesDone: Number(worker.progress?.routesDone || 0),
      routesTotal: Number(worker.progress?.routesTotal || 0),
      routesRemaining: Number(worker.progress?.routesRemaining || 0),
      currentObjectIndex: worker.progress?.currentObjectIndex ?? null,
    },
  };
}

function batchView(batch) {
  const batchJobs = batch.jobIds.map((jobId) => jobs.get(jobId)).filter(Boolean);
  const done = batchJobs.filter((job) => job.status === 'done').length;
  const failed = batchJobs.filter((job) => job.status === 'failed').length;
  const deleted = batchJobs.filter((job) => job.status === 'deleted').length;
  const resultItems = batch.results.flat();
  return {
    batchId: batch.batchId,
    status: done + failed + deleted === batchJobs.length ? 'done' : 'running',
    createdAt: batch.createdAt,
    totalItems: batch.totalItems,
    resultItems,
    resultCount: resultItems.length,
    jobsTotal: batchJobs.length,
    jobsDone: done,
    jobsFailed: failed,
    jobsDeleted: deleted,
    jobs: batchJobs.map((job) => {
      const worker = job.workerId ? workers.get(job.workerId) : null;
      return {
        jobId: job.jobId,
        workerId: job.workerId || null,
        status: job.status,
        itemsCount: job.items.length,
        resultCount: job.result?.length || 0,
        startedAt: job.startedAt || null,
        finishedAt: job.finishedAt || null,
        error: job.error || '',
        deletedAt: job.deletedAt || null,
        workerProgress: worker?.progress || null,
      };
    }),
  };
}

function statusView() {
  const active = activeWorkers().map(workerView);
  const workersStopped = active.filter((worker) => worker.stopped).length;
  return {
    ok: true,
    server: {
      host: HOST,
      port: PORT,
      localUrls: ['127.0.0.1', 'localhost', ...localIpAddresses()].map((host) => `http://${host}:${PORT}/`),
    },
    workersConnected: active.length,
    workersReady: active.filter((worker) => worker.ready).length,
    workersStopped,
    queuedJobs: queue.length,
    workers: active,
    batches: [...batches.values()].map((batch) => {
      const view = batchView(batch);
      return {
        batchId: view.batchId,
        status: view.status,
        createdAt: view.createdAt,
        totalItems: view.totalItems,
        resultCount: view.resultCount,
        jobsTotal: view.jobsTotal,
        jobsDone: view.jobsDone,
        jobsFailed: view.jobsFailed,
      };
    }),
  };
}

function updateWorker(workerId, patch = {}) {
  const existing = workers.get(workerId) || { workerId };
  const next = {
    ...existing,
    ...patch,
    progress: patch.progress || existing.progress || {},
    lastSeenMs: Date.now(),
    lastSeenAt: nowIso(),
  };
  workers.set(workerId, next);
  return next;
}

function setWorkerStop(workerId, reason = 'manual stop') {
  const existing = workers.get(workerId) || { workerId };
  return updateWorker(workerId, {
    status: existing.currentJobId ? 'stopping' : 'stopped',
    stopRequestedAt: nowIso(),
    stopReason: reason,
  });
}

function clearWorkerStop(workerId) {
  const existing = workers.get(workerId) || { workerId };
  const patch = {
    stopRequestedAt: null,
    stopReason: '',
  };
  if (existing.status === 'stopped' || existing.status === 'stopping') {
    patch.status = 'ready';
  }
  return updateWorker(workerId, patch);
}

function setAllWorkersStop(reason = 'manual stop all') {
  const affected = [];
  for (const workerId of workers.keys()) {
    affected.push(workerView(setWorkerStop(workerId, reason)));
  }
  return affected;
}

function clearAllWorkersStop() {
  const affected = [];
  for (const workerId of workers.keys()) {
    affected.push(workerView(clearWorkerStop(workerId)));
  }
  return affected;
}

function deleteJob(jobId, reason = 'manual delete') {
  const job = jobs.get(jobId);
  if (!job) return null;

  const queueIndex = queue.indexOf(jobId);
  if (queueIndex !== -1) {
    queue.splice(queueIndex, 1);
  }

  if (job.batchId) {
    const batch = batches.get(job.batchId);
    if (batch) {
      if (Array.isArray(batch.results) && typeof job.index === 'number') {
        batch.results[job.index] = [];
      }
    }
  }

  if (job.workerId) {
    const worker = workers.get(job.workerId);
    if (worker) {
      updateWorker(job.workerId, {
        status: worker.stopRequestedAt ? 'stopped' : 'busy',
        progress: worker.progress || {},
      });
    }
  }

  job.status = 'deleted';
  job.error = reason;
  job.deletedAt = nowIso();
  job.finishedAt = nowIso();
  job.result = null;
  return job;
}

function deleteAllJobs(reason = 'manual delete all') {
  const deletedJobs = [];
  for (const jobId of [...jobs.keys()]) {
    const job = jobs.get(jobId);
    if (!job || job.status === 'deleted') continue;
    deletedJobs.push(deleteJob(jobId, reason));
  }
  return deletedJobs.filter(Boolean);
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Transit Workers Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f14;
      --panel: #121821;
      --panel-2: #171f2b;
      --line: #293342;
      --text: #e8edf5;
      --muted: #9aa8bb;
      --accent: #4aa3ff;
      --ok: #44d17d;
      --warn: #f6c85f;
      --bad: #ff6b6b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 Arial, sans-serif;
    }
    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 44px;
    }
    header {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
    }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 16px; margin-bottom: 12px; }
    .muted { color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 12px;
      margin-bottom: 18px;
    }
    .toolbar {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin: 0 0 12px;
      flex-wrap: wrap;
    }
    .toolbar button {
      width: auto;
      min-width: 140px;
      padding: 10px 14px;
    }
    .stat, .section, .worker, .batch {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
    }
    .stat { padding: 14px; }
    .stat strong {
      display: block;
      font-size: 28px;
      line-height: 1.1;
      margin-top: 4px;
    }
    .layout {
      display: grid;
      grid-template-columns: 380px 1fr;
      gap: 14px;
      align-items: start;
    }
    .section { padding: 16px; }
    input[type="file"], input[type="number"], button {
      width: 100%;
      min-height: 40px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      padding: 8px 10px;
      font: inherit;
    }
    button {
      border: 0;
      background: var(--accent);
      color: #06111f;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled {
      cursor: default;
      opacity: 0.55;
    }
    .form {
      display: grid;
      gap: 10px;
    }
    .workers, .batches {
      display: grid;
      gap: 10px;
    }
    .worker, .batch {
      padding: 12px;
      background: var(--panel-2);
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 3px 8px;
      border-radius: 999px;
      background: #202b3a;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .badge.ready { color: #062313; background: var(--ok); }
    .badge.busy { color: #241801; background: var(--warn); }
    .badge.failed { color: #2b0707; background: var(--bad); }
    .badge.stopped { color: #f8f0f0; background: #6a1a1a; }
    .badge.stopping { color: #2f1d00; background: #ffd166; }
    .worker-note {
      margin-top: 6px;
      color: var(--warn);
      font-size: 12px;
      font-weight: 700;
    }
    .progress {
      height: 8px;
      overflow: hidden;
      border-radius: 999px;
      background: #263142;
      margin: 10px 0 8px;
    }
    .bar {
      height: 100%;
      width: 0%;
      border-radius: inherit;
      background: var(--accent);
      transition: width .2s ease;
    }
    .meta {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .actions, .worker-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .toolbar button {
      min-height: 38px;
      padding: 8px 14px;
      border-radius: 6px;
      background: #263142;
      color: var(--text);
      font-weight: 700;
      border: 0;
      cursor: pointer;
    }
    .toolbar button.danger {
      background: #7a1f1f;
      color: #fff;
    }
    .actions a, .worker-actions button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      padding: 8px 10px;
      border-radius: 6px;
      background: #263142;
      color: var(--text);
      text-decoration: none;
      font-weight: 700;
      border: 0;
      cursor: pointer;
      flex: 1;
      min-width: 118px;
    }
    #message {
      min-height: 20px;
      color: var(--muted);
    }
    @media (max-width: 900px) {
      header, .layout { display: block; }
      .grid { grid-template-columns: repeat(2, 1fr); }
      .section { margin-bottom: 14px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Transit Workers</h1>
        <div class="muted">Панель управления обработкой JSON через Яндекс.Карты</div>
      </div>
      <div class="muted" id="updated">Обновление...</div>
    </header>

    <div class="toolbar">
      <button id="syncAllButton">Sync all</button>
      <button id="stopAllButton">Stop all</button>
      <button id="continueAllButton">Continue all</button>
      <button id="deleteAllJobsButton" class="danger">Delete all jobs</button>
    </div>

    <section class="grid">
      <div class="stat"><span class="muted">Подключено</span><strong id="workersConnected">0</strong></div>
      <div class="stat"><span class="muted">Готовы</span><strong id="workersReady">0</strong></div>
      <div class="stat"><span class="muted">Остановлены</span><strong id="workersStopped">0</strong></div>
      <div class="stat"><span class="muted">В очереди</span><strong id="queuedJobs">0</strong></div>
      <div class="stat"><span class="muted">Пачек</span><strong id="batchesTotal">0</strong></div>
    </section>

    <section class="layout">
      <div class="section">
        <h2>Запуск JSON</h2>
        <div class="form">
          <input id="jsonFile" type="file" accept=".json,application/json">
          <label class="muted" for="workersCount">На сколько частей делить</label>
          <input id="workersCount" type="number" min="1" value="4">
          <button id="runButton" disabled>Запустить обработку</button>
          <div id="message">Выбери JSON-файл.</div>
        </div>
      </div>

      <div class="section">
        <h2>Workers</h2>
        <div id="workers" class="workers"></div>
      </div>
    </section>

    <section class="section" style="margin-top:14px">
      <h2>Запуски</h2>
      <div id="batches" class="batches"></div>
    </section>
  </main>

  <script>
    const state = { fileItems: null, fileName: '', latestBatchId: null };
    const $ = (id) => document.getElementById(id);
    const pct = (done, total) => total > 0 ? Math.round((done / total) * 100) : 0;
    const short = (value) => value ? String(value).slice(0, 8) : '';

    function setMessage(text) {
      $('message').textContent = text;
    }

    function renderWorkers(workers) {
      $('workers').innerHTML = workers.length ? workers.map((worker) => {
        const progress = worker.progress || {};
        const routesDone = Number(progress.routesDone || 0);
        const routesTotal = Number(progress.routesTotal || 0);
        const percent = pct(routesDone, routesTotal);
        const isStopping = worker.status === 'stopping';
        const isStopped = worker.status === 'stopped';
        const stopped = isStopping || isStopped;
        const workerAction = stopped ? 'resume' : 'stop';
        const workerActionLabel = stopped ? 'Resume' : 'Stop';
        return \`
          <article class="worker">
            <div class="row">
              <strong>\${worker.workerId}</strong>
              <span class="badge \${worker.status === 'ready' ? 'ready' : isStopping ? 'stopping' : isStopped ? 'stopped' : 'busy'}">\${worker.status}</span>
            </div>
            <div class="progress"><div class="bar" style="width:\${percent}%"></div></div>
            <div class="meta">
              <span>Объекты: \${progress.objectsDone || 0}/\${progress.objectsTotal || 0}</span>
              <span>Осталось: \${progress.objectsRemaining || 0}</span>
              <span>Маршруты: \${routesDone}/\${routesTotal}</span>
            </div>
            \${isStopping ? '<div class="worker-note">Ожидает завершения текущей задачи перед остановкой.</div>' : ''}
            \${isStopped ? '<div class="worker-note">Worker остановлен и не получает новые задачи.</div>' : ''}
            <div class="muted" style="margin-top:8px">job: \${short(worker.currentJobId) || 'нет'} · \${worker.lastSeenAt || ''}</div>
            <div class="worker-actions">
              <button data-worker-action="sync" data-worker-id="\${worker.workerId}">Sync</button>
              <button data-worker-action="\${workerAction}" data-worker-id="\${worker.workerId}">\${workerActionLabel}</button>
            </div>
          </article>
        \`;
      }).join('') : '<div class="muted">Workers пока не подключены.</div>';
    }

    function renderBatches(batches) {
      $('batches').innerHTML = batches.length ? batches.slice().reverse().map((batch) => {
        const percent = pct(batch.jobsDone + batch.jobsFailed, batch.jobsTotal);
        const done = batch.status === 'done';
        return \`
          <article class="batch">
            <div class="row">
              <strong>Batch \${short(batch.batchId)}</strong>
              <span class="badge \${done ? 'ready' : 'busy'}">\${batch.status}</span>
            </div>
            <div class="progress"><div class="bar" style="width:\${percent}%"></div></div>
            <div class="meta">
              <span>Объекты: \${batch.resultCount}/\${batch.totalItems}</span>
              <span>Jobs: \${batch.jobsDone}/\${batch.jobsTotal}</span>
              <span>Ошибки: \${batch.jobsFailed}</span>
            </div>
            <div class="actions">
              <a href="/api/batches/\${batch.batchId}" target="_blank">Открыть JSON</a>
              <a href="/api/batches/\${batch.batchId}/download">Скачать результат</a>
            </div>
          </article>
        \`;
      }).join('') : '<div class="muted">Запусков пока нет.</div>';
    }

    async function refresh() {
      const response = await fetch('/api/status', { cache: 'no-store' });
      const data = await response.json();
      window.__lastWorkers = data.workers || [];
      $('workersConnected').textContent = data.workersConnected;
      $('workersReady').textContent = data.workersReady;
      $('workersStopped').textContent = data.workersStopped;
      $('queuedJobs').textContent = data.queuedJobs;
      $('batchesTotal').textContent = data.batches.length;
      $('updated').textContent = new Date().toLocaleTimeString('ru-RU');
      renderWorkers(data.workers);
      renderBatches(data.batches);
    }

    async function workerAction(workerId, action, worker) {
      if (action === 'sync') {
        const response = await fetch('/api/workers/heartbeat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workerId,
            name: worker?.name || '',
            status: worker?.status || 'ready',
            currentJobId: worker?.currentJobId || null,
            progress: worker?.progress || {},
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось синхронизировать worker');
        return;
      }

      const response = await fetch(\`/api/workers/\${encodeURIComponent(workerId)}/\${action}\`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || \`Не удалось выполнить \${action}\`);
    }

    async function syncAllWorkers() {
      const workers = window.__lastWorkers || [];
      if (!workers.length) {
        setMessage('Workers пока нет.');
        return;
      }

      const results = await Promise.allSettled(
        workers.map((worker) => workerAction(worker.workerId, 'sync', worker))
      );
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length) {
        throw new Error('Не удалось синхронизировать ' + failed.length + ' worker(ов)');
      }
    }

    $('syncAllButton').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      setMessage('Syncing all workers...');
      try {
        await syncAllWorkers();
        await refresh();
        setMessage('All workers synced.');
      } catch (error) {
        setMessage(error.message || String(error));
      } finally {
        button.disabled = false;
      }
    });

    $('stopAllButton').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      setMessage('Stopping all workers...');
      try {
        const response = await fetch('/api/workers/stop-all', { method: 'POST' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to stop workers');
        await refresh();
        setMessage('Stopped workers: ' + (data.affected || 0) + '.');
      } catch (error) {
        setMessage(error.message || String(error));
      } finally {
        button.disabled = false;
      }
    });

    $('continueAllButton').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      setMessage('Resuming all workers...');
      try {
        const response = await fetch('/api/workers/resume-all', { method: 'POST' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to resume workers');
        await refresh();
        setMessage('Resumed workers: ' + (data.affected || 0) + '.');
      } catch (error) {
        setMessage(error.message || String(error));
      } finally {
        button.disabled = false;
      }
    });

    $('deleteAllJobsButton').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      setMessage('Deleting all jobs...');
      try {
        const response = await fetch('/api/jobs/delete-all', { method: 'POST' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to delete jobs');
        await refresh();
        setMessage('Deleted jobs: ' + (data.deleted || 0) + '.');
      } catch (error) {
        setMessage(error.message || String(error));
      } finally {
        button.disabled = false;
      }
    });

    $('workers').addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-worker-action][data-worker-id]');
      if (!button) return;
      button.disabled = true;
      const workerId = button.dataset.workerId;
      const action = button.dataset.workerAction;
      const worker = (window.__lastWorkers || []).find((entry) => entry.workerId === workerId);
      try {
        await workerAction(workerId, action, worker);
        await refresh();
      } catch (error) {
        setMessage(error.message || String(error));
      } finally {
        button.disabled = false;
      }
    });

    $('jsonFile').addEventListener('change', async () => {
      const file = $('jsonFile').files[0];
      state.fileItems = null;
      state.fileName = file?.name || '';
      $('runButton').disabled = true;
      if (!file) {
        setMessage('Выбери JSON-файл.');
        return;
      }
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error('В файле должен быть JSON-массив.');
        state.fileItems = parsed;
        $('runButton').disabled = false;
        setMessage(\`Файл \${file.name}: \${parsed.length} объектов. Можно запускать.\`);
      } catch (error) {
        setMessage(error.message || String(error));
      }
    });

    $('runButton').addEventListener('click', async () => {
      if (!state.fileItems) return;
      $('runButton').disabled = true;
      setMessage('Отправляю JSON в очередь...');
      try {
        const workers = Math.max(1, Number($('workersCount').value || 1));
        const response = await fetch('/api/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: state.fileItems, workers }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось запустить обработку.');
        state.latestBatchId = data.batchId;
        setMessage(\`Запущено: \${data.jobsQueued} частей. Batch: \${data.batchId}\`);
        await refresh();
      } catch (error) {
        setMessage(error.message || String(error));
      } finally {
        $('runButton').disabled = false;
      }
    });

    refresh().catch((error) => setMessage(error.message || String(error)));
    setInterval(() => refresh().catch(() => {}), 2000);
  </script>
</body>
</html>`;
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/') {
    sendHtml(res, dashboardHtml());
    return;
  }

  if (req.method === 'GET' && path === '/api/status') {
    sendJson(res, 200, statusView());
    return;
  }

  if (req.method === 'POST' && path === '/api/workers/heartbeat') {
    const body = await readJson(req);
    const workerId = String(body?.workerId || '').trim();
    if (!workerId) {
      sendError(res, 400, 'workerId is required');
      return;
    }

    const existing = workers.get(workerId) || { workerId };
    const requestedStatus = body?.status || 'ready';
    const status = existing.stopRequestedAt
      ? existing.currentJobId
        ? 'stopping'
        : 'stopped'
      : requestedStatus === 'stopped'
        ? existing.currentJobId
          ? 'stopping'
          : 'stopped'
        : requestedStatus;
    const worker = updateWorker(workerId, {
      name: body?.name || '',
      status,
      currentJobId: body?.currentJobId || null,
      progress: body?.progress || {},
      stopRequestedAt: existing.stopRequestedAt || null,
      stopReason: existing.stopReason || '',
    });
    sendJson(res, 200, { ok: true, worker: workerView(worker) });
    return;
  }

  if (req.method === 'POST' && path === '/api/workers/stop-all') {
    const workersStopped = setAllWorkersStop('manual stop all request');
    sendJson(res, 200, {
      ok: true,
      workers: workersStopped,
      affected: workersStopped.length,
    });
    return;
  }

  if (req.method === 'POST' && path === '/api/workers/resume-all') {
    const workersResumed = clearAllWorkersStop();
    sendJson(res, 200, {
      ok: true,
      workers: workersResumed,
      affected: workersResumed.length,
    });
    return;
  }

  if (req.method === 'POST' && path === '/api/jobs/delete-all') {
    const deletedJobs = deleteAllJobs('manual delete all request');
    sendJson(res, 200, {
      ok: true,
      deleted: deletedJobs.length,
      jobs: deletedJobs.map((job) => ({
        jobId: job.jobId,
        batchId: job.batchId,
        status: job.status,
        workerId: job.workerId || null,
      })),
    });
    return;
  }

  const workerControlMatch = path.match(/^\/api\/workers\/([^/]+)\/(stop|resume)$/);
  if (req.method === 'POST' && workerControlMatch) {
    const workerId = decodeURIComponent(workerControlMatch[1]);
    const action = workerControlMatch[2];
    if (action === 'stop') {
      const worker = setWorkerStop(workerId, 'manual stop request');
      sendJson(res, 200, { ok: true, worker: workerView(worker) });
      return;
    }

    const worker = clearWorkerStop(workerId);
    sendJson(res, 200, { ok: true, worker: workerView(worker) });
    return;
  }

  const jobPollMatch = path.match(/^\/api\/workers\/([^/]+)\/job$/);
  if (req.method === 'GET' && jobPollMatch) {
    const workerId = decodeURIComponent(jobPollMatch[1]);
    const existing = workers.get(workerId);
    if (existing?.currentJobId) {
      const currentJob = jobs.get(existing.currentJobId);
      if (currentJob?.status === 'deleted') {
        const worker = updateWorker(workerId, {
          currentJobId: null,
          status: existing.stopRequestedAt ? 'stopped' : 'ready',
        });
        sendJson(res, 200, {
          ok: true,
          job: null,
          command: 'delete',
          deletedJobId: currentJob.jobId,
          worker: workerView(worker),
        });
        return;
      }
    }
    if (existing?.stopRequestedAt) {
      const worker = updateWorker(workerId, {
        status: existing.currentJobId ? 'stopping' : 'stopped',
      });
      sendJson(res, 200, {
        ok: true,
        job: null,
        command: 'stop',
        worker: workerView(worker),
      });
      return;
    }

    const existingJob = [...jobs.values()].find((job) => job.workerId === workerId && job.status === 'running');
    if (existingJob) {
      updateWorker(workerId, { status: 'busy', currentJobId: existingJob.jobId });
      sendJson(res, 200, { ok: true, job: existingJob, worker: workerView(workers.get(workerId)) });
      return;
    }

    const jobId = queue.shift();
    if (!jobId) {
      updateWorker(workerId, { status: 'ready', currentJobId: null });
      sendJson(res, 200, { ok: true, job: null, worker: workerView(workers.get(workerId)) });
      return;
    }

    const job = jobs.get(jobId);
    job.workerId = workerId;
    job.status = 'running';
    job.startedAt = nowIso();
    updateWorker(workerId, { status: 'busy', currentJobId: job.jobId });
    sendJson(res, 200, { ok: true, job, worker: workerView(workers.get(workerId)) });
    return;
  }

  const jobSingleMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobSingleMatch) {
    const jobId = decodeURIComponent(jobSingleMatch[1]);
    const job = jobs.get(jobId);
    if (!job) {
      sendError(res, 404, 'Job not found');
      return;
    }

    sendJson(res, 200, { ok: true, job });
    return;
  }

  if (req.method === 'POST' && path === '/api/run') {
    const body = await readJson(req);
    const items = Array.isArray(body) ? body : body?.items;
    if (!Array.isArray(items)) {
      sendError(res, 400, 'Body must be JSON array or { "items": [...] }');
      return;
    }

    const readyWorkers = activeWorkers().filter((worker) => worker.status === 'ready');
    const requestedWorkers = Number(body?.workers || readyWorkers.length || 1);
    const chunks = splitIntoChunks(items, Math.max(1, Math.min(items.length || 1, requestedWorkers)));
    const batchId = randomUUID();
    const batch = {
      batchId,
      createdAt: nowIso(),
      totalItems: items.length,
      jobIds: [],
      results: Array.from({ length: chunks.length }, () => []),
    };

    chunks.forEach((chunk, index) => {
      const jobId = randomUUID();
      const job = {
        jobId,
        batchId,
        index,
        status: 'queued',
        workerId: null,
        items: chunk,
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        result: null,
        error: '',
      };
      jobs.set(jobId, job);
      batch.jobIds.push(jobId);
      queue.push(jobId);
    });

    batches.set(batchId, batch);
    sendJson(res, 202, {
      ok: true,
      batchId,
      jobsQueued: batch.jobIds.length,
      workersConnected: activeWorkers().length,
      workersReady: readyWorkers.length,
    });
    return;
  }

  const deleteMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const jobId = decodeURIComponent(deleteMatch[1]);
    const job = jobs.get(jobId);
    if (!job) {
      sendError(res, 404, 'Job not found');
      return;
    }

    if (job.status === 'deleted') {
      sendJson(res, 200, { ok: true, deleted: true, job });
      return;
    }

    const body = await readJson(req).catch(() => null);
    const deletedJob = deleteJob(jobId, body?.reason || 'manual delete');
    sendJson(res, 200, { ok: true, deleted: true, job: deletedJob });
    return;
  }

  const resultMatch = path.match(/^\/api\/jobs\/([^/]+)\/result$/);
  if (req.method === 'POST' && resultMatch) {
    const jobId = decodeURIComponent(resultMatch[1]);
    const job = jobs.get(jobId);
    if (!job) {
      sendError(res, 404, 'Job not found');
      return;
    }
    if (job.status === 'deleted') {
      sendError(res, 410, 'Job deleted');
      return;
    }

    const body = await readJson(req);
    const result = Array.isArray(body) ? body : body?.items;
    if (!Array.isArray(result)) {
      sendError(res, 400, 'Result must be JSON array or { "items": [...] }');
      return;
    }

    job.status = 'done';
    job.result = result;
    job.finishedAt = nowIso();
    const batch = batches.get(job.batchId);
    if (batch) batch.results[job.index] = result;
    if (job.workerId) {
      const existing = workers.get(job.workerId);
      updateWorker(job.workerId, {
        status: existing?.stopRequestedAt ? 'stopped' : 'ready',
        currentJobId: null,
        progress: {
          objectsDone: result.length,
          objectsTotal: result.length,
          objectsRemaining: 0,
          routesDone: 0,
          routesTotal: 0,
          routesRemaining: 0,
          currentObjectIndex: null,
        },
      });
    }
    sendJson(res, 200, { ok: true, batch: batch ? batchView(batch) : null });
    return;
  }

  const failMatch = path.match(/^\/api\/jobs\/([^/]+)\/fail$/);
  if (req.method === 'POST' && failMatch) {
    const jobId = decodeURIComponent(failMatch[1]);
    const job = jobs.get(jobId);
    if (!job) {
      sendError(res, 404, 'Job not found');
      return;
    }
    if (job.status === 'deleted') {
      sendError(res, 410, 'Job deleted');
      return;
    }

    const body = await readJson(req);
    job.status = 'failed';
    job.error = body?.error || 'Worker failed';
    job.finishedAt = nowIso();
    if (job.workerId) {
      const existing = workers.get(job.workerId);
      updateWorker(job.workerId, {
        status: existing?.stopRequestedAt ? 'stopped' : 'ready',
        currentJobId: null,
      });
    }
    sendJson(res, 200, { ok: true, job });
    return;
  }

  const batchDownloadMatch = path.match(/^\/api\/batches\/([^/]+)\/download$/);
  if (req.method === 'GET' && batchDownloadMatch) {
    const batch = batches.get(decodeURIComponent(batchDownloadMatch[1]));
    if (!batch) {
      sendError(res, 404, 'Batch not found');
      return;
    }

    sendDownload(res, `transit-result-${batch.batchId}.json`, batchView(batch).resultItems);
    return;
  }

  const batchMatch = path.match(/^\/api\/batches\/([^/]+)$/);
  if (req.method === 'GET' && batchMatch) {
    const batch = batches.get(decodeURIComponent(batchMatch[1]));
    if (!batch) {
      sendError(res, 404, 'Batch not found');
      return;
    }

    sendJson(res, 200, { ok: true, batch: batchView(batch) });
    return;
  }

  sendError(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    sendError(res, error.statusCode || 500, error.message || 'Internal server error');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Transit dispatcher API is listening on http://${HOST}:${PORT}`);
  for (const url of statusView().server.localUrls) {
    console.log(`Open dashboard: ${url}`);
  }
});
