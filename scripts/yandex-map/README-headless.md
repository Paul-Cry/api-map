# Headless Yandex Maps Runner

`yandex-maps-avito-transit-headless.py` запускает Яндекс.Карты через `crawl4ai`, может работать в `headless` или `headed` режиме, поддерживает `stealth` по умолчанию и умеет принимать прокси через CLI.

## Запуск

```bash
python scripts/yandex-map/yandex-maps-avito-transit-headless.py input.json --output avito-transit-yandex-result.json
```

## Режимы

- `--headless` - принудительно запускать браузер без окна.
- `--headed` - показать окно браузера для отладки.
- `--proxy http://user:pass@ip:port` - запустить браузер через указанный прокси.
- `--save-html` - сохранить HTML каждой страницы рядом с результатом.
- `--timeout-ms 60000` - увеличить ожидание страницы.
- `--delay-ms 250` - пауза между маршрутами.

## Примеры

```bash
python scripts/yandex-map/yandex-maps-avito-transit-headless.py input.json --headless --proxy http://user:pass@127.0.0.1:8080
```

```bash
python scripts/yandex-map/yandex-maps-avito-transit-headless.py input.json --headed --proxy http://127.0.0.1:8080
```

## npm shortcuts

```powershell
npm.cmd run yandex
npm.cmd run yandex:headless -- input.json
npm.cmd run yandex:api
```

## Перед запуском

```bash
pip install crawl4ai
crawl4ai-setup
```
