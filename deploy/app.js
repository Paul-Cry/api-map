import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const INDEX_PATH = join(__dirname, "index.html");

const FAVORITES_MARKER = "data-favorites-export";

function enhanceHtml(html) {
  if (html.includes(FAVORITES_MARKER)) {
    return html;
  }

  const favoritesCss = `
<style ${FAVORITES_MARKER}>
.favoritesBar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px;padding:12px;border:1px solid var(--line);border-radius:10px;background:#fff;box-shadow:0 8px 22px rgba(26,39,58,.07)}
.favoritesCount{font-weight:800;color:#0f5132;margin-right:auto}
.favoritesBtn{height:38px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--text);padding:0 13px;font-weight:800;cursor:pointer}
.favoritesBtn.primary{border-color:var(--accent);background:var(--accent);color:#fff}
.favoritesBtn:disabled{opacity:.45;cursor:not-allowed}
.favoriteCell{min-width:118px}
.favoriteLabel{display:inline-flex;align-items:center;gap:8px;font-weight:800;color:#334155;cursor:pointer}
.favoriteLabel input{width:18px;height:18px;accent-color:var(--accent)}
tbody tr.favoriteSelected{background:#eef8ff}
tbody tr.favoriteSelected:hover{background:#e5f3ff}
@media(max-width:900px){.favoritesBar{position:sticky;top:0;z-index:8}.favoritesCount{width:100%;margin-right:0}.favoritesBtn{flex:1}.favoriteLabel{justify-content:space-between;width:100%}.favoriteLabel input{width:22px;height:22px}}
</style>`;

  const favoritesPanel = `
<div class="favoritesBar" ${FAVORITES_MARKER}>
  <div class="favoritesCount" id="favoritesCount">Выбрано: 0</div>
  <button class="favoritesBtn primary" id="downloadFavorites" type="button" disabled>Скачать JSON</button>
  <button class="favoritesBtn" id="clearFavorites" type="button" disabled>Сбросить выбор</button>
</div>`;

  const favoritesScript = `
<script ${FAVORITES_MARKER}>
(() => {
  const table = document.getElementById("tbl");
  if (!table || table.dataset.favoritesReady === "1") return;
  table.dataset.favoritesReady = "1";

  const moneyToNumber = (text) => {
    const match = String(text || "").replace(/\\u00a0/g, " ").match(/\\d[\\d\\s]*/);
    return match ? Number(match[0].replace(/\\s/g, "")) : 0;
  };

  const minutesToNumber = (text) => {
    const value = String(text || "");
    const hours = value.match(/(\\d+)\\s*ч/);
    const minutes = value.match(/(\\d+)\\s*мин/);
    if (!hours && !minutes) return null;
    return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  };

  const selectedRows = () =>
    [...table.querySelectorAll(".favoriteCheck:checked")]
      .map((checkbox) => checkbox.closest("tr"))
      .filter(Boolean);

  const updateUi = () => {
    const rows = selectedRows();
    const count = document.getElementById("favoritesCount");
    const download = document.getElementById("downloadFavorites");
    const clear = document.getElementById("clearFavorites");

    if (count) count.textContent = "Выбрано: " + rows.length;
    if (download) download.disabled = rows.length === 0;
    if (clear) clear.disabled = rows.length === 0;

    table.querySelectorAll("tbody tr").forEach((row) => {
      row.classList.toggle("favoriteSelected", Boolean(row.querySelector(".favoriteCheck:checked")));
    });
  };

  const addSelectionControls = () => {
    const headRow = table.querySelector("thead tr");
    if (headRow && !headRow.querySelector(".favoriteHead")) {
      const th = document.createElement("th");
      th.className = "favoriteHead";
      th.textContent = "Выбор";
      headRow.prepend(th);
    }

    table.querySelectorAll("tbody tr").forEach((row) => {
      if (row.querySelector(".favoriteCheck")) return;

      const rank = row.dataset.rank || row.querySelector(".rank")?.textContent?.trim() || "";
      const cell = document.createElement("td");
      cell.className = "favoriteCell";
      cell.dataset.label = "Выбор";
      cell.innerHTML =
        '<label class="favoriteLabel"><span>Нравится</span><input class="favoriteCheck" type="checkbox" aria-label="Выбрать квартиру #' +
        rank +
        '"></label>';
      row.prepend(cell);
    });
  };

  const getCells = (row) => [...row.children].filter((cell) => !cell.classList.contains("favoriteCell"));

  const apartmentFromRow = (row) => {
    const cells = getCells(row);
    const commuteText = cells[8]?.innerText || "";
    const commuteLines = commuteText.split("\\n").map((line) => line.trim()).filter(Boolean);
    const link = row.querySelector("a.openBtn, a[href]");

    return {
      rank: Number(row.dataset.rank || row.querySelector(".rank")?.textContent || 0),
      grade: row.dataset.grade || row.querySelector(".grade")?.textContent?.trim() || "",
      score: Number.parseFloat(row.querySelector(".score")?.textContent || "0"),
      title: row.querySelector(".title")?.textContent?.trim() || "",
      address: row.querySelector(".address")?.textContent?.trim() || "",
      terms: row.querySelector(".terms")?.textContent?.trim() || "",
      total_for_3_months_rub: moneyToNumber(cells[3]?.innerText),
      monthly_payment_rub: moneyToNumber(cells[4]?.innerText),
      deposit_rub: moneyToNumber(cells[5]?.innerText),
      commission_rub: moneyToNumber(cells[6]?.innerText),
      utilities_rub: moneyToNumber(cells[7]?.innerText),
      commute_to_rodina: commuteLines[0]?.replace("Родина:", "").trim() || "",
      commute_to_oli_work: commuteLines[1]?.replace("Работа Оли:", "").trim() || "",
      commute_to_rodina_min: minutesToNumber(commuteLines[0]),
      commute_to_oli_work_min: minutesToNumber(commuteLines[1]),
      comment: cells[9]?.innerText?.trim() || "",
      url: link?.href || "",
    };
  };

  const downloadJson = () => {
    const apartments = selectedRows().map(apartmentFromRow);
    const payload = {
      created_at: new Date().toISOString(),
      count: apartments.length,
      apartments,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "selected-apartments.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  addSelectionControls();
  table.addEventListener("change", (event) => {
    if (event.target.classList.contains("favoriteCheck")) updateUi();
  });
  document.getElementById("downloadFavorites")?.addEventListener("click", downloadJson);
  document.getElementById("clearFavorites")?.addEventListener("click", () => {
    table.querySelectorAll(".favoriteCheck:checked").forEach((checkbox) => {
      checkbox.checked = false;
    });
    updateUi();
  });
  updateUi();
})();
</script>`;

  return html
    .replace("</head>", `${favoritesCss}</head>`)
    .replace('<section class="tableShell">', `${favoritesPanel}<section class="tableShell">`)
    .replace("</body>", `${favoritesScript}</body>`);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, {
        "Content-Type": "text/plain; charset=utf-8",
        Allow: "GET, HEAD",
      });
      res.end("Method not allowed");
      return;
    }

    const html = enhanceHtml(await readFile(INDEX_PATH, "utf8"));
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    res.end(html);
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Server error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Apartments ranking is running at http://localhost:${PORT}`);
  console.log(`For VDS external access use http://SERVER_IP:${PORT}`);
});
