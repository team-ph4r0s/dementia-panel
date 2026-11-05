# Подписки

Код — `server/src/routes/subscription.ts`, оформление — `services/subscription-settings.service.ts`,
лимиты — `services/subscription.service.ts`.

## Эндпоинт `GET /sub/:token`

Публичный, без авторизации; доступен по HTTP даже при включённом HTTPS (выданные ссылки не должны ломаться).
- Неизвестный токен — 404, выключенный подписчик — 403.
- Истёк срок или исчерпан лимит — 200 с пустым списком и заголовками (приложение покажет срок/трафик).
- В подписку попадают клиенты подписчика с `enabled = 1`, `external = 0`, не `pending:` и не `blocked` владельцем,
  на нодах со статусом не `uninstalled` (временно недоступная нода не пропадает из приложения).
- Порядок — `servers.sub_order`, имя — `servers.sub_name` или имя сервера; при включённой проверке доступности из стран к имени добавляются
  пометки ` · 🇷🇺✅ 🇰🇿❌` ([probes.md](probes.md)).
- **Мосты.** Если у подписчика задана страна (`subscribers.country`), а у ноды есть работающий мост в этой стране и он нужен (режим
  `always` или `auto` при недоступности ноды из страны), в конфигурации меняется только `Endpoint` — на адрес и порт моста, к имени
  добавляется ` · 🌉 🇷🇺`; ключи и параметры обфускации те же ([bridges.md](bridges.md)). Так во всех форматах.

## Форматы

Навигация в браузере (`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` и `Accept: text/html`)
без параметра `format` показывает HTML-страницу со статусом, сроком, трафиком, списком серверов и ссылками
на форматы. Распознанные клиенты mihomo сохраняют YAML, а явный параметр `format` сохраняет прежний выбор
формата даже в браузере. HTML не содержит клиентских конфигураций, не загружает внешние ресурсы и не кешируется.

| Формат | Как выбирается | Тело |
|---|---|---|
| Incy (по умолчанию) | `?format=awg`/`incy` или запрос, для которого не выбраны HTML и mihomo | base64 списка строк `awg://<base64url(.conf)>#<имя>` ([спецификация](https://docs.incy.cc/en/subscription-format/)) |
| JSON Incy | `?format=json` | `{"type":"amneziawg","version":1,"servers":[{"name","config":"<base64url .conf>"}]}` |
| mihomo | `?format=clash`/`mihomo` или UA `mihomo`, `clash-meta`, `clash-verge`, `flclash`, `clashmi`, `clash.party` | JSON (валидный YAML): `proxies` (`type: wireguard` + `amnezia-wg-option`), группа `Dementia`, `rules: MATCH,Dementia` |

В `[Peer]` строка `PresharedKey` (в mihomo — `pre-shared-key`) пишется только если у клиента или сервера есть PSK.
`AllowedIPs = 0.0.0.0/0, ::/0` — намеренно: у нод нет IPv6, и маршрут `::/0` в туннель не даёт IPv6-трафику клиента идти
мимо VPN (утечка реального адреса); так же настроены конфиги приложения AmneziaVPN. Не убирайте `::/0`.

### Приложения по платформам

Справочник показывается в панели («Оформление подписки» и окно ссылки подписки пользователя); данные —
`client/src/awgClients.ts`. Проверено в октябре 2026 — при изменениях в приложениях обновляйте файл и эту таблицу.

| Платформа | По ссылке подписки | Только вручную (.conf / QR клиента) |
|---|---|---|
| Windows | FlClash, Clash Verge Rev, Clash Party | AmneziaVPN, AmneziaWG |
| macOS | FlClash, Clash Verge Rev, Clash Party | AmneziaVPN, AmneziaWG |
| Linux | FlClash, Clash Verge Rev, Clash Party | AmneziaVPN, amneziawg-tools (`awg-quick`) |
| iPhone / iPad | **Incy** (единственный) | AmneziaVPN, AmneziaWG, DefaultVPN |
| Android | **Incy**, FlClash, Clash Meta for Android | AmneziaVPN, AmneziaWG, WG Tunnel |

- **Incy** принимает основную ссылку (`awg://`) и JSON-контейнер только на iOS и Android; настольная версия Incy AmneziaWG
  не поддерживает. Движок — amneziawg-go 3.1, параметры 3.x (`HeaderProtectionKey` и др.) понимает.
- **Клиенты mihomo** узнаются по User-Agent и получают YAML с `amnezia-wg-option` по основной ссылке (или `?format=clash`).
  AmneziaWG 3.x (`version: 3`, `header-protection-key`) — с ядра **mihomo 1.19.30** (август 2026); старые сборки
  подключаются только к нодам 1.x. На iPhone клиента mihomo с AmneziaWG нет: в Clash Mi ядро собрано без него.
- AmneziaVPN поддерживает AWG 3.x с версии 5.0.1.5; приложения Amnezia подписки по ссылке не принимают.
- Не подходят: Happ, v2rayN, v2rayNG (только Xray), Karing (нет AmneziaWG), Clash Mi (ядро без AmneziaWG), Hiddify
  (AmneziaWG заявлен, но формат подписок панели не принимает).

## Заголовки

| Заголовок | Источник |
|---|---|
| `Subscription-Userinfo` | `upload=total_rx; download=total_tx; total=traffic_limit; expire=unix` |
| `Profile-Title` | `base64:` + шаблон названия (`{user}` → имя), обрезка до 25 символов |
| `Profile-Update-Interval` | Часы (1–168, по умолчанию 12) |
| `Profile-Description`, `Announce` | `base64:` (объявление до 200 символов). Если включена проверка доступности из стран ([probes.md](probes.md)), к описанию добавляется строка с пояснением |
| `Announce-Url`, `Support-Url`, `Profile-Web-Page-Url` | URL, нормализованные в ASCII (`URL.href`) |
| `Support-Email`, `Sort-Order` (`ping`/`name`/`none`), `Hide-Url: 1` | Как есть |
| `Content-Disposition` | `contentDisposition('inline', '<имя>.txt|yaml')` |

**Только ASCII в заголовках** — иначе Node.js бросает `ERR_INVALID_CHAR`.

## Оформление

Страница «Оформление подписки» (`SubscriptionSettingsView.tsx`), API `GET/PUT /api/subscription-settings`
(`{ settings, servers: [{id, sub_name, sub_order}] }`). Значения хранятся в `settings` с префиксом `sub_`.

## Лимиты подписчиков

`traffic_limit` (байты) и `expire_at`. `SubscriptionService.refreshSuspension` (фоновая задача) выставляет
`suspended`, после чего клиенты подписчика снимаются с нод синхронизацией. Трафик подписчика — сумма по его клиентам.

## Сброс ссылки

`POST /api/subscribers/:id/reset-token` меняет токен **и перевыпускает ключи всех клиентов** подписчика (для нод
партнёра клиент создаётся заново). Иначе тот, кто скачал старую подписку, сохранил бы доступ.

## Публичный адрес

Ссылки строятся от `settings.public_url` или `window.location.origin` (настройка в «Безопасность → Настройки панели»).
