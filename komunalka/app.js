const DEFAULTS = {
  readingDate: new Date().toISOString().slice(0, 10),
  resources: {
    electricDay: {
      label: "Электричество день",
      hint: "Т1 · 7:00-23:00 · кВт·ч",
      start: 6317.43,
      current: 6317.43,
      tariff: 8.74,
    },
    electricNight: {
      label: "Электричество ночь",
      hint: "Т2 · 23:00-7:00 · кВт·ч",
      start: 2162.33,
      current: 2162.33,
      tariff: 3.77,
    },
    hotWater: {
      label: "Горячая вода",
      hint: "ГВС КПУ · куб. м",
      start: 21.905,
      current: 21.905,
      tariff: 317.71,
    },
    coldWater: {
      label: "Холодная вода",
      hint: "ХВС КПУ · куб. м",
      start: 26.416,
      current: 26.416,
      tariff: 66.87,
    },
  },
  wastewaterTariff: 52.48,
};

const STORAGE_KEY = "komunalka-calculator-v1";
const money = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
});
const decimal = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 3,
});

const rows = document.querySelector("#resourceRows");
const form = document.querySelector("#calculator");
const grandTotal = document.querySelector("#grandTotal");
const breakdownList = document.querySelector("#breakdownList");
const dateInput = document.querySelector("#readingDate");
const resetButton = document.querySelector("#resetButton");
const lastSaved = document.querySelector("#lastSaved");

let state = loadState();

render();
calculate();

form.addEventListener("input", (event) => {
  const field = event.target;

  if (field.id === "readingDate") {
    state.readingDate = field.value;
  }

  if (field.dataset.resource && field.dataset.field) {
    const value = Number.parseFloat(field.value.replace(",", "."));
    state.resources[field.dataset.resource][field.dataset.field] =
      Number.isFinite(value) ? value : 0;
  }

  if (field.id === "wastewaterTariff") {
    const value = Number.parseFloat(field.value.replace(",", "."));
    state.wastewaterTariff = Number.isFinite(value) ? value : 0;
  }

  saveState();
  calculate();
});

resetButton.addEventListener("click", () => {
  state = structuredClone(DEFAULTS);
  saveState();
  render();
  calculate();
});

function loadState() {
  const stored = localStorage.getItem(STORAGE_KEY);

  if (!stored) {
    return structuredClone(DEFAULTS);
  }

  try {
    const parsed = JSON.parse(stored);
    return {
      ...structuredClone(DEFAULTS),
      ...parsed,
      resources: {
        ...structuredClone(DEFAULTS.resources),
        ...parsed.resources,
      },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  lastSaved.textContent = "Сохранено в этом браузере";
}

function render() {
  dateInput.value = state.readingDate;
  rows.innerHTML = "";

  Object.entries(state.resources).forEach(([key, resource]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <strong>${resource.label}</strong>
        <small>${resource.hint}</small>
      </td>
      <td class="number-cell">
        <input inputmode="decimal" data-resource="${key}" data-field="start" value="${resource.start}" aria-label="${resource.label}: старт" />
      </td>
      <td class="number-cell">
        <input inputmode="decimal" data-resource="${key}" data-field="current" value="${resource.current}" aria-label="${resource.label}: сейчас" />
      </td>
      <td class="usage" data-usage="${key}">0</td>
      <td class="number-cell">
        <input inputmode="decimal" data-resource="${key}" data-field="tariff" value="${resource.tariff}" aria-label="${resource.label}: тариф" />
      </td>
      <td class="money" data-total="${key}">0,00 ₽</td>
    `;
    rows.append(tr);
  });

  const wastewaterRow = document.createElement("tr");
  wastewaterRow.innerHTML = `
    <td>
      <strong>Водоотведение</strong>
      <small>ХВС + ГВС · куб. м</small>
    </td>
    <td></td>
    <td></td>
    <td class="usage" data-usage="wastewater">0</td>
    <td class="number-cell">
      <input id="wastewaterTariff" inputmode="decimal" value="${state.wastewaterTariff}" aria-label="Водоотведение: тариф" />
    </td>
    <td class="money" data-total="wastewater">0,00 ₽</td>
  `;
  rows.append(wastewaterRow);
}

function calculate() {
  const result = Object.entries(state.resources).reduce(
    (acc, [key, resource]) => {
      const rawUsage = resource.current - resource.start;
      const usage = Math.max(0, rawUsage);
      const total = usage * resource.tariff;

      acc.resources[key] = { usage, rawUsage, total };
      acc.total += total;

      return acc;
    },
    { resources: {}, total: 0 },
  );

  const waterUsage =
    result.resources.hotWater.usage + result.resources.coldWater.usage;
  const wastewaterTotal = waterUsage * state.wastewaterTariff;
  result.total += wastewaterTotal;

  Object.entries(result.resources).forEach(([key, item]) => {
    const usageCell = document.querySelector(`[data-usage="${key}"]`);
    const totalCell = document.querySelector(`[data-total="${key}"]`);

    usageCell.textContent = decimal.format(item.usage);
    usageCell.classList.toggle("warning", item.rawUsage < 0);
    totalCell.textContent = money.format(item.total);
  });

  document.querySelector('[data-usage="wastewater"]').textContent =
    decimal.format(waterUsage);
  document.querySelector('[data-total="wastewater"]').textContent =
    money.format(wastewaterTotal);

  grandTotal.textContent = money.format(result.total);
  renderBreakdown(result, wastewaterTotal);
}

function renderBreakdown(result, wastewaterTotal) {
  const electric =
    result.resources.electricDay.total + result.resources.electricNight.total;
  const water =
    result.resources.hotWater.total +
    result.resources.coldWater.total +
    wastewaterTotal;

  breakdownList.innerHTML = `
    <div class="break-row">
      <dt>Электричество</dt>
      <dd>${money.format(electric)}</dd>
    </div>
    <div class="break-row">
      <dt>Вода</dt>
      <dd>${money.format(water)}</dd>
    </div>
    <div class="break-row">
      <dt>День Т1</dt>
      <dd>${money.format(result.resources.electricDay.total)}</dd>
    </div>
    <div class="break-row">
      <dt>Ночь Т2</dt>
      <dd>${money.format(result.resources.electricNight.total)}</dd>
    </div>
  `;
}
