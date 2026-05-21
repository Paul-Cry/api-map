# Transit API и workers

Центральный API раздает JSON-массивы на несколько компьютеров-воркеров, следит кто подключен, кто свободен, показывает прогресс и собирает обработанные части обратно в один общий JSON.

## Структура

```text
transit-api/
  server.js   # центральный API-диспетчер
  README.md   # инструкция

yandex-map/
  yandex-maps-avito-transit.user.js # Tampermonkey worker
```

## Как запустить API

На главном компьютере:

```bash
npm run transit-api
```

По умолчанию API слушает:

```text
http://0.0.0.0:8787
```

Для других компьютеров в локальной сети используй IP главного компьютера:

```text
http://192.168.1.10:8787
```

Если workers не видят API, открой порт `8787` в firewall Windows.

## Как открыть интерфейс

На главном компьютере открой в браузере:

```text
http://127.0.0.1:8787/
```

Или:

```text
http://localhost:8787/
```

С другого компьютера в локальной сети открывай IP главного компьютера:

```text
http://192.168.1.10:8787/
```

В интерфейсе видно:

- сколько workers подключено;
- сколько workers свободно;
- какой worker сейчас занят;
- сколько объектов осталось каждому worker;
- прогресс по запущенным пачкам;
- загрузка JSON-файла;
- запуск обработки;
- скачивание объединенного результата.

## Как подключить worker

На каждом из 4 компьютеров:

1. Установи Tampermonkey.
2. Установи файл `yandex-map/yandex-maps-avito-transit.user.js`.
3. Открой Яндекс.Карты.
4. В панели `Avito Transit` включи `Worker mode`.
5. Укажи уникальный `worker id`, например:
   - `pc-1`
   - `pc-2`
   - `pc-3`
   - `pc-4`
6. В поле API URL укажи адрес главного API, например:

```text
http://192.168.1.10:8787
```

После этого worker будет сам подключаться к API, показываться в статусе, ждать задания, обрабатывать свою часть JSON и отправлять результат назад.

Worker отправляет в API прогресс:

- сколько объектов всего получил;
- сколько объектов уже обработал;
- сколько объектов осталось;
- сколько маршрутов уже обработал;
- сколько маршрутов осталось.

## Как посмотреть подключенных workers

```bash
curl http://127.0.0.1:8787/api/status
```

Ответ содержит:

- `workersConnected` - сколько workers сейчас подключено.
- `workersReady` - сколько workers готовы принять задание.
- `queuedJobs` - сколько частей JSON ждут обработки.
- `workers` - список workers с `workerId`, статусом и текущим заданием.
- `batches` - список запущенных пачек.

Пример:

```json
{
  "ok": true,
  "workersConnected": 4,
  "workersReady": 4,
  "queuedJobs": 0,
  "workers": [
    {
      "workerId": "pc-1",
      "status": "ready",
      "currentJobId": null,
      "ready": true
    }
  ]
}
```

## Как отправить JSON на обработку

Самый простой способ - через web-интерфейс:

1. Открой `http://127.0.0.1:8787/`.
2. Выбери `.json` файл.
3. Укажи количество частей, обычно `4`.
4. Нажми `Запустить обработку`.

Также можно отправить через curl.

Можно отправить объект с полем `items`:

```bash
curl -X POST http://127.0.0.1:8787/api/run ^
  -H "Content-Type: application/json" ^
  -d "{\"items\":[{\"adress\":\"Москва, Тверская 1\"}],\"workers\":4}"
```

Можно отправить и просто сырой JSON-массив:

```bash
curl -X POST http://127.0.0.1:8787/api/run ^
  -H "Content-Type: application/json" ^
  -d "[{\"adress\":\"Москва, Тверская 1\"}]"
```

API вернет `batchId`:

```json
{
  "ok": true,
  "batchId": "....",
  "jobsQueued": 4,
  "workersConnected": 4,
  "workersReady": 4
}
```

## Как получить результат

В web-интерфейсе у каждого batch есть кнопка `Скачать результат`.

Также можно скачать напрямую:

```bash
curl http://127.0.0.1:8787/api/batches/<batchId>/download -o transit-result.json
```

Или посмотреть полный batch:

```bash
curl http://127.0.0.1:8787/api/batches/<batchId>
```

Готовый общий массив лежит в:

```text
batch.resultItems
```

## Логика работы

1. Worker каждые несколько секунд отправляет heartbeat на `/api/workers/heartbeat`.
2. API запоминает worker как подключенный. Если heartbeat не было больше 45 секунд, worker считается отключенным.
3. Когда worker свободен, он вызывает `/api/workers/<workerId>/job`.
4. Если заданий нет, API отвечает `job: null`, worker продолжает ждать.
5. Когда ты отправляешь большой JSON на `/api/run`, API делит массив на части по количеству workers.
6. Каждая часть становится отдельным job.
7. Свободные workers забирают job, обрабатывают его через Яндекс.Карты и локальный userscript.
8. После обработки worker отправляет массив результата на `/api/jobs/<jobId>/result`.
9. API складывает результат в batch.
10. Когда все job завершены, весь массив доступен в `/api/batches/<batchId>`.

## Статусы worker

- `ready` - worker подключен и свободен.
- `busy` - worker сейчас обрабатывает job.

## Статусы job

- `queued` - job ждет свободного worker.
- `running` - job уже у worker.
- `done` - job завершен и результат принят.
- `failed` - worker сообщил об ошибке.

## Настройки API

Можно менять порт через переменную окружения:

```bash
set PORT=8788
npm run transit-api
```

Или:

```bash
set TRANSIT_API_PORT=8788
npm run transit-api
```

Время, после которого worker считается offline:

```bash
set WORKER_TTL_MS=45000
npm run transit-api
```
