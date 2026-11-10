# HTTP API панели

## Домен панели через Cloudflare

- `GET /api/security/cloudflare` → `{enabled, domain, origin_ip, port, url, token_saved, email, listener_ready, error, https_ports}`.
- `POST /api/security/cloudflare` — `{domain, token?, origin_ip?, email?, port?}`. Пустой токен использует сохранённый; IPv4 определяется автоматически,
  email обязателен при отсутствии подходящего сертификата и сохранённой почты; порт по умолчанию 443. Создаёт или проксирует только адрес панели,
  выпускает сертификат при необходимости, сохраняет публичный адрес. При ошибке — откат HTTPS/настроек и подтверждённых изменений DNS.
- `DELETE /api/security/cloudflare` — DNS only для сохранённой записи, без удаления DNS/сертификата/HTTPS-входа/публичного адреса.
- Все три маршрута закрыты гостю. Подробности и ограничения — [cloudflare.md](cloudflare.md).
- `GET /api/security/ssl` дополнительно возвращает `cfTokenSaved` и `email`. `verify-cf`, `cf-zones`, `issue-cf` допускают пустой/отсутствующий токен
  для использования ранее сохранённого. Сам токен не возвращается. Изменения TLS и настройка домена сериализованы.

Все `/api/*`, кроме отмеченных, требуют `Authorization: Bearer <токен сессии>`. Ошибки — JSON `{error}` с
HTTP-кодом. Тела — JSON.

## Публичные
| Метод | Путь | Описание |
|---|---|---|
| GET | `/sub/:token` | Подписка, см. [subscriptions.md](subscriptions.md) |
| GET | `/api/health` | `{status, uptime, https, timestamp}`; доступен по HTTP и при включённом HTTPS (его опрашивает `install.sh`) |
| GET | `/api/migration/archive` | Зашифрованный архив переноса для нового сервера; заголовок `X-Migration-Auth` (производная от кода переноса). 403/429 при неверном коде |
| POST | `/api/migration/finish` | `{newUrl?}` — новая панель запущена, эта замораживается; тот же заголовок |
| POST | `/api/auth/login` | `{username, password}` → `{token, user}`; 429 при переборе |
| GET | `/.well-known/acme-challenge/:token` | Let's Encrypt HTTP-01 |
| * | `/api/federation/v1/*` | Партнёрский API (токен партнёра), см. [partners.md](partners.md) |
| WS | `/ws` | Первое сообщение `{type:'auth', token}` → `auth_ok`. Затем: логи установки (`{type:'start_install', serverId}` → `log`… `install_finished`) и живые обновления — сервер присылает `{type:'changed'}` (без данных) после успешной записи через API и итога фоновых опросов; клиент в ответ перезапрашивает списки. Гость сокет не открывает (закрытие 4401); при недействительной сессии сокет закрывается кодом 4401 на очередной рассылке |

## Авторизация
`GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/change-password` (`{oldPassword, newPassword}` → новый `token`),
`POST /api/auth/change-username` (`{password, newUsername}` → `{token, user}`; логин — до 64 символов `A-Za-z0-9._@-`, 409 если занят;
остальные сессии завершаются). Неверные пароли при смене логина/пароля ограничены: 5 за 15 минут на администратора (429).

