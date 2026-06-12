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
  const passthroughArgs = proxyOption.rest;
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

  await saveState({
    ...state,
    lastApiUrl: apiUrl,
    lastProxy: proxyValue,
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
    ...passthroughArgs,
  ].join(' ')}`);
  console.log('');

  return runPython([
    '--api-url',
    apiUrl,
    ...(proxyValue ? ['--proxy', proxyValue] : []),
    ...passthroughArgs,
  ]);
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
      console.log('5. Open output folder');
      console.log('0. Exit');
      console.log('');

      const choice = await promptChoice(rl, 'Select action', ['0', '1', '2', '3', '4', '5']);

      if (choice === '0') {
        return 0;
      }

      if (choice === '5') {
        await spawnAndWait('explorer.exe', [__dirname]);
        await rl.question('Press Enter to continue...');
        continue;
      }

      if (choice === '4') {
        const exitCode = await runApiMode(rl, state);
        await rl.question(`Worker finished with exit code ${exitCode}. Press Enter to continue...`);
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

  if (command === 'menu') {
    process.exitCode = await interactiveMenu();
    return;
  }

  console.error(`Unknown yandex launcher command: ${command}`);
  console.error('Available commands: menu, headless, api');
  process.exitCode = 1;
}

await main();
