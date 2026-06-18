#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const pythonScript = path.join(__dirname, 'yandex-maps-avito-transit-headless.py');
const pythonExe = process.env.PYTHON || 'python';
const defaultInput = path.join(projectRoot, 'merged-listings-2026-06-02.json');
const resultFile = path.join(__dirname, 'avito-transit-yandex-result.json');
const stateDir = path.join(os.homedir(), '.avito-parser');
const stateFile = path.join(stateDir, 'yandex-launcher.json');

const command = (process.argv[2] || 'menu').toLowerCase();
const extraArgs = process.argv.slice(3);

function spawnAndWait(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      stdio: 'inherit',
      cwd: projectRoot,
      shell: false,
      ...options,
    });

    const handleSignal = (signal) => {
      if (!child.killed) {
        child.kill(signal);
      }
    };

    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);

    const cleanup = () => {
      process.removeListener('SIGINT', handleSignal);
      process.removeListener('SIGTERM', handleSignal);
    };

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      cleanup();
      if (signal) {
        resolve(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

function spawnManyAndWait(commands) {
  const children = new Set();
  let stopping = false;

  return new Promise((resolve, reject) => {
    const exitCodes = Array(commands.length).fill(null);

    const stopAll = (signal) => {
      stopping = true;
      for (const child of children) {
        if (!child.killed) {
          child.kill(signal);
        }
      }
    };

    const cleanup = () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    };

    const onSigint = () => stopAll('SIGINT');
    const onSigterm = () => stopAll('SIGTERM');

    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    const maybeDone = () => {
      if (exitCodes.some((code) => code === null)) return;
      cleanup();
      if (stopping) {
        resolve(130);
        return;
      }
      resolve(exitCodes.some((code) => code !== 0) ? 1 : 0);
    };

    const writePrefixed = (stream, prefix, chunk) => {
      const lines = String(chunk).split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        stream.write(`${prefix} ${line}\n`);
      }
    };

    commands.forEach((item, index) => {
      const child = spawn(item.commandName, item.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: projectRoot,
        shell: false,
        ...item.options,
      });

      children.add(child);
      child.stdout.on('data', (chunk) => writePrefixed(process.stdout, item.prefix, chunk));
      child.stderr.on('data', (chunk) => writePrefixed(process.stderr, item.prefix, chunk));
      child.on('error', (error) => {
        cleanup();
        reject(error);
      });
      child.on('exit', (code, signal) => {
        children.delete(child);
        if (signal) {
          exitCodes[index] = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
        } else {
          exitCodes[index] = code ?? 0;
        }
        maybeDone();
      });
    });
  });
}

async function loadState() {
  try {
    const text = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveState(nextState) {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(stateFile, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
}

async function getJsonFiles() {
  const entries = await fs.readdir(projectRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => path.join(projectRoot, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right), 'ru'));
}

function formatFileChoices(files) {
  return files.map((filePath, index) => `  ${index + 1}. ${path.basename(filePath)}`).join('\n');
}

async function promptText(rl, question, defaultValue = '') {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = await rl.question(`${question}${suffix}: `);
  const trimmed = answer.trim();
  return trimmed || defaultValue;
}

async function promptChoice(rl, question, allowed) {
  const allowedSet = new Set(allowed);
  while (true) {
    const answer = (await rl.question(`${question}: `)).trim();
    if (allowedSet.has(answer)) return answer;
    console.log(`Choose one of: ${allowed.join(', ')}`);
  }
}

async function promptPositiveInteger(rl, question, defaultValue = '') {
  while (true) {
    const answer = await promptText(rl, question, defaultValue);
    const value = Number(answer);
    if (Number.isInteger(value) && value > 0) return value;
    console.log('Введите положительное целое число.');
  }
}

function parseCoords(value) {
  const parts = String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length !== 2) {
    throw new Error('Координаты должны быть в формате: 55.717681, 37.607984');
  }

  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('Координаты должны быть числами.');
  }

  return [lat, lon];
}

