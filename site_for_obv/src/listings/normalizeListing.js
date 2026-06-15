export function normalizeListing(item, index = 0) {
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
    total: toNumber(get("total", "totalCost", "threeMonthTotal", "total_for_period")),
    monthly: toNumber(get("monthly", "monthlyCost", "rentMonthly", "rent_per_month")),
    deposit: toNumber(deposit),
    commission: toNumber(commission),
    utilities: toNumber(utilities),
    commuteHome: String(get("commuteHome", "home", "Родина") || ""),
    commuteWork: String(get("commuteWork", "work", "работа Оли") || ""),
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
