# Тесты

Cloudflare: `cloudflare-panel.test.ts` — реальные API/БД/файлы TLS с подменой Cloudflare и ACME; сохранённый токен, защита адресов VPN,
чужих DNS-записей, откат, неизменность клиентов, доверенные IP прокси и дополнительный listener. Регрессия повторного выпуска проверяет,
что существующий `proxied: true` сохраняется. `cloudflare-process.test.ts` — настоящий процесс, перезапуск с дополнительным портом, HTTPS API
и WSS на нём при сохранении основного входа. `client/src/components/security/CloudflarePanel.test.tsx` — статус токена, повторное использование
без раскрытия секрета и явное подтверждение настройки домена.

Тесты сервера — vitest, каталог `server/test`. Каждый тестовый файл
получает собственный каталог данных (`test/setup.ts` → `DEMENTIA_DATA_DIR`) и, следовательно, свою БД; файлы
выполняются последовательно (`fileParallelism: false`).

Сервис-воркер проверяется в песочнице `vm` с поддельными кешем и сетью (`client/src/sw.test.ts`): главное — что `/api`, `/sub`, `/ws` и запросы с токеном не
кешируются; манифест, иконки и мета-теги — `pwa.test.ts`; заголовки кеширования статики — `server/test/static-cache.test.ts` (настоящая раздача через `express.static`).

Клиент (`cd client && npm test`, vitest + Testing Library + jsdom) проверяет то, что можно проверить без браузера: модель карты (`topology/model.test.ts`:
граф, здоровье линий, зазоры между значками), каркас окон и тосты (`components/ui/ui.test.tsx`: Esc, Tab, фокус), таблицу клиентов (сортировка, массовые
действия, подтверждения), раздел «Серверы» (выбор узла, инспекторы, слои), хук живых обновлений (`live.test.ts`: авторизация, переподключение, 4401).
`test/setup.ts` подменяет `ResizeObserver` и `matchMedia`, которых нет в jsdom. API подменяется `vi.mock('../api')`. Правило то же: тест на баг
должен падать на старом коде.

```bash
cd server
npm test                                   # всё (≈ 1–2 мин; Docker-тесты пропускаются, если нод нет)
npx vitest run test/provision-service.test.ts      # один файл
npx vitest run -t "лимит клиентов"                 # по названию
npm i --no-save @vitest/coverage-v8@3.2.7          # один раз (без правки package.json)
npx vitest run --coverage --coverage.provider=v8 --coverage.include='src/**'
```

`npx tsc --noEmit` проверяет только `src` — типы тестов не проверяются (`Response.json()` возвращает `unknown`).

## Что где проверяется

