import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const PORT = Number(globalThis.process?.env?.PORT || 4173);
const MAX_PORT_ATTEMPTS = 10;
// JSON-файлы с маршрутами и карточками могут быть довольно большими, поэтому
// держим лимит заметно выше обычного размера пользовательского экспорта.
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const IMAGE_FETCH_DELAY_MS = 5000;
const ANALYTICS_DATA_FILE = new URL('./analytics-data.json', import.meta.url);
const ADMIN_KEY_FILE = new URL('./.analytics-admin-key', import.meta.url);

function loadAdminKey() {
  const envKey = String(globalThis.process?.env?.ANALYTICS_ADMIN_KEY || globalThis.process?.env?.ADMIN_KEY || '').trim();
  if (envKey) return envKey;

  try {
    if (existsSync(ADMIN_KEY_FILE)) {
      const fileKey = readFileSync(ADMIN_KEY_FILE, 'utf8').trim();
      if (fileKey) return fileKey;
    }

    const generatedKey = `local-${randomBytes(12).toString('hex')}`;
    writeFileSync(ADMIN_KEY_FILE, `${generatedKey}\n`, 'utf8');
    return generatedKey;
  } catch {
    return '';
  }
}

const ADMIN_KEY = loadAdminKey();
const preferredFilterTimeKeys = ['Родина', 'работа Оли'];
const ignoredFilterTimeKeyNames = new Set([
  'address', 'adress', 'адрес', 'description', 'desc', 'описание', 'dop',
  'title', 'name', 'название', 'price', 'цена', 'url', 'link', 'href', 'avitourl',
]);

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Слишком большой запрос.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonPayload(req) {
  const body = await readBody(req);
  if (!body.length) return {};

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function rub(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(number)) + ' ₽';
}

function minutesText(value) {
  if (!Number.isFinite(value)) return 'нет';
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return (hours ? hours + ' ч ' : '') + minutes + ' мин';
}

function readFilterItemsFromText(text) {
  const parsed = JSON.parse(text);
  const items = unwrapItems(parsed);
  if (!items.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    throw new Error('В массиве должны быть только объекты объявлений.');
  }
  return items;
}

function detectFilterTimeKeys(items) {
  const keys = new Set(items.flatMap((item) => Object.keys(item || {})));
  const preferred = preferredFilterTimeKeys.filter((key) => keys.has(key));
  if (preferred.length) return preferred;

  const detected = [...keys].filter((key) => {
    if (!canAutoDetectFilterTimeKey(key)) return false;
    const values = items
      .map((item) => item?.[key])
      .filter((value) => value !== undefined && value !== null);
    return values.length > 0 && values.some((value) => {
      if (typeof value === 'number' && !preferredFilterTimeKeys.includes(key)) return false;
      return isCompactFilterTimeValue(value);
    });
  });

  return [...new Set([...preferred, ...detected])];
}

function canAutoDetectFilterTimeKey(key) {
  const normalized = String(key ?? '').trim();
  if (!normalized) return false;
  if (preferredFilterTimeKeys.includes(normalized)) return true;
  if (ignoredFilterTimeKeyNames.has(normalized.toLowerCase())) return false;
  return /время|маршрут|дорог|путь|работ|родин|ол|никит|time|route/i.test(normalized);
}

function isCompactFilterTimeValue(value) {
  if (!Number.isFinite(parseTransitMinutes(value))) return false;
  if (typeof value === 'number') return true;
  const text = String(value ?? '').trim();
  if (!text) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return text.length <= 32 && words.length <= 6;
}

function parseTransitMinutes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const text = String(value ?? '').toLowerCase().replace(',', '.');
  if (!text || text.includes('ошиб') || text.includes('не найден')) return Number.POSITIVE_INFINITY;

  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:ч|час|С‡|С‡Р°СЃ)/);
  const minuteMatch = text.match(/(\d+)\s*(?:мин|м\b|РјРёРЅ|Рј\b)/);
  const numberOnly = text.match(/^\s*(\d+)\s*$/);
  const total = (hourMatch ? Number(hourMatch[1]) * 60 : 0) + (minuteMatch ? Number(minuteMatch[1]) : 0);

  if (total > 0) return Math.round(total);
  if (numberOnly) return Number(numberOnly[1]);
  return Number.POSITIVE_INFINITY;
}

function buildDefaultTimeLimits(timeKeys) {
  return Object.fromEntries(timeKeys.map((key) => [key, 60]));
}

function normalizeTimeLimits(timeLimits, timeKeys) {
  const next = {};
  const defaultLimit = 60;
  for (const key of timeKeys) {
    const current = Number(timeLimits?.[key]);
    next[key] = Number.isFinite(current) && current > 0 ? current : defaultLimit;
  }
  return next;
}

function parseTerms(value) {
  return String(value ?? '')
    .split(/[\n,;]+/g)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

function matchesExcludedTitle(item, excludeTerms) {
  if (!excludeTerms.length) return false;
  const title = String(getFilterTitle(item)).toLowerCase();
  return excludeTerms.some((term) => title.includes(term));
}

function getFilterTitle(item) {
  return item.title || item.name || item.название || 'Без названия';
}

function getFilterPrice(item) {
  return item.price || item.цена || '';
}

function getFilterLink(item) {
  const value = item.url || item.URL || item.link || item.href || item.avitoUrl || '';
  if (typeof value !== 'string') return '';
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `https://www.avito.ru${value}`;
  return value;
}

function getBestTimeMinutes(item, timeKeys) {
  if (!timeKeys.length) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const key of timeKeys) {
    const minutes = parseTransitMinutes(item[key]);
    if (Number.isFinite(minutes) && minutes < best) best = minutes;
  }
  return best;
}

function sortFilterItems(items, sortMode, timeKeys) {
  const sorted = items.slice();
  sorted.sort((a, b) => {
    if (sortMode === 'price') {
      const priceDelta = parsePrice(getFilterPrice(a)) - parsePrice(getFilterPrice(b));
      if (priceDelta !== 0) return priceDelta;
      const timeDelta = getBestTimeMinutes(a, timeKeys) - getBestTimeMinutes(b, timeKeys);
      if (timeDelta !== 0) return timeDelta;
    } else {
      const timeDelta = getBestTimeMinutes(a, timeKeys) - getBestTimeMinutes(b, timeKeys);
      if (timeDelta !== 0) return timeDelta;
      const priceDelta = parsePrice(getFilterPrice(a)) - parsePrice(getFilterPrice(b));
      if (priceDelta !== 0) return priceDelta;
    }
    const titleA = String(getFilterTitle(a)).toLowerCase();
    const titleB = String(getFilterTitle(b)).toLowerCase();
    return titleA.localeCompare(titleB, 'ru');
  });
  return sorted;
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

function applyFilterServer(items, { timeKeys, timeLimits, excludeTerms, sortMode }) {
  let filtered = items;
  if (timeKeys.length) {
    filtered = filtered.filter((item) => timeKeys.every((key) => {
      const limit = Number(timeLimits[key]);
      return parseTransitMinutes(item[key]) <= limit;
    }));
  }
  filtered = filtered.filter((item) => !matchesExcludedTitle(item, excludeTerms));
  return sortFilterItems(filtered, sortMode, timeKeys);
}

function buildFilterStatusText(timeKeys, timeLimits, excludeTerms, visibleCount, totalCount) {
  const limitText = timeKeys.map((key) => `${key} до ${timeLimits[key]} мин`).join(', ');
  const excludedText = excludeTerms.length ? ` исключения: ${excludeTerms.join(', ')}` : '';
  return `Фильтр: ${limitText}${excludedText}: ${visibleCount} из ${totalCount}`;
}

function detectAnalyticsTimeKeys(items) {
  const ignored = new Set([
    'title', 'name', 'название', 'adress', 'address', 'адрес', 'price', 'цена',
    'url', 'link', 'href', 'description', 'dop', 'image', 'months',
    'rent_per_month', 'rent_for_period', 'commission_percent', 'commission',
    'deposit', 'total_for_period',
  ]);
  const keys = [];
  items.slice(0, 80).forEach((item) => {
    Object.keys(item || {}).forEach((key) => {
      const lower = key.toLowerCase();
      if (ignored.has(lower) || keys.includes(key)) return;
      const value = item[key];
      const text = String(value ?? '').toLowerCase();
      const looksLikeRoute = /время|маршрут|дорог|путь|работ|родин|оли|никит|time|route/.test(lower);
      const looksLikeDuration = /(\d+\s*(ч|час|мин|м\b|h|min))/.test(text);
      if ((looksLikeRoute || looksLikeDuration) && Number.isFinite(parseTime(value))) {
        if (typeof value === 'number' && !looksLikeRoute) return;
        keys.push(key);
      }
    });
  });
  return keys.sort((a, b) => {
    const score = (key) => /оли|ol/i.test(key) ? -2 : /родина|никит|nik/i.test(key) ? -1 : 0;
    return score(a) - score(b) || a.localeCompare(b, 'ru');
  });
}

function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').toLowerCase();
  if (!text.trim()) return Infinity;
  let total = 0;
  const day = text.match(/(\d+)\s*(?:д|дн|день|дня)/);
  const hour = text.match(/(\d+)\s*(?:ч|час|часа|часов|h)/);
  const min = text.match(/(\d+)\s*(?:м|мин|minute|min)/);
  if (day) total += Number(day[1]) * 1440;
  if (hour) total += Number(hour[1]) * 60;
  if (min) total += Number(min[1]);
  if (!total) {
    const onlyNumber = text.match(/^\s*(\d+)\s*$/);
    if (onlyNumber) total = Number(onlyNumber[1]);
  }
  return total || Infinity;
}

function chooseAnalyticsKey(preferredKey, timeKeys, matcher) {
  if (preferredKey && timeKeys.includes(preferredKey)) return preferredKey;
  const match = timeKeys.find((key) => matcher.test(key));
  return match || timeKeys[0] || '';
}

function getAnalyticsTitle(item) {
  return String(item?.title ?? item?.name ?? item?.название ?? 'Без названия');
}

function getAnalyticsAddress(item) {
  return String(item?.adress ?? item?.address ?? item?.адрес ?? '');
}

function getAnalyticsUrl(item) {
  return String(item?.url ?? item?.link ?? item?.href ?? '');
}

function parseMoney(value) {
  if (typeof value === 'number') return value;
  const text = String(value ?? '').replace(/\s+/g, ' ');
  const match = text.match(/(\d[\d\s.,]*)/);
  if (!match) return 0;
  return Number(match[1].replace(/[^\d]/g, '')) || 0;
}

function parseArea(item) {
  const text = [item?.title, item?.name, item?.description].filter(Boolean).join(' ');
  const match = text.match(/(\d+(?:[,.]\d+)?)\s*м[²2]/i);
  return match ? Number(match[1].replace(',', '.')) : 0;
}

function parseRooms(item) {
  const text = [item?.title, item?.name].filter(Boolean).join(' ').toLowerCase();
  const studio = /студ/.test(text);
  if (studio) return 0;
  const match = text.match(/(\d+)\s*[- ]?\s*(?:к|комн)/i);
  return match ? Number(match[1]) : null;
}

function parseFloorInfo(item) {
  const text = [item?.title, item?.name].filter(Boolean).join(' ');
  const match = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:эт|этаж)/i);
  if (!match) return { floor: null, totalFloors: null, category: 'этаж не найден' };
  const floor = Number(match[1]);
  const totalFloors = Number(match[2]);
  let category = 'средний этаж';
  if (floor === totalFloors) category = 'последний этаж';
  else if (floor <= 3) category = 'низкий этаж';
  else if (totalFloors && floor / totalFloors >= 0.7) category = 'высокий этаж';
  return { floor, totalFloors, category };
}

function areaCategory(area) {
  if (!area) return 'площадь не найдена';
  if (area < 35) return 'маленькая';
  if (area < 45) return 'нормальная';
  if (area < 60) return 'просторная';
  return 'большая';
}

function getRent(item) {
  return Number(item?.rent_per_month) || parseMoney(item?.price) || parseMoney(item?.rent) || 0;
}

function getMonths(item) {
  const months = Number(item?.months);
  if (Number.isFinite(months) && months > 0) return months;

  const source = [item?.dop, item?.description].map((value) => String(value ?? '').toLowerCase()).join(' ');
  if (/от\s+года|год(а|у)?/.test(source)) return 12;
  if (/полгода|6\s*мес/.test(source)) return 6;
  if (/2\s*года/.test(source)) return 24;

  return 3;
}

function getTotal(item, rent, months) {
  const total = Number(item?.total_for_period);
  if (Number.isFinite(total) && total > 0) return total;
  const commission = getCommission(item);
  const deposit = getDeposit(item) || getDepositFromText(item, rent);
  const partsTotal = rent * months + commission + deposit;
  if (Number.isFinite(partsTotal) && partsTotal > 0) return partsTotal;
  return rent * months;
}

