import { firefox } from 'playwright';
import fs from 'node:fs/promises';

const DEFAULT_URL =
  'https://www.avito.ru/moskva_i_mo/kvartiry/sdam/na_dlitelnyy_srok/do-30-tis-rubley-ASgBAgECAkSSA8gQ8AeQUgFFxpoMFXsiZnJvbSI6MCwidG8iOjMwMDAwfQ?cd=1&context=H4sIAAAAAAAA_wEmANn_YToxOntzOjE6InkiO3M6MTY6IkxoVHhZVkdEZTg0TjROWUgiO30OD4ZhJgAAAA&f=ASgBAgECAkSSA8gQ8AeQUgJF6AcVeyJmcm9tIjoyNSwidG8iOm51bGx9xpoMFXsiZnJvbSI6MCwidG8iOjMwMDAwfQ&localPriority=0';

const MIN_DELAY_MS = 7000;
const MAX_DELAY_MS = 14000;
const DEBUG_DIR = 'debug';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function timestamp() {
  return new Date().toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

async function logPageDiagnostics(page, label) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const itemCount = await page.locator('[data-marker="item"]').count().catch(() => 0);
  const paginationCount = await page.locator('[aria-label="Пагинация"]').count().catch(() => 0);
  const bodyText = normalizeText(await page.locator('body').innerText().catch(() => ''));
  const captchaLike = /капч|captcha|robot|подтвердите/i.test(bodyText);

  log(`${label}: URL=${url} | title=${title || '(пусто)'} | items=${itemCount} | pagination=${paginationCount} | captcha=${captchaLike ? 'да' : 'нет'}`);
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/(\d)([A-Za-zА-Яа-яЁё])/g, '$1 $2')
    .replace(/([A-Za-zА-Яа-яЁё])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPageUrl(baseUrl, pageNumber) {
  const url = new URL(baseUrl);
  url.searchParams.set('p', String(pageNumber));
  return url.toString();
}

function getPageNumberFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    const pageParam = url.searchParams.get('p');
    return pageParam ? Number(pageParam) : null;
  } catch {
    return null;
  }
}

async function extractItems(page) {
  const itemSelector = '#bx_serp-item-list [data-marker="item"], [data-marker="item"]';
  const items = await page.$$(itemSelector);

  const result = await Promise.all(
    items.map(async (item) => {
      const [price, title, adress, dop, description, href] = await Promise.all([
        item
          .$eval('[data-marker="item-price-value"], .item-price-value, [class*="item-price-value"]', (node) => node.textContent)
          .catch(() => ''),
        item
          .$eval('.iva-item-title-KE8A9, [class*="iva-item-title"]', (node) => node.textContent)
          .catch(() => ''),
        item
          .$eval('[data-marker="item-location"]', (node) => node.textContent)
          .catch(() => ''),
        item
          .$eval('[data-marker="item-specific-params"]', (node) => node.textContent)
          .catch(() => ''),
        item
          .$eval('.iva-item-bottomBlock-VewGa, [class*="iva-item-bottomBlock"]', (node) => node.textContent)
          .catch(() => ''),
        item
          .$eval('a[href]', (node) => node.href)
          .catch(() => ''),
      ]);

      return {
        title: normalizeText(title),
        price: normalizeText(price),
        adress: normalizeText(adress),
        dop: normalizeText(dop),
        description: normalizeText(description),
        url: href || null,
      };
    })
  );

  return result;
}

async function saveDebugArtifacts(page, pageNumber, reason) {
  await fs.mkdir(DEBUG_DIR, { recursive: true });

  const htmlPath = `${DEBUG_DIR}/page-${pageNumber}.html`;
  const shotPath = `${DEBUG_DIR}/page-${pageNumber}.png`;

  await fs.writeFile(htmlPath, await page.content(), 'utf8');
  await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

  log(`Сохранил отладочные файлы: ${htmlPath}, ${shotPath}. Причина: ${reason}`);
}

async function waitForListingsOrDiagnose(page, pageNumber) {
  const selectors = [
    '#bx_serp-item-list [data-marker="item"]',
    '[data-marker="item"]',
  ];

  const deadline = Date.now() + 300000;
  let captchaHintShown = false;

  while (Date.now() < deadline) {
    const url = page.url();
    const bodyText = normalizeText(await page.locator('body').innerText().catch(() => ''));

    for (const selector of selectors) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count > 0) {
        log(`Нашёл ${count} элементов по селектору ${selector}.`);
        return true;
      }
    }

    if (!captchaHintShown && /капч|captcha|robot|подтвердите/i.test(bodyText)) {
      log('Похоже, Avito показал капчу. Пройди её вручную в открытом браузере, после этого я продолжу автоматически.');
      captchaHintShown = true;
    }

    log(`Карточки ещё не видны, жду загрузку. Текущий URL: ${url}`);
    await sleep(2000);
  }

  await saveDebugArtifacts(page, pageNumber, 'не дождались карточек объявлений');
  return false;
}

