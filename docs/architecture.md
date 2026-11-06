# Архитектура

## Компоненты

```
 Браузер админа ──HTTPS/HTTP──► Панель (server/src/index.ts)
                                 │  Express API /api/*, SPA client/dist, подписки /sub/:token, WebSocket /ws
                                 │  SQLite data/dementia.db
                                 │
                                 ├──SSH──► Нода 1: Docker-контейнер AmneziaWG (панели или приложения Amnezia)
                                 ├──SSH──► Нода N
                                 └──HTTPS──► Панель партнёра (/api/federation/v1)  ← и обратно
 Приложения пользователей (Incy, mihomo) ──► /sub/:token
 VPN-трафик пользователей ──UDP──► ноды напрямую (панель в передаче трафика не участвует)
```

Панель **агентлесс**: на нодах нет демона панели, только Docker-контейнер AmneziaWG. Все действия — SSH-командами.

## Сервер (`server/src`)

| Файл | Назначение |
|---|---|
| `index.ts` | Порядок middleware, роутеры, единый порт HTTP+HTTPS (сниффинг первого байта), WebSocket (установка и живые обновления), фоновые задачи |
| `middleware/static-cache.ts` | Заголовки кеширования статики: `/assets/*` — `immutable`, `sw.js`/`index.html`/манифест — `no-cache` |
| `services/live.service.ts` | Рассылка сигнала `{type:'changed'}` WebSocket-подписчикам (слияние за 250 мс, проверка сессии, пинг мёртвых сокетов); middleware записи через API |
| `config.ts` | Каталог данных (`DEMENTIA_DATA_DIR`, по умолчанию `./data`) |
| `db/index.ts` | Схема, миграции, `transaction`, `getSetting`/`setSetting` |
| `middleware/auth.middleware.ts` | `requireAuth` (Bearer-токен сессии) |
| `middleware/rate-limit.ts` | `FailureLimiter` — счётчик неудачных попыток (логин, токены партнёров) |
| `middleware/security-headers.ts` | CSP, X-Frame-Options, nosniff, Referrer-Policy, HSTS |
| `middleware/error-handler.ts` | Единый JSON-обработчик ошибок (общий для `index.ts` и тестового приложения) |
| `middleware/migration-guard.ts` | Блокировка записей во время переноса панели (423) и заморозка после него (410); перенаправление `/sub` перенесённой панели, см. [migration.md](migration.md) |
| `routes/*.ts` | HTTP API, см. [api.md](api.md) |
| `services/ssh.service.ts` | SSH: TOFU-проверка ключа хоста, таймауты, stdin, `sudo -n` для не-root |
| `services/provision.service.ts` | Всё про ноды: установка, синхронизация, применение, сканирование и импорт, мониторинг |
| `services/awg.service.ts` | Ключи, генерация серверных/клиентских конфигов, выделение IP |
| `services/xray.service.ts`, `utils/vless-params.ts` | VLESS + Reality: config.json Xray из БД, ссылки `vless://`, прокси mihomo, параметры Reality, см. [vless.md](vless.md) |
| `services/subscription*.ts` | Лимиты подписчиков и оформление подписки |
| `services/partner.service.ts` | Партнёрский доступ — сторона владельца нод |
| `services/federation-client.service.ts` | Партнёрский доступ — сторона получателя |
| `services/ssl.service.ts` | Let's Encrypt (DNS-01 Cloudflare, HTTP-01), самоподписанные и свои сертификаты, автопродление |
| `services/secrets.service.ts` | Шифрование секретов в БД (AES-256-GCM) |
| `services/auth.service.ts` | Пароли (scrypt), сессии (SHA-256 токенов) |
| `services/fail2ban.service.ts` | fail2ban на хосте панели |
| `services/migration.service.ts` | Перенос панели, сторона прежней панели: код, снимок БД, состояния `prepared/exporting/migrated` |
| `services/migration-import.service.ts`, `migration-client.ts` | Сторона новой панели: импорт архива с откатом, скачивание архива и завершение переноса по сети |
| `services/probe.service.ts` | Проверка доступности нод из выбранных стран через check-host.net с подтверждением по журналу заглушки, см. [probes.md](probes.md) |
| `services/stub.service.ts` | Заглушка проверки доступности на ноде (контейнер `dementia-probe`): скрипты установки и чтения журнала, разбор журнала |
| `services/bridge.service.ts` | Мосты в странах пользователей: установка, правила пересылки из БД, проверки, решение «нужен мост», адреса для подписки, см. [bridges.md](bridges.md) |
| `services/version.service.ts` | Версия панели (корневой `package.json`) и последний релиз GitHub с кэшем, см. [releases.md](releases.md) |
| `utils/awg-params.ts` | Параметры AWG: генерация, проверка, рендер, разбор конфигов |
| `utils/amnezia-key.ts` | Разбор ключей AmneziaVPN `vpn://` |
| `utils/migration-archive.ts` | Формат зашифрованного архива переноса, код переноса и производные ключи (без доступа к БД) |
| `utils/net.ts` | Подсети, выделение IP, `shellQuote`, проверки хостов/портов, адрес редиректа на HTTPS |
| `utils/names.ts` | Имена клиентов на нодах партнёра: `subscriberPeerName`, `normalizePeerName` (до 64 символов) |
| `utils/http.ts` | `HttpError`, `asyncHandler`, `contentDisposition`, `base64HeaderValue`, `parseId` |

