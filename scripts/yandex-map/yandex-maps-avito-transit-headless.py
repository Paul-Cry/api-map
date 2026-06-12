#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import re
import sys
import time
import urllib.request
from urllib.error import HTTPError, URLError
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from copy import deepcopy
from html import unescape
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse
from datetime import datetime, timezone

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[2]
os.environ.setdefault("CRAWL4_AI_BASE_DIRECTORY", str(PROJECT_ROOT))

try:
    from bs4 import BeautifulSoup
except ImportError:  # pragma: no cover - optional dependency fallback
    BeautifulSoup = None

try:
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig, ProxyConfig
except ImportError as exc:  # pragma: no cover - user-facing import guard
    raise SystemExit(
        "crawl4ai is not installed. Install it first, for example:\n"
        "  pip install crawl4ai\n"
        "  crawl4ai-setup"
    ) from exc
DEFAULT_OUTPUT = SCRIPT_DIR / "avito-transit-yandex-result.json"
DEFAULT_TIMEOUT_MS = 60_000
DEFAULT_DELAY_MS = 250
DEFAULT_WORKER_POLL_MS = 5000
DEFAULT_API_TIMEOUT_MS = 30000
DEFAULT_HEADLESS = True
DEFAULT_VEHICLE = "mt"
DEFAULT_ZOOM = "10"
DEFAULT_VIEWPORT_WIDTH = 1600
DEFAULT_VIEWPORT_HEIGHT = 1200
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

DESTINATIONS = [
    {
        "key": "работа",
        "label": "работа",
        "coords": "55.806980,37.502579",
    },
]

JOB_WAIT_JS = r"""
(() => {
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const isBlocked = (text) => /пешком|проезд/i.test(text);

  const durationPatterns = [
    /(?:\d+\s*д\s*)?(?:\d+\s*ч\s*)?(?:\d+\s*мин(?:ут)?(?:\s*\d+\s*сек(?:унд(?:ы)?)?)?)/iu,
    /(?:\d+\s*д\s*)?\d+\s*ч(?:\s*\d+\s*мин(?:ут)?)?/iu,
    /\d+\s*мин(?:ут)?/iu,
    /\d+\s*сек(?:унд(?:ы)?)?/iu,
  ];

  const extract = (value) => {
    const text = normalize(value);
    if (!text || isBlocked(text)) return '';
    for (const pattern of durationPatterns) {
      const match = text.match(pattern);
      if (match) return normalize(match[0]);
    }
    return '';
  };

  const selectors = [
    '.route-snippet-view._active._type_masstransit[aria-hidden="false"] .masstransit-route-snippet-view__route-duration',
    '.route-snippet-view._active._type_masstransit .masstransit-route-snippet-view__route-duration',
    '.route-snippet-view._type_masstransit[aria-current="step"] .masstransit-route-snippet-view__route-duration',
    '.route-snippet-view._type_masstransit[aria-hidden="false"] .masstransit-route-snippet-view__route-duration',
    '.route-list-view._travel-mode_masstransit .route-snippet-view._active .masstransit-route-snippet-view__route-duration',
    '.masstransit-route-snippet-view__route-duration',
    '.route-snippet-view._type_masstransit[aria-label*="На общественном транспорте"]',
    '.route-list-view [aria-label*="На общественном транспорте"]',
    '[aria-label*="На общественном транспорте"]',
  ];

  let duration = '';
  let source = '';

  for (const selector of selectors) {
    const nodes = document.querySelectorAll(selector);
    for (const node of nodes) {
      const candidate = extract(node?.textContent || node?.getAttribute?.('aria-label') || '');
      if (candidate) {
        duration = candidate;
        source = selector;
        break;
      }
    }
    if (duration) break;
  }

  if (!duration) {
    const bodyText = normalize(document.body?.innerText || '');
    const lines = bodyText.split('\n').map(normalize).filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const candidate = extract(line);
      if (!candidate) continue;

      const around = [lines[index - 1], line, lines[index + 1], lines[index + 2]]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      if (around.includes('пешком') || around.includes('проезд')) continue;
      duration = candidate;
      source = 'body-text';
      break;
    }
  }

  document.documentElement.setAttribute('data-codex-route-duration', duration);
  document.documentElement.setAttribute('data-codex-route-source', source);
})();
"""