## Серверы `/api/servers`
| Метод | Путь | Описание |
|---|---|---|
| GET | `/`, `/:id` | Серверы (без секретов; `has_ssh_password`, `has_ssh_key`, параметры AWG, `remote_panel_name`…) |
| POST | `/` | Создать: `name, host, ssh_port, ssh_user, ssh_password \| ssh_key, awg_port, subnet`. 409, если сервер с таким хостом и портом AmneziaWG уже есть (то же при смене хоста/порта в PUT) |
| POST | `/awg-signature` | `{preset: "quic" \| "dns" \| "stun", domain?}` → `{preset, i1}` — готовый сигнатурный пакет I1 ([awg-protocol.md](awg-protocol.md)); ничего не сохраняет |
| POST | `/import-amnezia` | `{keys}` — импорт по ключам AmneziaVPN, см. [amnezia-import.md](amnezia-import.md) |
| PUT | `/:id` | Изменить: имя/хост/SSH (`auth_type` + секрет), `reset_host_key`, порт, подсеть, параметры AWG. У установленного сервера смена порта/подсети/параметров ждёт применения на ноде; при неудаче — 502 `{success: false, error, server}`, порт и параметры возвращены к прежним (остальные правки сохранены). Смена только `i1`–`i5` ноду не перезапускает |
| PUT | `/:id/extra-ports` | `{ports: [443, 53]}` — запасные UDP-порты ноды AmneziaWG (до 4, [node-management.md](node-management.md#extra-ports)); на установленной ноде применяются сразу, при неудаче — 502 `{success: false, error, server}` и прежний список. В ответах серверов — `extra_ports`, `extra_ports_active`, `extra_ports_error` |
| PUT | `/:id/country` | Локальная метка для глобуса: `{country: "FI"}` или `{country: null}`. Возвращает сервер, поддерживает партнёрские ноды |
| DELETE | `/:id?teardown=1&force=1` | Удалить (опционально с контейнером на ноде) |
| POST | `/:id/test-ssh` | Проверка SSH |
| POST | `/:id/scan` | Найти и подключить установленный AmneziaWG |
| POST | `/:id/sync` | Синхронизировать пиры |
| POST | `/:id/apply` | Применить параметры (перезапуск) |
| POST | `/:id/randomize-params` | Новые параметры текущей версии + применение (при неудаче — 502, как у PUT, параметры прежние) |
| POST | `/:id/reality-candidates` | `{domain?}` → `{candidates: [{domain, latency_ms, suitable}]}` — подбор сайта маскировки Reality с VLESS-ноды по SSH (TLS 1.3, HTTP/2, публичный IP) |
| POST | `/:id/upgrade-protocol` | Переход на AWG 3.x + переустановка |

Для нод партнёра доступны GET, sync и изменение локальной метки через `PUT /:id/country`.

Для VLESS укажите `protocol: "vless"` при создании ноды. Порт `awg_port` используется по TCP (по умолчанию 443),
подсеть не требуется. `PUT /:id` принимает `reality_sni`, `reality_dest`, `reality_short_ids` (массив строк),
`xray_flow` и `xray_fingerprint`. Если применить параметры к работающей ноде не удалось, панель возвращает 502
и восстанавливает прежние значения. `randomize-params` обновляет параметры Reality с сохранением пары ключей.
Сканирование, импорт AmneziaVPN, обновление протокола AWG и выдача ноды партнёру для VLESS недоступны.

Транспорт VLESS — `xray_transport` (`tcp` | `xhttp`), `xhttp_path`, `xhttp_mode` (`auto`, `packet-up`, `stream-up`, `stream-one`) в том же
`PUT /:id`; `randomize-params` их транспорт и режим не меняет, путь генерирует заново.

Вход через CDN Cloudflare ([vless.md](vless.md#cdn)):

| Метод | Путь | Тело / ответ |
|---|---|---|
| POST | `/api/servers/:id/cdn` | `{domain, port?, address?, origin_ip?, token?, email?}` → сервер. `port` — 443, 2053, 2083, 2087, 2096, 8443 (не порт VLESS, по умолчанию 8443); `token`/`email` — если не сохранены. 400 — не VLESS/неверные данные, 409 — имя занято (панель, нода, мост, чужая DNS-запись), 502 — Cloudflare/ACME/переустановка не удались (всё откатывается) |
| DELETE | `/api/servers/:id/cdn` | → сервер (+ `warning`, если нода или DNS не обновились) |

В ответе сервера — `cdn_enabled`, `cdn_cert_ready`, `cdn_domain`, `cdn_port`, `cdn_address`, `cdn_expires_at`, `cdn_error`; `cdn_cert`/`cdn_key` не отдаются.

## Клиенты
| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/servers/:serverId/clients` | Клиенты ноды (`external`, `partner_name`, `owner_blocked`, `pending`, `remote_state`) |
| POST | `/api/servers/:serverId/clients` | `{name?}` — создать (на ноде партнёра ждёт выдачи IP) |
| PUT | `/api/clients/:id` | `{name?, enabled?}`; для клиента партнёра `enabled` = блокировка владельцем |
| DELETE | `/api/clients/:id` | Удалить (клиента партнёра — 409) |
| GET | `/api/clients/:id/config` | `.conf` (409 для импортированных, партнёрских, ещё не созданных) |
| GET | `/api/clients/:id/qrcode` | `{qrcode, config, clientName}` |

## Пользователи подписок `/api/subscribers`
`GET /`, `POST /` (`name, server_ids, traffic_limit, expire_at, country`), `PUT /:id` (+ `enabled`), `DELETE /:id`,
`POST /:id/reset-token` (новый токен и ключи), `POST /:id/reset-traffic`.

## Версия
- `GET /api/version[?refresh=1]` — `{current, latest, latest_url, published_at, update_available, releases_url, checked_at, check_enabled, error}`: версия панели и последний релиз GitHub, см. [releases.md](releases.md).
- `GET /api/version/update` — `{available, reason, current, state, from, to, started_at, finished_at, message, log}`: можно ли обновить панель из интерфейса (иначе `reason`), состояние последнего обновления (`idle`/`running`/`success`/`failed`/`rolled_back`) и последние 300 строк журнала.
- `POST /api/version/update` `{version}` — обновить панель до последнего релиза (`version` должна совпасть с `latest`); 409 — недоступно, уже идёт или версия не последняя; 423/410 — во время переноса. См. [releases.md](releases.md#обновление-из-интерфейса).
- Серверы в `GET /api/servers` содержат версии ПО ноды: `node_awg_go`, `node_awg_tools`, `node_image`, `node_image_created`, `node_info_at`.

## Настройки
- `GET/PUT /api/settings` — `public_url`, `client_dns`, `client_mtu`.
- `GET/PUT /api/subscription-settings` — оформление подписки, `servers[{id, sub_name, sub_order}]` и `direct` («напрямую, мимо VPN»); `POST /api/subscription-settings/direct/refresh` — обновить сети стран. Подробно — [direct-routing.md](direct-routing.md).

Для клиента VLESS маршрут `config` отдаёт ссылку `vless://` в файле `.txt`, а `qrcode` кодирует ту же ссылку.
UUID не входит в списки и обычные ответы API. При сбросе ссылки подписчика его VLESS UUID перевыпускаются.

## Партнёры
- Владелец `/api/partners`: `GET /`, `POST /` (`name, node_ids, max_clients, traffic_limit, expire_at` →
  `{partner, token, connect_string}`), `PUT /:id` (+ `enabled`), `POST /:id/regenerate-token`, `DELETE /:id`,
  `GET /:id/clients`, `GET /:id/audit`.
- Получатель `/api/remote-panels`: `GET /`, `POST /` (`connect_string, name?`), `POST /:id/sync`, `PATCH /:id`
  (`name`), `DELETE /:id`.

## Перенос панели `/api/migration`
Администратор: `GET /status` (`{state, expiresAt, exportedAt, migratedAt, newUrl}`), `POST /prepare` (`{password}` → `{code, expiresAt}`, код показывается один раз),
`GET /download` (архив файлом), `POST /cancel`. Публичные (по коду) — `archive` и `finish` выше. В состоянии `exporting` все записи `/api/*` дают 423, у
перенесённой панели — 410, см. [migration.md](migration.md).

## Проверка доступности нод `/api/probes`
`GET /`, `GET /countries`, `PUT /` (`settings`, `servers[{id, probe_port}]`), `POST /run`, см. [probes.md](probes.md). `GET /api/servers` содержит `probes` и `stub_port`.

## Мосты `/api/bridges`
`GET /`, `POST /` (добавить и установить), `PUT /:id`, `PUT /:id/links` (`links[{server_id, mode}]`), `POST /:id/install`, `POST /:id/apply`,
`POST /:id/test-ssh`, `DELETE /:id` (`?teardown=1&force=1`), см. [bridges.md](bridges.md). SSH-секреты мостов в ответах не отдаются.

`PUT /:id/links/:serverId/cascade` принимает `{port: number | 'auto' | null, sni?: string}` (`sni` — сайт маскировки Reality для нового каскада, по умолчанию выбирает панель) и включает каскад XHTTP на указанном TCP-порту ноды (или на свободном, который подберёт нода при `"auto"`, с открытием в ufw/firewalld/iptables)
или возвращает DNAT. Ответ содержит обновлённый мост с `cascade_port` в привязке. Секреты каскада остаются на сервере.

## События, уведомления и резервные копии
- `GET /api/events`, `GET/PUT /api/telegram`, `POST /api/telegram/test`, `POST /api/telegram/detect-chat`.
- `GET /api/providers` — `{items, settings, telegram_ready}`: панель, ноды и мосты с данными кабинета (без пароля, только `password_saved`) и ближайшим платежом (`next_due`, `days_left`). `PUT /api/providers/:type/:id` (`type` = `panel|node|bridge`, у панели id `0`) — `url`, `login`, `password` (не передан — не менять, пустой — стереть), `amount`, `currency`, `pay_day`, `pay_month`; пустая форма удаляет запись. `GET /api/providers/:type/:id/password` — пароль по запросу администратора. `PUT /api/providers/settings` — `{remind_enabled, remind_days, remind_hour}`. Гостю недоступно. См. [providers.md](providers.md).
- `GET/PUT /api/backups/settings`, `POST /api/backups/test`, `/api/backups/run`, `GET /api/backups`, `GET /api/backups/:id/download`, `DELETE /api/backups/:id`, `POST /api/backups/recovery-key`.

## Учётная запись и 2FA
`POST /api/auth/login` дополнительно принимает `totp` или `recovery_code`. Настройка: `POST /api/auth/totp/setup`, `/totp/enable`, `/totp/disable`, `/totp/recovery/rotate`. Сессии: `GET /api/auth/sessions` (поле `role`), `DELETE /api/auth/sessions/:id`.

### Гостевой доступ
`GET /api/auth/guest` → `{enabled, username, has_password}`; `PUT /api/auth/guest` `{enabled, username, password?, current_password}` — включить/отключить гостя,
задать логин и пароль (пароль администратора обязателен, 409 если логин занят администратором); завершает гостевые сессии. Гость входит через
`POST /api/auth/login` (в ответе `user.role = "guest"`) и может только читать адреса из белого списка (см. [security.md](security.md)); остальные запросы — 403 `{guest: true}`.

## Безопасность `/api/security`
`GET /ssl`, `POST /ssl/verify-cf`, `/ssl/cf-zones`, `/ssl/issue-cf`, `/ssl/issue-http`, `/ssl/issue-ip`,
`/ssl/custom`, `/ssl/toggle`; `GET /fail2ban`, `POST /fail2ban/ban`, `/fail2ban/unban`, `/fail2ban/setup`.

## Обновления контейнеров AmneziaWG (только администратор)

- `GET /api/node-updates` → `{settings: {auto_update, hour_utc}, running, active_server, nodes}`. В `nodes` — имя, ID ноды и состояние из `node_updates`, без SSH-вывода и секретов.
- `PUT /api/node-updates` — `{auto_update: boolean, hour_utc: 0..23}`. По умолчанию автообновление выключено.
- `POST /api/node-updates/check` — проверить образы всех подходящих нод; опционально `{server_ids: [id, …]}`.
- `POST /api/node-updates/update` — обновить все подходящие ноды с доступным образом; опционально `{server_ids: [id, …]}` для явной повторной попытки.
- POST возвращает `202 {started: true}`; пакет выполняется по одной ноде, прогресс читается GET. Пересечение пакетов — 409. Итоги отдельной ноды — `result`/`error` и журнал событий.
- `GET /api/servers` и `/api/servers/:id` включают `node_update` с результатом проверки/обновления (null, если проверки не было или это партнёрская нода).
