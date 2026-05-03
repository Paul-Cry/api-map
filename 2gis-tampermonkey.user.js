// ==UserScript==
// @name         2GIS Route Helper
// @namespace    local.codex.2gis
// @version      1.2.1
// @description  Minimal panel: origin and destination, fill 2GIS inputs and press Enter.
// @match        https://2gis.ru/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '1.2.1';
  const UI_KEY = 'codex_2gis_min_ui';
  const LOG_KEY = 'codex_2gis_min_logs';
  const MAX_LOG_LINES = 200;

  function now() {
    return new Date().toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function readJson(key, fallback) {
    try {
      const raw = GM_getValue(key, JSON.stringify(fallback));
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    GM_setValue(key, JSON.stringify(value));
  }

  function getUiState() {
    return readJson(UI_KEY, { origin: '', destination: '' });
  }

  function setUiState(state) {
    writeJson(UI_KEY, state);
  }

  function getLogs() {
    const logs = readJson(LOG_KEY, []);
    return Array.isArray(logs) ? logs : [];
  }

  function setLogs(logs) {
    writeJson(LOG_KEY, logs.slice(-MAX_LOG_LINES));
  }

  function renderLogs() {
    const node = document.getElementById('codex-2gis-log-body');
    if (!node) return;
    node.textContent = getLogs().join('\n');
    node.scrollTop = node.scrollHeight;
  }

  function log(message) {
    const entry = `[${now()}] ${message}`;
    const logs = getLogs();
    logs.push(entry);
    setLogs(logs);
    renderLogs();
    console.log(`[2GIS Helper] ${message}`);
  }

  function clearLogs() {
    setLogs([]);
    renderLogs();
  }

  function nativeSetValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const setter = descriptor && descriptor.set;

    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }

    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      composed: true,
      data: value,
      inputType: 'insertText',
    }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function dispatchMouseClick(element) {
    const options = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
    };

    element.dispatchEvent(new MouseEvent('mousedown', options));
    element.dispatchEvent(new MouseEvent('mouseup', options));
    element.dispatchEvent(new MouseEvent('click', options));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findOriginInput() {
    const selectors = [
      'input[placeholder="Откуда"]',
      'input[placeholder="\\u041e\\u0442\\u043a\\u0443\\u0434\\u0430"]',
      '._1nhcezu ._ty5etr input[placeholder="Откуда"]',
      '._1u0eipb input[placeholder="Откуда"]',
      'input._z1ak2n[placeholder="Откуда"]',
    ];

    for (const selector of selectors) {
      const input = document.querySelector(selector);
      if (input) return input;
    }

    return null;
  }

  function findDestinationInput() {
    const selectors = [
      'input[placeholder="Куда"]',
      'input[placeholder="\\u041a\\u0443\\u0434\\u0430"]',
      'input._z1ak2n[placeholder="Куда"]',
      'input._uzkowp2[placeholder="Куда"]',
      '._1nhcezu ._ty5etr input[placeholder="Куда"]',
      '._1u0eipb input[placeholder="Куда"]',
    ];

    for (const selector of selectors) {
      const input = document.querySelector(selector);
      if (input) return input;
    }

    return null;
  }

  async function typeLikeHuman(input, text) {
    input.focus();
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const setter = descriptor && descriptor.set;

    if (setter) {
      setter.call(input, '');
    } else {
      input.value = '';
    }

    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      composed: true,
      data: '',
      inputType: 'deleteContentBackward',
    }));

    for (const char of text) {
      const nextValue = `${input.value}${char}`;
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: char }));
      input.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: char }));
      nativeSetValue(input, nextValue);
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: char }));
      await sleep(50);
    }

    await sleep(100);
    if (input.value !== text) {
      if (setter) {
        setter.call(input, text);
      } else {
        input.value = text;
      }
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        composed: true,
        data: text,
        inputType: 'insertText',
      }));
    }
  }

  async function pressEnterWithDelay(input) {
    log('Жду 1 секунду перед нажатием Enter.');
    await sleep(1000);
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
    input.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
  }

  async function runSimpleFlow() {
    const state = getUiState();
    const origin = String(state.origin || '').trim();
    const destination = String(state.destination || '').trim();

    if (!origin) {
      throw new Error('Введите адрес в поле панели справа.');
    }

    if (!destination) {
      throw new Error('Введите адрес "Куда" в поле панели справа.');
    }

    log('Шаг 1. Адреса указаны в панели.');
    log('Шаг 2. Нажата кнопка запуска.');
    log('Шаг 3. Ищу input "Откуда" на сайте 2GIS.');

    const originInput = findOriginInput();
    if (!originInput) {
      throw new Error('Не найден input "Откуда" на сайте 2GIS.');
    }

    log('Шаг 4. Input "Откуда" найден.');
    log('Шаг 5. Вводю значение в input "Откуда" как человек.');
    await typeLikeHuman(originInput, origin);
    log(`Шаг 6. В input "Откуда" введено значение: ${origin}`);
    log('Шаг 8. Нажимаю Enter на input "Откуда".');
    await pressEnterWithDelay(originInput);
    log('Шаг 9. Enter по input "Откуда" выполнен.');
    await sleep(500);

    log('Шаг 10. Ищу input "Куда" на сайте 2GIS.');
    const destinationInput = findDestinationInput();
    if (!destinationInput) {
      throw new Error('Не найден input "Куда" на сайте 2GIS.');
    }

    log('Шаг 11. Input "Куда" найден.');
    log('Шаг 12. Вводю значение в input "Куда" как человек.');
    await typeLikeHuman(destinationInput, destination);
    log(`Шаг 13. В input "Куда" введено значение: ${destinationInput.value}`);
    log('Шаг 14. Нажимаю Enter на input "Куда".');
    await pressEnterWithDelay(destinationInput);
    log('Шаг 15. Enter по input "Куда" выполнен.');
    log('Алгоритм завершён.');
  }

  function createUi() {
    if (document.getElementById('codex-2gis-root')) return;

    GM_addStyle(`
      #codex-2gis-root {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        height: 400px;
        z-index: 2147483647;
        display: grid;
        grid-template-columns: 1fr 1fr;
        overflow: hidden;
        background: rgba(10, 14, 22, 0.97);
        color: #e7eef8;
        border-top: 1px solid rgba(255,255,255,0.12);
        box-shadow: 0 -18px 50px rgba(0,0,0,0.35);
        font: 13px/1.45 Arial, sans-serif;
      }
      .codex-2gis-panel {
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
      }
      .codex-2gis-head {
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.12);
        background: linear-gradient(180deg, rgba(19,26,39,1), rgba(14,19,30,1));
      }
      .codex-2gis-title {
        font: 700 14px/1.2 Arial, sans-serif;
        color: #fff;
      }
      .codex-2gis-subtitle {
        margin-top: 4px;
        color: #9fb0c7;
        font: 12px/1.3 Arial, sans-serif;
      }
      #codex-2gis-log-body {
        margin: 0;
        padding: 12px 14px;
        flex: 1;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        background: rgba(8, 12, 18, 0.75);
      }
      .codex-2gis-controls {
        padding: 12px 14px;
        display: grid;
        gap: 10px;
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
      }
      .codex-2gis-card {
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 14px;
        padding: 12px;
        background: rgba(255,255,255,0.04);
      }
      .codex-2gis-label {
        display: block;
        margin-bottom: 6px;
        color: #b6c5da;
        font-size: 12px;
      }
      .codex-2gis-input {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid rgba(255,255,255,0.15);
        background: rgba(6,10,16,0.92);
        color: #fff;
        border-radius: 10px;
        padding: 10px 12px;
        outline: none;
      }
      .codex-2gis-input:focus {
        border-color: #4c8bf5;
        box-shadow: 0 0 0 3px rgba(76,139,245,0.18);
      }
      .codex-2gis-btn {
        width: 100%;
        box-sizing: border-box;
        border: 0;
        border-radius: 10px;
        padding: 10px 12px;
        background: #2d7ff9;
        color: #fff;
        cursor: pointer;
        font-weight: 700;
      }
      .codex-2gis-btn.secondary {
        background: #364255;
      }
      .codex-2gis-status {
        padding: 8px 10px;
        border-radius: 999px;
        display: inline-block;
        background: rgba(255,255,255,0.08);
      }
      .codex-2gis-meta {
        color: #9fb0c7;
        font-size: 12px;
        margin-top: 6px;
      }
    `);

    const root = document.createElement('div');
    root.id = 'codex-2gis-root';
    root.innerHTML = `
      <section class="codex-2gis-panel">
        <div class="codex-2gis-head">
          <div class="codex-2gis-title">2GIS Логи v${SCRIPT_VERSION}</div>
          <div class="codex-2gis-subtitle">Логи идут по шагам: ввод -> запуск -> поиск -> печать -> Enter</div>
        </div>
        <pre id="codex-2gis-log-body"></pre>
      </section>
      <section class="codex-2gis-panel" style="border-left: 1px solid rgba(255,255,255,0.12);">
        <div class="codex-2gis-head">
          <div class="codex-2gis-title">Управление</div>
          <div class="codex-2gis-subtitle">Два адреса, один запуск, два Enter</div>
        </div>
        <div class="codex-2gis-controls">
          <div class="codex-2gis-card">
            <div id="codex-2gis-status" class="codex-2gis-status">Готов к работе</div>
            <div class="codex-2gis-meta">Введите адреса "Откуда" и "Куда", затем нажмите "Выполнить"</div>
          </div>
          <div class="codex-2gis-card">
            <label class="codex-2gis-label" for="codex-2gis-origin">Адрес "Откуда"</label>
            <input id="codex-2gis-origin" class="codex-2gis-input" type="text" placeholder="Введите адрес" />
          </div>
          <div class="codex-2gis-card">
            <label class="codex-2gis-label" for="codex-2gis-destination">Адрес "Куда"</label>
            <input id="codex-2gis-destination" class="codex-2gis-input" type="text" placeholder="Введите адрес назначения" />
          </div>
          <button id="codex-2gis-run" class="codex-2gis-btn">Выполнить</button>
          <button id="codex-2gis-clear" class="codex-2gis-btn secondary">Очистить логи</button>
        </div>
      </section>
    `;

    document.body.appendChild(root);

    const originInput = root.querySelector('#codex-2gis-origin');
    const destinationInput = root.querySelector('#codex-2gis-destination');
    const runButton = root.querySelector('#codex-2gis-run');
    const clearButton = root.querySelector('#codex-2gis-clear');
    const statusNode = root.querySelector('#codex-2gis-status');

    const state = getUiState();
    originInput.value = state.origin || '';
    destinationInput.value = state.destination || '';

    originInput.addEventListener('input', () => {
      const nextState = getUiState();
      nextState.origin = originInput.value;
      setUiState(nextState);
    });

    destinationInput.addEventListener('input', () => {
      const nextState = getUiState();
      nextState.destination = destinationInput.value;
      setUiState(nextState);
    });

    runButton.addEventListener('click', () => {
      statusNode.textContent = 'Выполняю сценарий';
      runSimpleFlow()
        .then(() => {
          statusNode.textContent = 'Сценарий выполнен';
        })
        .catch((error) => {
          const message = error?.message || String(error);
          log(`Ошибка: ${message}`);
          statusNode.textContent = 'Ошибка';
        });
    });

    clearButton.addEventListener('click', () => {
      clearLogs();
      log('Логи очищены.');
      statusNode.textContent = 'Готов к работе';
    });

    renderLogs();
    log(`Панель 2GIS v${SCRIPT_VERSION} загружена.`);
  }

  function bootstrap() {
    if (!document.body) return;
    createUi();
  }

  bootstrap();
})();