DURATION_PATTERNS = [
    re.compile(r"(?:\d+\s*д\s*)?(?:\d+\s*ч\s*)?(?:\d+\s*мин(?:ут)?(?:\s*\d+\s*сек(?:унд(?:ы)?)?)?)", re.IGNORECASE),
    re.compile(r"(?:\d+\s*д\s*)?\d+\s*ч(?:\s*\d+\s*мин(?:ут)?)?", re.IGNORECASE),
    re.compile(r"\d+\s*мин(?:ут)?", re.IGNORECASE),
    re.compile(r"\d+\s*сек(?:унд(?:ы)?)?", re.IGNORECASE),
]


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def get_address(item: dict[str, Any]) -> str:
    return normalize_text(item.get("adress") or item.get("address") or item.get("адрес") or "")


def clean_route_address(address: str) -> str:
    text = normalize_text(address)
    if not text:
        return ""

    text = re.sub(r"\s*,?\s*(?:от\s*)?\d+\s*[–-]\s*\d+\s*мин(?:\.|ут)?\.?.*$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*,?\s*(?:от\s*)?\d+\s*мин(?:\.|ут)?\.?.*$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*,\s*,+", ", ", text)
    text = re.sub(r"[.,;:\s]+$", "", text).strip()

    if re.search(r"\d", text):
        text = re.sub(r"\s+[^\d,][^,]*$", "", text).strip()

    return text


def with_moscow_hint(address: str) -> str:
    text = clean_route_address(address)
    if not text:
        return ""
    if re.search(r"москв|moscow", text, flags=re.IGNORECASE):
        return text
    return f"{text}, Москва"


def build_jobs(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []

    for item_index, item in enumerate(items):
        origin = with_moscow_hint(get_address(item))
        if not origin:
            continue

        for destination in DESTINATIONS:
            destination_name = destination["label"]
            jobs.append(
                {
                    "itemIndex": item_index,
                    "origin": origin,
                    "destination": f"{destination['coords']}",
                    "destinationKey": destination["key"],
                    "destinationLabel": destination_name,
                    "destinationCoords": destination["coords"],
                }
            )

    return jobs


def load_items(source: str) -> list[dict[str, Any]]:
    text = source
    path = Path(source)
    try:
        if path.exists() and path.is_file():
            text = path.read_text(encoding="utf-8")
    except OSError:
        text = source

    parsed = json.loads(text)
    if not isinstance(parsed, list):
        raise ValueError("Нужен JSON-массив объектов.")

    items: list[dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, dict):
            raise ValueError("Каждый элемент JSON-массива должен быть объектом.")
        items.append(deepcopy(item))
    return items


def encode_route_url(origin: str, destination: str) -> str:
    base = "https://yandex.ru/maps/213/moscow/"
    params = {
        "ll": "37.617700,55.755863",
        "mode": "routes",
        "rtext": f"{origin}~{destination}",
        "rtt": DEFAULT_VEHICLE,
        "z": DEFAULT_ZOOM,
    }
    query = "&".join(f"{key}={quote(value, safe=',~')}" for key, value in params.items())
    return f"{base}?{query}"


def extract_duration_from_text(text: str) -> str:
    normalized = normalize_text(unescape(text))
    if not normalized:
        return ""

    lowered = normalized.lower()
    if "пешком" in lowered or "проезд" in lowered:
        return ""

    for pattern in DURATION_PATTERNS:
        match = pattern.search(normalized)
        if match:
            return normalize_text(match.group(0))

    return ""


def html_to_text(html: str) -> str:
    if not html:
        return ""

    if BeautifulSoup is not None:
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "noscript"]):
            tag.decompose()
        return soup.get_text("\n")

    stripped = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html)
    stripped = re.sub(r"(?s)<[^>]+>", "\n", stripped)
    return unescape(stripped)


