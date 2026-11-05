# База данных

SQLite (`node:sqlite`, Node ≥ 22.13), файл `data/dementia.db`, режим WAL, `foreign_keys = ON`, `busy_timeout = 5000`.

## Миграции

`server/src/db/index.ts`, массив `migrations`; номер применённой версии — `PRAGMA user_version`. Каждая миграция
выполняется в транзакции при старте (`initDatabase`).

**Правила:**
- Новые изменения — только новой функцией в конце массива. Применённые миграции не редактировать.
- Колонки — через `addColumn(table, definition)` (идемпотентно).
- `initDatabase(targetVersion?)` останавливается на заданной версии — так `migrations.test.ts` воспроизводит БД старых версий и проверяет обновление.
- Данные, которые меняют смысл (шифрование, хэширование), переносите в миграции, а не «на лету».

| Версия | Что добавила |
|---|---|
| v1 | Исходная схема: admins, sessions, subscribers, servers, clients, settings |
| v2 | Флаги синхронизации, TOFU host_key, накопление трафика, приостановка подписчиков, уникальные IP, шифрование секретов, хэши сессий |
| v3 | `servers.sub_name`, `sub_order` (имена/порядок в подписке) |
| v4 | Параметры AWG 3.x, поля контейнера (`container_name`, `iface`, `conf_path`, `awg_tool`, `managed_by`), `clients.external` |
| v5 | Партнёрский доступ: `partners`, `partner_nodes`, `partner_audit`, `remote_panels`; поля клиентов/серверов для партнёров |
| v6 | Уникальный индекс `idx_clients_server_pubkey` (ключ клиента на ноде; не создаётся, если дубли уже есть — предупреждение в логе), таблица `trusted_login_ips` |
| v7 | Версии ПО AmneziaWG на ноде: `node_awg_go`, `node_awg_tools`, `node_image`, `node_image_created`, `node_info_at` |
| v8 | Проверка доступности из стран: `servers.probe_port`, таблица `probe_results` |
| v9 | Заглушка проверки (`servers.stub_port`, `stub_token`; `probe_results.method`, `tcp_ok`, `udp_ok`, `spoofed`, `verified`), мосты (`bridges`, `bridge_links`, `bridge_state`), `subscribers.country` |
| v10 | Журнал событий панели: таблица `events` |
| v11 | 2FA и сессии: `admins.totp_secret`, `totp_enabled`, `recovery_codes`; таблица `sessions` с `id`, `ip`, `user_agent`, `last_activity` |
| v12 | Гостевой доступ: `sessions.role` (`admin` / `guest`); логин и хэш пароля гостя — в `settings` (`guest_*`) |
| v13 | Проверка и обновление Docker-образов нод: `node_updates` |
| v14 | Необязательная метка страны для глобуса: `servers.country` |

## Таблицы

### `servers` — ноды
| Поле | Смысл |
|---|---|
| `host`, `ssh_port`, `ssh_user` | SSH-доступ (`ssh_user='partner'` у нод партнёра) |
| `ssh_password`, `ssh_key` | **Зашифрованы** (`enc:v1:…`). Одно из двух |
| `host_key` | Отпечаток SSH-ключа хоста (TOFU), сбрасывается при смене host |
| `awg_port`, `deployed_port` | Желаемый порт и порт, с которым создан контейнер; различие → переустановка |
| `subnet` | Адрес сервера в туннеле с маской (`10.8.0.1/24`; у Amnezia бывает адрес сети `10.8.1.0/24`) |
| `server_private_key`, `server_public_key`, `preshared_key` | Ключи интерфейса (приватный не уходит в API) |
| `awg_version` | 1 — AmneziaWG 1.x, 3 — 3.x |
| `jc, jmin, jmax, s1, s2, s3, s4, h1..h4, i1..i5, header_protection_key, extra_params` | Параметры обфускации, см. [awg-protocol.md](awg-protocol.md). `h1..h4` — текст (число или диапазон) |
| `status` | `uninstalled`, `installing`, `online`, `offline`, `error` |
| `needs_sync`, `needs_apply` | Изменения ещё не доставлены на ноду (повторяются фоновым опросом) |
| `last_error`, `fail_count`, `last_seen` | Состояние опроса; 3 неудачи подряд → `offline` |
| `container_name`, `iface`, `conf_path`, `awg_tool` | Где AmneziaWG на ноде (`amnezia-awg`/`awg0`/`/opt/amnezia/awg/awg0.conf`/`awg` у панели) |
| `managed_by` | `dementia` — контейнер панели, `amnezia` — контейнер приложения Amnezia, `partner` — нода партнёра |
| `sub_name`, `sub_order` | Отображаемое имя и порядок в подписке |
| `country` | Двухбуквенный код страны для размещения ноды на глобусе, NULL — без геопривязки. У нод партнёров метка хранится локально |
| `remote_panel_id`, `remote_node_id` | Нода партнёрской панели (без SSH); каскадное удаление с `remote_panels` |
| `probe_port` | Порт TCP-проверки доступности из стран для нод без заглушки (ноды партнёров) и запасной для своих; NULL — не задан ([probes.md](probes.md)) |
| `stub_port`, `stub_token` | Порт заглушки проверки доступности на ноде (NULL — не установлена) и метка её страницы (не секрет: по ней проверяется пересылка через мост) |
| `node_awg_go`, `node_awg_tools`, `node_image`, `node_image_created`, `node_info_at` | Версии ПО AmneziaWG на ноде (amneziawg-go, утилиты, образ и дата его сборки) и время их чтения; `node_info_at = NULL` — перечитать при следующем опросе |

