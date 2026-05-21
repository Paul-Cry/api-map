import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = join(__dirname, "data");
const UPLOADS_DIR = join(__dirname, "uploads");
const DB_PATH = join(DATA_DIR, "listings.json");
const MAX_BODY_SIZE = 25 * 1024 * 1024;

const pages = new Map([
  ["/", join(__dirname, "index.html")],
  ["/admin", join(__dirname, "admin.html")],
  ["/admin.html", join(__dirname, "admin.html")],
]);

await ensureStorage();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/listings") {
      const data = await readDatabase();
      sendJson(res, {
        items: data.items,
        updatedAt: data.updatedAt,
        sourceFile: data.sourceFile,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/import") {
      const mode = url.searchParams.get("mode") === "append" ? "append" : "replace";
      const importResult = await readImportPayload(req);
      const current = await readDatabase();
      const nextItems = mode === "append"
        ? current.items.concat(importResult.items)
        : importResult.items;

      const payload = {
        updatedAt: new Date().toISOString(),
        sourceFile: importResult.fileName,
        items: nextItems.map(normalizeListing),
      };

      await saveUploadedFile(importResult.fileName, importResult.rawText);
      await writeDatabase(payload);
      sendJson(res, {
        ok: true,
        count: payload.items.length,
        imported: importResult.items.length,
        mode,
        sourceFile: payload.sourceFile,
        updatedAt: payload.updatedAt,
      });
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/listings") {
      const payload = {
        updatedAt: new Date().toISOString(),
        sourceFile: null,
        items: [],
      };
      await writeDatabase(payload);
      sendJson(res, { ok: true, count: 0, updatedAt: payload.updatedAt });
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && pages.has(url.pathname)) {
      await sendFile(res, pages.get(url.pathname), "text/html; charset=utf-8", req.method === "HEAD");
      return;
    }

    sendText(res, 404, "Страница не найдена");
  } catch (error) {
    console.error(error);
    sendJson(res, { ok: false, error: error.message || "Server error" }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Listings site is running at http://${HOST}:${PORT}`);
});

async function ensureStorage() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOADS_DIR, { recursive: true });
  try {
    await readFile(DB_PATH, "utf8");
  } catch {
    await writeDatabase({ updatedAt: null, sourceFile: null, items: [] });
  }
}

async function readDatabase() {
  const raw = await readFile(DB_PATH, "utf8");
  const parsed = JSON.parse(raw || "{}");
  const items = Array.isArray(parsed) ? parsed : parsed.items;
  return {
    updatedAt: parsed.updatedAt || null,
    sourceFile: parsed.sourceFile || null,
    items: Array.isArray(items) ? items.map(normalizeListing) : [],
  };
}

async function writeDatabase(payload) {
  await writeFile(DB_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function sendFile(res, path, contentType, headOnly = false) {
  const body = await readFile(path);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
  });
  if (headOnly) {
    res.end();
    return;
  }
  res.end(body);
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function readImportPayload(req) {
  const contentType = req.headers["content-type"] || "";
  const body = await readBody(req);

  if (contentType.includes("multipart/form-data")) {
    const boundary = getBoundary(contentType);
    if (!boundary) throw new Error("Не найден boundary у multipart-запроса");
    const file = parseMultipartFile(body, boundary);
    return parseImportText(file.text, file.name || "objects.json");
  }

  if (contentType.includes("application/json") || contentType.includes("text/plain")) {
    return parseImportText(body.toString("utf8"), "api-import.json");
  }

  throw new Error("Поддерживаются JSON-файл или JSON-тело запроса");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error("Файл слишком большой. Лимит 25 МБ"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getBoundary(contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? (match[1] || match[2]) : null;
}

function parseMultipartFile(buffer, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const headerBreak = Buffer.from("\r\n\r\n");
  let offset = 0;

  while (offset < buffer.length) {
    const start = buffer.indexOf(marker, offset);
    if (start === -1) break;
    const headerStart = start + marker.length + 2;
    const headerEnd = buffer.indexOf(headerBreak, headerStart);
    if (headerEnd === -1) break;

    const headers = buffer.slice(headerStart, headerEnd).toString("utf8");
    const next = buffer.indexOf(marker, headerEnd + headerBreak.length);
    if (next === -1) break;

    if (/name="file"/i.test(headers)) {
      const nameMatch = headers.match(/filename="([^"]*)"/i);
      const content = trimMultipartTail(buffer.slice(headerEnd + headerBreak.length, next));
      return {
        name: sanitizeFileName(nameMatch?.[1] || "objects.json"),
        text: content.toString("utf8"),
      };
    }

    offset = next;
  }

  throw new Error("В форме не найден файл с именем поля file");
}

function trimMultipartTail(buffer) {
  let end = buffer.length;
  while (end > 0 && (buffer[end - 1] === 10 || buffer[end - 1] === 13)) end -= 1;
  return buffer.slice(0, end);
}

function parseImportText(text, fileName) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Файл должен быть валидным JSON");
  }

  const items = extractItems(parsed);
  if (!items.length) {
    throw new Error("В JSON не найден массив объектов");
  }

  return {
    fileName: sanitizeFileName(fileName),
    rawText: text,
    items,
  };
}

function extractItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  for (const key of ["items", "listings", "objects", "data", "apartments"]) {
    if (Array.isArray(parsed?.[key])) return parsed[key];
  }
  return [];
}

function normalizeListing(item, index = 0) {
  const get = (...keys) => {
    for (const key of keys) {
      if (item?.[key] !== undefined && item?.[key] !== null && item?.[key] !== "") return item[key];
    }
    return "";
  };

  const price = get("price", "monthly", "rent", "cost");
  const deposit = get("deposit", "pledge", "securityDeposit");
  const commission = get("commission", "fee");
  const utilities = get("utilities", "communal", "jku", "ЖКУ");

  return {
    id: String(get("id", "url") || `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`),
    title: String(get("title", "name", "object", "apartment") || "Объявление без названия"),
    price: String(price || ""),
    address: String(get("address", "adress", "location") || ""),
    metro: String(get("metro", "station") || ""),
    terms: String(get("terms", "dop", "details") || ""),
    description: String(get("description", "text", "comment", "notes") || ""),
    url: String(get("url", "link", "href") || ""),
    grade: String(get("grade", "rating") || ""),
    score: toNumber(get("score", "rankScore")),
    total: toNumber(get("total", "totalCost", "threeMonthTotal")),
    monthly: toNumber(get("monthly", "monthlyCost", "rentMonthly")),
    deposit: toNumber(deposit),
    commission: toNumber(commission),
    utilities: toNumber(utilities),
    commuteHome: String(get("commuteHome", "home", "Родина", "Р РѕРґРёРЅР°") || ""),
    commuteWork: String(get("commuteWork", "work", "работа Оли", "СЂР°Р±РѕС‚Р° РћР»Рё") || ""),
    raw: item,
  };
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const normalized = value.replace(/\s/g, "").replace(",", ".");
  const match = normalized.match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function sanitizeFileName(name) {
  const fallback = "objects.json";
  const safeBase = basename(name || fallback).replace(/[^\wа-яА-ЯёЁ.-]+/g, "_");
  const ext = extname(safeBase);
  return ext ? safeBase : `${safeBase || "objects"}.json`;
}

async function saveUploadedFile(fileName, text) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = `${stamp}-${sanitizeFileName(fileName)}`;
  const target = join(UPLOADS_DIR, safeName);
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(target, { encoding: "utf8" });
    stream.on("finish", resolve);
    stream.on("error", reject);
    stream.end(text);
  });
}