async function readExistingOutput(path) {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeOutputFile(path, items) {
  await fs.writeFile(path, JSON.stringify(items, null, 2), 'utf8');
}

async function waitForPageChange(page, previousPageNumber) {
  const deadline = Date.now() + 180000;

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    const currentPageNumber = getPageNumberFromUrl(currentUrl);

    if (currentPageNumber !== null && currentPageNumber !== previousPageNumber) {
      log(`Обнаружил переход на страницу ${currentPageNumber}: ${currentUrl}`);
      return currentPageNumber;
    }

    await sleep(1000);
  }

  throw new Error('Не дождался ручного перехода на следующую страницу.');
}

async function parseAvitoListings({
  baseUrl = DEFAULT_URL,
  out = 'result.json',
  headless = true,
} = {}) {
  log('Запускаю браузер.');

  const browser = await firefox.launch({
    headless,
    slowMo: 250,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1024 },
    locale: 'ru-RU',
  });

  const page = await context.newPage();
  const allItems = [];

  try {
    log(`Открой вручную эту ссылку в браузере: ${baseUrl}`);
    log('Я подожду, пока страница загрузится, а потом начну сбор автоматически.');

    const waitUntilNavigated = async () => {
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        const currentUrl = page.url();
        if (currentUrl && currentUrl !== 'about:blank' && currentUrl !== 'chrome://newtab/') {
          return currentUrl;
        }
        await sleep(1000);
      }
      throw new Error('Не дождался, пока ты откроешь нужную страницу в браузере.');
    };

    await waitUntilNavigated();
    await logPageDiagnostics(page, 'После ручного открытия');

    log('Пробую сразу собрать карточки со страницы.');
    let items = await extractItems(page);

    if (items.length === 0) {
      log('Сразу карточки не появились. Если видишь капчу, пройди её вручную, я подожду и проверю ещё раз.');
      await logPageDiagnostics(page, 'Перед ожиданием');
      const hasListings = await waitForListingsOrDiagnose(page, 1);
      if (!hasListings) {
        log('Не нашёл карточки объявлений.');
        return [];
      }

      items = await extractItems(page);
    }

    log(`Найдено ${items.length} объявлений.`);
    allItems.push(...items);
    let mergedItems = [...(await readExistingOutput(out)), ...allItems];
    await writeOutputFile(out, mergedItems);
    log(`Сохранил ${mergedItems.length} объектов в файл ${out}.`);

    let currentPageNumber = getPageNumberFromUrl(page.url());

    while (true) {
      log('Перелистни страницу вручную в браузере, и я продолжу сбор автоматически.');
      currentPageNumber = await waitForPageChange(page, currentPageNumber);
      await logPageDiagnostics(page, 'После ручного перехода');

      let nextItems = await extractItems(page);
      if (nextItems.length === 0) {
        log('Карточки на новой странице ещё не видны, подожду немного.');
        const hasListings = await waitForListingsOrDiagnose(page, 1);
        if (!hasListings) {
          log('На новой странице не нашёл карточки объявлений.');
          break;
        }
        nextItems = await extractItems(page);
      }

      if (nextItems.length === 0) {
        log('После перехода карточки так и не появились, завершаю сбор.');
        break;
      }

      log(`На новой странице найдено ${nextItems.length} объявлений.`);
      allItems.push(...nextItems);
      mergedItems = [...(await readExistingOutput(out)), ...allItems];
      await writeOutputFile(out, mergedItems);
      log(`Обновил файл ${out}. Сейчас в нём ${mergedItems.length} объектов.`);
    }

    return allItems;
  } finally {
    log('Закрываю браузер.');
    await browser.close().catch(() => {});
  }
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_URL,
    out: null,
    headless: true,
  };

  for (const arg of argv) {
    if (arg.startsWith('--url=')) {
      args.baseUrl = arg.slice('--url='.length);
    } else if (arg.startsWith('--out=')) {
      args.out = arg.slice('--out='.length);
    } else if (arg === '--headed') {
      args.headless = false;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  log('Начинаю сбор объявлений с Avito.');
  log('Переходы по страницам теперь отслеживаются автоматически по клику в браузере.');

  const items = await parseAvitoListings({
    baseUrl: args.baseUrl,
    out: args.out || 'result.json',
    headless: args.headless,
  });

  log(`Сбор завершён. Всего объектов: ${items.length}.`);

  console.log(JSON.stringify(items, null, 2));
}

main().catch((error) => {
  console.error('Ошибка при парсинге Avito:', error);
  process.exitCode = 1;
});

export {
  buildPageUrl,
  extractItems,
  parseAvitoListings,
  parseArgs,
};