## Клиент (`client/src`)

SPA без роутера: вкладки в `App.tsx` (`AppTab` из `Navbar.tsx`): Серверы (карта сети с инспектором — `ServersView`, режим «Список» и карточка «Доступность нод из стран»), Мосты, Пользователи,
Оформление подписки, Партнёры, События, Безопасность (+ резервные копии, Telegram и перенос панели). Крупные вкладки загружаются через `React.lazy`. Учётная запись (логин, пароль, 2FA и сессии) — `AccountModal`. Все запросы — через `api/index.ts` (`request()` с Bearer-токеном из localStorage;
на 401 генерируется событие `auth_unauthorized`). Типы ответов сервера — `types/index.ts`; держите их в
соответствии с сериализаторами сервера. Данные обновляются по сигналу WebSocket (`live.ts`, [инвариант 42](../AGENTS.md)), а страховочный опрос идёт раз в минуту; без сокета
(у гостя или при обрыве) — каждые 15 с (`App.tsx`). Формы инициализируются только при открытии модалок (иначе обновление затирает ввод).

### Приложение на телефоне (PWA)

Панель устанавливается как приложение (Android/iOS): манифест, иконки и сервис-воркер лежат в `client/public`, регистрация и кнопка установки — `pwa.ts`,
`InstallAppButton.tsx`. Без связи при запуске показывается `ConnectionLost` (токен не стирается), в работе — баннер «Нет связи». Воркер не кеширует
`/api`, `/sub`, `/ws` (инвариант 44). Подробно — [pwa.md](pwa.md).

### Карта сети («Серверы»)

`ServersView` — карта слева и инспектор справа; переключатель «Карта / Глобус / Список» запоминается в localStorage (список — прежнее представление:
переключатель нод, карточка ноды, таблица клиентов).

- **Модель** (`topology/model.ts`) — граф из `servers` (с проверками из стран), `bridges` (привязки, `active`) и `subscribers` (страна): панель в
  центре, ноды на первом кольце, мосты на втором (в сторону своих нод), страны на третьем (в сторону своего моста или нод). Кольца вытянуты по
  горизонтали на широком холсте и по вертикали на телефоне (`Orientation`); зазоры между значками выдерживает `spreadAngles`.
- **Линии**: панель→нода (состояние ноды), мост→нода (режим и `active` привязки), страна→мост и страна→нода (результат проверки из страны:
  `ok`/`partial`/`fail`). Если в стране включён мост, прямая линия до ноды становится обходной (пунктир), а поток идёт через мост.
