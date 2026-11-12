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
- **Запасные порты.** У ноды AmneziaWG с применёнными запасными портами следом за основной записью идут записи `<имя> · порт N` —
  тот же конфиг с другим портом в `Endpoint` ([node-management.md](node-management.md#extra-ports)).
- **Мосты.** Если у подписчика задана страна (`subscribers.country`), а у ноды есть работающий мост в этой стране и он нужен (режим
  `always` или `auto` при недоступности ноды из страны), в конфигурации меняется только `Endpoint` — на адрес и порт моста, к имени
  добавляется ` · 🌉 🇷🇺`; ключи и параметры обфускации те же ([bridges.md](bridges.md)). Так во всех форматах.

## Форматы

Навигация в браузере (`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` и `Accept: text/html`)
без параметра `format` показывает HTML-страницу со статусом, сроком, трафиком, списком серверов и ссылками
на форматы, кнопки «Добавить в приложение» (ссылки-схемы `incy://`, `hiddify://`, `v2rayng://`, `happ://`, `streisand://`,
`shadowrocket://`, `sing-box://`, `sn://` (NekoBox), `flclash://`, `clash://`; список и сборка — `utils/app-links.ts`; приложения подбираются по
протоколам подписки, платформа пользователя определяется скриптом и ставится первой) и поле с ссылкой для копирования. Схемы Incy и Hiddify сверены
с их документацией, остальные — общепринятые формы, схему Happ (`happ://add/`) проверить по документации не удалось. Адрес в кнопках —
`public_url` из настроек или адрес запроса. Скрипт страницы (копирование, платформа) отдаётся файлом `/sub/page.js`, потому что CSP запрещает
встроенные скрипты. Распознанные клиенты mihomo сохраняют YAML, а явный параметр `format` сохраняет прежний выбор
формата даже в браузере. HTML не содержит клиентских конфигураций, не загружает внешние ресурсы и не кешируется.

| Формат | Как выбирается | Тело |
|---|---|---|
| Incy (по умолчанию) | `?format=awg`/`incy` или запрос, для которого не выбраны HTML, mihomo и v2ray | base64 смешанного списка `awg://<base64url(.conf)>#<имя>` и `vless://…#<имя>` ([спецификация](https://docs.incy.cc/en/subscription-format/)) |
| JSON Incy | `?format=json` | `{"type":"amneziawg","version":1,"servers":[…]}`; AWG — `{name,config}`, VLESS — `{name,protocol:"vless",link}` |
| mihomo | `?format=clash`/`mihomo` или UA `mihomo`, `clash-meta`, `clash-verge`, `flclash`, `clashmi`, `clash.party` | JSON (валидный YAML): AWG `type: wireguard` + `amnezia-wg-option`, VLESS `type: vless` + `reality-opts`, группа `Dementia` (и «Авто», см. ниже), `rules`: сначала DIRECT для IP-адресов AWG, затем правила [«Напрямую»](direct-routing.md), если включены, и `MATCH,Dementia` |
| v2ray | `?format=v2ray` или UA `v2rayN`, `v2rayNG`, `Hiddify`, `Streisand`, `Happ`, `NekoBox` | base64 списка только `vless://…`; записи AWG пропускаются |

Правила DIRECT для IP-адресов AWG в начале mihomo-профиля обходят гонку `protect()` при запуске TUN в FlClash на Android
([FlClash #2966](https://github.com/chen08209/FlClash/issues/2966)): иначе пакеты AWG могут зациклиться в туннеле.
Доменные адреса нод эти правила не покрывают; адреса VLESS и CDN в них не добавляются. Если FlClash уже зациклился,
принудительно остановите и заново запустите приложение.

VLESS-ссылка имеет вид `vless://<uuid>@<host>:<port>?type=tcp&security=reality&pbk=…&fp=…&sni=…&sid=…&flow=…&encryption=none#<имя>`.
Публичный ключ Reality кодируется в base64url, `sid` — первый shortId ноды, пустой `flow` не добавляется. Клиенты VLESS без
`client_uuid` не попадают в подписку. Мост подменяет хост и порт VLESS так же, как `Endpoint` у AWG. С транспортом XHTTP в ссылку
добавляются `type=xhttp&path=…&host=…&mode=…` (mihomo — `network: xhttp` + `xhttp-opts`). Нода с включённым входом через CDN даёт вторую
запись `<имя> · CDN` (VLESS + XHTTP + TLS на адрес Cloudflare, без flow) — [vless.md](vless.md#cdn); мост её не меняет.

В `[Peer]` строка `PresharedKey` (в mihomo — `pre-shared-key`) пишется только если у клиента или сервера есть PSK.
`AllowedIPs = 0.0.0.0/0, ::/0` — намеренно (если администратор не включил [«Напрямую, мимо VPN»](direct-routing.md) для AWG; тогда IPv4 за вычетом выбранных сетей, `::/0` остаётся): у нод нет IPv6, и маршрут `::/0` в туннель не даёт IPv6-трафику клиента идти
мимо VPN (утечка реального адреса); так же настроены конфиги приложения AmneziaVPN. Не убирайте `::/0`.

### Автопереключение в mihomo

Если в подписке больше одной записи и включена настройка «Автопереключение в приложениях mihomo» (`clash_auto`, по умолчанию
включена; `settings.sub_clash_auto = '0'` — выключена), профиль содержит две группы:

- `Dementia` (`select`) — `Авто` первой, затем все ноды: пользователь по-прежнему может выбрать ноду вручную, и уже сделанный
  им выбор сохраняется;
- `Авто` (`fallback`) — все ноды **в порядке подписки**; приложение проверяет их через саму ноду (`generate_204`, раз в 300 с,
  `lazy`) и ведёт трафик через первую работающую.

Порядок подписки уже содержит нужный приоритет: мост в режиме `main` идёт перед запасной прямой записью ([bridges.md](bridges.md)),
вход VLESS через CDN — после прямого. Поэтому `fallback`, а не `url-test`: выбор по задержке гонял бы пользователя между адресами.
Смысл группы — решение принимает приложение в сети пользователя, а не панель по проверкам из дата-центров ([probes.md](probes.md)).
Прокси, названный как группа (`Авто`, `Dementia`), получает суффикс ` 2`. Incy, JSON и v2ray групп не имеют — там выбор за приложением.

### Приложения AWG по платформам

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

### Приложения VLESS по платформам

HTML-страница подписки содержит ссылку на формат `v2ray` и этот список приложений. Они получают base64-список VLESS-ссылок
по основному адресу через распознавание User-Agent либо по `?format=v2ray`.

| Платформа | Приложения |
|---|---|
| Android | v2rayNG, Hiddify |
| iPhone / iPad | Streisand, Happ |
| Windows / macOS / Linux | Hiddify, v2rayN |

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