async function promptRouteAddresses(rl, defaultAddresses = []) {
  const defaultCount = Array.isArray(defaultAddresses) && defaultAddresses.length
    ? String(defaultAddresses.length)
    : '1';
  const count = await promptPositiveInteger(rl, 'Сколько адресов для расчёта маршрутов', defaultCount);
  const addresses = [];

  for (let index = 0; index < count; index += 1) {
    const previous = Array.isArray(defaultAddresses) ? defaultAddresses[index] : null;
    let name = '';
    while (!name) {
      name = await promptText(
        rl,
        `Название адреса ${index + 1}`,
        previous?.name || ''
      );
      if (!name) console.log('Название адреса не должно быть пустым.');
    }

    while (true) {
      const coordsText = await promptText(
        rl,
        `Координаты адреса "${name}"`,
        Array.isArray(previous?.coords) ? previous.coords.join(', ') : ''
      );
      try {
        addresses.push({ name, coords: parseCoords(coordsText) });
        break;
      } catch (error) {
        console.log(error.message || error);
      }
    }
  }

  return addresses;
}

function parseAddressesJson(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.addresses)) return parsed.addresses;
  } catch {
    return [];
  }
  return [];
}

async function resolveRouteAddressesArg(rl, state, addressesJsonValue) {
  if (addressesJsonValue) return addressesJsonValue;

  const defaults = parseAddressesJson(state.lastRouteAddressesJson || '[]');
  const addresses = await promptRouteAddresses(rl, defaults);
  return JSON.stringify(addresses);
}

async function validateApiUrl(apiUrl) {
  const normalized = apiUrl.replace(/\/+$/g, '');
  const response = await fetch(`${normalized}/api/status`, {
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API responded with HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const payload = await response.json();
  if (!payload || payload.ok !== true) {
    throw new Error(payload?.error || 'API status endpoint did not return ok=true');
  }

  return normalized;
}

function normalizeProxyInput(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) return text;
  return `http://${text}`;
}

function consumeOption(args, names) {
  const nameSet = new Set(names);
  const rest = [];
  let value = '';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equalsIndex = arg.indexOf('=');

    if (equalsIndex > 0 && nameSet.has(arg.slice(0, equalsIndex))) {
      value = arg.slice(equalsIndex + 1);
      continue;
    }

    if (nameSet.has(arg)) {
      value = args[index + 1] || '';
      index += 1;
      continue;
    }

    rest.push(arg);
  }

  return { value, rest };
}

async function readProxyFile(proxyFile) {
  const resolvedPath = path.resolve(projectRoot, proxyFile);
  const text = await fs.readFile(resolvedPath, 'utf8');
  const proxies = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(normalizeProxyInput);

  return { resolvedPath, proxies };
}

async function runPython(args) {
  return spawnAndWait(pythonExe, [pythonScript, ...args]);
}

async function runBatchMode(inputPath, headless, saveHtml, extraPythonArgs = []) {
  const args = [inputPath, ...(headless ? ['--headless'] : ['--headed'])];
  if (saveHtml) {
    args.push('--save-html');
  }
  args.push(...extraPythonArgs);

  console.log('');
  console.log('Running:');
  console.log(`  ${pythonExe} ${[pythonScript, ...args].join(' ')}`);
  console.log(`  Output: ${resultFile}`);
  console.log('');

  return runPython(args);
}