- **Интерактив** (`TopologyMap.tsx`): колесо и щипок — масштаб, перетаскивание фона — панорама, перетаскивание узла — своё расположение
  (localStorage, кнопка сброса), наведение подсвечивает связи, пакеты бегут по активным линиям, вспышка при смене состояния; слои «мосты» и «страны»;
  узлы доступны с клавиатуры (Tab, Enter, Esc). Анимации отключаются при `prefers-reduced-motion`.
- **Инспектор**: нода (`NodeDetails` + `ClientList`), мост и страна (`TopologyInspectors`), без выбора — сводка сети (`NetworkOverview`: что требует
  внимания) и проверка из стран.
- **Глобус** (`TopologyGlobe.tsx`, `topology/globe.ts`): тот же граф в ортографической проекции D3. Локальный атлас Natural Earth
  загружается вместе с режимом; положение приблизительное, по опорной точке страны. Метки раздвигаются при пересечении.
  Дуги показывают маршруты подписок и настройки мостов. Панель не имеет метки, объекты без геопривязки доступны в списке.
- **Диалоги**: `components/ui` — `ModalShell` (каркас всех окон), `FeedbackProvider`/`useFeedback` (тосты, `confirm`, `alert`).
- **Клиенты** (`ClientList`): сортировка (`clientSort.ts`), выбор, массовое включение/отключение/удаление (клиентов партнёров удалять нельзя), постраничный показ.

## Фоновые задачи (`index.ts`)

| Задача | Период | Что делает |
|---|---|---|
| `statsLoop` | 30 с после завершения | Опрос нод (`fetchServerStats`, до 5 параллельно): трафик, статус, досинхронизация; мосты (`BridgeService.checkAll`: правила из БД применены и на месте); пересчёт приостановки подписчиков и партнёров |
| `federationLoop` | 60 с | Синхронизация с панелями партнёров (`FederationClient.syncAll`) |
| `nodeUpdateLoop` | 60 с после завершения | Проверка Docker-образов нод раз в сутки и последовательное автообновление в выбранный час UTC (выключено по умолчанию); очередь ноды, проверка сохранности пиров и откат, пауза переноса, `LiveService.notify()` |
| `probeLoop` | 60 с | Проверка доступности нод из стран, если включена и пришёл срок (`ProbeService.isDue`), затем сквозная проверка мостов; каждый раз — пересчёт «нужен мост» по сигналу от клиентов (`BridgeService.evaluate`) |

Каждый из циклов `statsLoop`, `federationLoop` и `probeLoop` по завершении вызывает `LiveService.notify()`, а `statsLoop` — после каждой опрошенной ноды: интерфейсы администраторов обновляются сразу, а не ждут опроса.
| очистка | 1 ч | Истёкшие сессии, счётчики ограничений |
| `renewIfNeeded` | 12 ч | Продление сертификата Let's Encrypt за 30 дней до окончания |
| `BackupService.runIfDue` | по расписанию | Зашифрованная копия в выбранное облако и retention; не запускается при переносе панели |

События пишет `EventService`; `TelegramService` доставляет их асинхронно, сетевые ошибки не влияют на операции панели.

## Порядок middleware (важно)

1. Заголовки безопасности.
2. `/.well-known/acme-challenge/:token`, затем `/sub` (у перенесённой панели — `subscriptionFreeze`) — доступны по HTTP даже при включённом HTTPS.
3. Перенаправление на HTTPS (для `/api/*` по HTTP — 403 JSON, кроме `/api/health`), когда HTTPS включён.
4. `express.json` (1 МБ), `migrationGuard` для `/api`, `/api/health`, `/api/federation/v1`, `/api/auth`, защищённые роутеры, JSON-404 для `/api/*`.
5. Статика SPA и fallback на `index.html`.
6. JSON error handler (`HttpError`, ошибки парсинга JSON, 500 без стектрейса).