def extract_duration_from_html(html: str) -> tuple[str, str]:
    if not html:
        return "", ""

    attr_match = re.search(
        r'data-codex-route-duration="([^"]*)"',
        html,
        flags=re.IGNORECASE,
    )
    if attr_match:
        duration = normalize_text(unescape(attr_match.group(1)))
        if duration:
            return duration, "data-codex-route-duration"

    if BeautifulSoup is not None:
        soup = BeautifulSoup(html, "html.parser")
        selectors = [
            '.route-snippet-view._active._type_masstransit[aria-hidden="false"] .masstransit-route-snippet-view__route-duration',
            '.route-snippet-view._active._type_masstransit .masstransit-route-snippet-view__route-duration',
            '.route-snippet-view._type_masstransit[aria-current="step"] .masstransit-route-snippet-view__route-duration',
            '.route-snippet-view._type_masstransit[aria-hidden="false"] .masstransit-route-snippet-view__route-duration',
            '.route-list-view._travel-mode_masstransit .route-snippet-view._active .masstransit-route-snippet-view__route-duration',
            ".masstransit-route-snippet-view__route-duration",
            '.route-snippet-view._type_masstransit[aria-label*="На общественном транспорте"]',
            '.route-list-view [aria-label*="На общественном транспорте"]',
            '[aria-label*="На общественном транспорте"]',
        ]

        for selector in selectors:
            for node in soup.select(selector):
                candidate = extract_duration_from_text(
                    node.get("aria-label") or node.get_text(" ", strip=True)
                )
                if candidate:
                    return candidate, selector

    text = html_to_text(html)
    lines = [normalize_text(line) for line in text.splitlines() if normalize_text(line)]

    for index, line in enumerate(lines):
        candidate = extract_duration_from_text(line)
        if not candidate:
            continue

        around = " ".join(
            part
            for part in [lines[index - 1] if index - 1 >= 0 else "", line, lines[index + 1] if index + 1 < len(lines) else "", lines[index + 2] if index + 2 < len(lines) else ""]
            if part
        ).lower()
        if "пешком" in around or "проезд" in around:
            continue

        return candidate, "body text"

    body_match = re.search(
        r"(?:(?:\d+\s*д\s*)?(?:\d+\s*ч\s*)?(?:\d+\s*мин(?:ут)?(?:\s*\d+\s*сек(?:унд(?:ы)?)?)?))|(?:\d+\s*ч(?:\s*\d+\s*мин(?:ут)?)?)|(?:\d+\s*мин(?:ут)?)|(?:\d+\s*сек(?:унд(?:ы)?)?)",
        text,
        flags=re.IGNORECASE,
    )
    if body_match:
        candidate = extract_duration_from_text(body_match.group(0))
        if candidate:
            return candidate, "body regex"

    return "", ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Headless Crawl4AI runner for Yandex Maps transit times."
    )
    parser.add_argument(
        "input",
        nargs="?",
        default="",
        help="Path to a JSON file with Avito items or a raw JSON array string.",
    )
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT),
        help=f"Where to write the augmented JSON (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--timeout-ms",
        type=int,
        default=DEFAULT_TIMEOUT_MS,
        help=f"Page timeout in milliseconds (default: {DEFAULT_TIMEOUT_MS})",
    )
    parser.add_argument(
        "--delay-ms",
        type=int,
        default=DEFAULT_DELAY_MS,
        help=f"Delay between jobs in milliseconds (default: {DEFAULT_DELAY_MS})",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run the browser with a visible window for debugging.",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Force headless mode explicitly.",
    )
    parser.add_argument(
        "--save-html",
        action="store_true",
        help="Save raw HTML for each job into the output directory for debugging.",
    )
    parser.add_argument(
        "--proxy",
        default="",
        help="Proxy URL for the browser, for example http://user:pass@host:port.",
    )
    parser.add_argument(
        "--api-url",
        default="",
        help="Worker API URL for api mode, for example http://127.0.0.1:8787.",
    )
    parser.add_argument(
        "--worker-id",
        default="",
        help="Optional worker id used in api mode.",
    )
    parser.add_argument(
        "--worker-poll-ms",
        type=int,
        default=DEFAULT_WORKER_POLL_MS,
        help=f"Delay between worker API polls in milliseconds (default: {DEFAULT_WORKER_POLL_MS}).",
    )
    parser.add_argument(
        "--api-timeout-ms",
        type=int,
        default=DEFAULT_API_TIMEOUT_MS,
        help=f"HTTP timeout for worker API calls in milliseconds (default: {DEFAULT_API_TIMEOUT_MS}).",
    )
    return parser.parse_args()


async def fetch_route_duration(
    crawler: AsyncWebCrawler,
    job: dict[str, Any],
    timeout_ms: int,
    proxy_config: ProxyConfig | None = None,
) -> tuple[str, str, str]:
    url = encode_route_url(job["origin"], job["destination"])
    run_config_kwargs: dict[str, Any] = {
        "cache_mode": CacheMode.BYPASS,
        "page_timeout": timeout_ms,
        "wait_for": (
            'js:() => document.querySelector(".masstransit-route-snippet-view__route-duration") '
            '|| /маршрут не найден|время не найдено|ничего не найдено/i.test(document.body?.innerText || "")'
        ),
        "js_code": JOB_WAIT_JS,
        "remove_overlay_elements": True,
        "delay_before_return_html": 0.5,
    }
    if proxy_config is not None:
        run_config_kwargs["proxy_config"] = proxy_config

    run_config = CrawlerRunConfig(**run_config_kwargs)
    result = await crawler.arun(url=url, config=run_config)
    html = result.html or result.cleaned_html or ""
    duration, source = extract_duration_from_html(html)
    return duration, source, html