### `clients` — пиры
| Поле | Смысл |
|---|---|
| `server_id`, `subscriber_id` | Нода; пользователь-подписчик (NULL — отдельный клиент) |
| `client_ip` | Уникален в пределах сервера (`idx_clients_server_ip`). `pending:<uuid>` — клиент на ноде партнёра ещё не создан у владельца |
| `client_public_key`, `client_private_key` | Публичный уникален в пределах сервера (`idx_clients_server_pubkey`). Приватный пуст (`''`) у импортированных и у клиентов партнёра на нашей ноде |
| `preshared_key` | PSK пира |
| `enabled` | Включён самим владельцем клиента |
| `total_rx`, `total_tx`, `rx_counter`, `tx_counter` | Накопленный трафик и последние значения счётчиков интерфейса |
| `external` | Импортирован из существующей установки (конфиг выдать нельзя) |
| `partner_id`, `remote_ref` | Сторона владельца: клиент создан партнёром; `remote_ref` — id клиента у партнёра (идемпотентность) |
| `owner_blocked` | Сторона владельца: заблокирован владельцем ноды (партнёр включить не может) |
| `remote_peer_id`, `remote_state` | Сторона получателя: id пира у владельца; `blocked` или `error: …` |

### `subscribers` — пользователи подписок
`token` (секрет ссылки `/sub/<token>`), `enabled`, `traffic_limit` (байты, 0 — без лимита), `expire_at`,
`suspended` (вычисляется фоновой задачей: истёк срок или исчерпан лимит), `country` (страна пользователя, двухбуквенный код; по ней
подписка выбирает мост, NULL — не задана).

### `partners`, `partner_nodes`, `partner_audit` — выданные доступы (сторона владельца)
`token_hash` (SHA-256), `token_hint` (для отображения), `enabled`, `suspended`, `max_clients`, `traffic_limit`,
`expire_at`, `last_used_at`, `last_ip`. `partner_nodes` — какие ноды доступны. Журнал хранит до 1000 записей на партнёра.

### `remote_panels` — подключённые панели партнёров (сторона получателя)
`base_url`, `token` (**зашифрован**), `partner_name` (как нас назвал владелец), `status`
(`pending`/`online`/`error`/`revoked`), `limits` (JSON), `last_sync_at`, `last_error`.

### `probe_results` — доступность нод из стран
`(server_id, country)` — ключ; `method` (`stub` — заглушка с подтверждением, `tcp` — порт по ответу check-host.net, `ping` — записи до v0.2.0);
`ok_nodes` / `total_nodes` — сколько проверяющих узлов страны достучалось до ноды, `tcp_ok`/`udp_ok` — сколько дошло по TCP и UDP по журналу
заглушки, `spoofed` — узлы с подменённым ответом, `verified` — результат подтверждён журналом, `rtt_ms`, `checked_at`.
Каскадно удаляется с сервером. Устаревшие (старше трёх интервалов, но не менее двух часов) результаты не показываются.

### `bridges`, `bridge_links`, `bridge_state` — мосты ([bridges.md](bridges.md))
`bridges`: SSH-доступ как у `servers` (`ssh_password`, `ssh_key` — **зашифрованы**, `host_key` — TOFU), `country`, `status`, `rules_hash`
(SHA-256 применённых правил), `needs_apply`, `fail_count`, `last_error`, `last_seen`. `bridge_links`: нода моста, `listen_port` (уникален на
мосту, не меняется после привязки), `mode` (`auto`/`always`/`off`), `check_ok`/`checked_at` — сквозная проверка пересылки. `bridge_state`:
по паре нода × страна — `active` (мост выдаётся), серии проверок `fail_streak`/`ok_streak`, `reason` (`probe`/`clients`), `changed_at`.
Связи удаляются каскадно вместе с мостом и нодой.

### Прочее

Настройки домена панели: `cf_panel_enabled`, `cf_panel_domain`, `cf_panel_zone`, `cf_panel_record`, `cf_panel_ip`, `cf_panel_port`,
`cf_panel_error`. Это метаданные отдельной DNS-записи и HTTPS-входа; секретный API токен остаётся в зашифрованном `cf_token`.
Схема БД не меняется. `public_url` обновляется после успешной настройки домена. При отключении сохраняются домен, HTTPS-порт и URL.
- `admins` — администратор (scrypt), зашифрованный `totp_secret`, `totp_enabled`, SHA-256 кодов восстановления; `sessions` — SHA-256 токенов с `expires_at`, ролью (`admin`/`guest`), IP, User-Agent и активностью, `trusted_login_ips` — IP успешных входов
  администратора (исключение из блокировки по логину, см. [security.md](security.md)).
- `settings` — ключ/значение: `ssl_*`, `cf_token` (**зашифрован**), `public_url`, `client_dns`, `client_mtu`,
  `sub_*` (оформление подписки), `probe_*` (проверка из стран), `migration_*` (состояние переноса панели: `migration_state`,
  `migration_key` — **зашифрован**, `migration_auth_hash`, `migration_expires_at`, `migration_exported_at`, `migration_migrated_at`,
  `migration_new_url`; в снимок для переноса не попадают).

## Состояние обновлений контейнеров (v13)

`node_updates`: одна запись на ноду, внешний ключ `server_id` с `ON DELETE CASCADE`.
Хранит `current_image`/`latest_image` (immutable ID), `available`, `checked_at`, `attempted_at`, `updated_at`,
`result` (`current`, `available`, `updated`, `rolled_back`, `error`) и безопасный текст `error`.
Настройки `node_auto_update` (по умолчанию `0`) и `node_update_hour` (по умолчанию `3`, UTC) живут в `settings`.
Обновление контейнера не меняет записи клиентов, подписчиков или их ключи.