| Файл | Что покрывает |
|---|---|
| `awg*.test.ts`, `net.test.ts`, `amnezia-key.test.ts`, `names.test.ts` | Чистые функции: параметры AWG и их проверка, подсети и IP, ключи AmneziaVPN, имена пиров, адрес редиректа |
| `auth.test.ts`, `admin-auth-settings.test.ts`, `login-lockout.test.ts`, `auth-login-limits.test.ts` | Вход, сессии, смена пароля, блокировки, настройки панели и подписки |
| `admin-servers.test.ts` | Админ-API серверов и клиентов: валидация, отсутствие секретов, удаление, конфиги/QR, импорт ключей Amnezia |
| `provision-service.test.ts` | `ProvisionService` с подменой SSH: синхронизация, применение, установка, опрос, TOFU, разбор вывода сканирования, подключение установленного AWG |
| `federation-owner.test.ts`, `api-federation.test.ts`, `federation.test.ts` | Сторона владельца нод: изоляция партнёров, лимиты, приостановка, журнал, ограничения частоты |
| `admin-remote-security.test.ts` | Подключение панелей партнёров (сторона получателя), раздел «Безопасность» |
| `issues-regression.test.ts`, `hardening.test.ts` | Регрессии по Issues/Advisories и результатам аудитов (инъекции из данных партнёра, ошибки HTTP, CSP) |
| `subscription*.test.ts` | Публичная ссылка подписки, заголовки (только ASCII), приостановка по сроку и трафику |
| `ssl-service.test.ts`, `fail2ban-service.test.ts` | Сертификаты (самоподписанные, загруженные, продление, Cloudflare) и fail2ban (подставная утилита, только POSIX) |
| `migrations.test.ts` | Обновление БД со старых версий схемы (`initDatabase(targetVersion)`) |
| `server-process.test.ts` | Настоящий процесс панели: HTTP и HTTPS на одном порту, WebSocket, редирект, устойчивость к мусору |
| `static-cache.test.ts` | Кеширование статики интерфейса: `/assets` — immutable, `sw.js`/`index.html`/манифест — no-cache, тип манифеста |
| `live.test.ts` | Живые обновления: `{type:'changed'}` после успешной записи, не после чтения и ошибки, слияние частых записей, закрытие сокета с сессией (4401) |
| `reset-admin-cli.test.ts` | CLI сброса пароля администратора |
| `migration.test.ts`, `migration-restore.test.ts` | Перенос панели: формат и защита архива, код, состояния прежней панели (423/410, перенаправление подписок), полный круг «экспорт → CLI в чистый каталог», откат при ошибке, выбор сертификата |
| `migration-process.test.ts` | Перенос на настоящем процессе панели (`index.ts`): блокировка записей (423), забор архива по HTTP и по HTTPS с самоподписанным сертификатом, подсказка при HTTP на панели с HTTPS, заморозка и перенаправление подписок |
| `migration-fidelity.test.ts` | Перенос ничего не теряет: каждая таблица БД до и после совпадает построчно, индексы, большая БД (600 клиентов), архив со старой схемой (v7) обновляется при импорте |
| `probes.test.ts` | Проверка из стран с подменой check-host.net и журнала заглушки: разбор ответов и журнала, установка заглушки, подтверждение по журналу (подмена ответа, UDP против TCP, чужой адрес узла), запасной TCP, ноды партнёров, подписка (название, описание, три формата), устаревание, ошибки провайдера |
| `real-docker-nodes.test.ts`, `real-docker-lifecycle.test.ts` | Реальные ноды в Docker: установка, переустановка, 1.x → 3.x, применение, смена порта, TOFU, удаление |
| `real-docker-vless.test.ts` | Нода VLESS на ноде 1: установка Xray, подключение настоящим клиентом Xray (TCP и XHTTP) с выходом в интернет, блокировка частных сетей по IP и по имени (`localhost` → SSH узла), учёт трафика, отказ непринятого конфига без замены, вход через CDN (TLS на 8443 с сертификатом из БД), удаление без чужого `dementia-xray` |
| `real-docker-amnezia.test.ts` | Сервер с контейнером «как у приложения AmneziaVPN»: отказ установки поверх, подключение без перезапуска, синхронизация, применение, замена |
| `real-federation-e2e.test.ts` | Две панели-процесса и реальная нода: получатель → владелец → Docker |
| `bridges.test.ts` | Мосты: правила пересылки, API (установка, привязка, откат, удаление), фоновое применение, решение «нужен мост» (проверки, сигнал от клиентов, гистерезис), подмена адреса в подписке, сквозная проверка, страна пользователя |
| `extra-ports.test.ts` | Запасные порты: правила, проверка списка, откат при сбое, выдача в подписке только применённых, повторное применение после перезапуска контейнера, фоновая сверка |
| `real-docker-extra-ports.test.ts` | Запасные порты на ноде 1: UDP-пакеты с ноды 2 на запасной порт доходят до AmneziaWG в контейнере (счётчик датаграмм), перезапуск контейнера, пропавшие правила, очистка |
| `real-docker-bridge.test.ts` | Заглушка на ноде 1 (TCP, UDP, журнал, сохранение порта) и мост на ноде 2: установка без Docker и systemd, пересылка TCP до заглушки ноды, отсутствие дублей переходов, очистка |
| `panel-update.test.ts` | Обновление панели из интерфейса: API `/api/version/update`, проверка версии, разбор состояния и журнала (запуск `systemd-run` подменён) |
| `update-panel-script.test.ts` | `update-panel.sh` на настоящем git с тегами: обновление, откат с восстановлением БД, сбои. На Windows нужен `TEST_BASH=<bash.exe Git for Windows>`, иначе пропускается |
| `test/install/run.sh` (не vitest) | `install.sh` целиком в чистом Ubuntu 24.04: случайные логин/пароль и вывод данных подключения, обновление (в т.ч. из git: при ошибке `git pull` служба не останавливается; сохранение переменных `.env`), занятый порт, CLI сброса пароля (`in-container.sh`); затем **перенос панели между двумя контейнерами** одной сети (`migration-old.sh` + `migration-new.sh`): интерактивный перенос из файла в псевдотерминале (`pty-drive.py`: вопросы, скрытый ввод кода, сертификат на IP), неверный код, отказ заменить данные, перенос по сети с заменой, прежние логин и пароль, ключ шифрования, заморозка прежней панели и перенаправление подписок, обновление панели при включённом HTTPS; затем **обновление работающей панели предыдущего релиза** (`upgrade.sh`: тег `v0.1.0`, данные, сессия, HTTPS, свой `.env`, схема БД — построчное сравнение до/после, `dump-db.mjs` и `compare-dumps.mjs`; нужны теги git) (≈ 20 минут, нужны Docker и интернет; `SKIP_MIGRATION=1` — только установка, `SKIP_INSTALL=1` — без неё, `SKIP_UPGRADE=1` — без обновления) |