async def process_items(
    items: list[dict[str, Any]],
    output_path: Path | None,
    timeout_ms: int,
    delay_ms: int,
    save_html: bool,
    headless: bool,
    proxy_config: ProxyConfig | None = None,
    progress_tracker: WorkerProgressTracker | None = None,
) -> list[dict[str, Any]]:
    jobs = build_jobs(items)
    if not jobs:
        raise ValueError("Не нашёл объектов с полем adress, address или адрес.")

    browser_config = BrowserConfig(
        headless=headless,
        enable_stealth=True,
        viewport_width=DEFAULT_VIEWPORT_WIDTH,
        viewport_height=DEFAULT_VIEWPORT_HEIGHT,
        user_agent=DEFAULT_USER_AGENT,
    )

    html_dir = None
    if save_html and output_path is not None:
        html_dir = output_path.parent / f"{output_path.stem}_html"
        html_dir.mkdir(parents=True, exist_ok=True)

    result_items = deepcopy(items)
    total = len(jobs)

    async with AsyncWebCrawler(config=browser_config) as crawler:
        for index, job in enumerate(jobs, start=1):
            item_index = job["itemIndex"]
            print(
                f"[{index}/{total}] объект {item_index + 1}, {job['destinationLabel']}: "
                f"{job['origin']} -> {job['destination']}"
            )

            if progress_tracker is not None:
                await progress_tracker.set_job(job)

            try:
                duration, source, html = await fetch_route_duration(
                    crawler,
                    job,
                    timeout_ms,
                    proxy_config=proxy_config,
                )
            except Exception as exc:
                duration = "время не найдено"
                source = f"error: {exc}"
                html = ""
                print(f"  ! ошибка: {exc}")

            if not duration:
                duration = "время не найдено"

            result_items[item_index][job["destinationKey"]] = duration
            print(f"  = {duration} ({source or 'no source'})")

            if progress_tracker is not None:
                await progress_tracker.mark_route_done(job)

            if save_html and html and html_dir is not None:
                html_name = f"{index:04d}_item_{item_index + 1}_{job['destinationKey']}.html"
                (html_dir / html_name).write_text(html, encoding="utf-8")

            if delay_ms > 0 and index < total:
                await asyncio.sleep(delay_ms / 1000)

    if output_path is not None:
        output_path.write_text(
            json.dumps(result_items, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    return result_items


def resolve_headless(args: argparse.Namespace) -> bool:
    if args.headed:
        return False
    if args.headless:
        return True
    return DEFAULT_HEADLESS


def resolve_proxy_config(proxy_value: str) -> ProxyConfig | None:
    proxy_text = str(proxy_value or "").strip()
    if not proxy_text:
        return None

    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", proxy_text):
        proxy_text = f"http://{proxy_text}"

    return ProxyConfig.from_string(proxy_text)


def normalize_api_url(api_url: str) -> str:
    text = normalize_text(api_url)
    if not text:
        return ""

    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("API URL must start with http:// or https://")

    return text.rstrip("/")


def api_request_json(
    api_url: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    timeout_ms: int = DEFAULT_API_TIMEOUT_MS,
) -> dict[str, Any] | None:
    url = f"{api_url.rstrip('/')}{path}"
    data = None
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    request = urllib.request.Request(
        url=url,
        data=data,
        headers=headers,
        method=method.upper(),
    )

    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=max(1, timeout_ms) / 1000) as response:
            raw = response.read().decode("utf-8").strip()
            if not raw:
                return None
            return json.loads(raw)
    except HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace").strip()
        message = raw
        if raw:
            try:
                payload = json.loads(raw)
                message = payload.get("error") or payload.get("message") or raw
            except Exception:
                message = raw
        raise RuntimeError(f"API HTTP {error.code}: {message or error.reason}") from error
    except URLError as error:
        reason = getattr(error, "reason", None)
        raise RuntimeError(f"API request failed: {reason or error}") from error


async def api_request_json_async(
    api_url: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    timeout_ms: int = DEFAULT_API_TIMEOUT_MS,
) -> dict[str, Any] | None:
    return await asyncio.to_thread(api_request_json, api_url, method, path, body, timeout_ms)


@dataclass
class WorkerProgressTracker:
    items: list[dict[str, Any]]
    jobs: list[dict[str, Any]]
    started_at_iso: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    started_monotonic: float = field(default_factory=time.monotonic)
    routes_total: int = field(init=False)
    routes_done: int = 0
    current_job_id: str | None = None
    current_item_index: int | None = None
    last_error: str = ''

    def __post_init__(self) -> None:
        self.routes_total = len(self.jobs)
        self._routes_by_item = Counter(job['itemIndex'] for job in self.jobs)
        self._routes_done_by_item = defaultdict(int)
        self._completed_items: set[int] = set()
        self._items_with_routes = set(self._routes_by_item.keys())
        self._items_total = len(self.items)
        self._lock = asyncio.Lock()

    async def set_job(self, job: dict[str, Any] | None) -> None:
        async with self._lock:
            self.current_job_id = str(job.get('jobId') or '').strip() if job else None
            self.current_item_index = job.get('itemIndex') + 1 if job and isinstance(job.get('itemIndex'), int) else None

    async def mark_route_done(self, job: dict[str, Any], error: str = '') -> dict[str, Any]:
        item_index = int(job.get('itemIndex') or 0)
        async with self._lock:
            self.routes_done = min(self.routes_total, self.routes_done + 1)
            self._routes_done_by_item[item_index] += 1
            if self._routes_done_by_item[item_index] >= self._routes_by_item[item_index]:
                self._completed_items.add(item_index)
            self.current_item_index = item_index + 1
            self.last_error = error
            return self._snapshot_locked()

    async def snapshot(self, current_status: str = 'ready') -> dict[str, Any]:
        async with self._lock:
            return self._build_payload_locked(current_status)

    def _snapshot_locked(self) -> dict[str, Any]:
        return self._build_payload_locked('busy' if self.current_job_id else 'ready')

    def _build_payload_locked(self, current_status: str) -> dict[str, Any]:
        skipped_items = self._items_total - len(self._items_with_routes)
        objects_done = skipped_items + len(self._completed_items)
        objects_done = max(0, min(objects_done, self._items_total))
        elapsed_ms = max(0, int((time.monotonic() - self.started_monotonic) * 1000))
        return {
            'objectsDone': objects_done,
            'objectsTotal': self._items_total,
            'objectsRemaining': max(0, self._items_total - objects_done),
            'routesDone': self.routes_done,
            'routesTotal': self.routes_total,
            'routesRemaining': max(0, self.routes_total - self.routes_done),
            'currentObjectIndex': self.current_item_index,
            'elapsedMs': elapsed_ms,
            'startedAt': self.started_at_iso,
            'status': current_status,
            'currentJobId': self.current_job_id,
            'lastError': self.last_error,
        }


def make_worker_progress(items: list[dict[str, Any]], routes_done: int = 0) -> dict[str, Any]:
    objects_total = len(items)
    routes_total = objects_total * len(DESTINATIONS)
    routes_done = max(0, min(int(routes_done), routes_total))
    objects_done = objects_total if routes_total and routes_done >= routes_total else 0
    current_object_index = None if not routes_total or routes_done >= routes_total else 1

    return {
        "objectsDone": objects_done,
        "objectsTotal": objects_total,
        "objectsRemaining": max(0, objects_total - objects_done),
        "routesDone": routes_done,
        "routesTotal": routes_total,
        "routesRemaining": max(0, routes_total - routes_done),
        "currentObjectIndex": current_object_index,
    }


def make_worker_id() -> str:
    return f"worker-{os.urandom(4).hex()}"


async def run_api_worker(
    api_url: str,
    timeout_ms: int,
    delay_ms: int,
    save_html: bool,
    headless: bool,
    proxy_config: ProxyConfig | None,
    worker_poll_ms: int,
    api_timeout_ms: int,
    worker_id: str | None = None,
) -> int:
    worker_id_value = normalize_text(worker_id) or make_worker_id()
    worker_path = f"/api/workers/{quote(worker_id_value, safe='')}"

    print(f"API worker mode started: {worker_id_value}")
    print(f"API URL: {api_url}")

    try:
        api_request_json(api_url, "POST", f"{worker_path}/resume", timeout_ms=api_timeout_ms)
    except Exception as exc:
        print(f"Не удалось подключиться к API: {exc}", file=sys.stderr)
        return 1

    while True:
        try:
            heartbeat_payload = api_request_json(
                api_url,
                "POST",
                "/api/workers/heartbeat",
                {
                    "workerId": worker_id_value,
                    "name": "Crawl4AI Yandex worker",
                    "status": "ready",
                    "currentJobId": None,
                    "progress": make_worker_progress([], 0),
                },
                timeout_ms=api_timeout_ms,
            )

            if heartbeat_payload and heartbeat_payload.get("command") == "delete":
                print("Job deleted by API, exiting worker.")
                return 0
            if heartbeat_payload and heartbeat_payload.get("command") == "stop":
                print("Stop requested by API, exiting worker.")
                return 0

            payload = api_request_json(
                api_url,
                "GET",
                f"{worker_path}/job",
                timeout_ms=api_timeout_ms,
            ) or {}

            if payload.get("command") == "delete":
                print("API requested job delete, exiting worker.")
                return 0
            if payload.get("command") == "stop":
                print("API requested stop, exiting worker.")
                return 0

            job = payload.get("job")
            if not job:
                await asyncio.sleep(max(1, worker_poll_ms) / 1000)
                continue

            job_id = str(job.get("jobId") or "").strip()
            items = job.get("items") if isinstance(job.get("items"), list) else []
            print(f"Received API job {job_id}: {len(items)} items.")

            try:
                api_request_json(
                    api_url,
                    "POST",
                    "/api/workers/heartbeat",
                    {
                        "workerId": worker_id_value,
                        "name": "Crawl4AI Yandex worker",
                        "status": "busy",
                        "currentJobId": job_id,
                        "progress": make_worker_progress(items, 0),
                    },
                    timeout_ms=api_timeout_ms,
                )
            except Exception as exc:
                print(f"Не удалось отправить busy heartbeat: {exc}", file=sys.stderr)

            try:
                result_items = await process_items(
                    items=[item for item in items if isinstance(item, dict)],
                    output_path=None,
                    timeout_ms=timeout_ms,
                    delay_ms=delay_ms,
                    save_html=save_html,
                    headless=headless,
                    proxy_config=proxy_config,
                )
            except Exception as exc:
                error_message = str(exc) or exc.__class__.__name__
                print(f"API job {job_id} failed: {error_message}", file=sys.stderr)
                try:
                    api_request_json(
                        api_url,
                        "POST",
                        f"/api/jobs/{quote(job_id, safe='')}/fail",
                        {
                            "workerId": worker_id_value,
                            "error": error_message,
                        },
                        timeout_ms=api_timeout_ms,
                    )
                except Exception as fail_exc:
                    print(f"Не удалось отправить fail в API: {fail_exc}", file=sys.stderr)
                await asyncio.sleep(max(1, worker_poll_ms) / 1000)
                continue

            try:
                api_request_json(
                    api_url,
                    "POST",
                    f"/api/jobs/{quote(job_id, safe='')}/result",
                    {
                        "workerId": worker_id_value,
                        "items": result_items,
                    },
                    timeout_ms=api_timeout_ms,
                )
                print(f"Submitted API job {job_id}.")
            except Exception as exc:
                error_message = str(exc) or exc.__class__.__name__
                print(f"Не удалось отправить результат для job {job_id}: {error_message}", file=sys.stderr)
                if "deleted" in error_message.lower() or "410" in error_message:
                    print("Job was deleted remotely, continuing.")
                else:
                    await asyncio.sleep(max(1, worker_poll_ms) / 1000)
                    continue

            try:
                api_request_json(
                    api_url,
                    "POST",
                    "/api/workers/heartbeat",
                    {
                        "workerId": worker_id_value,
                        "name": "Crawl4AI Yandex worker",
                        "status": "ready",
                        "currentJobId": None,
                        "progress": make_worker_progress(result_items, len(result_items) * len(DESTINATIONS)),
                    },
                    timeout_ms=api_timeout_ms,
                )
            except Exception as exc:
                print(f"Не удалось отправить heartbeat: {exc}", file=sys.stderr)

        except KeyboardInterrupt:
            print("Worker interrupted.")
            return 0
        except Exception as exc:
            print(f"Worker API error: {exc}", file=sys.stderr)
            await asyncio.sleep(max(1, worker_poll_ms) / 1000)

    return 0


async def run_api_worker_connected(
    api_url: str,
    timeout_ms: int,
    delay_ms: int,
    save_html: bool,
    headless: bool,
    proxy_config: ProxyConfig | None,
    worker_poll_ms: int,
    api_timeout_ms: int,
    worker_id: str | None = None,
) -> int:
    worker_id_value = normalize_text(worker_id) or make_worker_id()
    worker_path = f"/api/workers/{quote(worker_id_value, safe='')}"
    worker_name = "Crawl4AI Yandex worker"
    heartbeat_interval_ms = 5000
    worker_started_at = datetime.now(timezone.utc).isoformat()
    worker_started_monotonic = time.monotonic()
    state_lock = asyncio.Lock()
    shared_state: dict[str, Any] = {
        "tracker": None,
        "status": "ready",
        "current_job_id": None,
        "last_error": "",
    }
    stop_event = asyncio.Event()

    print(f"API worker mode started: {worker_id_value}")
    print(f"API URL: {api_url}")

    def build_idle_progress(status: str = "ready", current_job_id: str | None = None, last_error: str = "") -> dict[str, Any]:
        elapsed_ms = max(0, int((time.monotonic() - worker_started_monotonic) * 1000))
        return {
            "objectsDone": 0,
            "objectsTotal": 0,
            "objectsRemaining": 0,
            "routesDone": 0,
            "routesTotal": 0,
            "routesRemaining": 0,
            "currentObjectIndex": None,
            "elapsedMs": elapsed_ms,
            "startedAt": worker_started_at,
            "status": status,
            "currentJobId": current_job_id,
            "lastError": last_error,
        }

    async def set_state(**updates: Any) -> None:
        async with state_lock:
            shared_state.update(updates)

    async def get_state_snapshot() -> tuple[WorkerProgressTracker | None, str, str | None, str]:
        async with state_lock:
            tracker = shared_state["tracker"]
            status = str(shared_state["status"] or "ready")
            current_job_id = shared_state["current_job_id"]
            last_error = str(shared_state["last_error"] or "")
        return tracker, status, current_job_id, last_error

    async def build_heartbeat_payload() -> dict[str, Any]:
        tracker, status, current_job_id, last_error = await get_state_snapshot()
        if tracker is None:
            progress = build_idle_progress(status=status, current_job_id=current_job_id, last_error=last_error)
        else:
            progress = await tracker.snapshot(current_status=status)
            progress["status"] = status
            progress["currentJobId"] = current_job_id
            progress["lastError"] = last_error or progress.get("lastError") or ""

        return {
            "workerId": worker_id_value,
            "name": worker_name,
            "status": status,
            "currentJobId": current_job_id,
            "progress": progress,
        }

    async def send_heartbeat() -> dict[str, Any] | None:
        payload = await build_heartbeat_payload()
        try:
            response = await api_request_json_async(
                api_url,
                "POST",
                "/api/workers/heartbeat",
                payload,
                timeout_ms=api_timeout_ms,
            )
            if response and response.get("command") in {"delete", "stop"}:
                print(f"API requested {response['command']} for worker {worker_id_value}.")
                stop_event.set()
            return response
        except Exception as exc:
            print(f"Heartbeat error: {exc}", file=sys.stderr)
            return None

    async def request_json_with_retry(
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        label: str,
        allow_deleted: bool = False,
    ) -> dict[str, Any] | None:
        retry_delay = max(1, worker_poll_ms) / 1000
        while not stop_event.is_set():
            try:
                return await api_request_json_async(api_url, method, path, body, timeout_ms=api_timeout_ms)
            except Exception as exc:
                message = str(exc)
                lowered = message.lower()
                if allow_deleted and ("410" in message or "deleted" in lowered):
                    return {"deleted": True, "message": message}
                print(f"{label} error: {exc}", file=sys.stderr)
                await asyncio.sleep(retry_delay)
        return None

    async def heartbeat_loop() -> None:
        try:
            while not stop_event.is_set():
                await send_heartbeat()
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=heartbeat_interval_ms / 1000)
                except asyncio.TimeoutError:
                    continue
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"Heartbeat loop error: {exc}", file=sys.stderr)

    heartbeat_task = asyncio.create_task(heartbeat_loop())

    try:
        resume_payload = await request_json_with_retry(
            "POST",
            f"{worker_path}/resume",
            label="Resume request",
        )
        if stop_event.is_set():
            return 0
        if resume_payload is None:
            print("Worker stopped before resume completed.")
            return 1

        await send_heartbeat()

        while not stop_event.is_set():
            payload = await request_json_with_retry(
                "GET",
                f"{worker_path}/job",
                label="Job poll",
            )
            if stop_event.is_set():
                break
            if payload is None:
                await asyncio.sleep(max(1, worker_poll_ms) / 1000)
                continue

            if payload.get("command") == "delete":
                print("API requested job delete, exiting worker.")
                return 0
            if payload.get("command") == "stop":
                print("API requested stop, exiting worker.")
                return 0

            job = payload.get("job")
            if not job:
                await set_state(tracker=None, status="ready", current_job_id=None, last_error="")
                await asyncio.sleep(max(1, worker_poll_ms) / 1000)
                continue

            job_id = str(job.get("jobId") or "").strip()
            raw_items = job.get("items") if isinstance(job.get("items"), list) else []
            items = [item for item in raw_items if isinstance(item, dict)]

            await set_state(tracker=None, status="busy", current_job_id=job_id, last_error="")
            print(f"Received API job {job_id}: {len(items)} items.")

            if not items:
                result_items: list[dict[str, Any]] = []
            else:
                tracker = WorkerProgressTracker(items=items, jobs=build_jobs(items))
                await set_state(tracker=tracker, status="busy", current_job_id=job_id, last_error="")

                try:
                    result_items = await process_items(
                        items=items,
                        output_path=None,
                        timeout_ms=timeout_ms,
                        delay_ms=delay_ms,
                        save_html=save_html,
                        headless=headless,
                        proxy_config=proxy_config,
                        progress_tracker=tracker,
                    )
                except Exception as exc:
                    error_message = str(exc) or exc.__class__.__name__
                    await set_state(status="busy", current_job_id=job_id, last_error=error_message)
                    print(f"API job {job_id} failed: {error_message}", file=sys.stderr)
                    fail_response = await request_json_with_retry(
                        "POST",
                        f"/api/jobs/{quote(job_id, safe='')}/fail",
                        body={
                            "workerId": worker_id_value,
                            "error": error_message,
                        },
                        label=f"Fail submit for job {job_id}",
                        allow_deleted=True,
                    )
                    if fail_response and fail_response.get("deleted"):
                        print(f"Job {job_id} was already deleted remotely.")
                    await set_state(tracker=None, status="ready", current_job_id=None, last_error="")
                    await send_heartbeat()
                    await asyncio.sleep(max(1, worker_poll_ms) / 1000)
                    continue

            await set_state(status="busy", current_job_id=job_id, last_error="")
            result_response = await request_json_with_retry(
                "POST",
                f"/api/jobs/{quote(job_id, safe='')}/result",
                body={
                    "workerId": worker_id_value,
                    "items": result_items,
                },
                label=f"Result submit for job {job_id}",
                allow_deleted=True,
            )
            if result_response and result_response.get("deleted"):
                print(f"Job {job_id} was already deleted remotely.")
            else:
                print(f"Submitted API job {job_id}.")

            await set_state(tracker=None, status="ready", current_job_id=None, last_error="")
            await send_heartbeat()
            await asyncio.sleep(max(1, worker_poll_ms) / 1000)

        return 0
    except KeyboardInterrupt:
        print("Worker interrupted.")
        return 0
    finally:
        stop_event.set()
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task


