# Yandex Maps Avito Transit

Папка с двумя вариантами запуска расчета времени маршрута из адресов Avito до двух точек в Москве:

- `yandex-maps-avito-transit.user.js` - userscript для ручного запуска в браузере.
- `yandex-maps-avito-transit-headless.py` - headless/headed runner на `crawl4ai` с поддержкой `--proxy`.

Точки назначения:

- `Родина`: `55.764323,37.556119`
- `работа Оли`: `55.661195,37.508398`

## Userscript

Открыть страницу Яндекс.Карт:

```text
https://yandex.ru/maps/213/moscow/?ll=37.617700%2C55.755863&mode=routes&rtext=&rtt=mt&z=10
```

Установить `yandex-maps-avito-transit.user.js` в Tampermonkey, затем вставить JSON-массив объектов Avito и нажать `Старт`.

## Input format

```json
[
  {
    "title": "Квартира",
    "price": "50000",
    "adress": "Москва, улица Генерала Тюленева, 9"
  }
]
```

Скрипт читает поле `adress`, `address` или `адрес`.

## Output format

```json
[
  {
    "title": "Квартира",
    "price": "50000",
    "adress": "Москва, улица Генерала Тюленева, 9",
    "Родина": "54 мин",
    "работа Оли": "1 ч 12 мин"
  }
]
```

## Headless runner

Установить зависимости:

```bash
pip install crawl4ai
crawl4ai-setup
```

Пример запуска:

```bash
python scripts/yandex-map/yandex-maps-avito-transit-headless.py input.json --headless --proxy http://user:pass@ip:port
```

Полезные флаги:

- `--headless` - запуск без окна браузера.
- `--headed` - запуск с видимым окном для отладки.
- `--proxy http://user:pass@ip:port` - прокси для браузера.
- `--save-html` - сохранить HTML каждой страницы рядом с результатом.
- `--timeout-ms 60000` - увеличить ожидание страницы.
- `--delay-ms 250` - пауза между маршрутами.

Подробнее см. [`README-headless.md`](./README-headless.md).

## Удобный запуск через npm

Из корня проекта можно запускать так:

```bash
npm run menu
```

Это откроет интерактивное меню для Yandex Maps.

Если нужен прямой headless-запуск из npm, используй:

```bash
npm run yandex:headless -- input.json --headless
```

С прокси:

```bash
npm run yandex:headless -- input.json --headless --proxy http://user:pass@ip:port
```

Если PowerShell блокирует `npm.ps1`, используй обычные Windows-обертки из корня проекта:

```powershell
.\menu.cmd
.\yandex-headless.cmd input.json --headless
```

Если нужен именно npm-стиль из PowerShell, запускай `npm.cmd run menu` вместо `npm run menu`.

## Quick commands

From the project root:

```powershell
npm.cmd run yandex
npm.cmd run yandex:headless -- input.json
npm.cmd run yandex:api
```

For direct headless run with proxy:

```powershell
npm.cmd run yandex:headless -- input.json --proxy http://user:pass@ip:port
```

`yandex` opens the interactive launcher, `yandex:headless` starts the Python runner, and `yandex:api` starts the API worker mode.