## Хелперы (`test/helpers`)

| Хелпер | Для чего |
|---|---|
| `api.ts` → `createAdminApi(env, username)` | Клиент админ-API тестового приложения (`test-app.ts`): `api(path, method, body)` → `{status, body}` |
| `db.ts` → `insertServer/insertClient/insertSubscriber` | Прямые вставки в БД с валидными ключами и параметрами |
| `ssh-stub.ts` → `stubSsh(responder)` | Подмена `SshService.executeCommand`: записывает команды и stdin (`calls`), ответ задаёт `responder` |
| `remote-panel.ts` → `newRemote`, `createRemotePanel` | Имитация панели владельца нод (подмена `fetch`); поля `failWith`, `latencyMs`, `assignedIp`, `nodeParams` управляют ответами |
| `panel-process.ts` → `startPanel`, `eventually` | Реальный процесс панели с собственной БД и портом, запросы по HTTP/TLS, ожидание фоновых операций |
| `check-host.ts` → `provider`, `installProviderStub`, `stubNodeResponder` | Подмена check-host.net (узлы, ответы http/tcp/udp, недошедшие запросы) и SSH-ответов заглушки: в журнал ноды попадают обращения узлов из `provider.reach` |
| `migration-cli.ts` → `runCli`, `newDataDir`, `readDb` | CLI переноса (`src/cli/migration.ts`) отдельным процессом на собственном каталоге данных; строки `@@ключ=значение` разбираются в `values` |

`test-app.ts` собирает те же роутеры и тот же `errorHandler`/`securityHeaders`, что `src/index.ts`; всё, что живёт только в
`index.ts` (WebSocket, HTTPS на одном порту, фоновые циклы), проверяется через `startPanel`.

## Правила для новых тестов

1. **Проверяйте реальный код** — роуты, сервисы, БД. Нельзя копировать логику в тест и «доказывать» её (так были устроены
   первые `edge-cases.test.ts`, они заменены).
2. Тест на баг должен **падать на старом коде**: перед коммитом откатите исправление (`git stash push -- server/src/...`)
   и убедитесь.
3. Не обращайтесь к реальной сети и SSH: `stubSsh` для SSH, `stubRemotePanel` для панели партнёра, `vi.stubGlobal('fetch')`
   для Cloudflare. Подмену `fetch` нужно сопровождать `passthroughBaseUrl`, если тест сам ходит в тестовое приложение.
