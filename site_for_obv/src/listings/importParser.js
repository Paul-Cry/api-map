import { basename, extname } from "node:path";
import { readBody } from "../http.js";

export async function readImportPayload(req) {
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

export function parseImportText(text, fileName) {
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

export function sanitizeFileName(name) {
  const fallback = "objects.json";
  const safeBase = basename(name || fallback).replace(/[^\wа-яА-ЯёЁ.-]+/g, "_");
  const ext = extname(safeBase);
  return ext ? safeBase : `${safeBase || "objects"}.json`;
}

function extractItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  for (const key of ["items", "listings", "objects", "data", "apartments"]) {
    if (Array.isArray(parsed?.[key])) return parsed[key];
  }
  return [];
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