function getPaymentSourceText(item) {
  return [item?.dop, item?.description]
    .map((value) => String(value ?? ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCommission(item) {
  const commission = Number(item?.commission);
  if (Number.isFinite(commission) && commission >= 0) return commission;

  const source = getPaymentSourceText(item);
  if (/без\s+комисс/i.test(source)) return 0;

  const percentMatch = source.match(/комисс\w*[^0-9]{0,24}(\d{1,3})\s*%/i);
  if (percentMatch) {
    const percent = Number(percentMatch[1]);
    const rent = getRent(item);
    if (Number.isFinite(percent) && percent > 0 && rent > 0) {
      return rent * percent / 100;
    }
  }

  const percent = Number(item?.commission_percent);
  const rent = getRent(item);
  if (Number.isFinite(percent) && percent > 0 && rent > 0) return rent * percent / 100;
  return 0;
}

function getDeposit(item) {
  const deposit = Number(item?.deposit);
  return Number.isFinite(deposit) && deposit > 0 ? deposit : 0;
}

function getDepositFromText(item, monthlyPrice) {
  const source = getPaymentSourceText(item);
  if (/без\s+залог/i.test(source)) return 0;

  const depositMatch = source.match(/(?:залог|депозит)[^0-9₽р]{0,40}(\d[\d\s.]*)\s*(?:₽|руб|р\.?)/i);
  if (depositMatch) {
    const parsed = parseMoney(depositMatch[0]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const oneMonthMatch = source.match(/(?:залог|депозит)[^.]{0,80}(?:месяц|мес|размере месячной|один)/i);
  if (oneMonthMatch && monthlyPrice > 0) return monthlyPrice;

  return 0;
}

function moveInCategory(startPayment, rent) {
  if (!rent) return 'нет данных';
  if (startPayment <= rent * 1.5) return 'дешёвый вход';
  if (startPayment <= rent * 2.5) return 'средний вход';
  return 'дорогой вход';
}

function balanceType(olya, nikita) {
  if (!Number.isFinite(olya) || !Number.isFinite(nikita)) return 'нет данных';
  const diff = Math.abs(olya - nikita);
  if (diff === 0) return 'одинаково';
  const side = olya < nikita ? 'Оле быстрее' : 'Никите быстрее';
  if (diff <= 15) return 'почти одинаково, ' + side;
  if (diff <= 30) return 'разница 16-30 мин, ' + side;
  if (diff <= 60) return 'разница 31-60 мин, ' + side;
  return 'разница больше 60 мин, ' + side;
}

function average(values) {
  const good = values.filter((value) => Number.isFinite(value));
  return good.length ? good.reduce((sum, value) => sum + value, 0) / good.length : 0;
}

function median(values) {
  const good = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!good.length) return 0;
  const mid = Math.floor(good.length / 2);
  return good.length % 2 ? good[mid] : (good[mid - 1] + good[mid]) / 2;
}

function percentile(values, ratio) {
  const good = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!good.length) return 0;
  return good[Math.min(good.length - 1, Math.floor((good.length - 1) * ratio))];
}

function scoreLower(value, best, worst) {
  if (!Number.isFinite(value)) return null;
  if (!Number.isFinite(best) || !Number.isFinite(worst) || best === worst) return 100;
  return Math.round(Math.max(0, Math.min(100, 100 - ((value - best) / (worst - best)) * 100)));
}

function scoreHigher(value, best, worst) {
  if (!Number.isFinite(value) || !value) return null;
  if (!Number.isFinite(best) || !Number.isFinite(worst) || best === worst) return 100;
  return Math.round(Math.max(0, Math.min(100, ((value - best) / (worst - best)) * 100)));
}

function avgScore(values) {
  const good = values.filter((value) => Number.isFinite(value));
  return good.length ? Math.round(good.reduce((sum, value) => sum + value, 0) / good.length) : 0;
}

function gradeLabel(score) {
  if (score >= 85) return 'отлично';
  if (score >= 70) return 'хорошо';
  if (score >= 50) return 'нормально';
  if (score >= 30) return 'слабо';
  return 'плохо';
}

function getPeriodLabel(rows) {
  const months = [...new Set(rows.map((row) => row.months).filter(Boolean))];
  if (months.length === 1) return 'за ' + months[0] + ' мес.';
  return 'за период';
}

function buildAnalyticsView(items, { olyaKey, nikitaKey, fastLimit, timeKeys }) {
  const baseRows = items.map((item, index) => {
    const rent = getRent(item);
    const months = getMonths(item);
    const total = getTotal(item, rent, months);
    const area = parseArea(item);
    const rooms = parseRooms(item);
    const floorInfo = parseFloorInfo(item);
    const olya = parseTime(item[olyaKey]);
    const nikita = parseTime(item[nikitaKey]);
    const avgCommute = Number.isFinite(olya) && Number.isFinite(nikita) ? (olya + nikita) / 2 : Infinity;
    const maxCommute = Math.max(olya, nikita);
    const diffTime = Math.abs(olya - nikita);
    const commission = getCommission(item);
    const deposit = getDeposit(item) || getDepositFromText(item, rent);
    const startPayment = rent + commission + deposit;
    const priceM2 = area ? rent / area : 0;
    const dailyRent = rent / 30;
    const rubPerCommuteMin = Number.isFinite(avgCommute) && avgCommute > 0 ? rent / avgCommute : 0;
    return {
      index,
      item,
      title: getAnalyticsTitle(item),
      address: getAnalyticsAddress(item),
      url: getAnalyticsUrl(item),
      rent,
      total,
      months,
      area,
      rooms,
      floor: floorInfo.floor,
      totalFloors: floorInfo.totalFloors,
      floorCategory: floorInfo.category,
      areaCategory: areaCategory(area),
      commission,
      deposit,
      startPayment,
      overpaymentPercent: rent ? (startPayment / rent) * 100 : 0,
      moveInCostCategory: moveInCategory(startPayment, rent),
      priceM2,
      dailyRent,
      rubPerCommuteMin,
      olya,
      nikita,
      avgCommute,
      maxCommute,
      diffTime,
      balanceType: balanceType(olya, nikita),
    };
  }).filter((row) => row.rent > 0);

  const ranges = {
    rentMin: Math.min(...baseRows.map((row) => row.rent)),
    rentMax: Math.max(...baseRows.map((row) => row.rent)),
    priceM2Min: Math.min(...baseRows.map((row) => row.priceM2).filter(Boolean)),
    priceM2Max: Math.max(...baseRows.map((row) => row.priceM2).filter(Boolean)),
    avgMin: Math.min(...baseRows.map((row) => row.avgCommute).filter(Number.isFinite)),
    avgMax: Math.max(...baseRows.map((row) => row.avgCommute).filter(Number.isFinite)),
    diffMin: Math.min(...baseRows.map((row) => row.diffTime).filter(Number.isFinite)),
    diffMax: Math.max(...baseRows.map((row) => row.diffTime).filter(Number.isFinite)),
    areaMin: Math.min(...baseRows.map((row) => row.area).filter(Boolean)),
    areaMax: Math.max(...baseRows.map((row) => row.area).filter(Boolean)),
    startMin: Math.min(...baseRows.map((row) => row.startPayment).filter(Number.isFinite)),
    startMax: Math.max(...baseRows.map((row) => row.startPayment).filter(Number.isFinite)),
  };

  const rows = baseRows.map((row) => {
    const rentScore = scoreLower(row.rent, ranges.rentMin, ranges.rentMax);
    const priceM2Score = row.priceM2 ? scoreLower(row.priceM2, ranges.priceM2Min, ranges.priceM2Max) : null;
    const commuteScore = scoreLower(row.avgCommute, ranges.avgMin, ranges.avgMax);
    const balanceScore = scoreLower(row.diffTime, ranges.diffMin, ranges.diffMax);
    const areaScore = row.area ? scoreHigher(row.area, ranges.areaMin, ranges.areaMax) : null;
    const startPaymentScore = scoreLower(row.startPayment, ranges.startMin, ranges.startMax);
    const finalScore = avgScore([rentScore, priceM2Score, commuteScore, balanceScore, areaScore, startPaymentScore]);

    return {
      ...row,
      rentScore,
      priceM2Score,
      commuteScore,
      balanceScore,
      areaScore,
      startPaymentScore,
      finalScore,
      grade: gradeLabel(finalScore),
    };
  });

  const periodLabel = getPeriodLabel(rows);
  const rents = rows.map((row) => row.rent);
  const totals = rows.map((row) => row.total);
  const m2 = rows.map((row) => row.priceM2).filter(Boolean);
  const startPayments = rows.map((row) => row.startPayment);
  const olyaTimes = rows.map((row) => row.olya);
  const nikitaTimes = rows.map((row) => row.nikita);
  const avgTimes = rows.map((row) => row.avgCommute);
  const diffTimes = rows.map((row) => row.diffTime);
  const rubPerMinute = rows.map((row) => row.rubPerCommuteMin).filter(Boolean);
  const fastBoth = rows.filter((row) => row.olya <= fastLimit && row.nikita <= fastLimit);
  const midRange = rows.filter((row) => row.avgCommute >= 60 && row.avgCommute <= 90);
  const midRangeMedians = median(midRange.map((row) => row.rent));

  const metrics = [
    ['Объектов', rows.length, 'с распознанной ценой'],
    ['Средняя аренда', rub(average(rents)), 'средняя цена всех объектов'],
    ['Медианная аренда', rub(median(rents)), 'типичная цена рынка'],
    ['Минимум / максимум', rub(Math.min(...rents)) + ' / ' + rub(Math.max(...rents)), 'по месячной аренде'],
    ['Средняя цена за м²', m2.length ? rub(average(m2)) : 'нет данных', 'если площадь найдена в названии'],
    ['Медиана цены за м²', m2.length ? rub(median(m2)) : 'нет данных', 'типичная цена за метр'],
    ['Средний стартовый платёж', rub(average(startPayments)), '1 месяц + комиссия + залог'],
    ['Среднее до Оли', minutesText(Math.round(average(olyaTimes))), 'по всем объектам с временем'],
    ['Среднее до Никиты', minutesText(Math.round(average(nikitaTimes))), 'по всем объектам с временем'],
    ['Среднее для двоих', minutesText(Math.round(average(avgTimes))), 'среднее двух маршрутов'],
    ['Средняя разница', minutesText(Math.round(average(diffTimes))), 'насколько маршруты отличаются'],
    ['Среднее ₽/мин пути', rubPerMinute.length ? rub(average(rubPerMinute)) : 'нет данных', 'аренда / среднее время'],
    ['Медиана ₽/мин пути', rubPerMinute.length ? rub(median(rubPerMinute)) : 'нет данных', 'типичное значение'],
    ['Быстрые для обоих', fastBoth.length, 'до ' + fastLimit + ' мин каждому'],
    ['Медиана 60-90 мин', midRange.length ? rub(midRangeMedians) : 'нет данных', 'вариантов: ' + midRange.length + ', по среднему времени до двоих'],
    ['Медиана итого ' + periodLabel, rub(median(totals)), 'аренда + комиссия + залог'],
    ['Порог дорогих вариантов', rub(percentile(rents, 0.9)), 'примерно 10% объявлений дороже'],
  ].map(([label, value, note]) => ({ label, value, note }));

  const cheapest = rows.slice().sort((a, b) => a.total - b.total || a.rent - b.rent)[0];
  const expensive = rows.slice().sort((a, b) => b.rent - a.rent)[0];
  const quickestOlya = rows.filter((row) => Number.isFinite(row.olya)).sort((a, b) => a.olya - b.olya)[0];
  const balanced = rows.filter((row) => Number.isFinite(row.avgCommute)).sort((a, b) => a.diffTime - b.diffTime || a.avgCommute - b.avgCommute)[0];
  const insights = [
    ['Самый дешёвый', cheapest ? rub(cheapest.total) + '<br>' + esc(cheapest.title) : 'нет данных'],
    ['Самый дорогой', expensive ? rub(expensive.rent) + '<br>' + esc(expensive.title) : 'нет данных'],
    ['Самый быстрый до Оли', quickestOlya ? minutesText(quickestOlya.olya) + '<br>' + rub(quickestOlya.rent) : 'нет данных'],
    ['Минимальная разница', balanced ? minutesText(balanced.olya) + ' / ' + minutesText(balanced.nikita) + '<br>разница ' + minutesText(balanced.diffTime) : 'нет данных'],
  ].map(([title, body]) => ({ title, body }));

  const baseColumns = [
    { label: 'Объект' },
    { label: 'Аренда' },
    { label: 'Цена за м²' },
    { label: 'Итого ' + periodLabel },
    { label: 'До Оли' },
    { label: 'До Никиты' },
  ];

  const cheap = rows.slice().sort((a, b) => a.total - b.total || a.rent - b.rent);
  const expensiveRows = rows.slice().sort((a, b) => b.rent - a.rent);
  const olya = rows.filter((row) => Number.isFinite(row.olya)).sort((a, b) => a.olya - b.olya || a.rent - b.rent);
  const nikita = rows.filter((row) => Number.isFinite(row.nikita)).sort((a, b) => a.nikita - b.nikita || a.rent - b.rent);
  const balancedRows = rows.filter((row) => Number.isFinite(row.avgCommute)).sort((a, b) => a.diffTime - b.diffTime || a.avgCommute - b.avgCommute || a.rent - b.rent);
  const score = rows.slice().sort((a, b) => b.finalScore - a.finalScore || a.rent - b.rent);
  const value = rows.filter((row) => row.priceM2 > 0).sort((a, b) => a.priceM2 - b.priceM2 || a.rent - b.rent);
  const start = rows.slice().sort((a, b) => a.startPayment - b.startPayment || a.rent - b.rent);
  const minute = rows.filter((row) => row.rubPerCommuteMin > 0).sort((a, b) => a.rubPerCommuteMin - b.rubPerCommuteMin || a.avgCommute - b.avgCommute);

  const tableRows = {
    cheap,
    expensive: expensiveRows,
    olya,
    nikita,
    balanced: balancedRows,
    score,
    value,
    start,
    minute,
    buckets: buildAnalyticsBuckets(rows),
    categories: buildAnalyticsCategories(rows),
  };

  const tableColumns = {
    cheap: baseColumns,
    expensive: baseColumns,
    olya: baseColumns,
    nikita: baseColumns,
    balanced: [...baseColumns, { label: 'Баланс' }],
    score: [...baseColumns, { label: 'Оценка' }],
    value: [...baseColumns, { label: 'Оценка' }],
    start: [...baseColumns, { label: 'Стартовый платёж' }],
    minute: [...baseColumns, { label: '₽/мин пути' }],
    buckets: [
      { label: 'Группа' },
      { label: 'Маршрут' },
      { label: 'Кол-во' },
      { label: 'Средняя аренда' },
      { label: 'Медиана' },
    ],
    categories: [
      { label: 'Тип' },
      { label: 'Категория' },
      { label: 'Кол-во' },
      { label: 'Средняя аренда' },
      { label: 'Медиана аренды' },
      { label: 'Средний вход' },
      { label: 'Средняя разница' },
    ],
  };

  const tableHighlights = { cheap: 8, expensive: 8, olya: 10, nikita: 10, balanced: 10, score: 10, value: 10, start: 10, minute: 10 };

  return {
    timeKeys,
    olyaKey,
    nikitaKey,
    fastLimit,
    rows,
    metrics,
    insights,
    tableRows,
    tableColumns,
    tableHighlights,
    periodLabel,
  };
}

function buildAnalyticsBuckets(rows) {
  const groups = [
    ['до 60 мин', (row, key) => row[key] <= 60],
    ['60-90 мин', (row, key) => row[key] > 60 && row[key] <= 90],
    ['90-120 мин', (row, key) => row[key] > 90 && row[key] <= 120],
    ['больше 120 мин', (row, key) => row[key] > 120 && Number.isFinite(row[key])],
  ];
  const keys = [
    ['Оля', 'olya'],
    ['Никита', 'nikita'],
    ['Оба маршрута', 'both'],
  ];
  const result = [];
  groups.forEach((group) => {
    keys.forEach((key) => {
      const list = key[1] === 'both'
        ? rows.filter((row) => group[1](row, 'olya') && group[1](row, 'nikita'))
        : rows.filter((row) => group[1](row, key[1]));
      result.push({
        group: group[0],
        route: key[0],
        count: list.length,
        avg: average(list.map((row) => row.rent)),
        median: median(list.map((row) => row.rent)),
      });
    });
  });
  return result;
}

function buildAnalyticsCategories(rows) {
  const categories = [];
  const addCategoryRows = (title, field) => {
    [...new Set(rows.map((row) => row[field]))].sort((a, b) => String(a).localeCompare(String(b), 'ru')).forEach((name) => {
      const list = rows.filter((row) => row[field] === name);
      categories.push({
        type: title,
        name,
        count: list.length,
        avg: average(list.map((row) => row.rent)),
        median: median(list.map((row) => row.rent)),
        avgStart: average(list.map((row) => row.startPayment)),
        avgDiff: average(list.map((row) => row.diffTime)),
      });
    });
  };
  addCategoryRows('Баланс', 'balanceType');
  addCategoryRows('Стартовый платёж', 'moveInCostCategory');
  return categories.sort((a, b) => a.type.localeCompare(b.type, 'ru') || b.count - a.count);
}

function getListingUrl(item) {
  const value = item?.url || item?.URL || item?.link || item?.href || item?.avitoUrl || '';
  if (typeof value !== 'string') return '';
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `https://www.avito.ru${value}`;
  return value;
}

function resolveUrl(value, baseUrl) {
  if (!value || typeof value !== 'string') return '';

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return '';
  }
}

function extractImageFromHtml(html, baseUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /"image"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/i,
    /"imageUrl"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return resolveUrl(match[1].replaceAll('\\/', '/'), baseUrl);
    }
  }

  return '';
}

async function fetchPreviewImage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  return extractImageFromHtml(html, response.url || url);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handlePreviewImages(req, res) {
  const body = await readBody(req);
  const payload = JSON.parse(body || '{}');
  const items = Array.isArray(payload.items) ? payload.items : [];
  const limit = Math.max(1, Math.min(Number(payload.limit || 40), 80));
  const delayMs = Math.max(0, Math.min(Number(payload.delayMs || IMAGE_FETCH_DELAY_MS), 30000));
  const urls = [...new Set(items.map(getListingUrl).filter(Boolean))].slice(0, limit);
  const results = {};

  for (const [index, url] of urls.entries()) {
    try {
      results[url] = await fetchPreviewImage(url);
    } catch {
      results[url] = '';
    }
    if (index < urls.length - 1 && delayMs > 0) {
      await delay(delayMs);
    }
  }

  jsonResponse(res, 200, { results });
}

function unwrapItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.result)) return value.result;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  throw new Error('JSON должен быть массивом или объектом с result/items/data.');
}

function getAdminKey(req) {
  return String(req.headers['x-admin-key'] || '').trim();
}

function ensureAdmin(req) {
  if (!ADMIN_KEY) {
    const error = new Error('На сервере не задан ANALYTICS_ADMIN_KEY. Сохранение отключено.');
    error.status = 403;
    throw error;
  }

  if (getAdminKey(req) !== ADMIN_KEY) {
    const error = new Error('Неверный ключ панели управления.');
    error.status = 401;
    throw error;
  }
}

