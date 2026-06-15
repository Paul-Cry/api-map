import { readFile } from "node:fs/promises";
import { MAX_BODY_SIZE } from "./config.js";
import { HttpError } from "./errors.js";

export async function sendFile(res, path, contentType, headOnly = false) {
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

export function sendJson(res, body, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(JSON.stringify(body));
}

export function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

export async function readJsonPayload(req) {
  const body = await readBody(req);
  try {
    return JSON.parse(body.toString("utf8") || "{}");
  } catch {
    throw new HttpError("Invalid JSON body", 400);
  }
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new HttpError("Файл слишком большой. Лимит 25 МБ", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function setCookie(res, cookie) {
  const previous = res.getHeader?.("Set-Cookie");
  const next = Array.isArray(previous) ? previous.concat(cookie) : previous ? [previous, cookie] : cookie;
  res.setHeader?.("Set-Cookie", next);
}

export function parseCookies(header) {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index === -1) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}