async function runApiMode(rl, state, extraPythonArgs = []) {
  const apiOption = consumeOption(extraPythonArgs, ['--api-url']);
  const proxyOption = consumeOption(apiOption.rest, ['--proxy']);
  const addressesOption = consumeOption(proxyOption.rest, ['--addresses-json', '--destinations-json']);
  const passthroughArgs = addressesOption.rest;
  const defaultApiUrl = state.lastApiUrl || 'http://127.0.0.1:8787';
  let apiUrl = '';

  if (apiOption.value) {
    try {
      apiUrl = await validateApiUrl(apiOption.value);
    } catch (error) {
      console.error(`Invalid API URL: ${error.message || error}`);
      return 1;
    }
  } else {
    while (!apiUrl) {
      const candidate = await promptText(rl, 'API URL', defaultApiUrl);
      try {
        apiUrl = await validateApiUrl(candidate);
      } catch (error) {
        console.error(`Invalid API URL: ${error.message || error}`);
        apiUrl = '';
      }
    }
  }

  const defaultProxy = state.lastProxy || '';
  const proxyValue = proxyOption.value
    ? normalizeProxyInput(proxyOption.value)
    : normalizeProxyInput(await promptText(rl, 'Proxy URL (leave empty for none)', defaultProxy));
  const addressesJson = await resolveRouteAddressesArg(rl, state, addressesOption.value);

  await saveState({
    ...state,
    lastApiUrl: apiUrl,
    lastProxy: proxyValue,
    lastRouteAddressesJson: addressesJson,
  });

  console.log('');
  console.log('Starting API worker:');
  console.log(`  API URL: ${apiUrl}`);
  console.log(`  Proxy:    ${proxyValue || '(none)'}`);
  console.log(`  Worker:   ${pythonExe} ${[
    pythonScript,
    '--api-url',
    apiUrl,
    ...(proxyValue ? ['--proxy', proxyValue] : []),
    '--addresses-json',
    addressesJson,
    ...passthroughArgs,
  ].join(' ')}`);
  console.log('');

  return runPython([
    '--api-url',
    apiUrl,
    ...(proxyValue ? ['--proxy', proxyValue] : []),
    '--addresses-json',
    addressesJson,
    ...passthroughArgs,
  ]);
}

async function resolveApiUrlForMode(rl, state, apiUrlValue) {
  const defaultApiUrl = state.lastApiUrl || 'http://127.0.0.1:8787';

  if (apiUrlValue) {
    return validateApiUrl(apiUrlValue);
  }

  while (true) {
    const candidate = await promptText(rl, 'API URL', defaultApiUrl);
    try {
      return await validateApiUrl(candidate);
    } catch (error) {
      console.error(`Invalid API URL: ${error.message || error}`);
    }
  }
}

async function runApiProxyFileMode(rl, state, extraPythonArgs = []) {
  const apiOption = consumeOption(extraPythonArgs, ['--api-url']);
  const proxyFileOption = consumeOption(apiOption.rest, ['--proxy-file', '--proxies']);
  const limitOption = consumeOption(proxyFileOption.rest, ['--limit']);
  const addressesOption = consumeOption(limitOption.rest, ['--addresses-json', '--destinations-json']);
  const passthroughArgs = addressesOption.rest;

  let apiUrl = '';
  try {
    apiUrl = await resolveApiUrlForMode(rl, state, apiOption.value);
  } catch (error) {
    console.error(`Invalid API URL: ${error.message || error}`);
    return 1;
  }

  const proxyFile = proxyFileOption.value || (await promptText(rl, 'Proxy TXT file'));
  if (!proxyFile) {
    console.error('Proxy TXT file is required.');
    return 1;
  }

  let proxyData = null;
  try {
    proxyData = await readProxyFile(proxyFile);
  } catch (error) {
    console.error(`Could not read proxy file: ${error.message || error}`);
    return 1;
  }

  let proxies = proxyData.proxies;
  if (limitOption.value) {
    const limit = Number(limitOption.value);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error('--limit must be a positive integer.');
      return 1;
    }
    proxies = proxies.slice(0, limit);
  }

  if (!proxies.length) {
    console.error(`Proxy file has no proxies: ${proxyData.resolvedPath}`);
    return 1;
  }

  const addressesJson = await resolveRouteAddressesArg(rl, state, addressesOption.value);

  await saveState({
    ...state,
    lastApiUrl: apiUrl,
    lastRouteAddressesJson: addressesJson,
  });

  const runId = Date.now().toString(36);
  const commands = proxies.map((proxyValue, index) => {
    const workerNumber = String(index + 1).padStart(2, '0');
    const workerId = `yandex-${runId}-${workerNumber}`;
    return {
      commandName: pythonExe,
      prefix: `[worker ${workerNumber}/${proxies.length}]`,
      args: [
        pythonScript,
        '--api-url',
        apiUrl,
        '--proxy',
        proxyValue,
        '--worker-id',
        workerId,
        '--addresses-json',
        addressesJson,
        ...passthroughArgs,
      ],
    };
  });

  console.log('');
  console.log('Starting API workers from proxy file:');
  console.log(`  API URL:     ${apiUrl}`);
  console.log(`  Proxy file:  ${proxyData.resolvedPath}`);
  console.log(`  Workers:     ${commands.length}`);
  console.log(`  Addresses:   ${parseAddressesJson(addressesJson).length}`);
  console.log(`  Extra args:  ${passthroughArgs.length ? passthroughArgs.join(' ') : '(none)'}`);
  console.log('');

  return spawnManyAndWait(commands);
}