async function readSavedAnalyticsData() {
  try {
    const text = await readFile(ANALYTICS_DATA_FILE, 'utf8');
    const payload = JSON.parse(text);
    const items = unwrapItems(payload);
    return {
      items,
      updatedAt: typeof payload?.updatedAt === 'string' ? payload.updatedAt : null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { items: [], updatedAt: null };
    throw error;
  }
}

async function handleGetAnalyticsData(req, res) {
  const saved = await readSavedAnalyticsData();
  jsonResponse(res, 200, {
    items: saved.items,
    count: saved.items.length,
    updatedAt: saved.updatedAt,
  });
}

async function handleSaveAnalyticsData(req, res) {
  ensureAdmin(req);
  const body = await readBody(req);
  const payload = JSON.parse(body || '{}');
  const items = unwrapItems(payload);
  const saved = {
    updatedAt: new Date().toISOString(),
    count: items.length,
    items,
  };

  await writeFile(ANALYTICS_DATA_FILE, JSON.stringify(saved, null, 2), 'utf8');
  jsonResponse(res, 200, {
    ok: true,
    count: items.length,
    updatedAt: saved.updatedAt,
  });
}

async function handleFilterPreview(req, res) {
  const payload = await readJsonPayload(req);
  const text = typeof payload === 'string' ? payload : String(payload?.text ?? '');
  const fileName = typeof payload === 'object' && payload?.fileName ? String(payload.fileName) : 'objects.json';
  const items = readFilterItemsFromText(text);
  const timeKeys = detectFilterTimeKeys(items);

  jsonResponse(res, 200, {
    ok: true,
    fileName,
    items,
    count: items.length,
    timeKeys,
    timeLimits: buildDefaultTimeLimits(timeKeys),
  });
}

async function handleFilterRun(req, res) {
  const payload = await readJsonPayload(req);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const sortMode = payload?.sortMode === 'price' ? 'price' : 'time';
  const excludeTerms = Array.isArray(payload?.excludeTerms)
    ? payload.excludeTerms.map((term) => String(term ?? '').trim().toLowerCase()).filter(Boolean)
    : parseTerms(payload?.excludeTitle ?? '');
  const timeKeys = Array.isArray(payload?.timeKeys) ? payload.timeKeys.filter(Boolean) : detectFilterTimeKeys(items);
  const timeLimits = normalizeTimeLimits(payload?.timeLimits, timeKeys);
  const visibleItems = applyFilterServer(items, { timeKeys, timeLimits, excludeTerms, sortMode });

  jsonResponse(res, 200, {
    ok: true,
    items,
    count: items.length,
    visibleItems,
    visibleCount: visibleItems.length,
    timeKeys,
    timeLimits,
    excludeTerms,
    sortMode,
    statusText: buildFilterStatusText(timeKeys, timeLimits, excludeTerms, visibleItems.length, items.length),
  });
}

async function handleAnalyticsRun(req, res) {
  const payload = await readJsonPayload(req);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const fastLimit = Number.isFinite(Number(payload?.fastLimit)) ? Number(payload.fastLimit) : 90;
  const timeKeys = Array.isArray(payload?.timeKeys) && payload.timeKeys.length
    ? payload.timeKeys.filter(Boolean)
    : detectAnalyticsTimeKeys(items);
  const olyaKey = chooseAnalyticsKey(payload?.olyaKey, timeKeys, /оли|ol/i);
  const nikitaKey = chooseAnalyticsKey(payload?.nikitaKey, timeKeys, /родина|никит|nik/i);
  const analytics = buildAnalyticsView(items, { olyaKey, nikitaKey, fastLimit, timeKeys });

  jsonResponse(res, 200, {
    ok: true,
    items,
    timeKeys: analytics.timeKeys,
    selectedKeys: { olyaKey: analytics.olyaKey, nikitaKey: analytics.nikitaKey },
    fastLimit: analytics.fastLimit,
    ...analytics,
  });
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
      grid-template-columns: 1.4fr 0.95fr 0.75fr auto auto auto auto auto auto;
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

    .time-filters {
      display: none;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
      padding: 12px;
      border: 1px solid rgba(110, 168, 255, 0.14);
      border-radius: var(--radius);
      background: var(--panel-soft);
      box-shadow: var(--shadow);
    }

    .time-filters.visible {
      display: grid;
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
    .status.busy {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--accent);
    }

    .status.busy::before {
      content: '';
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 2px solid rgba(110, 168, 255, 0.28);
      border-top-color: var(--accent);
      animation: statusSpin 0.8s linear infinite;
      flex: 0 0 auto;
    }

    @keyframes statusSpin {
      to { transform: rotate(360deg); }
    }

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
      grid-template-columns: 180px minmax(0, 1fr);
      gap: 8px;
      padding: 12px 14px;
      border: 1px solid rgba(110, 168, 255, 0.13);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(18,25,42,0.96), rgba(13,19,31,0.96));
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.26);
      transition: transform 150ms ease, box-shadow 150ms ease, border-color 150ms ease;
    }

    .card-photo {
      width: 100%;
      aspect-ratio: 4 / 3;
      border: 1px solid rgba(110, 168, 255, 0.13);
      border-radius: 12px;
      overflow: hidden;
      background: rgba(7, 11, 20, 0.72);
      display: grid;
      place-items: center;
      color: var(--muted);
      font-size: 12px;
      text-align: center;
      align-self: start;
    }

    .card-photo img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
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

    @media (max-width: 620px) {
      .hero { padding: 14px; }
      .panel-head { align-items: flex-start; flex-direction: column; }
      .button, .download-btn { width: 100%; }
      .card {
        grid-template-columns: 120px minmax(0, 1fr);
        padding: 10px;
      }
      .price { font-size: 18px; }
      .description { -webkit-line-clamp: 2; }
      .time-row { padding: 8px; }
    }

    @media (max-width: 430px) {
      .card { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="app">
    <section class="hero">
      <h1>Avito Transit</h1>
      <p>Загрузи JSON-файл, получи ленту карточек объявлений и отфильтруй их по времени в пути. Карточка показывает фото, название, цену, адрес, описание и ссылку на открытие объявления.</p>
      <div style="margin-top:12px;">
        <a class="button" href="/merge" style="display:inline-flex; text-decoration:none;">Объединить JSON</a>
        <a class="button" href="/costs" style="display:inline-flex; text-decoration:none; margin-left:8px;">Расходы за 3 месяца</a>
        <a class="button" href="/analytics" style="display:inline-flex; text-decoration:none; margin-left:8px;">Аналитика</a>
      </div>
    </section>

    <section class="toolbar">
      <label class="field">
        JSON-файл
        <input id="fileInput" type="file" accept=".json,application/json">
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
      <button id="imageButton" class="button" type="button" disabled>Найти фото</button>
      <button id="downloadUrlsButton" class="download-btn" type="button" disabled>Ссылки</button>
      <button id="downloadButton" class="download-btn" type="button" disabled>Скачать JSON</button>
    </section>

    <section id="timeFilters" class="time-filters" aria-label="Фильтры по полям времени"></section>

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
    const ignoredTimeKeyNames = new Set([
      'address', 'adress', 'адрес', 'description', 'desc', 'описание', 'dop',
      'title', 'name', 'название', 'price', 'цена', 'url', 'link', 'href', 'avitourl',
    ]);

    const els = {
      fileInput: document.querySelector('#fileInput'),
      excludeTitle: document.querySelector('#excludeTitle'),
      sortMode: document.querySelector('#sortMode'),
      showButton: document.querySelector('#showButton'),
      filterButton: document.querySelector('#filterButton'),
      resetButton: document.querySelector('#resetButton'),
      imageButton: document.querySelector('#imageButton'),
      downloadUrlsButton: document.querySelector('#downloadUrlsButton'),
      downloadButton: document.querySelector('#downloadButton'),
      timeFilters: document.querySelector('#timeFilters'),
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
      timeLimits: {},
      excludeTerms: [],
      sortMode: 'time',
      imageCache: new Map(),
      imageLoading: false,
      isBusy: false,
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

    function displayText(value) {
      const text = String(value ?? '');
      if (!/[РС][\u0400-\u04ff]/.test(text)) return text;

      try {
        const bytes = [];
        for (const char of text) {
          const code = char.codePointAt(0);
          const byte = windows1251Byte(code);
          if (byte === null) return text;
          bytes.push(byte);
        }

        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
        return decoded.includes('\uFFFD') ? text : decoded;
      } catch {
        return text;
      }
    }

    function windows1251Byte(code) {
      if (code <= 0x7f) return code;
      if (code === 0x0401) return 0xa8;
      if (code === 0x0451) return 0xb8;
      if (code >= 0x0410 && code <= 0x044f) return code - 0x0350;

      const extra = {
        0x0402: 0x80, 0x0403: 0x81, 0x201a: 0x82, 0x0453: 0x83,
        0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
        0x20ac: 0x88, 0x2030: 0x89, 0x0409: 0x8a, 0x2039: 0x8b,
        0x040a: 0x8c, 0x040c: 0x8d, 0x040b: 0x8e, 0x040f: 0x8f,
        0x0452: 0x90, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
        0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
        0x2122: 0x99, 0x0459: 0x9a, 0x203a: 0x9b, 0x045a: 0x9c,
        0x045c: 0x9d, 0x045b: 0x9e, 0x045f: 0x9f, 0x00a0: 0xa0,
        0x040e: 0xa1, 0x045e: 0xa2, 0x0408: 0xa3, 0x00a4: 0xa4,
        0x0490: 0xa5, 0x00a6: 0xa6, 0x00a7: 0xa7, 0x00a9: 0xa9,
        0x0404: 0xaa, 0x00ab: 0xab, 0x00ac: 0xac, 0x00ad: 0xad,
        0x00ae: 0xae, 0x0407: 0xaf, 0x00b0: 0xb0, 0x00b1: 0xb1,
        0x0406: 0xb2, 0x0456: 0xb3, 0x0491: 0xb4, 0x00b5: 0xb5,
        0x00b6: 0xb6, 0x00b7: 0xb7, 0x2116: 0xb9, 0x0454: 0xba,
        0x00bb: 0xbb, 0x0458: 0xbc, 0x0405: 0xbd, 0x0455: 0xbe,
        0x0457: 0xbf,
      };

      return extra[code] ?? null;
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
      els.resultStatus.classList.remove('ok', 'warn', 'bad', 'busy');
      if (tone !== 'info') els.resultStatus.classList.add(tone);
    }

    function nextPaint() {
      return new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }

    function setBusyState(text) {
      state.isBusy = true;
      setStatus(text, 'busy');
      updateActionsState();
    }

    function clearBusyState() {
      state.isBusy = false;
      updateActionsState();
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

      const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:ч|час|С‡|С‡Р°СЃ)/);
      const minuteMatch = text.match(/(\d+)\s*(?:мин|м\b|РјРёРЅ|Рј\b)/);
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

    function isCompactTimeValue(value) {
      if (!isTimeValue(value)) return false;
      if (typeof value === 'number') return true;

      const text = String(value ?? '').trim();
      if (!text) return false;

      const words = text.split(/\s+/).filter(Boolean);
      return text.length <= 32 && words.length <= 6;
    }

    function canAutoDetectTimeKey(key) {
      const normalized = String(key ?? '').trim();
      if (!normalized) return false;
      if (preferredTimeKeys.includes(normalized)) return true;
      if (ignoredTimeKeyNames.has(normalized.toLowerCase())) return false;
      return /время|маршрут|дорог|путь|работ|родин|ол|никит|time|route/i.test(normalized);
    }

    function detectTimeKeys(items) {
      const keys = new Set(items.flatMap((item) => Object.keys(item)));
      const preferred = preferredTimeKeys.filter((key) => keys.has(key));
      if (preferred.length) return preferred;

      const detected = [...keys].filter((key) => {
        if (!canAutoDetectTimeKey(key)) return false;
        const values = items
          .map((item) => item[key])
          .filter((value) => value !== undefined && value !== null);
        return values.length > 0 && values.some((value) => {
          if (typeof value === 'number' && !preferredTimeKeys.includes(key)) return false;
          return isCompactTimeValue(value);
        });
      });

      return [...new Set([...preferred, ...detected])];
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

    function getImageCandidate(value) {
      if (!value) return '';
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) {
        for (const entry of value) {
          const candidate = getImageCandidate(entry);
          if (candidate) return candidate;
        }
      }
      if (typeof value === 'object') {
        return value.url || value.src || value.href || value.imageUrl || value.preview || '';
      }
      return '';
    }

    function getImageUrl(item) {
      const directKeys = ['image', 'imageUrl', 'img', 'photo', 'photoUrl', 'preview', 'thumbnail', 'cover'];
      const arrayKeys = ['images', 'imageUrls', 'photos', 'photoUrls', 'pictures'];

      for (const key of directKeys) {
        const candidate = getImageCandidate(item[key]);
        if (candidate) return candidate;
      }

      for (const key of arrayKeys) {
        const candidate = getImageCandidate(item[key]);
        if (candidate) return candidate;
      }

      return state.imageCache.get(getLink(item)) || '';
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
      const value = item.url || item.URL || item.link || item.href || item.avitoUrl || '';
      if (typeof value !== 'string') return '';
      if (value.startsWith('//')) return 'https:' + value;
      if (value.startsWith('/')) return 'https://www.avito.ru' + value;
      return value;
    }

    function collectUrls(items) {
      return [...new Set(items.map(getLink).filter(Boolean))];
    }

    function getDefaultTimeLimit() {
      return 60;
    }

    function syncTimeLimits() {
      const next = {};
      const defaultLimit = getDefaultTimeLimit();
      for (const key of state.timeKeys) {
        const current = Number(state.timeLimits[key]);
        next[key] = Number.isFinite(current) && current > 0 ? current : defaultLimit;
      }
      state.timeLimits = next;
    }

    function renderTimeFilters() {
      syncTimeLimits();
      els.timeFilters.classList.toggle('visible', state.timeKeys.length > 0);

      if (!state.timeKeys.length) {
        els.timeFilters.innerHTML = '';
        return;
      }

      els.timeFilters.innerHTML = state.timeKeys.map((key, index) => (
        '<label class="field">' +
          esc(displayText(key)) +
          '<input class="time-limit-input" data-time-index="' + index + '" type="number" min="1" step="1" value="' + esc(state.timeLimits[key]) + '">' +
        '</label>'
      )).join('');
    }

    function readTimeLimitsFromInputs() {
      els.timeFilters.querySelectorAll('.time-limit-input').forEach((input) => {
        const key = state.timeKeys[Number(input.dataset.timeIndex)];
        if (!key) return;
        state.timeLimits[key] = Number(input.value || 0);
      });
    }

    function getInvalidTimeLimits() {
      readTimeLimitsFromInputs();
      return state.timeKeys.filter((key) => {
        const limit = Number(state.timeLimits[key]);
        return !Number.isFinite(limit) || limit <= 0;
      });
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
      const hasUrls = collectUrls(state.visibleItems).length > 0;
      const locked = state.isBusy;
      els.fileInput.disabled = locked;
      els.excludeTitle.disabled = locked;
      els.sortMode.disabled = locked;
      els.showButton.disabled = locked;
      els.filterButton.disabled = locked || !hasItems || !state.timeKeys.length;
      els.resetButton.disabled = locked || !hasItems;
      els.imageButton.disabled = locked || !hasUrls || state.imageLoading;
      els.downloadUrlsButton.disabled = locked || !hasUrls;
      els.downloadUrlsButton.classList.toggle('disabled', locked || !hasUrls);
      els.downloadButton.disabled = locked || !hasVisible;
      els.downloadButton.classList.toggle('disabled', locked || !hasVisible);
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

    function downloadUrlsFile() {
      const urls = collectUrls(state.visibleItems);
      if (!urls.length) {
        setStatus('Ссылок для скачивания нет.', 'warn');
        log('Скачивание ссылок не выполнено: url не найдены.', 'warn');
        return;
      }

      const blob = new Blob([urls.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      anchor.href = url;
      anchor.download = (state.fileName ? state.fileName.replace(/\.json$/i, '') : 'filtered') + '-urls-' + stamp + '.txt';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('Ссылки скачаны: ' + urls.length + '.', 'ok');
      log('Ссылки экспортированы: ' + urls.length + '.', 'ok');
    }

    function readItemsFromText(text) {
      const parsed = unwrapJson(JSON.parse(text));
      if (!parsed.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
        throw new Error('В массиве должны быть только объекты объявлений.');
      }
      return parsed;
    }

    function applyFilter(items) {
      let filtered = items;
      if (state.timeKeys.length) {
        filtered = filtered.filter((item) => state.timeKeys.every((key) => {
          const limit = Number(state.timeLimits[key]);
          return parseTransitMinutes(item[key]) <= limit;
        }));
      }
      filtered = applyExclusions(filtered);
      return filtered;
    }

    function updateSummary() {
      els.fileName.textContent = state.fileName || 'не выбран';
      els.countInfo.textContent = String(state.visibleItems.length);
      els.timeInfo.textContent = state.timeKeys.length ? state.timeKeys.map(displayText).join(', ') : 'нет';
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

      const timeKeys = state.timeKeys;
      els.feed.className = 'feed';
      els.feed.innerHTML = ordered.map((item) => {
        const title = displayText(getTitle(item));
        const price = displayText(getPrice(item));
        const address = displayText(getAddress(item));
        const description = displayText(getDescription(item));
        const link = getLink(item);
        const imageUrl = getImageUrl(item);
        const imageMarkup = imageUrl
          ? '<div class="card-photo"><img src="' + esc(imageUrl) + '" alt="' + esc(title) + '" loading="lazy" referrerpolicy="no-referrer"></div>'
          : '<div class="card-photo">Фото пока нет</div>';
        const titleMarkup = link
          ? '<a class="title" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + '</a>'
          : '<div class="title">' + esc(title) + '</div>';
        const timeMarkup = timeKeys.length
          ? '<div class="time-row">' +
              timeKeys.map((key) => '<span class="time-pill">' + esc(displayText(key)) + ': ' + esc(displayText(item[key] ?? '')) + '</span>').join('') +
            '</div>'
          : '';
        const linkMarkup = link
          ? '<a class="link-btn" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Открыть</a>'
          : '<span class="link-btn disabled">Ссылка не найдена</span>';

        return [
          '<article class="card">',
            imageMarkup,
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
      renderTimeFilters();
      state.sortMode = els.sortMode.value;
      state.visibleItems = items.slice();
      updateSummary();
      renderCards(items);
      updateActionsState();
      const timeText = state.timeKeys.length ? 'Найдены поля времени: ' + state.timeKeys.map(displayText).join(', ') : 'Поля времени не найдены';
      setStatus('Загружено объектов: ' + items.length + '. ' + timeText, state.timeKeys.length ? 'ok' : 'warn');
      log('JSON распарсен: ' + items.length + ' объектов.', 'ok');
      log(timeText + '.', state.timeKeys.length ? 'ok' : 'warn');
    }

    async function loadPreviewImages(options = {}) {
      const urls = collectUrls(state.visibleItems);
      if (!urls.length) {
        if (!options.silent) setStatus('Ссылок для поиска фото нет.', 'warn');
        return;
      }

      const missingItems = state.visibleItems.filter((item) => getLink(item) && !getImageUrl(item));
      if (!missingItems.length) {
        if (!options.silent) {
          setStatus('Фото уже есть для текущих карточек.', 'ok');
          log('Поиск фото не нужен: в текущем списке уже есть изображения.', 'ok');
        }
        return;
      }

      state.imageLoading = true;
      updateActionsState();
      if (!options.silent) setStatus('Ищу фото по ссылкам Avito...', 'ok');
      log('Поиск фото по url: ' + missingItems.length + ' объявлений.', 'info');

      try {
        const response = await fetch('/api/preview-images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: missingItems, limit: 80 }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось получить фото.');

        let found = 0;
        Object.entries(data.results || {}).forEach(([url, imageUrl]) => {
          if (imageUrl) {
            state.imageCache.set(url, imageUrl);
            found += 1;
          }
        });

        renderCards(state.visibleItems);
        setStatus('Фото найдено: ' + found + ' из ' + missingItems.length + '.', found ? 'ok' : 'warn');
        log('Поиск фото завершён: найдено ' + found + ' из ' + missingItems.length + '.', found ? 'ok' : 'warn');
      } catch (error) {
        const message = error?.message || String(error);
        setStatus('Фото не удалось получить: ' + message, 'warn');
        log('Ошибка поиска фото: ' + message, 'warn');
      } finally {
        state.imageLoading = false;
        updateActionsState();
      }
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

    function handleFilter(options = {}) {
      state.excludeTerms = parseTerms(els.excludeTitle.value);
      if (!state.allItems.length) {
        setStatus('Сначала загрузи JSON.', 'warn');
        log('Фильтр не применён: данных ещё нет.', 'warn');
        return;
      }

      if (!state.timeKeys.length) {
        setStatus('Поля времени не найдены.', 'warn');
        log('Фильтр не применён: поля времени не найдены.', 'warn');
        return;
      }

      const invalidTimeKeys = getInvalidTimeLimits();
      if (invalidTimeKeys.length) {
        const names = invalidTimeKeys.map(displayText).join(', ');
        setStatus('Проверь лимиты времени для полей: ' + names, 'bad');
        log('Фильтр не применён: неверные лимиты для полей ' + names + '.', 'warn');
        return;
      }

      const filtered = applyFilter(state.allItems);
      state.visibleItems = filtered;
      state.sortMode = els.sortMode.value;
      renderCards(filtered);
      updateSummary();
      updateActionsState();
      const excludedText = state.excludeTerms.length ? ' исключения: ' + state.excludeTerms.join(', ') : '';
      const limitText = state.timeKeys
        .map((key) => displayText(key) + ' до ' + state.timeLimits[key] + ' мин')
        .join(', ');
      setStatus('Фильтр: ' + limitText + excludedText + ': ' + filtered.length + ' из ' + state.allItems.length, 'ok');
      log('Фильтр применён: ' + limitText + excludedText + ', осталось ' + filtered.length + ' из ' + state.allItems.length, 'ok');
      if (options.fetchImages) {
        void loadPreviewImages({ silent: true });
      }
    }

    function handleReset() {
      if (!state.allItems.length) return;
      state.visibleItems = state.allItems.slice();
      state.sortMode = els.sortMode.value;
      renderTimeFilters();
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

    async function loadFilterPreviewFromServer(text, fileName) {
      setBusyState('Обрабатываю файл и считаю карточки...');
      await nextPaint();

      try {
        const response = await fetch('/api/filter-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, fileName }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось разобрать JSON на сервере.');

        state.rawText = text;
        state.fileName = data.fileName || fileName || '';
        state.allItems = Array.isArray(data.items) ? data.items : [];
        state.timeKeys = Array.isArray(data.timeKeys) ? data.timeKeys : [];
        state.timeLimits = data.timeLimits || {};
        state.excludeTerms = parseTerms(els.excludeTitle.value);
        renderTimeFilters();
        state.sortMode = els.sortMode.value;
        state.visibleItems = state.allItems.slice();
        renderCards(state.visibleItems);
        updateSummary();
        updateActionsState();
        const timeText = state.timeKeys.length ? 'Найдены поля времени: ' + state.timeKeys.map(displayText).join(', ') : 'Поля времени не найдены';
        setStatus('Готово: ' + state.allItems.length + ' объектов. ' + timeText, state.timeKeys.length ? 'ok' : 'warn');
        log('JSON распарсен сервером: ' + state.allItems.length + ' объектов.', 'ok');
        log(timeText + '.', state.timeKeys.length ? 'ok' : 'warn');
      } finally {
        clearBusyState();
      }
    }

    async function runFilterOnServer() {
      if (!state.allItems.length) {
        setStatus('Сначала загрузи JSON.', 'warn');
        log('Фильтр не применён: данных ещё нет.', 'warn');
        return;
      }

      readTimeLimitsFromInputs();
      const invalidTimeKeys = getInvalidTimeLimits();
      if (invalidTimeKeys.length) {
        const names = invalidTimeKeys.map(displayText).join(', ');
        setStatus('Проверь лимиты времени для полей: ' + names, 'bad');
        log('Фильтр не применён: неверные лимиты для полей ' + names + '.', 'warn');
        return;
      }

      setBusyState('Считаю подходящие карточки...');
      await nextPaint();

      try {
        const response = await fetch('/api/filter-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: state.allItems,
            timeKeys: state.timeKeys,
            timeLimits: state.timeLimits,
            excludeTerms: parseTerms(els.excludeTitle.value),
            sortMode: els.sortMode.value,
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось отфильтровать данные.');

        state.visibleItems = Array.isArray(data.visibleItems) ? data.visibleItems : [];
        state.sortMode = data.sortMode || els.sortMode.value;
        renderCards(state.visibleItems);
        updateSummary();
        updateActionsState();
        setStatus(data.statusText || ('Фильтр: ' + state.visibleItems.length + ' из ' + state.allItems.length), 'ok');
        log('Фильтр применён на сервере: осталось ' + state.visibleItems.length + ' из ' + state.allItems.length, 'ok');
      } finally {
        clearBusyState();
      }
    }

    async function handleFileInput() {
      const file = els.fileInput.files?.[0];
      if (!file) return;

      try {
        log('Выбран файл: ' + file.name + ' (' + file.size + ' байт).', 'info');
        setBusyState('Читаю файл...');
        await nextPaint();
        const text = await file.text();
        setBusyState('Файл прочитан. Отправляю на сервер и считаю карточки...');
        await nextPaint();
        await loadFilterPreviewFromServer(text, file.name);
      } catch (error) {
        const message = error?.message || String(error);
        setStatus('Не удалось прочитать файл: ' + message, 'bad');
        log('Ошибка чтения файла: ' + message, 'bad');
        clearBusyState();
      }
    }

    async function handleShow() {
      if (!state.rawText) {
        const file = els.fileInput.files?.[0];
        if (file) {
          await handleFileInput();
          return;
        }
        setStatus('Сначала выбери JSON-файл.', 'warn');
        log('Нажата кнопка "Показать карточки", но файл не выбран.', 'warn');
        return;
      }

      try {
        await loadFilterPreviewFromServer(state.rawText, state.fileName || 'текущий JSON');
      } catch (error) {
        const message = error?.message || String(error);
        setStatus('JSON не загружен: ' + message, 'bad');
        log('Ошибка загрузки JSON: ' + message, 'bad');
      }
    }

    async function handleFilter(options = {}) {
      try {
        await runFilterOnServer();
        if (options.fetchImages) {
          void loadPreviewImages({ silent: true });
        }
      } catch (error) {
        const message = error?.message || String(error);
        setStatus('Фильтр не применён: ' + message, 'bad');
        log('Ошибка фильтрации: ' + message, 'bad');
      }
    }

    function handleReset() {
      if (!state.allItems.length) return;
      state.visibleItems = state.allItems.slice();
      state.sortMode = els.sortMode.value;
      renderTimeFilters();
      renderCards(state.visibleItems);
      updateSummary();
      updateActionsState();
      setStatus('Показаны все объекты: ' + state.allItems.length, 'ok');
      log('Сброс фильтра, показаны все объекты.', 'info');
    }

    els.fileInput.addEventListener('change', handleFileInput);
    els.showButton.addEventListener('click', handleShow);
    els.filterButton.addEventListener('click', () => handleFilter({ fetchImages: true }));
    els.resetButton.addEventListener('click', handleReset);
    els.imageButton.addEventListener('click', () => loadPreviewImages());
    els.downloadUrlsButton.addEventListener('click', downloadUrlsFile);
    els.downloadButton.addEventListener('click', downloadJsonFile);
    els.clearLogs.addEventListener('click', clearLogs);
    els.sortMode.addEventListener('change', () => {
      state.sortMode = els.sortMode.value;
      if (!state.allItems.length) return;
      void handleFilter();
      log('Сортировка изменена на "' + els.sortMode.value + '".', 'info');
    });
    els.excludeTitle.addEventListener('change', () => {
      if (state.allItems.length) void handleFilter();
    });
    els.excludeTitle.addEventListener('keyup', (event) => {
      if (event.key === 'Enter' && state.allItems.length) void handleFilter();
    });
    els.timeFilters.addEventListener('input', (event) => {
      if (!event.target.classList.contains('time-limit-input')) return;
      readTimeLimitsFromInputs();
      if (state.allItems.length) void handleFilter();
    });

    log('Интерфейс готов.', 'ok');
    renderLogs();
    updateActionsState();
  </script>
</body>
</html>`;

const analyticsPage = String.raw`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Аналитика аренды</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #080a10;
      --panel: rgba(18, 21, 30, 0.94);
      --panel-strong: #171b26;
      --text: #f3f6fb;
      --muted: #a9b1c0;
      --line: #2a3140;
      --accent: #7cc7a8;
      --accent-2: #f1bd6b;
      --accent-3: #89a7ff;
      --bad: #ff8585;
      --warn: #ffd36e;
      --shadow: 0 24px 60px rgba(0, 0, 0, 0.42);
      --radius: 14px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at 18% 0%, rgba(124, 199, 168, 0.18), transparent 28%),
        radial-gradient(circle at 82% 8%, rgba(241, 189, 107, 0.12), transparent 24%),
        linear-gradient(180deg, #080a10 0%, #111520 100%);
      font-family: Inter, "Segoe UI", Arial, sans-serif;
    }
    button, input, select, textarea { font: inherit; }
    .app { width: min(1380px, calc(100vw - 24px)); margin: 0 auto; padding: 18px 0 26px; }
    .hero, .panel, .toolbar, .metric, .insight {
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: var(--radius);
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .hero { padding: 18px 20px; margin-bottom: 14px; background: linear-gradient(180deg, rgba(26,31,43,0.96), rgba(16,20,29,0.96)); }
    .hero-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 30px; line-height: 1.05; }
    p { margin: 8px 0 0; max-width: 980px; color: var(--muted); line-height: 1.5; }
    .nav { display: flex; gap: 8px; flex-wrap: wrap; }
    .link-btn, .action-btn {
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 40px; padding: 0 13px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.1); background: #202637;
      color: var(--text); text-decoration: none; font-weight: 800; white-space: nowrap; cursor: pointer;
    }
    .action-btn.primary { background: var(--accent); color: #07120e; border-color: var(--accent); }
    .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .toolbar { display: grid; grid-template-columns: 1fr 1fr 170px 170px auto auto; gap: 12px; align-items: end; padding: 14px; margin-bottom: 14px; }
    .field { display: grid; gap: 6px; color: #d8dfeb; font-size: 13px; font-weight: 750; }
    input, select, textarea {
      width: 100%; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;
      background: #101520; color: var(--text); outline: none;
    }
    input, select { min-height: 40px; padding: 0 11px; }
    input[type="file"] { padding: 8px 10px; color: var(--muted); }
    textarea { min-height: 150px; padding: 12px; resize: vertical; font: 12px/1.5 "Cascadia Code", Consolas, monospace; }
    input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,199,168,0.15); }
    .json-box { margin-bottom: 14px; }
    .metrics { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
    .metric { min-height: 96px; padding: 13px; display: grid; align-content: space-between; }
    .metric span { color: var(--muted); font-size: 12px; font-weight: 750; }
    .metric strong { font-size: 22px; line-height: 1; letter-spacing: 0; }
    .metric em { color: var(--accent-2); font-style: normal; font-size: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
    .panel { overflow: hidden; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; background: var(--panel-strong); border-bottom: 1px solid var(--line); }
    .panel-title { font-size: 15px; font-weight: 900; }
    .panel-meta { display: grid; gap: 4px; justify-items: end; text-align: right; }
    .stage {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 0 9px;
      border-radius: 999px;
      background: rgba(137, 167, 255, 0.14);
      color: #dfe6ff;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .stage.ok { background: rgba(124, 199, 168, 0.16); color: #d5ffe9; }
    .stage.warn { background: rgba(255, 211, 110, 0.16); color: #ffe6a3; }
    .stage.bad { background: rgba(255, 133, 133, 0.16); color: #ffd0d0; }
    .status { color: var(--muted); font-size: 13px; }
    .panel-body { padding: 12px; }
    .insights { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
    .insight { padding: 13px; min-height: 130px; }
    .insight b { display: block; margin-bottom: 8px; font-size: 13px; }
    .insight div { color: var(--muted); font-size: 12px; line-height: 1.45; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 9px; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: left; vertical-align: top; font-size: 13px; }
    th { color: #dce5f2; background: rgba(255,255,255,0.03); font-size: 12px; }
    .money { color: var(--accent-2); font-weight: 900; white-space: nowrap; }
    .time { color: var(--accent); font-weight: 900; white-space: nowrap; }
    .muted { color: var(--muted); font-size: 12px; line-height: 1.4; }
    .title { color: var(--text); text-decoration: none; font-weight: 800; }
    .title:hover { color: var(--accent); text-decoration: underline; }
    .listing-cell {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .thumb {
      flex: 0 0 auto;
      width: 82px;
      height: 60px;
      border-radius: 11px;
      overflow: hidden;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      display: grid;
      place-items: center;
      color: var(--muted);
      font-size: 11px;
      text-align: center;
    }
    .thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .listing-copy {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .fav-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      margin-left: auto;
      border: 1px solid rgba(255, 133, 133, 0.22);
      border-radius: 10px;
      background: rgba(255, 133, 133, 0.08);
      color: #ffc7c7;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      flex: 0 0 auto;
    }
    .fav-btn.active {
      background: rgba(255, 133, 133, 0.18);
      border-color: rgba(255, 133, 133, 0.42);
      color: #ff8d8d;
    }
    .fav-btn:hover {
      background: rgba(255, 133, 133, 0.14);
    }
    .row-actions {
      margin-left: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 0 0 auto;
    }
    .issue-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border: 1px solid rgba(242, 195, 107, 0.24);
      border-radius: 10px;
      background: rgba(242, 195, 107, 0.09);
      color: #ffd36e;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      flex: 0 0 auto;
    }
    .issue-btn.active {
      background: rgba(242, 195, 107, 0.2);
      border-color: rgba(242, 195, 107, 0.5);
      color: #ffe08f;
    }
    .issue-btn:hover {
      background: rgba(242, 195, 107, 0.15);
    }
    .fav-row td {
      background: rgba(255, 133, 133, 0.04);
    }
    .fav-panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .fav-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .badge { display: inline-flex; min-height: 24px; align-items: center; padding: 0 8px; border-radius: 999px; background: rgba(137,167,255,0.14); color: #dfe6ff; font-size: 12px; font-weight: 800; }
    .viewed-row td { background: rgba(255, 255, 255, 0.02); opacity: 0.76; }
    .fresh-row td { background: rgba(124, 199, 168, 0.045); }
    .favorite-row td { background: rgba(255, 133, 133, 0.07); }
    .issue-row td { background: rgba(242, 195, 107, 0.06); }
    .top-row td { background: rgba(124, 199, 168, 0.09); }
    .top-tag {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      margin: 0 7px 5px 0;
      padding: 0 7px;
      border-radius: 999px;
      background: rgba(124, 199, 168, 0.16);
      color: #c8ffe9;
      font-size: 11px;
      font-weight: 900;
      vertical-align: middle;
    }
    .table-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding-top: 10px;
      color: var(--muted);
      font-size: 12px;
    }
    .small-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 34px;
      padding: 0 11px;
      border: 1px solid rgba(124, 199, 168, 0.24);
      border-radius: 10px;
      background: rgba(124, 199, 168, 0.11);
      color: #dfffee;
      font-weight: 850;
      cursor: pointer;
      white-space: nowrap;
    }
    .small-btn:hover { border-color: rgba(124, 199, 168, 0.48); background: rgba(124, 199, 168, 0.16); }
    .full-view.hidden, .analytics-section.hidden { display: none; }
    .empty { min-height: 170px; display: grid; place-items: center; color: var(--muted); text-align: center; }
    .method { display: grid; gap: 8px; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .method strong { color: var(--text); }
    @media (max-width: 1120px) {
      .toolbar, .grid { grid-template-columns: 1fr; }
      .metrics, .insights { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 620px) {
      .app { width: min(100vw - 16px, 760px); padding-top: 10px; }
      h1 { font-size: 24px; }
      .metrics, .insights { grid-template-columns: 1fr; }
      .panel-body { overflow-x: auto; }
      table { min-width: 720px; }
    }
  </style>
</head>
<body>
  <main class="app">
    <section class="hero">
      <div class="hero-top">
        <div>
          <h1>Аналитика аренды</h1>
          <p>Загрузи JSON с объявлениями и получи разбор рынка: средняя и медианная цена, дешёвые и дорогие варианты, полная стоимость въезда, время до Оли, время до Никиты и сбалансированные варианты.</p>
        </div>
        <nav class="nav">
          <a class="link-btn" href="/">Фильтр</a>
          <a class="link-btn" href="/costs">Расходы</a>
          <a class="link-btn" href="/merge">Объединить JSON</a>
          <a class="link-btn" href="/analytics-admin">Панель</a>
        </nav>
      </div>
    </section>

    <section class="toolbar">
      <label class="field">JSON-файл <input id="fileInput" type="file" accept=".json,application/json"></label>
      <label class="field">Порог быстрых вариантов, мин <input id="fastLimit" type="number" min="10" max="300" step="5" value="90"></label>
      <label class="field">Поле Оли <select id="olyaKey"></select></label>
      <label class="field">Поле Никиты <select id="nikitaKey"></select></label>
      <button id="analyzeBtn" class="action-btn primary" type="button">Построить</button>
      <button id="imageButton" class="action-btn" type="button">Фото объявлений</button>
    </section>

    <section class="panel json-box">
      <div class="panel-head">
        <div class="panel-title">JSON вручную</div>
        <div class="panel-meta">
          <div id="stage" class="stage">Готово</div>
          <div id="status" class="status">Можно загрузить файл или вставить массив объектов сюда</div>
        </div>
      </div>
      <div class="panel-body">
        <textarea id="jsonInput" placeholder='[{"title":"2-к. квартира","rent_per_month":45000,"Родина":"1 ч 43 мин","работа Оли":"2 ч 17 мин"}]'></textarea>
      </div>
    </section>

    <section class="metrics" id="metrics"></section>
    <section class="insights" id="insights"></section>

    <section class="panel full-view hidden" id="fullView">
      <div class="panel-head">
        <div>
          <div class="panel-title" id="fullTitle">Все варианты</div>
          <div class="status" id="fullStatus"></div>
        </div>
        <button class="small-btn" id="backToAnalytics" type="button">Назад к аналитике</button>
      </div>
      <div class="panel-body" id="fullTable"></div>
    </section>

    <section class="grid analytics-section">
      <section class="panel">
        <div class="panel-head"><div class="panel-title">Самые дешёвые</div><div class="status">по стоимости за 3 месяца</div></div>
        <div class="panel-body" id="cheapTable"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><div class="panel-title">Самые дорогие</div><div class="status">по аренде в месяц</div></div>
        <div class="panel-body" id="expensiveTable"></div>
      </section>
    </section>

    <section class="grid analytics-section">
      <section class="panel">
        <div class="panel-head"><div class="panel-title">Быстрее всего до Оли</div><div id="olyaAvg" class="status"></div></div>
        <div class="panel-body" id="olyaTable"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><div class="panel-title">Быстрее всего до Никиты</div><div id="nikitaAvg" class="status"></div></div>
        <div class="panel-body" id="nikitaTable"></div>
      </section>
    </section>

    <section class="grid analytics-section">
      <section class="panel">
        <div class="panel-head"><div class="panel-title">Золотая середина</div><div id="balancedAvg" class="status"></div></div>
        <div class="panel-body" id="balancedTable"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><div class="panel-title">Градация по времени</div><div class="status">средняя стоимость в группах</div></div>
        <div class="panel-body" id="bucketsTable"></div>
      </section>
    </section>

    <section class="grid analytics-section">
      <section class="panel">
        <div class="panel-head"><div class="panel-title">Оценка 0-100</div><div id="scoreAvg" class="status"></div></div>
        <div class="panel-body" id="scoreTable"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><div class="panel-title">Минимальная цена за м²</div><div id="valueAvg" class="status"></div></div>
        <div class="panel-body" id="valueTable"></div>
      </section>
    </section>

    <section class="grid analytics-section">
      <section class="panel">
        <div class="panel-head"><div class="panel-title">Самый дешёвый вход</div><div id="startAvg" class="status"></div></div>
        <div class="panel-body" id="startTable"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><div class="panel-title">Минимум ₽ за минуту пути</div><div id="minuteAvg" class="status"></div></div>
        <div class="panel-body" id="minuteTable"></div>
      </section>
    </section>

    <section class="grid analytics-section">
      <section class="panel">
        <div class="panel-head"><div class="panel-title">Типы баланса и входа</div><div class="status">сводка категорий</div></div>
        <div class="panel-body" id="categoryTable"></div>
      </section>
    </section>

    <section class="panel analytics-section" id="favoritesPanel">
      <div class="panel-head">
        <div class="fav-panel-head">
          <div>
            <div class="panel-title">Понравившиеся</div>
            <div id="favoritesStatus" class="status">Избранные варианты сохраняются в браузере</div>
          </div>
          <div class="fav-actions">
            <button id="downloadFavoritesBtn" class="small-btn" type="button">Скачать избранное JSON</button>
            <span class="badge">Сохранено: <span id="favoritesCount" style="margin-left:6px;">0</span></span>
          </div>
        </div>
      </div>
      <div class="panel-body" id="favoriteTable"></div>
    </section>

    <section class="panel analytics-section" id="commuteIssuesPanel">
      <div class="panel-head">
        <div class="fav-panel-head">
          <div>
            <div class="panel-title">Проверить время в пути</div>
            <div id="commuteIssuesStatus" class="status">Отмечай объекты, где указанное время не совпало с картами</div>
          </div>
          <div class="fav-actions">
            <button id="downloadCommuteIssuesBtn" class="small-btn" type="button">Скачать список JSON</button>
            <span class="badge">Сохранено: <span id="commuteIssuesCount" style="margin-left:6px;">0</span></span>
          </div>
        </div>
      </div>
      <div class="panel-body" id="commuteIssuesTable"></div>
    </section>

    <section class="panel analytics-section">
      <div class="panel-head"><div class="panel-title">Что учитывается в анализе</div><div class="status">методика</div></div>
      <div class="panel-body method">
        <div><strong>Медиана</strong> показывает типичную цену устойчивее среднего, потому что дорогие выбросы сильно тянут среднее вверх.</div>
        <div><strong>Полная стоимость</strong> важна рядом с месячной арендой: залог и комиссия могут сделать дешёвый объект дорогим на входе.</div>
        <div><strong>Цена за м²</strong> помогает сравнивать разные площади, а время до двух адресов показывает реальную бытовую стоимость локации.</div>
        <div><strong>Дополнительные рейтинги</strong> строятся только по числам: цена за м², стартовый платёж, среднее время и разница между маршрутами.</div>
      </div>
    </section>
  </main>

  <script>
    const els = {
      fileInput: document.querySelector('#fileInput'),
      jsonInput: document.querySelector('#jsonInput'),
      analyzeBtn: document.querySelector('#analyzeBtn'),
      fastLimit: document.querySelector('#fastLimit'),
      olyaKey: document.querySelector('#olyaKey'),
      nikitaKey: document.querySelector('#nikitaKey'),
      stage: document.querySelector('#stage'),
      status: document.querySelector('#status'),
      imageButton: document.querySelector('#imageButton'),
      metrics: document.querySelector('#metrics'),
      insights: document.querySelector('#insights'),
      cheapTable: document.querySelector('#cheapTable'),
      expensiveTable: document.querySelector('#expensiveTable'),
      olyaTable: document.querySelector('#olyaTable'),
      nikitaTable: document.querySelector('#nikitaTable'),
      balancedTable: document.querySelector('#balancedTable'),
      bucketsTable: document.querySelector('#bucketsTable'),
      scoreTable: document.querySelector('#scoreTable'),
      valueTable: document.querySelector('#valueTable'),
      startTable: document.querySelector('#startTable'),
      minuteTable: document.querySelector('#minuteTable'),
      categoryTable: document.querySelector('#categoryTable'),
      favoriteTable: document.querySelector('#favoriteTable'),
      favoritesPanel: document.querySelector('#favoritesPanel'),
      favoritesStatus: document.querySelector('#favoritesStatus'),
      favoritesCount: document.querySelector('#favoritesCount'),
      downloadFavoritesBtn: document.querySelector('#downloadFavoritesBtn'),
      commuteIssuesTable: document.querySelector('#commuteIssuesTable'),
      commuteIssuesPanel: document.querySelector('#commuteIssuesPanel'),
      commuteIssuesStatus: document.querySelector('#commuteIssuesStatus'),
      commuteIssuesCount: document.querySelector('#commuteIssuesCount'),
      downloadCommuteIssuesBtn: document.querySelector('#downloadCommuteIssuesBtn'),
      olyaAvg: document.querySelector('#olyaAvg'),
      nikitaAvg: document.querySelector('#nikitaAvg'),
      balancedAvg: document.querySelector('#balancedAvg'),
      scoreAvg: document.querySelector('#scoreAvg'),
      valueAvg: document.querySelector('#valueAvg'),
      startAvg: document.querySelector('#startAvg'),
      minuteAvg: document.querySelector('#minuteAvg'),
      fullView: document.querySelector('#fullView'),
      fullTitle: document.querySelector('#fullTitle'),
      fullStatus: document.querySelector('#fullStatus'),
      fullTable: document.querySelector('#fullTable'),
      backToAnalytics: document.querySelector('#backToAnalytics'),
    };

    const PREVIEW_LIMIT = 15;
    const FAVORITES_STORAGE_KEY = 'analytics-favorites-v1';
    const VIEWED_STORAGE_KEY = 'analytics-viewed-v1';
    const COMMUTE_ISSUES_STORAGE_KEY = 'analytics-commute-issues-v1';

    const tableTitles = {
      cheap: 'Все самые дешёвые варианты',
      expensive: 'Все самые дорогие варианты',
      olya: 'Все варианты по времени до Оли',
      nikita: 'Все варианты по времени до Никиты',
      balanced: 'Все варианты золотой середины',
      score: 'Все варианты по среднему времени',
      value: 'Все варианты по цене за м²',
      start: 'Все варианты по стоимости заселения',
      minute: 'Все варианты по ₽ за минуту пути',
    };

    const state = {
      items: [],
      rows: [],
      timeKeys: [],
      tableRows: {},
      tableColumns: {},
      tableHighlights: {},
      analyticsView: null,
      openTableKey: null,
      imageCache: new Map(),
      imageLoading: false,
      favoriteKeys: loadStoredKeys(FAVORITES_STORAGE_KEY),
      viewedKeys: loadStoredKeys(VIEWED_STORAGE_KEY),
      commuteIssueKeys: loadStoredKeys(COMMUTE_ISSUES_STORAGE_KEY),
    };

    function loadStoredKeys(storageKey) {
      try {
        const raw = localStorage.getItem(storageKey);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.map((value) => String(value)).filter(Boolean) : [];
      } catch {
        return [];
      }
    }

    function saveStoredKeys(storageKey, keys) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(keys));
      } catch {
        // localStorage может быть недоступен в приватном режиме.
      }
    }

    function esc(value) {
      return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    }

    function rub(value) {
      const number = Number(value || 0);
      return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(number)) + ' ₽';
    }

    function minutesText(value) {
      if (!Number.isFinite(value)) return 'нет';
      const hours = Math.floor(value / 60);
      const minutes = value % 60;
      return (hours ? hours + ' ч ' : '') + minutes + ' мин';
    }

    function unwrapJson(value) {
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.result)) return value.result;
      if (Array.isArray(value?.items)) return value.items;
      if (Array.isArray(value?.data)) return value.data;
      throw new Error('JSON должен быть массивом или объектом с result/items/data.');
    }

    function parseMoney(value) {
      if (typeof value === 'number') return value;
      const text = String(value ?? '').replace(/\s+/g, ' ');
      const match = text.match(/(\d[\d\s.,]*)/);
      if (!match) return 0;
      return Number(match[1].replace(/[^\d]/g, '')) || 0;
    }

    function parseArea(item) {
      const text = [item?.title, item?.name, item?.description].filter(Boolean).join(' ');
      const match = text.match(/(\d+(?:[,.]\d+)?)\s*м[²2]/i);
      return match ? Number(match[1].replace(',', '.')) : 0;
    }

    function parseRooms(item) {
      const text = [item?.title, item?.name].filter(Boolean).join(' ').toLowerCase();
      const studio = /студ/.test(text);
      if (studio) return 0;
      const match = text.match(/(\d+)\s*[- ]?\s*(?:к|комн)/i);
      return match ? Number(match[1]) : null;
    }

    function parseFloorInfo(item) {
      const text = [item?.title, item?.name].filter(Boolean).join(' ');
      const match = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:эт|этаж)/i);
      if (!match) return { floor: null, totalFloors: null, category: 'этаж не найден' };
      const floor = Number(match[1]);
      const totalFloors = Number(match[2]);
      let category = 'средний этаж';
      if (floor === totalFloors) category = 'последний этаж';
      else if (floor <= 3) category = 'низкий этаж';
      else if (totalFloors && floor / totalFloors >= 0.7) category = 'высокий этаж';
      return { floor, totalFloors, category };
    }

    function areaCategory(area) {
      if (!area) return 'площадь не найдена';
      if (area < 35) return 'маленькая';
      if (area < 45) return 'нормальная';
      if (area < 60) return 'просторная';
      return 'большая';
    }

    function parseTime(value) {
      if (typeof value === 'number') return value;
      const text = String(value ?? '').toLowerCase();
      if (!text.trim()) return Infinity;
      let total = 0;
      const day = text.match(/(\d+)\s*(?:д|дн|день|дня)/);
      const hour = text.match(/(\d+)\s*(?:ч|час|часа|часов|h)/);
      const min = text.match(/(\d+)\s*(?:м|мин|minute|min)/);
      if (day) total += Number(day[1]) * 1440;
      if (hour) total += Number(hour[1]) * 60;
      if (min) total += Number(min[1]);
      if (!total) {
        const onlyNumber = text.match(/^\s*(\d+)\s*$/);
        if (onlyNumber) total = Number(onlyNumber[1]);
      }
      return total || Infinity;
    }

    function getTitle(item) {
      return String(item?.title ?? item?.name ?? item?.название ?? 'Без названия');
    }

    function getAddress(item) {
      return String(item?.adress ?? item?.address ?? item?.адрес ?? '');
    }

    function getUrl(item) {
      return String(item?.url ?? item?.link ?? item?.href ?? '');
    }

    function getFavoriteKey(row) {
      const item = row?.item || row;
      if (!item || typeof item !== 'object') return '';
      return String(
        item.url ||
        item.URL ||
        item.link ||
        item.href ||
        row?.url ||
        [item.title, item.adress || item.address || item['адрес'], item.rent_per_month || item.price || row?.rent].filter(Boolean).join('|')
      ).trim();
    }

    function encodeKey(key) {
      return encodeURIComponent(String(key ?? ''));
    }

    function decodeKey(key) {
      try {
        return decodeURIComponent(String(key ?? ''));
      } catch {
        return String(key ?? '');
      }
    }

    function isFavoriteRow(row) {
      const key = getFavoriteKey(row);
      return key ? state.favoriteKeys.includes(key) : false;
    }

    function isViewedRow(row) {
      const key = getFavoriteKey(row);
      return key ? state.viewedKeys.includes(key) : false;
    }

    function isCommuteIssueRow(row) {
      const key = getFavoriteKey(row);
      return key ? state.commuteIssueKeys.includes(key) : false;
    }

    function markViewedRow(row) {
      const key = getFavoriteKey(row);
      if (!key || state.viewedKeys.includes(key)) return;
      state.viewedKeys = [...state.viewedKeys, key];
      saveStoredKeys(VIEWED_STORAGE_KEY, state.viewedKeys);
    }

    function toggleFavoriteRow(row) {
      const key = getFavoriteKey(row);
      if (!key) return;
      if (state.favoriteKeys.includes(key)) {
        state.favoriteKeys = state.favoriteKeys.filter((value) => value !== key);
      } else {
        state.favoriteKeys = [...state.favoriteKeys, key];
      }
      saveStoredKeys(FAVORITES_STORAGE_KEY, state.favoriteKeys);
      renderTables();
      renderBuckets();
      if (state.openTableKey) {
        const rows = state.tableRows[state.openTableKey] || [];
        const columns = buildAnalyticsColumns(state.openTableKey);
        renderTable(els.fullTable, rows, columns, state.tableHighlights[state.openTableKey] || 0, { getRowClass });
      }
    }

    function toggleCommuteIssueRow(row) {
      const key = getFavoriteKey(row);
      if (!key) return;
      if (state.commuteIssueKeys.includes(key)) {
        state.commuteIssueKeys = state.commuteIssueKeys.filter((value) => value !== key);
      } else {
        state.commuteIssueKeys = [...state.commuteIssueKeys, key];
      }
      saveStoredKeys(COMMUTE_ISSUES_STORAGE_KEY, state.commuteIssueKeys);
      renderTables();
      renderBuckets();
      renderFavorites();
      renderCommuteIssues();
      if (state.openTableKey) {
        const rows = state.tableRows[state.openTableKey] || [];
        const columns = buildAnalyticsColumns(state.openTableKey);
        renderTable(els.fullTable, rows, columns, state.tableHighlights[state.openTableKey] || 0, { getRowClass });
      }
    }

    function getListingUrl(item) {
      const value = item?.url || item?.URL || item?.link || item?.href || item?.avitoUrl || '';
      if (typeof value !== 'string') return '';
      if (value.startsWith('//')) return 'https:' + value;
      if (value.startsWith('/')) return 'https://www.avito.ru' + value;
      return value;
    }

    function getImageCandidate(value) {
      if (!value) return '';
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) {
        for (const entry of value) {
          const candidate = getImageCandidate(entry);
          if (candidate) return candidate;
        }
      }
      if (typeof value === 'object') {
        return value.url || value.src || value.href || value.imageUrl || value.preview || '';
      }
      return '';
    }

    function getImageUrl(row) {
      const item = row?.item || row;
      if (!item || typeof item !== 'object') return '';

      const directKeys = ['image', 'imageUrl', 'img', 'photo', 'photoUrl', 'preview', 'thumbnail', 'cover'];
      const arrayKeys = ['images', 'imageUrls', 'photos', 'photoUrls', 'pictures'];

      for (const key of directKeys) {
        const candidate = getImageCandidate(item[key]);
        if (candidate) return candidate;
      }

      for (const key of arrayKeys) {
        const candidate = getImageCandidate(item[key]);
        if (candidate) return candidate;
      }

      const link = getListingUrl(item);
      return link ? state.imageCache.get(link) || '' : '';
    }

    function getRowClass(row) {
      const classes = [];
      if (isFavoriteRow(row)) classes.push('favorite-row');
      if (isCommuteIssueRow(row)) classes.push('issue-row');
      classes.push(isViewedRow(row) ? 'viewed-row' : 'fresh-row');
      return classes.join(' ');
    }

    function getRent(item) {
      return Number(item?.rent_per_month) || parseMoney(item?.price) || parseMoney(item?.rent) || 0;
    }

    function getMonths(item) {
      const months = Number(item?.months);
      return Number.isFinite(months) && months > 0 ? months : 3;
    }

    function getTotal(item, rent, months) {
      const total = Number(item?.total_for_period);
      if (Number.isFinite(total) && total > 0) return total;

      const partsTotal = Number(item?.rent_for_period || 0) + Number(item?.commission || 0) + Number(item?.deposit || 0);
      if (Number.isFinite(partsTotal) && partsTotal > 0) return partsTotal;

      return rent * months;
    }

    function getCommission(item) {
      const commission = Number(item?.commission);
      if (Number.isFinite(commission) && commission >= 0) return commission;
      const percent = Number(item?.commission_percent);
      const rent = getRent(item);
      if (Number.isFinite(percent) && percent > 0 && rent > 0) return rent * percent / 100;
      return 0;
    }

    function getDeposit(item) {
      const deposit = Number(item?.deposit);
      return Number.isFinite(deposit) && deposit > 0 ? deposit : 0;
    }

    function moveInCategory(startPayment, rent) {
      if (!rent) return 'нет данных';
      if (startPayment <= rent * 1.5) return 'дешёвый вход';
      if (startPayment <= rent * 2.5) return 'средний вход';
      return 'дорогой вход';
    }

    function balanceType(olya, nikita) {
      if (!Number.isFinite(olya) || !Number.isFinite(nikita)) return 'нет данных';
      const diff = Math.abs(olya - nikita);
      if (diff === 0) return 'одинаково';
      const side = olya < nikita ? 'Оле быстрее' : 'Никите быстрее';
      if (diff <= 15) return 'почти одинаково, ' + side;
      if (diff <= 30) return 'разница 16-30 мин, ' + side;
      if (diff <= 60) return 'разница 31-60 мин, ' + side;
      return 'разница больше 60 мин, ' + side;
    }

    function getPeriodLabel(rows) {
      const months = [...new Set(rows.map((row) => row.months).filter(Boolean))];
      if (months.length === 1) return 'за ' + months[0] + ' мес.';
      return 'за период';
    }

    function detectTimeKeys(items) {
      const ignored = new Set([
        'title', 'name', 'название', 'adress', 'address', 'адрес', 'price', 'цена',
        'url', 'link', 'href', 'description', 'dop', 'image', 'months',
        'rent_per_month', 'rent_for_period', 'commission_percent', 'commission',
        'deposit', 'total_for_period',
      ]);
      const keys = [];
      items.slice(0, 80).forEach((item) => {
        Object.keys(item || {}).forEach((key) => {
          const lower = key.toLowerCase();
          if (ignored.has(lower) || keys.includes(key)) return;
          const value = item[key];
          const text = String(value ?? '').toLowerCase();
          const looksLikeRoute = /время|маршрут|дорог|путь|работ|родин|оли|никит|time|route/.test(lower);
          const looksLikeDuration = /(\d+\s*(ч|час|мин|м\b|h|min))/.test(text);
          if ((looksLikeRoute || looksLikeDuration) && Number.isFinite(parseTime(value))) {
            if (typeof value === 'number' && !looksLikeRoute) return;
            keys.push(key);
          }
        });
      });
      return keys.sort((a, b) => {
        const score = (key) => /оли|ol/i.test(key) ? -2 : /родина|никит|nik/i.test(key) ? -1 : 0;
        return score(a) - score(b) || a.localeCompare(b, 'ru');
      });
    }

    function average(values) {
      const good = values.filter((value) => Number.isFinite(value));
      return good.length ? good.reduce((sum, value) => sum + value, 0) / good.length : 0;
    }

    function median(values) {
      const good = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
      if (!good.length) return 0;
      const mid = Math.floor(good.length / 2);
      return good.length % 2 ? good[mid] : (good[mid - 1] + good[mid]) / 2;
    }

    function percentile(values, ratio) {
      const good = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
      if (!good.length) return 0;
      return good[Math.min(good.length - 1, Math.floor((good.length - 1) * ratio))];
    }

    function scoreLower(value, best, worst) {
      if (!Number.isFinite(value)) return null;
      if (!Number.isFinite(best) || !Number.isFinite(worst) || best === worst) return 100;
      return Math.round(Math.max(0, Math.min(100, 100 - ((value - best) / (worst - best)) * 100)));
    }

    function scoreHigher(value, best, worst) {
      if (!Number.isFinite(value) || !value) return null;
      if (!Number.isFinite(best) || !Number.isFinite(worst) || best === worst) return 100;
      return Math.round(Math.max(0, Math.min(100, ((value - best) / (worst - best)) * 100)));
    }

    function avgScore(values) {
      const good = values.filter((value) => Number.isFinite(value));
      return good.length ? Math.round(good.reduce((sum, value) => sum + value, 0) / good.length) : 0;
    }

    function gradeLabel(score) {
      if (score >= 85) return 'отлично';
      if (score >= 70) return 'хорошо';
      if (score >= 50) return 'нормально';
      if (score >= 30) return 'слабо';
      return 'плохо';
    }

    function prepareRows() {
      const olyaKey = els.olyaKey.value;
      const nikitaKey = els.nikitaKey.value;
      const baseRows = state.items.map((item, index) => {
        const rent = getRent(item);
        const months = getMonths(item);
        const total = getTotal(item, rent, months);
        const area = parseArea(item);
        const rooms = parseRooms(item);
        const floorInfo = parseFloorInfo(item);
        const olya = parseTime(item[olyaKey]);
        const nikita = parseTime(item[nikitaKey]);
        const avgCommute = Number.isFinite(olya) && Number.isFinite(nikita) ? (olya + nikita) / 2 : Infinity;
        const maxCommute = Math.max(olya, nikita);
        const diffTime = Math.abs(olya - nikita);
        const commission = getCommission(item);
        const deposit = getDeposit(item);
        const startPayment = rent + commission + deposit;
        const priceM2 = area ? rent / area : 0;
        const dailyRent = rent / 30;
        const rubPerCommuteMin = Number.isFinite(avgCommute) && avgCommute > 0 ? rent / avgCommute : 0;
        return {
          index, item, title: getTitle(item), address: getAddress(item), url: getUrl(item),
          rent, total, months, area, rooms, floor: floorInfo.floor, totalFloors: floorInfo.totalFloors,
          floorCategory: floorInfo.category, areaCategory: areaCategory(area),
          commission, deposit, startPayment, overpaymentPercent: rent ? startPayment / rent * 100 : 0,
          moveInCostCategory: moveInCategory(startPayment, rent),
          priceM2, dailyRent, rubPerCommuteMin, olya, nikita, avgCommute, maxCommute, diffTime,
          balanceType: balanceType(olya, nikita),
        };
      }).filter((row) => row.rent > 0);
      const ranges = {
        rentMin: Math.min(...baseRows.map((row) => row.rent)),
        rentMax: Math.max(...baseRows.map((row) => row.rent)),
        priceM2Min: Math.min(...baseRows.map((row) => row.priceM2).filter(Boolean)),
        priceM2Max: Math.max(...baseRows.map((row) => row.priceM2).filter(Boolean)),
        avgMin: Math.min(...baseRows.map((row) => row.avgCommute).filter(Number.isFinite)),
        avgMax: Math.max(...baseRows.map((row) => row.avgCommute).filter(Number.isFinite)),
        diffMin: Math.min(...baseRows.map((row) => row.diffTime).filter(Number.isFinite)),
        diffMax: Math.max(...baseRows.map((row) => row.diffTime).filter(Number.isFinite)),
        areaMin: Math.min(...baseRows.map((row) => row.area).filter(Boolean)),
        areaMax: Math.max(...baseRows.map((row) => row.area).filter(Boolean)),
        startMin: Math.min(...baseRows.map((row) => row.startPayment).filter(Number.isFinite)),
        startMax: Math.max(...baseRows.map((row) => row.startPayment).filter(Number.isFinite)),
      };

      state.rows = baseRows.map((row) => {
        const rentScore = scoreLower(row.rent, ranges.rentMin, ranges.rentMax);
        const priceM2Score = row.priceM2 ? scoreLower(row.priceM2, ranges.priceM2Min, ranges.priceM2Max) : null;
        const commuteScore = scoreLower(row.avgCommute, ranges.avgMin, ranges.avgMax);
        const balanceScore = scoreLower(row.diffTime, ranges.diffMin, ranges.diffMax);
        const areaScore = row.area ? scoreHigher(row.area, ranges.areaMin, ranges.areaMax) : null;
        const startPaymentScore = scoreLower(row.startPayment, ranges.startMin, ranges.startMax);
        const finalScore = avgScore([rentScore, priceM2Score, commuteScore, balanceScore, areaScore, startPaymentScore]);

        return {
          ...row,
          rentScore,
          priceM2Score,
          commuteScore,
          balanceScore,
          areaScore,
          startPaymentScore,
          finalScore,
          grade: gradeLabel(finalScore),
        };
      });
    }

    function setStatus(text, tone) {
      els.status.textContent = text;
      els.status.style.color = tone === 'ok' ? 'var(--accent)' : tone === 'warn' ? 'var(--warn)' : 'var(--muted)';
    }

    function setStage(text, tone = 'info') {
      els.stage.textContent = text;
      els.stage.className = 'stage' + (tone === 'info' ? '' : ' ' + tone);
    }

    function fillTimeSelects() {
      const options = state.timeKeys.map((key) => '<option value="' + esc(key) + '">' + esc(key) + '</option>').join('');
      els.olyaKey.innerHTML = options;
      els.nikitaKey.innerHTML = options;
      const olya = state.timeKeys.find((key) => /оли|ol/i.test(key)) || state.timeKeys[1] || state.timeKeys[0] || '';
      const nikita = state.timeKeys.find((key) => /родина|никит|nik/i.test(key)) || state.timeKeys[0] || olya;
      els.olyaKey.value = olya;
      els.nikitaKey.value = nikita;
    }

    function renderMetrics() {
      const rents = state.rows.map((row) => row.rent);
      const totals = state.rows.map((row) => row.total);
      const m2 = state.rows.map((row) => row.priceM2).filter(Boolean);
      const startPayments = state.rows.map((row) => row.startPayment);
      const olyaTimes = state.rows.map((row) => row.olya);
      const nikitaTimes = state.rows.map((row) => row.nikita);
      const avgTimes = state.rows.map((row) => row.avgCommute);
      const diffTimes = state.rows.map((row) => row.diffTime);
      const rubPerMinute = state.rows.map((row) => row.rubPerCommuteMin).filter(Boolean);
      const fastLimit = Number(els.fastLimit.value || 90);
      const fastBoth = state.rows.filter((row) => row.olya <= fastLimit && row.nikita <= fastLimit);
      const periodLabel = getPeriodLabel(state.rows);
      const values = [
        ['Объектов', state.rows.length, 'с распознанной ценой'],
        ['Средняя аренда', rub(average(rents)), 'средняя цена всех объектов'],
        ['Медианная аренда', rub(median(rents)), 'типичная цена рынка'],
        ['Минимум / максимум', rub(Math.min(...rents)) + ' / ' + rub(Math.max(...rents)), 'по месячной аренде'],
        ['Средняя цена за м²', m2.length ? rub(average(m2)) : 'нет данных', 'если площадь найдена в названии'],
        ['Медиана цены за м²', m2.length ? rub(median(m2)) : 'нет данных', 'типичная цена за метр'],
        ['Средний стартовый платёж', rub(average(startPayments)), '1 месяц + комиссия + залог'],
        ['Среднее до Оли', minutesText(Math.round(average(olyaTimes))), 'по всем объектам с временем'],
        ['Среднее до Никиты', minutesText(Math.round(average(nikitaTimes))), 'по всем объектам с временем'],
        ['Среднее для двоих', minutesText(Math.round(average(avgTimes))), 'среднее двух маршрутов'],
        ['Средняя разница', minutesText(Math.round(average(diffTimes))), 'насколько маршруты отличаются'],
        ['Среднее ₽/мин пути', rubPerMinute.length ? rub(average(rubPerMinute)) : 'нет данных', 'аренда / среднее время'],
        ['Медиана ₽/мин пути', rubPerMinute.length ? rub(median(rubPerMinute)) : 'нет данных', 'типичное значение'],
        ['Быстрые для обоих', fastBoth.length, 'до ' + fastLimit + ' мин каждому'],
        ['Медиана итого ' + periodLabel, rub(median(totals)), 'аренда + комиссия + залог'],
        ['Порог дорогих вариантов', rub(percentile(rents, 0.9)), 'примерно 10% объявлений дороже'],
      ];
      els.metrics.innerHTML = values.map((item) => '<article class="metric"><span>' + esc(item[0]) + '</span><strong>' + esc(item[1]) + '</strong><em>' + esc(item[2]) + '</em></article>').join('');
    }

    function renderInsights() {
      const rows = state.rows;
      const cheapest = rows.slice().sort((a, b) => a.total - b.total || a.rent - b.rent)[0];
      const expensive = rows.slice().sort((a, b) => b.rent - a.rent)[0];
      const quickestOlya = rows.filter((row) => Number.isFinite(row.olya)).sort((a, b) => a.olya - b.olya)[0];
      const balanced = rows.filter((row) => Number.isFinite(row.avgCommute)).sort((a, b) => a.diffTime - b.diffTime || a.avgCommute - b.avgCommute)[0];
      const blocks = [
        ['Самый дешёвый', cheapest ? rub(cheapest.total) + '<br>' + esc(cheapest.title) : 'нет данных'],
        ['Самый дорогой', expensive ? rub(expensive.rent) + '<br>' + esc(expensive.title) : 'нет данных'],
        ['Самый быстрый до Оли', quickestOlya ? minutesText(quickestOlya.olya) + '<br>' + rub(quickestOlya.rent) : 'нет данных'],
        ['Минимальная разница', balanced ? minutesText(balanced.olya) + ' / ' + minutesText(balanced.nikita) + '<br>разница ' + minutesText(balanced.diffTime) : 'нет данных'],
      ];
      els.insights.innerHTML = blocks.map((block) => '<article class="insight"><b>' + esc(block[0]) + '</b><div>' + block[1] + '</div></article>').join('');
    }

    function listingCell(row) {
      const imageUrl = getImageUrl(row);
      const favoriteKey = getFavoriteKey(row);
      const favoriteActive = favoriteKey && state.favoriteKeys.includes(favoriteKey);
      const issueActive = favoriteKey && state.commuteIssueKeys.includes(favoriteKey);
      const title = row.url
        ? '<a class="title js-viewed-link" data-view-key="' + esc(encodeKey(favoriteKey)) + '" href="' + esc(row.url) + '" target="_blank" rel="noopener noreferrer">' + esc(row.title) + '</a>'
        : '<span class="title">' + esc(row.title) + '</span>';
      const thumb = imageUrl
        ? '<div class="thumb"><img src="' + esc(imageUrl) + '" alt="' + esc(row.title) + '" loading="lazy" referrerpolicy="no-referrer"></div>'
        : '<div class="thumb">Фото</div>';
      return '<div class="listing-cell">' +
        thumb +
        '<div class="listing-copy">' +
          title +
          (row.address ? '<div class="muted">' + esc(row.address) + '</div>' : '') +
        '</div>' +
        '<div class="row-actions">' +
          '<button class="fav-btn js-fav-toggle' + (favoriteActive ? ' active' : '') + '" type="button" data-favorite-key="' + esc(encodeKey(favoriteKey)) + '" title="' + (favoriteActive ? 'Убрать из понравившихся' : 'Добавить в понравившиеся') + '" aria-label="' + (favoriteActive ? 'Убрать из понравившихся' : 'Добавить в понравившиеся') + '">' + (favoriteActive ? '♥' : '♡') + '</button>' +
          '<button class="issue-btn js-issue-toggle' + (issueActive ? ' active' : '') + '" type="button" data-issue-key="' + esc(encodeKey(favoriteKey)) + '" title="' + (issueActive ? 'Убрать отметку о несовпадении времени' : 'Отметить, что время не совпало') + '" aria-label="' + (issueActive ? 'Убрать отметку о несовпадении времени' : 'Отметить, что время не совпало') + '">⚠</button>' +
        '</div>' +
      '</div>';
    }

    function renderTable(target, rows, columns, highlightCount = 0, options = {}) {
      if (!rows.length) {
        target.innerHTML = '<div class="empty">Нет данных для этого блока.</div>';
        return;
      }
      const visibleRows = options.limit ? rows.slice(0, options.limit) : rows;
      target.innerHTML = '<table><thead><tr>' + columns.map((col) => '<th>' + esc(col.label) + '</th>').join('') + '</tr></thead><tbody>' +
        visibleRows.map((row, index) => {
          const isTop = index < highlightCount;
          const extraClass = options.getRowClass ? String(options.getRowClass(row, index) || '').trim() : '';
          const rowClass = [isTop ? 'top-row' : '', extraClass].filter(Boolean).join(' ');
          return '<tr' + (rowClass ? ' class="' + esc(rowClass) + '"' : '') + '>' + columns.map((col, columnIndex) => {
            const tag = isTop && columnIndex === 0 ? '<span class="top-tag">Топ-' + (index + 1) + '</span>' : '';
            return '<td>' + tag + col.render(row, index) + '</td>';
          }).join('') + '</tr>';
        }).join('') +
        '</tbody></table>' +
        (options.tableKey && rows.length > visibleRows.length
          ? '<div class="table-footer"><span>Показано ' + visibleRows.length + ' из ' + rows.length + '</span><button class="small-btn js-open-table" type="button" data-table="' + esc(options.tableKey) + '">Смотреть все</button></div>'
          : '');
    }

    function renderTables() {
      const periodLabel = getPeriodLabel(state.rows);
      const baseColumns = [
        { label: 'Объект', render: listingCell },
        { label: 'Аренда', render: (row) => '<span class="money">' + rub(row.rent) + '</span>' },
        { label: 'Цена за м²', render: (row) => row.priceM2 ? '<span class="money">' + rub(row.priceM2) + '</span>' : '<span class="muted">нет площади</span>' },
        { label: 'Итого ' + periodLabel, render: (row) => '<span class="money">' + rub(row.total) + '</span>' + (periodLabel === 'за период' ? '<div class="muted">' + esc(row.months) + ' мес.</div>' : '') },
        { label: 'До Оли', render: (row) => '<span class="time">' + minutesText(row.olya) + '</span>' },
        { label: 'До Никиты', render: (row) => '<span class="time">' + minutesText(row.nikita) + '</span>' },
      ];
      const cheap = state.rows.slice().sort((a, b) => a.total - b.total || a.rent - b.rent);
      const expensive = state.rows.slice().sort((a, b) => b.rent - a.rent);
      const olya = state.rows.filter((row) => Number.isFinite(row.olya)).sort((a, b) => a.olya - b.olya || a.rent - b.rent);
      const nikita = state.rows.filter((row) => Number.isFinite(row.nikita)).sort((a, b) => a.nikita - b.nikita || a.rent - b.rent);
      const balanced = state.rows.filter((row) => Number.isFinite(row.avgCommute)).sort((a, b) => a.diffTime - b.diffTime || a.avgCommute - b.avgCommute || a.rent - b.rent);
      const score = state.rows.slice().sort((a, b) => b.finalScore - a.finalScore || a.rent - b.rent);
      const value = state.rows.filter((row) => row.priceM2 > 0).sort((a, b) => a.priceM2 - b.priceM2 || a.rent - b.rent);
      const start = state.rows.slice().sort((a, b) => a.startPayment - b.startPayment || a.rent - b.rent);
      const minute = state.rows.filter((row) => row.rubPerCommuteMin > 0).sort((a, b) => a.rubPerCommuteMin - b.rubPerCommuteMin || a.avgCommute - b.avgCommute);
      const balancedColumns = [
        ...baseColumns,
        { label: 'Баланс', render: (row) => '<span class="badge">разница ' + minutesText(row.diffTime) + '</span>' },
      ];
      const scoreColumns = [
        ...baseColumns,
        { label: 'Оценка', render: (row) => '<span class="badge">' + row.finalScore + '/100 · ' + esc(row.grade) + '</span>' },
      ];
      const startColumns = [
        ...baseColumns,
        { label: 'Стартовый платёж', render: (row) => '<span class="money">' + rub(row.startPayment) + '</span><div class="muted">' + esc(row.moveInCostCategory) + '</div>' },
      ];
      const minuteColumns = [
        ...baseColumns,
        { label: '₽/мин пути', render: (row) => '<span class="money">' + rub(row.rubPerCommuteMin) + '</span><div class="muted">аренда / ' + esc(minutesText(Math.round(row.avgCommute))) + '</div>' },
      ];

      state.tableRows = { cheap, expensive, olya, nikita, balanced, score, value, start, minute };
      state.tableColumns = { cheap: baseColumns, expensive: baseColumns, olya: baseColumns, nikita: baseColumns, balanced: balancedColumns, score: scoreColumns, value: scoreColumns, start: startColumns, minute: minuteColumns };
      state.tableHighlights = { cheap: 8, expensive: 8, olya: 10, nikita: 10, balanced: 10, score: 10, value: 10, start: 10, minute: 10 };

      renderTable(els.cheapTable, cheap, baseColumns, 8, { limit: PREVIEW_LIMIT, tableKey: 'cheap' });
      renderTable(els.expensiveTable, expensive, baseColumns, 8, { limit: PREVIEW_LIMIT, tableKey: 'expensive' });
      renderTable(els.olyaTable, olya, baseColumns, 10, { limit: PREVIEW_LIMIT, tableKey: 'olya' });
      renderTable(els.nikitaTable, nikita, baseColumns, 10, { limit: PREVIEW_LIMIT, tableKey: 'nikita' });
      renderTable(els.balancedTable, balanced, balancedColumns, 10, { limit: PREVIEW_LIMIT, tableKey: 'balanced' });
      renderTable(els.scoreTable, score, scoreColumns, 10, { limit: PREVIEW_LIMIT, tableKey: 'score' });
      renderTable(els.valueTable, value, scoreColumns, 10, { limit: PREVIEW_LIMIT, tableKey: 'value' });
      renderTable(els.startTable, start, startColumns, 10, { limit: PREVIEW_LIMIT, tableKey: 'start' });
      renderTable(els.minuteTable, minute, minuteColumns, 10, { limit: PREVIEW_LIMIT, tableKey: 'minute' });
      els.olyaAvg.textContent = 'вариантов: ' + olya.length + ', средняя аренда: ' + rub(average(olya.map((row) => row.rent)));
      els.nikitaAvg.textContent = 'вариантов: ' + nikita.length + ', средняя аренда: ' + rub(average(nikita.map((row) => row.rent)));
      els.balancedAvg.textContent = 'средняя аренда: ' + rub(average(balanced.map((row) => row.rent)));
      els.scoreAvg.textContent = 'оценка: среднее из числовых показателей';
      els.valueAvg.textContent = 'вариантов с площадью: ' + value.length;
      els.startAvg.textContent = 'средний вход: ' + rub(average(start.map((row) => row.startPayment)));
      els.minuteAvg.textContent = 'среднее: ' + rub(average(minute.map((row) => row.rubPerCommuteMin)));
    }

    function renderBuckets() {
      const groups = [
        ['до 60 мин', (row, key) => row[key] <= 60],
        ['60-90 мин', (row, key) => row[key] > 60 && row[key] <= 90],
        ['90-120 мин', (row, key) => row[key] > 90 && row[key] <= 120],
        ['больше 120 мин', (row, key) => row[key] > 120 && Number.isFinite(row[key])],
      ];
      const keys = [
        ['Оля', 'olya'],
        ['Никита', 'nikita'],
        ['Оба маршрута', 'both'],
      ];
      const rows = [];
      groups.forEach((group) => {
        keys.forEach((key) => {
          const list = key[1] === 'both'
            ? state.rows.filter((row) => group[1](row, 'olya') && group[1](row, 'nikita'))
            : state.rows.filter((row) => group[1](row, key[1]));
          rows.push({ group: group[0], route: key[0], count: list.length, avg: average(list.map((row) => row.rent)), median: median(list.map((row) => row.rent)) });
        });
      });
      renderTable(els.bucketsTable, rows, [
        { label: 'Группа', render: (row) => esc(row.group) },
        { label: 'Маршрут', render: (row) => esc(row.route) },
        { label: 'Кол-во', render: (row) => '<span class="badge">' + row.count + '</span>' },
        { label: 'Средняя аренда', render: (row) => '<span class="money">' + rub(row.avg) + '</span>' },
        { label: 'Медиана', render: (row) => '<span class="money">' + rub(row.median) + '</span>' },
      ]);

      const categories = [];
      const addCategoryRows = (title, field) => {
        [...new Set(state.rows.map((row) => row[field]))].sort((a, b) => String(a).localeCompare(String(b), 'ru')).forEach((name) => {
          const list = state.rows.filter((row) => row[field] === name);
          categories.push({
            type: title,
            name,
            count: list.length,
            avg: average(list.map((row) => row.rent)),
            median: median(list.map((row) => row.rent)),
            avgStart: average(list.map((row) => row.startPayment)),
            avgDiff: average(list.map((row) => row.diffTime)),
          });
        });
      };
      addCategoryRows('Баланс', 'balanceType');
      addCategoryRows('Стартовый платёж', 'moveInCostCategory');
      renderTable(els.categoryTable, categories.sort((a, b) => a.type.localeCompare(b.type, 'ru') || b.count - a.count), [
        { label: 'Тип', render: (row) => esc(row.type) },
        { label: 'Категория', render: (row) => esc(row.name) },
        { label: 'Кол-во', render: (row) => '<span class="badge">' + row.count + '</span>' },
        { label: 'Средняя аренда', render: (row) => '<span class="money">' + rub(row.avg) + '</span>' },
        { label: 'Медиана аренды', render: (row) => '<span class="money">' + rub(row.median) + '</span>' },
        { label: 'Средний вход', render: (row) => '<span class="money">' + rub(row.avgStart) + '</span>' },
        { label: 'Средняя разница', render: (row) => row.type === 'Баланс' ? '<span class="time">' + minutesText(Math.round(row.avgDiff)) + '</span>' : '<span class="muted">-</span>' },
      ]);
    }

    function getRowsWithoutImages() {
      return state.rows.filter((row) => {
        const item = row?.item || row;
        const link = getListingUrl(item);
        return link && !getImageUrl(row);
      });
    }

    function updateImageButtonState() {
      if (!els.imageButton) return;
      els.imageButton.disabled = !state.rows.length || state.imageLoading;
    }

    async function loadPreviewImages() {
      const missingRows = getRowsWithoutImages();
      if (!missingRows.length) {
        setStatus('Фото уже есть в данных или ссылки на объявления не найдены.', 'ok');
        return;
      }

      state.imageLoading = true;
      updateImageButtonState();
      setStatus('Подгружаю фото по одному, пауза 5 секунд между запросами...', 'warn');

      const items = missingRows.slice(0, 40).map((row) => row.item || row);

      try {
        const response = await fetch('/api/preview-images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items,
            limit: items.length,
            delayMs: 5000,
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось получить фото.');

        let found = 0;
        Object.entries(data.results || {}).forEach(([url, imageUrl]) => {
          if (imageUrl) {
            state.imageCache.set(url, imageUrl);
            found += 1;
          }
        });

        renderTables();
        renderBuckets();
        setStatus('Фото подгружены: ' + found + ' из ' + items.length + '.', found ? 'ok' : 'warn');
      } catch (error) {
        setStatus('Фото не удалось получить: ' + (error?.message || String(error)), 'warn');
      } finally {
        state.imageLoading = false;
        updateImageButtonState();
      }
    }

    function getFavoriteRows() {
      const rowsByKey = new Map(state.rows.map((row) => [getFavoriteKey(row), row]));
      return state.favoriteKeys.map((key) => rowsByKey.get(key)).filter(Boolean);
    }

    function getCommuteIssueRows() {
      const rowsByKey = new Map(state.rows.map((row) => [getFavoriteKey(row), row]));
      return state.commuteIssueKeys.map((key) => rowsByKey.get(key)).filter(Boolean);
    }

    function renderFavorites() {
      if (!els.favoriteTable || !els.favoritesCount) return;

      const favoriteRows = getFavoriteRows();
      els.favoritesCount.textContent = String(state.favoriteKeys.length);

      if (!favoriteRows.length) {
        els.favoriteTable.innerHTML = '<div class="empty">' + (state.favoriteKeys.length
          ? 'В избранном есть сохранённые варианты, но в текущем JSON они не найдены.'
          : 'Пока нет понравившихся вариантов. Нажми на сердечко в таблице.') + '</div>';
        if (els.favoritesStatus) {
          els.favoritesStatus.textContent = state.favoriteKeys.length
            ? 'Сохранено ' + state.favoriteKeys.length + ', в текущем JSON не найдено'
            : 'Избранных нет';
        }
        return;
      }

      if (els.favoritesStatus) {
        els.favoritesStatus.textContent = 'Показано ' + favoriteRows.length + ' из ' + state.favoriteKeys.length + ' сохранённых вариантов';
      }

      renderTable(els.favoriteTable, favoriteRows, buildAnalyticsColumns('cheap'), 0, {
        limit: favoriteRows.length,
        tableKey: 'favorites',
        getRowClass,
      });
    }

    function renderCommuteIssues() {
      if (!els.commuteIssuesTable || !els.commuteIssuesCount) return;

      const issueRows = getCommuteIssueRows();
      els.commuteIssuesCount.textContent = String(state.commuteIssueKeys.length);

      if (!issueRows.length) {
        els.commuteIssuesTable.innerHTML = '<div class="empty">' + (state.commuteIssueKeys.length
          ? 'Отмеченные варианты есть, но в текущем JSON они не найдены.'
          : 'Пока нет отмеченных расхождений. Нажми на значок ⚠ в таблице.') + '</div>';
        if (els.commuteIssuesStatus) {
          els.commuteIssuesStatus.textContent = state.commuteIssueKeys.length
            ? 'Сохранено ' + state.commuteIssueKeys.length + ', в текущем JSON не найдено'
            : 'Отмеченных расхождений нет';
        }
        return;
      }

      if (els.commuteIssuesStatus) {
        els.commuteIssuesStatus.textContent = 'Показано ' + issueRows.length + ' из ' + state.commuteIssueKeys.length + ' отмеченных вариантов';
      }

      renderTable(els.commuteIssuesTable, issueRows, buildAnalyticsColumns('cheap'), 0, {
        limit: issueRows.length,
        tableKey: 'commute-issues',
        getRowClass,
      });
    }

    function downloadFavoritesJson() {
      const favoriteRows = getFavoriteRows();
      if (!favoriteRows.length) {
        setStatus('Сначала добавь варианты в понравившиеся.', 'warn');
        return;
      }

      const payload = favoriteRows.map((row) => ({ ...row }));
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      anchor.href = url;
      anchor.download = 'favorites-' + stamp + '.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('Избранное скачано: ' + payload.length + ' вариантов.', 'ok');
    }

    function downloadCommuteIssuesJson() {
      const issueRows = getCommuteIssueRows();
      if (!issueRows.length) {
        setStatus('Сначала отметь варианты кнопкой ⚠.', 'warn');
        return;
      }

      const payload = issueRows.map((row) => ({
        ...row,
        flagReason: 'Указанное время не совпало с фактическим',
        flaggedAt: new Date().toISOString(),
      }));
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      anchor.href = url;
      anchor.download = 'commute-issues-' + stamp + '.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('Список расхождений скачан: ' + payload.length + ' вариантов.', 'ok');
    }

    function setFullViewVisible(isVisible) {
      els.fullView.classList.toggle('hidden', !isVisible);
      document.querySelectorAll('.analytics-section').forEach((section) => {
        section.classList.toggle('hidden', isVisible);
      });
    }

    function openFullTable(tableKey, options = {}) {
      const rows = state.tableRows[tableKey] || [];
      const columns = state.tableColumns[tableKey] || [];

      if (!rows.length || !columns.length) {
        setStatus('Сначала построй аналитику, потом можно открыть полную таблицу.', 'warn');
        setFullViewVisible(false);
        return;
      }

      els.fullTitle.textContent = tableTitles[tableKey] || 'Все варианты';
      els.fullStatus.textContent = 'Всего вариантов: ' + rows.length;
      renderTable(els.fullTable, rows, columns, state.tableHighlights[tableKey] || 0);
      setFullViewVisible(true);

      if (!options.skipHistory) {
        history.pushState({ tableKey }, '', '/analytics?table=' + encodeURIComponent(tableKey));
      }
      els.fullView.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function closeFullTable(options = {}) {
      setFullViewVisible(false);
      if (!options.skipHistory) {
        history.pushState({}, '', '/analytics');
      }
    }

    function openTableFromUrl() {
      const tableKey = new URLSearchParams(location.search).get('table');
      if (!tableKey) {
        setFullViewVisible(false);
        return;
      }
      openFullTable(tableKey, { skipHistory: true });
    }

    function renderAll() {
      if (!state.rows.length) {
        els.metrics.innerHTML = '';
        els.insights.innerHTML = '';
        setFullViewVisible(false);
        [els.cheapTable, els.expensiveTable, els.olyaTable, els.nikitaTable, els.balancedTable, els.bucketsTable, els.scoreTable, els.valueTable, els.startTable, els.minuteTable, els.categoryTable].forEach((el) => {
          el.innerHTML = '<div class="empty">Загрузи JSON и нажми “Построить”.</div>';
        });
        setStage(state.items.length ? 'JSON загружен' : 'Ожидание файла', state.items.length ? 'warn' : 'info');
        updateImageButtonState();
        return;
      }
      renderMetrics();
      renderInsights();
      renderTables();
      renderBuckets();
      openTableFromUrl();
      setStatus('Построена аналитика по ' + state.rows.length + ' объектам. Поля времени: ' + els.olyaKey.value + ', ' + els.nikitaKey.value + '.', 'ok');
      setStage('Аналитика построена', 'ok');
      updateImageButtonState();
    }

    function loadText(text) {
      setStage('Разбор JSON', 'info');
      const parsed = unwrapJson(JSON.parse(text));
      state.items = parsed;
      state.timeKeys = detectTimeKeys(parsed);
      fillTimeSelects();
      prepareRows();
      setStage('Подсчёт аналитики', 'info');
      renderAll();
    }

    async function readJsonResponse(response, fallbackMessage) {
      const text = await response.text();
      let data = null;

      if (text.trim()) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(text || fallbackMessage);
        }
      }

      if (!response.ok) {
        throw new Error(data?.error || data?.message || text || fallbackMessage);
      }

      return data;
    }

    async function loadSavedAnalyticsData() {
      try {
        setStage('Проверяю сохранённый JSON', 'info');
        const response = await fetch('/api/analytics-data');
        const data = await readJsonResponse(response, 'Не удалось загрузить сохранённый JSON.');
        if (!Array.isArray(data.items) || !data.items.length) return;
        els.jsonInput.value = JSON.stringify(data.items, null, 2);
        state.items = data.items;
        state.timeKeys = detectTimeKeys(data.items);
        fillTimeSelects();
        prepareRows();
        renderAll();
        const updatedText = data.updatedAt ? ' Обновлено: ' + new Date(data.updatedAt).toLocaleString('ru-RU') + '.' : '';
        setStatus('Загружен сохранённый JSON: ' + data.items.length + ' объектов.' + updatedText, 'ok');
        setStage('Сохранённый JSON загружен', 'ok');
      } catch (error) {
        setStatus('Сохранённый JSON не загружен: ' + (error?.message || String(error)), 'warn');
        setStage('Сохранение не найдено', 'warn');
      }
    }

    async function handleFile() {
      const file = els.fileInput.files?.[0];
      if (!file) return;
      setStage('Читаю файл', 'info');
      const text = await file.text();
      els.jsonInput.value = text;
      setStage('Файл загружен', 'info');
      loadText(text);
    }

    function handleAnalyze() {
      try {
        if (!els.jsonInput.value.trim()) {
          setStatus('Сначала загрузи файл или вставь JSON.', 'warn');
          setStage('Нет JSON для подсчёта', 'warn');
          return;
        }
        setStage('Разбираю вставленный JSON', 'info');
        loadText(els.jsonInput.value);
      } catch (error) {
        state.items = [];
        state.rows = [];
        renderAll();
        setStatus('Ошибка JSON: ' + (error?.message || String(error)), 'warn');
        setStage('Ошибка разбора JSON', 'bad');
      }
    }

    function buildAnalyticsColumns(tableKey) {
      const periodLabel = state.analyticsView?.periodLabel || 'за период';
      const baseColumns = [
        { label: 'Объект', render: listingCell },
        { label: 'Аренда', render: (row) => '<span class="money">' + rub(row.rent) + '</span>' },
        { label: 'Цена за м²', render: (row) => row.priceM2 ? '<span class="money">' + rub(row.priceM2) + '</span>' : '<span class="muted">нет площади</span>' },
        { label: 'Итого ' + periodLabel, render: (row) => '<span class="money">' + rub(row.total) + '</span>' + (periodLabel === 'за период' ? '<div class="muted">' + esc(row.months) + ' мес.</div>' : '') },
        { label: 'До Оли', render: (row) => '<span class="time">' + minutesText(row.olya) + '</span>' },
        { label: 'До Никиты', render: (row) => '<span class="time">' + minutesText(row.nikita) + '</span>' },
      ];

      const tableColumns = {
        cheap: baseColumns,
        expensive: baseColumns,
        olya: baseColumns,
        nikita: baseColumns,
        balanced: [...baseColumns, { label: 'Баланс', render: (row) => '<span class="badge">разница ' + minutesText(row.diffTime) + '</span>' }],
        score: [...baseColumns, { label: 'Оценка', render: (row) => '<span class="badge">' + row.finalScore + '/100 · ' + esc(row.grade) + '</span>' }],
        value: [...baseColumns, { label: 'Оценка', render: (row) => '<span class="badge">' + row.finalScore + '/100 · ' + esc(row.grade) + '</span>' }],
        start: [...baseColumns, { label: 'Стартовый платёж', render: (row) => '<span class="money">' + rub(row.startPayment) + '</span><div class="muted">' + esc(row.moveInCostCategory) + '</div>' }],
        minute: [...baseColumns, { label: '₽/мин пути', render: (row) => '<span class="money">' + rub(row.rubPerCommuteMin) + '</span><div class="muted">аренда / ' + esc(minutesText(Math.round(row.avgCommute))) + '</div>' }],
      };

      return tableColumns[tableKey] || baseColumns;
    }

    function applyAnalyticsView(data) {
      state.analyticsView = data;
      state.items = Array.isArray(data?.items) ? data.items : state.items;
      state.rows = Array.isArray(data?.rows) ? data.rows : [];
      state.timeKeys = Array.isArray(data?.timeKeys) ? data.timeKeys : [];
      state.tableRows = data?.tableRows || {};
      state.tableColumns = data?.tableColumns || {};
      state.tableHighlights = data?.tableHighlights || {};

      if (Array.isArray(data?.timeKeys) && data.timeKeys.length) {
        fillTimeSelects();
        if (data.selectedKeys?.olyaKey) els.olyaKey.value = data.selectedKeys.olyaKey;
        if (data.selectedKeys?.nikitaKey) els.nikitaKey.value = data.selectedKeys.nikitaKey;
      }

      renderAll();
    }

    async function loadAnalyticsView(items) {
      const response = await fetch('/api/analytics-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          timeKeys: state.timeKeys,
          olyaKey: els.olyaKey.value,
          nikitaKey: els.nikitaKey.value,
          fastLimit: Number(els.fastLimit.value || 90),
        }),
      });
      const data = await readJsonResponse(response, 'Не удалось построить аналитику на сервере.');
      applyAnalyticsView(data);
      return data;
    }

    function renderMetrics() {
      if (!state.analyticsView) return;
      els.metrics.innerHTML = state.analyticsView.metrics
        .map((item) => '<article class="metric"><span>' + esc(item.label) + '</span><strong>' + esc(item.value) + '</strong><em>' + esc(item.note) + '</em></article>')
        .join('');
    }

    function renderInsights() {
      if (!state.analyticsView) return;
      els.insights.innerHTML = state.analyticsView.insights
        .map((item) => '<article class="insight"><b>' + esc(item.title) + '</b><div>' + item.body + '</div></article>')
        .join('');
    }

    function renderTables() {
      if (!state.analyticsView) return;
      const rows = state.tableRows;
      renderTable(els.cheapTable, rows.cheap || [], buildAnalyticsColumns('cheap'), 8, { limit: PREVIEW_LIMIT, tableKey: 'cheap', getRowClass });
      renderTable(els.expensiveTable, rows.expensive || [], buildAnalyticsColumns('expensive'), 8, { limit: PREVIEW_LIMIT, tableKey: 'expensive', getRowClass });
      renderTable(els.olyaTable, rows.olya || [], buildAnalyticsColumns('olya'), 10, { limit: PREVIEW_LIMIT, tableKey: 'olya', getRowClass });
      renderTable(els.nikitaTable, rows.nikita || [], buildAnalyticsColumns('nikita'), 10, { limit: PREVIEW_LIMIT, tableKey: 'nikita', getRowClass });
      renderTable(els.balancedTable, rows.balanced || [], buildAnalyticsColumns('balanced'), 10, { limit: PREVIEW_LIMIT, tableKey: 'balanced', getRowClass });
      renderTable(els.scoreTable, rows.score || [], buildAnalyticsColumns('score'), 10, { limit: PREVIEW_LIMIT, tableKey: 'score', getRowClass });
      renderTable(els.valueTable, rows.value || [], buildAnalyticsColumns('value'), 10, { limit: PREVIEW_LIMIT, tableKey: 'value', getRowClass });
      renderTable(els.startTable, rows.start || [], buildAnalyticsColumns('start'), 10, { limit: PREVIEW_LIMIT, tableKey: 'start', getRowClass });
      renderTable(els.minuteTable, rows.minute || [], buildAnalyticsColumns('minute'), 10, { limit: PREVIEW_LIMIT, tableKey: 'minute', getRowClass });
      els.olyaAvg.textContent = 'вариантов: ' + (rows.olya || []).length + ', средняя аренда: ' + rub(average((rows.olya || []).map((row) => row.rent)));
      els.nikitaAvg.textContent = 'вариантов: ' + (rows.nikita || []).length + ', средняя аренда: ' + rub(average((rows.nikita || []).map((row) => row.rent)));
      els.balancedAvg.textContent = 'средняя аренда: ' + rub(average((rows.balanced || []).map((row) => row.rent)));
      els.scoreAvg.textContent = 'оценка: среднее из серверных расчётов';
      els.valueAvg.textContent = 'вариантов с площадью: ' + (rows.value || []).length;
      els.startAvg.textContent = 'средний вход: ' + rub(average((rows.start || []).map((row) => row.startPayment)));
      els.minuteAvg.textContent = 'среднее: ' + rub(average((rows.minute || []).map((row) => row.rubPerCommuteMin)));
      renderFavorites();
    }

    function renderBuckets() {
      if (!state.analyticsView) return;
      renderTable(els.bucketsTable, state.tableRows.buckets || [], [
        { label: 'Группа', render: (row) => esc(row.group) },
        { label: 'Маршрут', render: (row) => esc(row.route) },
        { label: 'Кол-во', render: (row) => '<span class="badge">' + row.count + '</span>' },
        { label: 'Средняя аренда', render: (row) => '<span class="money">' + rub(row.avg) + '</span>' },
        { label: 'Медиана', render: (row) => '<span class="money">' + rub(row.median) + '</span>' },
      ]);

      renderTable(els.categoryTable, state.tableRows.categories || [], [
        { label: 'Тип', render: (row) => esc(row.type) },
        { label: 'Категория', render: (row) => esc(row.name) },
        { label: 'Кол-во', render: (row) => '<span class="badge">' + row.count + '</span>' },
        { label: 'Средняя аренда', render: (row) => '<span class="money">' + rub(row.avg) + '</span>' },
        { label: 'Медиана аренды', render: (row) => '<span class="money">' + rub(row.median) + '</span>' },
        { label: 'Средний вход', render: (row) => '<span class="money">' + rub(row.avgStart) + '</span>' },
        { label: 'Средняя разница', render: (row) => row.type === 'Баланс' ? '<span class="time">' + minutesText(Math.round(row.avgDiff)) + '</span>' : '<span class="muted">-</span>' },
      ]);
    }

    function renderAll() {
      renderMetrics();
      renderInsights();
      renderTables();
      renderBuckets();
      renderFavorites();
      renderCommuteIssues();
      openTableFromUrl();
      if (state.analyticsView) {
        setStatus('Построена аналитика по ' + state.rows.length + ' объектам. Поля времени: ' + (els.olyaKey.value || '-') + ', ' + (els.nikitaKey.value || '-') + '.', 'ok');
      }
    }

    function openFullTable(tableKey, options = {}) {
      const rows = state.tableRows[tableKey] || [];
      const columns = buildAnalyticsColumns(tableKey);

      if (!rows.length || !columns.length) {
        setStatus('Сначала построй аналитику, потом можно открыть полную таблицу.', 'warn');
        setFullViewVisible(false);
        return;
      }

      els.fullTitle.textContent = tableTitles[tableKey] || 'Все варианты';
      els.fullStatus.textContent = 'Всего вариантов: ' + rows.length;
      state.openTableKey = tableKey;
      renderTable(els.fullTable, rows, columns, state.tableHighlights[tableKey] || 0, { getRowClass });
      setFullViewVisible(true);

      if (!options.skipHistory) {
        history.pushState({ tableKey }, '', '/analytics?table=' + encodeURIComponent(tableKey));
      }
      els.fullView.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function closeFullTable(options = {}) {
      state.openTableKey = null;
      setFullViewVisible(false);
      if (!options.skipHistory) {
        history.pushState({}, '', '/analytics');
      }
    }

    async function loadText(text) {
      const parsed = unwrapJson(JSON.parse(text));
      state.items = parsed;
      els.jsonInput.value = text;
      await loadAnalyticsView(parsed);
    }

    async function loadSavedAnalyticsData() {
      try {
        const response = await fetch('/api/analytics-data');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось загрузить сохранённый JSON.');
        if (!Array.isArray(data.items) || !data.items.length) return;
        els.jsonInput.value = JSON.stringify(data.items, null, 2);
        await loadAnalyticsView(data.items);
        const updatedText = data.updatedAt ? ' Обновлено: ' + new Date(data.updatedAt).toLocaleString('ru-RU') + '.' : '';
        setStatus('Загружен сохранённый JSON: ' + data.items.length + ' объектов.' + updatedText, 'ok');
      } catch (error) {
        setStatus('Сохранённый JSON не загружен: ' + (error?.message || String(error)), 'warn');
      }
    }

    async function handleFile() {
      const file = els.fileInput.files?.[0];
      if (!file) return;
      const text = await file.text();
      await loadText(text);
    }

    async function handleAnalyze() {
      try {
        if (!els.jsonInput.value.trim()) {
          setStatus('Сначала загрузи файл или вставь JSON.', 'warn');
          return;
        }
        await loadText(els.jsonInput.value);
      } catch (error) {
        state.items = [];
        state.rows = [];
        state.analyticsView = null;
        renderAll();
        setStatus('Ошибка JSON: ' + (error?.message || String(error)), 'warn');
      }
    }

    els.fileInput.addEventListener('change', handleFile);
    els.analyzeBtn.addEventListener('click', handleAnalyze);
    els.imageButton.addEventListener('click', () => { void loadPreviewImages(); });
    els.downloadFavoritesBtn.addEventListener('click', downloadFavoritesJson);
    els.downloadCommuteIssuesBtn.addEventListener('click', downloadCommuteIssuesJson);
    els.fastLimit.addEventListener('input', () => { if (state.items.length) { void loadAnalyticsView(state.items); } });
    els.olyaKey.addEventListener('change', () => { if (state.items.length) { void loadAnalyticsView(state.items); } });
    els.nikitaKey.addEventListener('change', () => { if (state.items.length) { void loadAnalyticsView(state.items); } });
    document.addEventListener('click', (event) => {
      const favoriteButton = event.target.closest('.js-fav-toggle');
      if (favoriteButton) {
        const key = decodeKey(favoriteButton.dataset.favoriteKey || '');
        const row = state.rows.find((item) => getFavoriteKey(item) === key);
        if (row) toggleFavoriteRow(row);
        return;
      }

      const issueButton = event.target.closest('.js-issue-toggle');
      if (issueButton) {
        const key = decodeKey(issueButton.dataset.issueKey || '');
        const row = state.rows.find((item) => getFavoriteKey(item) === key);
        if (row) toggleCommuteIssueRow(row);
        return;
      }

      const viewedLink = event.target.closest('.js-viewed-link');
      if (viewedLink) {
        const key = decodeKey(viewedLink.dataset.viewKey || '');
        const row = state.rows.find((item) => getFavoriteKey(item) === key);
        if (row) {
          markViewedRow(row);
          renderTables();
          renderBuckets();
          if (state.openTableKey) {
            const rows = state.tableRows[state.openTableKey] || [];
            const columns = buildAnalyticsColumns(state.openTableKey);
            renderTable(els.fullTable, rows, columns, state.tableHighlights[state.openTableKey] || 0, { getRowClass });
          }
        }
      }

      const button = event.target.closest('.js-open-table');
      if (!button) return;
      openFullTable(button.dataset.table);
    });
    els.backToAnalytics.addEventListener('click', () => closeFullTable());
    window.addEventListener('popstate', () => openTableFromUrl());
    renderAll();
    loadSavedAnalyticsData();
  </script>
</body>
</html>`;

const costsPage = String.raw`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Расходы за 3 месяца</title>
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
      --bad: #ff8080;
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
    button, input, select { font: inherit; }
    .app {
      width: min(1260px, calc(100vw - 24px));
      margin: 0 auto;
      padding: 18px 0 24px;
    }
    .hero, .panel, .toolbar, .summary {
      border: 1px solid rgba(110, 168, 255, 0.14);
      border-radius: var(--radius);
      background: var(--panel);
      box-shadow: var(--shadow);
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
    h1 { margin: 0; font-size: 28px; line-height: 1.12; letter-spacing: -0.02em; }
    p { margin: 10px 0 0; color: var(--muted); line-height: 1.55; max-width: 880px; }
    .nav {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .link-btn, .action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      padding: 0 14px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 800;
      white-space: nowrap;
      border: 1px solid rgba(110, 168, 255, 0.18);
      background: rgba(17, 25, 42, 0.9);
      color: var(--text);
      cursor: pointer;
    }
    .action-btn {
      border-color: rgba(87, 214, 176, 0.3);
      background: linear-gradient(180deg, rgba(87, 214, 176, 0.24), rgba(42, 142, 120, 0.22));
    }
    .link-btn:hover, .action-btn:hover { border-color: rgba(139, 188, 255, 0.55); }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 140px 190px 180px auto;
      gap: 10px;
      align-items: end;
      padding: 14px;
      margin-bottom: 14px;
    }
    .field {
      display: grid;
      gap: 6px;
      color: #c9d5e5;
      font-size: 13px;
      font-weight: 700;
    }
    input, select {
      width: 100%;
      min-height: 42px;
      border: 1px solid rgba(110, 168, 255, 0.16);
      border-radius: 12px;
      background: #0c1322;
      color: var(--text);
      outline: none;
      padding: 0 12px;
    }
    input[type="file"] { padding: 8px 10px; color: var(--muted); }
    input:focus, select:focus { border-color: rgba(139, 188, 255, 0.62); }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      padding: 14px;
      margin-bottom: 14px;
    }
    .metric {
      min-height: 78px;
      border: 1px solid rgba(110, 168, 255, 0.1);
      border-radius: 12px;
      background: rgba(12, 19, 34, 0.76);
      padding: 12px;
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .metric strong {
      display: block;
      margin-top: 8px;
      font-size: 22px;
      line-height: 1.1;
    }
    .panel { overflow: hidden; }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: rgba(18, 25, 42, 0.72);
    }
    .panel-title { font-size: 16px; font-weight: 900; }
    .status { color: var(--muted); font-size: 13px; font-weight: 700; }
    .status.ok { color: var(--good); }
    .status.warn { color: var(--warn); }
    .table-wrap { overflow-x: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 980px;
    }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid rgba(34, 48, 70, 0.76);
      vertical-align: top;
      text-align: left;
    }
    th {
      color: #c9d5e5;
      background: rgba(11, 18, 32, 0.82);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    td { color: #dce6f4; font-size: 14px; }
    .money { white-space: nowrap; font-variant-numeric: tabular-nums; font-weight: 800; }
    .total { color: var(--good); font-size: 16px; }
    .object { min-width: 280px; }
    .title {
      color: var(--text);
      font-weight: 850;
      line-height: 1.35;
      text-decoration: none;
    }
    a.title:hover { color: var(--accent-strong); }
    .address {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .notes {
      display: grid;
      gap: 4px;
      min-width: 170px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .notes .warn { color: var(--warn); }
    .empty {
      padding: 28px 16px;
      color: var(--muted);
      text-align: center;
      font-weight: 700;
    }
    @media (max-width: 900px) {
      .toolbar { grid-template-columns: 1fr 1fr; }
      .action-btn { width: 100%; }
      .summary { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 560px) {
      .app { width: min(100% - 16px, 1260px); padding-top: 10px; }
      .hero, .toolbar, .summary { border-radius: 12px; }
      h1 { font-size: 24px; }
      .toolbar, .summary { grid-template-columns: 1fr; }
      .link-btn, .action-btn { width: 100%; }
      .nav { width: 100%; }
    }
  </style>
</head>
<body>
  <main class="app">
    <section class="hero">
      <div class="hero-top">
        <h1>Расходы за 3 месяца</h1>
        <div class="nav">
          <a class="link-btn" href="/">Фильтр</a>
          <a class="link-btn" href="/merge">Объединить JSON</a>
          <a class="link-btn" href="/analytics">Аналитика</a>
        </div>
      </div>
      <p>Загрузи JSON с объявлениями: страница посчитает аренду за выбранное количество месяцев, комиссию агентства и залог по каждому объекту.</p>
    </section>

    <section class="toolbar">
      <label class="field">
        JSON-файл
        <input id="fileInput" type="file" accept=".json,application/json">
      </label>
      <label class="field">
        Месяцев
        <input id="monthsInput" type="number" min="1" max="24" step="1" value="3">
      </label>
      <label class="field">
        Сортировка
        <select id="sortMode">
          <option value="total-desc">Итог: дороже</option>
          <option value="total-asc">Итог: дешевле</option>
          <option value="rent-asc">Аренда: дешевле</option>
          <option value="deposit-desc">Залог: больше</option>
        </select>
      </label>
      <label class="field">
        Поиск
        <input id="searchInput" type="text" placeholder="адрес или название">
      </label>
      <button id="downloadBtn" class="action-btn" type="button" disabled>Скачать расчёт</button>
    </section>

    <section class="summary" aria-live="polite">
      <div class="metric"><span>Объектов</span><strong id="countMetric">0</strong></div>
      <div class="metric"><span>Минимум</span><strong id="minMetric">0 ₽</strong></div>
      <div class="metric"><span>Медиана</span><strong id="medianMetric">0 ₽</strong></div>
      <div class="metric"><span>Максимум</span><strong id="maxMetric">0 ₽</strong></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title">Расчёт по объектам</div>
        <div id="status" class="status">Выбери JSON-файл</div>
      </div>
      <div id="tableWrap" class="table-wrap">
        <div class="empty">Пока данных нет.</div>
      </div>
    </section>
  </main>

  <script>
    const els = {
      fileInput: document.querySelector('#fileInput'),
      monthsInput: document.querySelector('#monthsInput'),
      sortMode: document.querySelector('#sortMode'),
      searchInput: document.querySelector('#searchInput'),
      downloadBtn: document.querySelector('#downloadBtn'),
      countMetric: document.querySelector('#countMetric'),
      minMetric: document.querySelector('#minMetric'),
      medianMetric: document.querySelector('#medianMetric'),
      maxMetric: document.querySelector('#maxMetric'),
      status: document.querySelector('#status'),
      tableWrap: document.querySelector('#tableWrap'),
    };

    const state = {
      items: [],
      rows: [],
      fileName: '',
    };

    function esc(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function displayText(value) {
      return String(value ?? '').trim();
    }

    function unwrapJson(value) {
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.result)) return value.result;
      if (Array.isArray(value?.items)) return value.items;
      if (Array.isArray(value?.data)) return value.data;
      throw new Error('JSON должен быть массивом объектов или объектом с result/items/data.');
    }

    function rub(value) {
      if (!Number.isFinite(value)) return '0 ₽';
      return new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: 'RUB',
        maximumFractionDigits: 0,
      }).format(Math.round(value));
    }

    function parseMoney(value) {
      const text = String(value ?? '').replace(/\u00a0/g, ' ');
      const matches = [...text.matchAll(/(\d[\d\s.]*)\s*(?:₽|руб|р\.?)/gi)];
      if (matches.length) {
        const valueText = matches[0][1].replace(/[^\d.]/g, '');
        const parsed = Number(valueText);
        return Number.isFinite(parsed) ? parsed : 0;
      }

      const fallback = text.match(/(\d[\d\s]{2,})/);
      if (!fallback) return 0;
      const parsed = Number(fallback[1].replace(/\D/g, ''));
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function parsePrice(item) {
      return parseMoney(item?.price ?? item?.Price ?? item?.цена ?? '');
    }

    function getPaymentSourceText(item) {
      return [item?.dop, item?.description].map(displayText).join(' ').replace(/\s+/g, ' ').trim();
    }

    function findCommissionPercent(item) {
      const source = getPaymentSourceText(item);
      if (/без\s+комисс/i.test(source)) return 0;

      const match = source.match(/комисс\w*[^0-9]{0,24}(\d{1,3})\s*%/i);
      if (!match) return null;

      const percent = Number(match[1]);
      return Number.isFinite(percent) ? Math.max(0, percent) : null;
    }

    function findDeposit(item, monthlyPrice) {
      const source = getPaymentSourceText(item);
      if (/без\s+залог/i.test(source)) {
        return { value: 0, found: true, inferred: false };
      }

      const depositMatch = source.match(/(?:залог|депозит)[^0-9₽р]{0,40}(\d[\d\s.]*)\s*(?:₽|руб|р\.?)/i);
      if (depositMatch) {
        const parsed = parseMoney(depositMatch[1]);
        return { value: parsed, found: true, inferred: false };
      }

      const oneMonthMatch = source.match(/(?:залог|депозит)[^.]{0,80}(?:месяц|мес|размере месячной|один)/i);
      if (oneMonthMatch && monthlyPrice > 0) {
        return { value: monthlyPrice, found: true, inferred: true };
      }

      return { value: 0, found: false, inferred: false };
    }

    function getTitle(item) {
      return displayText(item?.title ?? item?.name ?? item?.название ?? 'Без названия');
    }

    function getAddress(item) {
      return displayText(item?.adress ?? item?.address ?? item?.адрес ?? '');
    }

    function getLink(item) {
      return displayText(item?.url ?? item?.link ?? item?.href ?? '');
    }

    function calculateRow(item) {
      const months = Math.max(1, Math.min(Number(els.monthsInput.value || 3), 24));
      const rent = parsePrice(item);
      const rentForPeriod = rent * months;
      const commissionPercent = findCommissionPercent(item);
      const commission = commissionPercent === null ? 0 : rent * commissionPercent / 100;
      const deposit = findDeposit(item, rent);
      const total = rentForPeriod + commission + deposit.value;
      const commissionText = commissionPercent === null ? 'не найдена' : commissionPercent + '%';
      const depositText = deposit.found
        ? deposit.inferred ? 'залог принят как 1 месяц' : 'залог найден'
        : 'залог не найден';

      return {
        item,
        title: getTitle(item),
        address: getAddress(item),
        link: getLink(item),
        months,
        rent,
        rentPerMonth: rent,
        rentForPeriod,
        commissionPercent,
        commission,
        deposit,
        depositValue: deposit.value,
        commissionText,
        depositText,
        paymentSource: getPaymentSourceText(item),
        total,
        totalForPeriod: total,
        paymentFormula: rub(rent) + ' × ' + months + ' мес. + ' + rub(commission) + ' + ' + rub(deposit.value),
      };
    }

    function setStatus(text, tone = 'info') {
      els.status.textContent = text;
      els.status.className = 'status' + (tone === 'info' ? '' : ' ' + tone);
    }

    function getVisibleRows() {
      const query = els.searchInput.value.trim().toLowerCase();
      const sortMode = els.sortMode.value;
      const rows = state.rows.filter((row) => {
        if (!query) return true;
        return (row.title + ' ' + row.address).toLowerCase().includes(query);
      });

      rows.sort((a, b) => {
        if (sortMode === 'total-asc') return a.total - b.total;
        if (sortMode === 'rent-asc') return a.rent - b.rent;
        if (sortMode === 'deposit-desc') return b.deposit.value - a.deposit.value;
        return b.total - a.total;
      });

      return rows;
    }

    function renderSummary(rows) {
      els.countMetric.textContent = String(rows.length);
      if (!rows.length) {
        els.minMetric.textContent = '0 ₽';
        els.medianMetric.textContent = '0 ₽';
        els.maxMetric.textContent = '0 ₽';
        return;
      }

      const totals = rows.map((row) => row.total);
      const sortedTotals = totals.slice().sort((a, b) => a - b);
      const middle = Math.floor(sortedTotals.length / 2);
      const median = sortedTotals.length % 2
        ? sortedTotals[middle]
        : (sortedTotals[middle - 1] + sortedTotals[middle]) / 2;
      els.minMetric.textContent = rub(Math.min(...totals));
      els.medianMetric.textContent = rub(median);
      els.maxMetric.textContent = rub(Math.max(...totals));
    }

    function renderRows() {
      const rows = getVisibleRows();
      renderSummary(rows);
      els.downloadBtn.disabled = !rows.length;

      if (!rows.length) {
        els.tableWrap.innerHTML = '<div class="empty">Ничего не найдено.</div>';
        setStatus(state.items.length ? 'Нет объектов под поиск.' : 'Выбери JSON-файл', state.items.length ? 'warn' : 'info');
        return;
      }

      els.tableWrap.innerHTML = [
        '<table>',
          '<thead><tr>',
            '<th>Объект</th>',
            '<th>Аренда в месяц</th>',
            '<th>За период</th>',
            '<th>Комиссия</th>',
            '<th>Залог</th>',
            '<th>Итого</th>',
            '<th>Разбор</th>',
          '</tr></thead>',
          '<tbody>',
            rows.map((row) => {
              const title = row.link
                ? '<a class="title" href="' + esc(row.link) + '" target="_blank" rel="noopener noreferrer">' + esc(row.title) + '</a>'
                : '<div class="title">' + esc(row.title) + '</div>';
              const commissionText = row.commissionText;
              const depositNote = row.depositText;
              const warnings = [
                row.commissionPercent === null ? '<span class="warn">Комиссия не найдена, считается 0 ₽</span>' : '',
                row.deposit.found ? '' : '<span class="warn">Залог не найден, считается 0 ₽</span>',
              ].filter(Boolean).join('');
              const formula = row.paymentFormula;

              return [
                '<tr>',
                  '<td class="object">' + title + (row.address ? '<div class="address">' + esc(row.address) + '</div>' : '') + '</td>',
                  '<td class="money">' + rub(row.rent) + '</td>',
                  '<td class="money">' + rub(row.rentForPeriod) + '</td>',
                  '<td><div class="money">' + rub(row.commission) + '</div><div class="address">' + esc(commissionText) + '</div></td>',
                  '<td><div class="money">' + rub(row.deposit.value) + '</div><div class="address">' + esc(depositNote) + '</div></td>',
                  '<td class="money total">' + rub(row.total) + '</td>',
                  '<td><div class="notes"><span>' + esc(formula) + '</span>' + warnings + '</div></td>',
                '</tr>',
              ].join('');
            }).join(''),
          '</tbody>',
        '</table>',
      ].join('');

      setStatus('Показано объектов: ' + rows.length + ' из ' + state.items.length, 'ok');
    }

    async function handleFile() {
      const file = els.fileInput.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        state.items = unwrapJson(JSON.parse(text));
        state.fileName = file.name;
        state.rows = state.items.map(calculateRow);
        renderRows();
      } catch (error) {
        state.items = [];
        state.rows = [];
        renderRows();
        setStatus(error?.message || String(error), 'warn');
      }
    }

    function recalculate() {
      state.rows = state.items.map(calculateRow);
      renderRows();
    }

    function downloadRows() {
      const rows = getVisibleRows().map((row) => ({
        ...row.item,
        months: row.months,
        rent_per_month: Math.round(row.rent),
        rent_for_period: Math.round(row.rentForPeriod),
        commission_percent: row.commissionPercent,
        commission: Math.round(row.commission),
        deposit: Math.round(row.deposit.value),
        total_for_period: Math.round(row.total),
        rent_per_month_raw: Math.round(row.rentPerMonth),
        commission_text: row.commissionText,
        deposit_text: row.depositText,
        payment_source: row.paymentSource,
        payment_formula: row.paymentFormula,
      }));

      const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'costs-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      link.click();
      URL.revokeObjectURL(link.href);
    }

    els.fileInput.addEventListener('change', handleFile);
    els.monthsInput.addEventListener('input', recalculate);
    els.sortMode.addEventListener('change', renderRows);
    els.searchInput.addEventListener('input', renderRows);
    els.downloadBtn.addEventListener('click', downloadRows);

    renderRows();
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
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <a class="back-link" href="/">На главный сайт</a>
          <a class="back-link" href="/costs">Расходы за 3 месяца</a>
          <a class="back-link" href="/analytics">Аналитика</a>
        </div>
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

    function cleanMergedAddress(value) {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return '';

      const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
      const kept = [];

      for (const part of parts) {
        if (/^(?:р-н|район)\b/i.test(part)) continue;
        if (/^м\.\s*/iu.test(part)) continue;
        if (/^метро\b/i.test(part)) continue;
        kept.push(part);
      }

      return kept.join(', ').replace(/\s*,\s*/g, ', ').replace(/,\s*,+/g, ', ').trim();
    }

    function cleanMergedItem(item) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;

      const next = { ...item };
      for (const key of ['adress', 'address', 'адрес']) {
        if (typeof next[key] === 'string' && next[key].trim()) {
          next[key] = cleanMergedAddress(next[key]);
        }
      }

      return next;
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
      const merged = [...state.arrays[0], ...state.arrays[1]].map(cleanMergedItem);
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
      setStatus('Объединено объектов: ' + merged.length + '. Адреса очищены от района и метро.', 'ok');
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

const analyticsAdminPage = String.raw`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Панель аналитики</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #080a10;
      --panel: rgba(18, 21, 30, 0.94);
      --panel-strong: #171b26;
      --text: #f3f6fb;
      --muted: #a9b1c0;
      --line: #2a3140;
      --accent: #7cc7a8;
      --warn: #ffd36e;
      --bad: #ff8585;
      --shadow: 0 24px 60px rgba(0, 0, 0, 0.42);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at 18% 0%, rgba(124, 199, 168, 0.18), transparent 28%),
        linear-gradient(180deg, #080a10 0%, #111520 100%);
      font-family: Inter, "Segoe UI", Arial, sans-serif;
    }
    button, input, textarea { font: inherit; }
    .app { width: min(980px, calc(100vw - 24px)); margin: 0 auto; padding: 18px 0 26px; }
    .hero, .panel {
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 14px;
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .hero { padding: 18px 20px; margin-bottom: 14px; background: linear-gradient(180deg, rgba(26,31,43,0.96), rgba(16,20,29,0.96)); }
    .hero-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 28px; }
    p { margin: 8px 0 0; color: var(--muted); line-height: 1.5; }
    .nav { display: flex; gap: 8px; flex-wrap: wrap; }
    .link-btn, .action-btn {
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 40px; padding: 0 13px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.1); background: #202637;
      color: var(--text); text-decoration: none; font-weight: 800; white-space: nowrap; cursor: pointer;
    }
    .action-btn.primary { background: var(--accent); color: #07120e; border-color: var(--accent); }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; background: var(--panel-strong); border-bottom: 1px solid var(--line); }
    .panel-title { font-size: 15px; font-weight: 900; }
    .status { color: var(--muted); font-size: 13px; }
    .panel-body { display: grid; gap: 12px; padding: 14px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .field { display: grid; gap: 6px; color: #d8dfeb; font-size: 13px; font-weight: 750; }
    input, textarea {
      width: 100%; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;
      background: #101520; color: var(--text); outline: none;
    }
    input { min-height: 40px; padding: 0 11px; }
    input[type="file"] { padding: 8px 10px; color: var(--muted); }
    textarea { min-height: 420px; padding: 12px; resize: vertical; font: 12px/1.5 "Cascadia Code", Consolas, monospace; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .pill { display: inline-flex; min-height: 32px; align-items: center; padding: 0 10px; border-radius: 999px; background: rgba(124,199,168,0.12); color: #dfffee; font-size: 13px; font-weight: 800; }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    @media (max-width: 760px) {
      .grid { grid-template-columns: 1fr; }
      .link-btn, .action-btn { width: 100%; }
      .nav { width: 100%; }
    }
  </style>
</head>
<body>
  <main class="app">
    <section class="hero">
      <div class="hero-top">
        <div>
          <h1>Панель управления аналитикой</h1>
          <p>Здесь сохраняется JSON для страницы аналитики. После сохранения страница /analytics будет открывать эти данные с любого устройства, у которого есть доступ к сайту.</p>
        </div>
        <nav class="nav">
          <a class="link-btn" href="/analytics">Аналитика</a>
          <a class="link-btn" href="/">Фильтр</a>
        </nav>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title">Сохранённый JSON</div>
        <div id="status" class="status">Загружаю состояние...</div>
      </div>
      <div class="panel-body">
        <div class="grid">
          <label class="field">Админ-ключ <input id="adminKey" type="password" placeholder="ANALYTICS_ADMIN_KEY"></label>
          <label class="field">JSON-файл <input id="fileInput" type="file" accept=".json,application/json"></label>
        </div>
        <div class="row">
          <button id="loadSavedBtn" class="action-btn" type="button">Загрузить сохранённый</button>
          <button id="saveBtn" class="action-btn primary" type="button">Сохранить JSON</button>
          <span class="pill">Объектов: <span id="countInfo" style="margin-left:6px;">0</span></span>
          <span class="pill">Обновлено: <span id="updatedInfo" style="margin-left:6px;">нет</span></span>
        </div>
        <textarea id="jsonInput" placeholder='[{"title":"2-к. квартира","rent_per_month":45000}]'></textarea>
        <p class="warn">Ключ не сохраняется в браузере. Без переменной окружения <code>ANALYTICS_ADMIN_KEY</code> сервер не разрешит запись.</p>
      </div>
    </section>
  </main>

  <script>
    const DEFAULT_ADMIN_KEY = ${JSON.stringify(ADMIN_KEY)};
    const els = {
      adminKey: document.querySelector('#adminKey'),
      fileInput: document.querySelector('#fileInput'),
      loadSavedBtn: document.querySelector('#loadSavedBtn'),
      saveBtn: document.querySelector('#saveBtn'),
      jsonInput: document.querySelector('#jsonInput'),
      status: document.querySelector('#status'),
      countInfo: document.querySelector('#countInfo'),
      updatedInfo: document.querySelector('#updatedInfo'),
    };

    function unwrapJson(value) {
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.result)) return value.result;
      if (Array.isArray(value?.items)) return value.items;
      if (Array.isArray(value?.data)) return value.data;
      throw new Error('JSON должен быть массивом или объектом с result/items/data.');
    }

    function setStatus(text, tone = 'info') {
      els.status.textContent = text;
      els.status.style.color = tone === 'ok' ? 'var(--accent)' : tone === 'warn' ? 'var(--warn)' : tone === 'bad' ? 'var(--bad)' : 'var(--muted)';
    }

    function updateCountFromText() {
      try {
        const items = unwrapJson(JSON.parse(els.jsonInput.value || '[]'));
        els.countInfo.textContent = String(items.length);
        return items;
      } catch {
        els.countInfo.textContent = 'ошибка JSON';
        return null;
      }
    }

    async function loadSaved() {
      try {
        const response = await fetch('/api/analytics-data');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось загрузить JSON.');
        els.jsonInput.value = JSON.stringify(data.items || [], null, 2);
        els.countInfo.textContent = String(data.count || 0);
        els.updatedInfo.textContent = data.updatedAt ? new Date(data.updatedAt).toLocaleString('ru-RU') : 'нет';
        setStatus('Сохранённый JSON загружен.', 'ok');
      } catch (error) {
        setStatus(error?.message || String(error), 'bad');
      }
    }

    async function saveJson() {
      try {
        const items = updateCountFromText();
        if (!items) throw new Error('Проверь JSON перед сохранением.');
        const key = els.adminKey.value.trim();

        if (!key) throw new Error('Введи админ-ключ.');

        const response = await fetch('/api/analytics-data', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
          body: JSON.stringify(items),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось сохранить JSON.');
        els.countInfo.textContent = String(data.count || items.length);
        els.updatedInfo.textContent = data.updatedAt ? new Date(data.updatedAt).toLocaleString('ru-RU') : 'только что';
        setStatus('JSON сохранён. Теперь /analytics будет брать эти данные.', 'ok');
      } catch (error) {
        setStatus(error?.message || String(error), 'bad');
      }
    }

    async function handleFile() {
      const file = els.fileInput.files?.[0];
      if (!file) return;
      els.jsonInput.value = await file.text();
      updateCountFromText();
      setStatus('Файл загружен в поле. Нажми “Сохранить JSON”, чтобы записать на сервер.', 'ok');
    }

    els.fileInput.addEventListener('change', handleFile);
    els.jsonInput.addEventListener('input', updateCountFromText);
    els.loadSavedBtn.addEventListener('click', loadSaved);
    els.saveBtn.addEventListener('click', saveJson);
    if (DEFAULT_ADMIN_KEY) els.adminKey.value = DEFAULT_ADMIN_KEY;
    loadSaved();
  </script>
</body>
</html>`;

function createServer() {
  return http.createServer(async (req, res) => {
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

      if (req.method === 'GET' && url.pathname === '/costs') {
        htmlResponse(res, costsPage);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/analytics') {
        htmlResponse(res, analyticsPage);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/analytics-admin') {
        htmlResponse(res, analyticsAdminPage);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/analytics-data') {
        await handleGetAnalyticsData(req, res);
        return;
      }

      if (req.method === 'PUT' && url.pathname === '/api/analytics-data') {
        await handleSaveAnalyticsData(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/preview-images') {
        await handlePreviewImages(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/filter-preview') {
        await handleFilterPreview(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/filter-run') {
        await handleFilterRun(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/analytics-run') {
        await handleAnalyticsRun(req, res);
        return;
      }

      jsonResponse(res, 404, { error: 'Not found' });
    } catch (error) {
      jsonResponse(res, error?.status || 500, { error: error?.message || String(error) });
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