async def main_async() -> int:
    args = parse_args()
    headless = resolve_headless(args)

    try:
        api_url = normalize_api_url(args.api_url) if args.api_url else ""
    except Exception as exc:
        print(f"Invalid API URL: {exc}", file=sys.stderr)
        return 1

    if api_url:
        try:
            proxy_config = resolve_proxy_config(args.proxy)
        except Exception as exc:
            print(f"Invalid proxy value: {exc}", file=sys.stderr)
            return 1

        try:
            worker_id = normalize_text(args.worker_id) or make_worker_id()
        except Exception as exc:
            print(f"Invalid worker id: {exc}", file=sys.stderr)
            return 1

        return await run_api_worker_connected(
            api_url=api_url,
            timeout_ms=args.timeout_ms,
            delay_ms=args.delay_ms,
            save_html=args.save_html,
            headless=headless,
            proxy_config=proxy_config,
            worker_poll_ms=args.worker_poll_ms,
            api_timeout_ms=args.api_timeout_ms,
            worker_id=worker_id,
        )

    try:
        if not args.input:
            raise ValueError("Input is required unless --api-url is provided.")
        items = load_items(args.input)
    except Exception as exc:
        print(f"Не удалось прочитать входные данные: {exc}", file=sys.stderr)
        return 1

    try:
        proxy_config = resolve_proxy_config(args.proxy)
    except Exception as exc:
        print(f"Invalid proxy value: {exc}", file=sys.stderr)
        return 1

    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    print(
        f"Запуск Crawl4AI в {'headless' if headless else 'headed'}-режиме. "
        f"Элементов: {len(items)}. Результат: {output_path}"
    )
    if proxy_config is not None:
        print(f"Proxy: {str(args.proxy).strip()}")

    try:
        await process_items(
            items=items,
            output_path=output_path,
            timeout_ms=args.timeout_ms,
            delay_ms=args.delay_ms,
            save_html=args.save_html,
            headless=headless,
            proxy_config=proxy_config,
        )
    except Exception as exc:
        print(f"Сбой обработки: {exc}", file=sys.stderr)
        return 1

    print(f"Готово: {output_path}")
    return 0


def main() -> None:
    raise SystemExit(asyncio.run(main_async()))


if __name__ == "__main__":
    main()