async function interactiveMenu() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const state = await loadState();

  try {
    while (true) {
      console.clear();
      console.log('Yandex Maps transit launcher');
      console.log(`Project: ${projectRoot}`);
      console.log(`Result:  ${resultFile}`);
      console.log(state.lastApiUrl ? `Last API: ${state.lastApiUrl}` : 'Last API: not set');
      console.log(state.lastProxy ? `Last proxy: ${state.lastProxy}` : 'Last proxy: not set');
      console.log('');
      console.log('1. Run default input (merged-listings-2026-06-02.json)');
      console.log('2. Run result.json');
      console.log('3. Pick any JSON from project root');
      console.log('4. API worker mode');
      console.log('5. API workers from proxy TXT');
      console.log('6. Open output folder');
      console.log('0. Exit');
      console.log('');

      const choice = await promptChoice(rl, 'Select action', ['0', '1', '2', '3', '4', '5', '6']);

      if (choice === '0') {
        return 0;
      }

      if (choice === '6') {
        await spawnAndWait('explorer.exe', [__dirname]);
        await rl.question('Press Enter to continue...');
        continue;
      }

      if (choice === '4') {
        const exitCode = await runApiMode(rl, state);
        await rl.question(`Worker finished with exit code ${exitCode}. Press Enter to continue...`);
        continue;
      }

      if (choice === '5') {
        const exitCode = await runApiProxyFileMode(rl, state);
        await rl.question(`Workers finished with exit code ${exitCode}. Press Enter to continue...`);
        continue;
      }

      let inputPath = defaultInput;
      if (choice === '2') {
        inputPath = path.join(projectRoot, 'result.json');
      } else if (choice === '3') {
        const files = await getJsonFiles();
        if (!files.length) {
          console.log('No JSON files found in project root.');
          await rl.question('Press Enter to continue...');
          continue;
        }

        console.log('');
        console.log('Available JSON files:');
        console.log(formatFileChoices(files));
        console.log('');

        while (true) {
          const selected = await promptText(rl, 'Pick a file number');
          const index = Number(selected);
          if (Number.isInteger(index) && index >= 1 && index <= files.length) {
            inputPath = files[index - 1];
            break;
          }
          console.log('Invalid selection.');
        }
      }

      const mode = await promptChoice(rl, 'Mode (1=headless, 2=headed)', ['1', '2']);
      const saveHtml = (await promptChoice(rl, 'Save HTML? (1=no, 2=yes)', ['1', '2'])) === '2';
      const exitCode = await runBatchMode(inputPath, mode === '1', saveHtml);
      await rl.question(`Batch finished with exit code ${exitCode}. Press Enter to continue...`);
    }
  } finally {
    rl.close();
  }
}

async function main() {
  if (command === 'headless') {
    process.exitCode = await runPython(extraArgs.length ? extraArgs : [defaultInput, '--headless']);
    return;
  }

  if (command === 'api') {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const state = await loadState();
    try {
      process.exitCode = await runApiMode(rl, state, extraArgs);
    } finally {
      rl.close();
    }
    return;
  }

  if (command === 'api-proxies' || command === 'api:proxies') {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const state = await loadState();
    try {
      process.exitCode = await runApiProxyFileMode(rl, state, extraArgs);
    } finally {
      rl.close();
    }
    return;
  }

  if (command === 'menu') {
    process.exitCode = await interactiveMenu();
    return;
  }

  console.error(`Unknown yandex launcher command: ${command}`);
  console.error('Available commands: menu, headless, api, api-proxies');
  process.exitCode = 1;
}

await main();