4. Ограничители (`FailureLimiter`, лимит партнёра) глобальны для файла: тесты, исчерпывающие лимит, ставьте последними
   или сбрасывайте счётчики (`loginIpLimiter.reset(ip)`).
5. Проверки утечек секретов — по именам полей в кавычках (`"ssh_password"`), а не подстроке: поле `has_ssh_password` легально.
6. Тесты процесса и Docker требуют таймаутов (`it(..., 120000)`), а ожидание фоновой синхронизации — `eventually`/`vi.waitFor`,
   не `sleep`.
7. Новая функция или правка поведения — тест и строка в нужном документе (`docs/`), а при новом правиле — пункт в
   `AGENTS.md`.

## Реальные ноды в Docker

`real-docker-*.test.ts` и `real-federation-e2e.test.ts` ищут ноды по открытому SSH-порту (2222 — нода 1, 2223 — нода 2) и
пропускаются, если их нет. Нода — контейнер Docker-in-Docker с `sshd` (root / `rootpass123`, `--privileged`); Dockerfile и
скрипт — в `server/test/docker`:

Dockerfile удаляет унаследованный SSH-клиент DinD из локальной базы apk перед загрузкой пакетов.
Нода принимает SSH-соединения, поэтому ей достаточно `openssh-server` с его зависимостями.

```bash
server/test/docker/nodes.sh up       # собрать образ, запустить dementia-node-1 (SSH 2222) и dementia-node-2 (SSH 2223)
server/test/docker/nodes.sh status
server/test/docker/nodes.sh down
```

Тесты сами удаляют установленный на ноде контейнер `amnezia-awg`. Нода 1 используется `real-docker-nodes` и
`real-federation-e2e` (последовательно), нода 2 — `real-docker-lifecycle`. Образ AmneziaWG скачивается внутри ноды при первой
установке (нужен интернет).

## CI

`bridges.test.ts` проверяет API каскада, ограничение локальных портов в конфиге, сокрытие секретов и откат при сбое.
`real-docker-bridge-cascade.test.ts` через SSH запускает Xray на обеих Docker-нодах, проверяет передачу UDP и TCP в обе стороны
на прежнем порту моста, очистку старой записи DNAT и удаление контейнеров при отключении.

Клиентские компонентные тесты запускаются `cd client && npm test` (Vitest, jsdom, Testing Library).

`.github/workflows/ci.yml`: `server` (типы, тесты без Docker, сборка), `client` (линт, тесты, сборка), `scripts` (shellcheck), `install` (`install.sh` в чистом
Ubuntu, `test/install/run.sh`) и `e2e` — поднимает тестовые ноды и запускает весь набор, включая Docker-тесты. Сбой любого задания блокирует CI.
Локально ту же проверку на Linux можно выполнить в контейнере:

```bash
docker run --rm -v "$PWD:/src:ro" node:24-alpine sh -c \
  'mkdir /work && cd /src && tar cf - --exclude=node_modules --exclude=.git --exclude=dist --exclude=data . | tar xf - -C /work \
   && cd /work/server && npm ci && npx vitest run'
```

## Обновления контейнеров AmneziaWG

`node-updates.test.ts`: настоящие сервис, БД и API с `stubSsh`; сохранение обычных, импортированных, отключённых и партнёрских клиентов,
ключей и подписок; очередь с syncconf, расписание UTC, запрет гостю, пауза переноса, ограничение повторов и безопасные ошибки.
`update-awg-script.test.ts`: настоящий bash-скрипт со stateful-подменой Docker CLI — скачивание до остановки,
замена по ID, ошибки pull/rename/stop/run, несовпадение пира, откат и отказ при несохранённых ручных изменениях.
`real-docker-node-updates.test.ts`: реальная нода 2, обновление с сохранением БД/конфига/пиров и откат при потере пира в новом контейнере.
