#!/bin/bash
# Обновление работающей панели предыдущего релиза до текущей версии через install.sh: данные, учётные данные, сессии, настройки,
# HTTPS и добавленные вручную переменные .env сохраняются, схема БД обновляется, новые разделы API отвечают.
# Предыдущий релиз берётся из тега git (UPGRADE_FROM_TAG, по умолчанию v0.1.0); без тега проверка пропускается.
set -uo pipefail

source /harness/common.sh
FROM_TAG="${UPGRADE_FROM_TAG:-v0.1.0}"
PASSWORD='UpgradeAdminPass-123'
LOCAL=https://127.0.0.1:3001
STRIP() { sed 's/\x1b\[[0-9;]*m//g'; }
G() { git -c safe.directory='*' -c user.email=test@example.com -c user.name=test "$@"; }
# /src смонтирован с хоста (другой владелец). При fetch из локального репозитория git-upload-pack не получает настройки из -c,
# поэтому исключение нужно в глобальной конфигурации (контейнер одноразовый)
git config --global --add safe.directory /src
git config --global --add safe.directory /src/.git

apt-get install -y -qq git curl ca-certificates >/dev/null 2>&1
if ! git -c safe.directory=/src -C /src rev-parse -q --verify "refs/tags/$FROM_TAG" >/dev/null 2>&1; then
  echo "ПРОПУСК: в репозитории нет тега $FROM_TAG (для проверки нужна история с тегами: git fetch --tags)"
  exit 0
fi

section "U1. Установка предыдущего релиза $FROM_TAG"
mkdir -p /old-src && git -c safe.directory=/src -C /src archive --format=tar "$FROM_TAG" | tar x -C /old-src
chown -R 1000:1000 /old-src
OLD_VERSION=$(node -p "require('/old-src/package.json').version" 2>/dev/null || sed -n 's/.*"version": "\(.*\)".*/\1/p' /old-src/package.json | head -1)
cd /old-src && PANEL_USER=upgrade.admin PANEL_PASSWORD="$PASSWORD" bash install.sh > /tmp/old-install.out 2>&1 || {
  STRIP < /tmp/old-install.out | tail -30
  fail "установка предыдущего релиза"
  exit 1
}
echo "установлена версия $OLD_VERSION"
printf 'TRUST_PROXY=loopback\n# добавлено администратором\nDEMENSION_SELF_UPDATE=1\n' >> /opt/demension-panel/server/.env

section "U2. Данные, HTTPS и сессия на старой версии"
curl -s -X POST http://127.0.0.1:3001/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"upgrade.admin\",\"password\":\"$PASSWORD\"}" > /tmp/login.json
TOKEN=$(node -p "JSON.parse(require('fs').readFileSync('/tmp/login.json','utf8')).token")
api() { curl -sk -X "$1" "$LOCAL$2" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' ${3:+-d "$3"}; }
SERVER_ID=$(curl -s -X POST http://127.0.0.1:3001/api/servers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"Upgrade Node","host":"203.0.113.77","ssh_user":"root","ssh_password":"upgrade-ssh-secret"}' | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
[ -n "$SERVER_ID" ] && [ "$SERVER_ID" != undefined ] || fail "сервер не создан на старой версии"
curl -s -X POST http://127.0.0.1:3001/api/subscribers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"upgrade-user","server_ids":[]}' > /tmp/sub.json
SUB_TOKEN=$(node -p "JSON.parse(require('fs').readFileSync('/tmp/sub.json','utf8')).token")
curl -s -X PUT http://127.0.0.1:3001/api/settings -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"public_url":"http://panel.old.example:3001","client_dns":"9.9.9.9","client_mtu":1380}' > /dev/null
curl -s -X PUT http://127.0.0.1:3001/api/subscription-settings -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"settings":{"title":"{user} VPN","announce":"Плановые работы"},"servers":[{"id":'"$SERVER_ID"',"sub_name":"🇩🇪 Берлин","sub_order":2}]}' > /dev/null
# клиент с накопленным трафиком (панель до переноса создаёт клиентов только на установленных нодах — вставляем напрямую)
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/opt/demension-panel/data/demension.db');
const sub = db.prepare('SELECT id FROM subscribers').get().id;
db.prepare(\"INSERT INTO clients (server_id, subscriber_id, name, client_ip, client_public_key, client_private_key, preshared_key, total_rx, total_tx) VALUES (?, ?, 'upgrade-phone', '10.8.0.2', 'UPGRADE_PUBKEY=', 'UPGRADE_PRIVKEY=', 'UPGRADE_PSK=', 4242424242, 8484848484)\").run($SERVER_ID, sub);
db.close();
"
# HTTPS на той же панели: обновление такой панели раньше ломало проверку запуска
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3001/api/security/ssl/issue-ip -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"ip":"127.0.0.1"}')
[ "$STATUS" = 200 ] || fail "сертификат на IP не выпущен на старой версии ($STATUS)"
sleep 1
node /harness/dump-db.mjs /opt/demension-panel/data/demension.db > /tmp/before.json
echo "выгрузка до обновления: $(wc -c < /tmp/before.json) байт"
CERT_BEFORE=$(sha256sum /opt/demension-panel/data/ssl/privkey.pem | cut -d' ' -f1)
KEY_BEFORE=$(cat /opt/demension-panel/data/secret.key)

section "U3. Обновление до текущей версии (install.sh поверх работающей панели с HTTPS, без вопросов)"
# Имитируем старую установку из Git. Новый код доступен через локальный origin.
LEGACY=/opt/demension-panel
G -C "$LEGACY" init -q -b main &&
  G -C "$LEGACY" fetch -q /src "refs/tags/$FROM_TAG" &&
  G -C "$LEGACY" reset -q --mixed FETCH_HEAD &&
  G -C /work init -q -b main &&
  G -C /work fetch -q "$LEGACY" main &&
  G -C /work reset -q --mixed FETCH_HEAD &&
  G -C /work add -A &&
  G -C /work commit -q -m 'Текущий код для проверки обновления' &&
  G init -q --bare -b main /origin.git &&
  G -C /work push -q /origin.git main &&
  G -C "$LEGACY" remote add origin /origin.git || exit 1
EXPECTED_HEAD=$(G -C /work rev-parse HEAD)

# Шесть старых копий под обоими именами БД и отдельная копия переноса.
BACKUPS="$LEGACY/data/backups"
mkdir -p "$BACKUPS/pre-migration-fixture"
for i in 1 2 3; do
  touch "$BACKUPS/demension.db.20000101-00000$i" "$BACKUPS/demension.db-wal.20000101-00000$i" "$BACKUPS/demension.db-shm.20000101-00000$i"
  touch "$BACKUPS/dementia.db.20000102-00000$i"
done
touch "$BACKUPS/pre-migration-fixture/dementia.db"

cd /work
bash install.sh > /tmp/update.out 2>&1
CODE=$?
STRIP < /tmp/update.out | tail -22
[ "$CODE" -eq 0 ] || fail "обновление завершилось с ошибкой ($CODE)"
[ "$(G -C /opt/dementia-panel rev-parse HEAD)" = "$EXPECTED_HEAD" ] || fail "Git-код старой установки не обновился до ожидаемого коммита"
STRIP < /tmp/update.out | grep_q "не менялись" || fail "установщик не сообщил, что логин и пароль не менялись"
NEW_VERSION=$(node -p "require('/work/package.json').version")

section "U4. Данные после обновления"
node /harness/dump-db.mjs /opt/dementia-panel/data/dementia.db > /tmp/after.json
node /harness/compare-dumps.mjs /tmp/before.json /tmp/after.json || fail "данные изменились при обновлении"
node -e "
const after = JSON.parse(require('fs').readFileSync('/tmp/after.json','utf8'));
const before = JSON.parse(require('fs').readFileSync('/tmp/before.json','utf8'));
if (after.__user_version <= before.__user_version) { console.error('версия схемы не выросла'); process.exit(1); }
if (!after.probe_results) { console.error('нет таблицы probe_results'); process.exit(1); }
if (!after.servers[0] || after.servers[0].probe_port !== null) { console.error('probe_port не добавлен'); process.exit(1); }
" || fail "схема БД не обновлена"
[ "$(sha256sum /opt/dementia-panel/data/ssl/privkey.pem | cut -d' ' -f1)" = "$CERT_BEFORE" ] || fail "сертификат TLS изменился"
[ "$(cat /opt/dementia-panel/data/secret.key)" = "$KEY_BEFORE" ] || fail "ключ шифрования изменился"
BACKUPS=/opt/dementia-panel/data/backups
copies=("$BACKUPS"/{dementia,demension}.db.[0-9]*)
[ "${#copies[@]}" -eq 5 ] || fail "после обновления должно остаться пять копий БД"
find "$BACKUPS" -maxdepth 1 -name 'demension.db.*' ! -name '*.20000101-*' | grep_q . || fail "резервная копия БД перед обновлением не создана"
[ -f "$BACKUPS/demension.db.20000101-000003" ] && [ -f "$BACKUPS/demension.db-wal.20000101-000003" ] &&
  [ -f "$BACKUPS/demension.db-shm.20000101-000003" ] || fail "не сохранена последняя старая копия с WAL и SHM"
for i in 1 2; do
  for suffix in "" "-wal" "-shm"; do
    [ ! -e "$BACKUPS/demension.db$suffix.20000101-00000$i" ] || fail "устаревшая копия или её WAL/SHM не удалены"
  done
done
[ -f "$BACKUPS/pre-migration-fixture/dementia.db" ] || fail "удалена резервная копия переноса"
# Переименование проекта: каталог, служба, файл БД и переменные .env переехали, старые имена остались ссылками
[ -d /opt/dementia-panel ] && [ ! -L /opt/dementia-panel ] || fail "панель не перенесена в /opt/dementia-panel"
[ "$(readlink /opt/demension-panel)" = /opt/dementia-panel ] || fail "/opt/demension-panel не стал ссылкой на новый каталог"
[ -f /etc/systemd/system/dementia.service ] || fail "нет службы dementia.service"
grep_q -x 'Alias=demension.service' /etc/systemd/system/dementia.service || fail "у службы нет псевдонима demension.service"
[ ! -f /etc/systemd/system/demension.service ] || fail "осталась служба прежнего имени"
[ -f /opt/dementia-panel/data/dementia.db ] && [ ! -e /opt/dementia-panel/data/demension.db ] || fail "файл БД не переименован в dementia.db"
grep_q -x 'DEMENTIA_SELF_UPDATE=1' /opt/dementia-panel/server/.env || fail "переменная DEMENSION_* не переименована в .env"
ENVF=/opt/dementia-panel/server/.env
grep_q -x 'TRUST_PROXY=loopback' "$ENVF" || fail "переменная .env потеряна при обновлении"
[ "$(stat -c '%a' "$ENVF")" = 600 ] || fail "права .env не 600"

section "U5. Работа после обновления: вход со старой сессией и паролем, HTTPS, подписки, новые разделы"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$LOCAL/api/auth/me" -H "Authorization: Bearer $TOKEN")" = 200 ] || fail "сессия администратора не пережила обновление"
STATUS=$(curl -sk -o /tmp/login2.json -w '%{http_code}' -X POST "$LOCAL/api/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"upgrade.admin\",\"password\":\"$PASSWORD\"}")
[ "$STATUS" = 200 ] || fail "прежний пароль не подходит ($STATUS)"
HEALTH=$(curl -s http://127.0.0.1:3001/api/health)
echo "health по HTTP: $HEALTH"
echo "$HEALTH" | grep_q '"https":true' || fail "HTTPS не работает после обновления"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3001/sub/$SUB_TOKEN")" = 200 ] || fail "ссылка подписки по HTTP не работает"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$LOCAL/sub/$SUB_TOKEN?format=clash")" = 200 ] || fail "подписка mihomo не работает"
VERSION=$(api GET /api/version | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).current")
echo "версия в панели: $VERSION (было $OLD_VERSION)"
[ "$VERSION" = "v$NEW_VERSION" ] || fail "панель не перезапущена на новой версии: $VERSION"
SERVERS=$(api GET /api/servers)
echo "$SERVERS" | grep_q '"Upgrade Node"' || fail "нода пропала"
echo "$SERVERS" | grep_q '"probes":\[\]' || fail "у сервера нет поля probes"
echo "$SERVERS" | grep_q 'upgrade-ssh-secret' && fail "SSH-пароль утёк в API"
[ "$(api GET /api/migration/status | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).state")" = idle ] || fail "раздел переноса не отвечает"
[ "$(api GET /api/probes | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).settings.enabled")" = false ] || fail "проверка из стран должна быть выключена по умолчанию"
SUBLINK=$(curl -s "http://127.0.0.1:3001/sub/$SUB_TOKEN" | base64 -d 2>/dev/null | head -c 200)
echo "подписка без нод пуста: [$SUBLINK]"

section "U6. Обновление из панели (update-panel.sh + настоящий install.sh) до тега релиза и откат неудачного релиза"
# Добавляем релизы новее текущего в локальный origin, созданный в U3.
PANEL=/opt/dementia-panel
CUR="v$NEW_VERSION"
NEXT="v$(node -p "const v=require('$PANEL/package.json').version.split('.'); v[2]=+v[2]+1; v.join('.')")"
BROKEN="v$(node -p "const v=require('$PANEL/package.json').version.split('.'); v[2]=+v[2]+2; v.join('.')")"
G clone -q /origin.git /next
sed -i "s/\"version\": \"$NEW_VERSION\"/\"version\": \"${NEXT#v}\"/" /next/package.json
G -C /next commit -qam "release $NEXT" && G -C /next tag "$NEXT"
sed -i "s/\"version\": \"${NEXT#v}\"/\"version\": \"${BROKEN#v}\"/" /next/package.json
echo "const broken: number = 'не число';" >> /next/server/src/index.ts   # релиз, который не собирается
G -C /next commit -qam "release $BROKEN" && G -C /next tag "$BROKEN"
G -C /next push -q origin main --tags

node /harness/dump-db.mjs "$PANEL/data/dementia.db" > /tmp/before6.json
bash "$PANEL/server/dist/scripts/update-panel.sh" "$PANEL" "$PANEL/data/update" "$NEXT" "$CUR"
CODE=$?
STRIP < "$PANEL/data/update/update.log" | tail -12
cat "$PANEL/data/update/status.json"
[ "$CODE" -eq 0 ] || fail "обновление из панели завершилось с ошибкой ($CODE)"
grep_q '"state":"success"' "$PANEL/data/update/status.json" || fail "состояние обновления не success"
VERSION=$(api GET /api/version | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).current")
[ "$VERSION" = "$NEXT" ] || fail "после обновления из панели версия $VERSION, ожидалась $NEXT"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "$LOCAL/api/auth/me" -H "Authorization: Bearer $TOKEN")" = 200 ] || fail "сессия не пережила обновление из панели"
[ "$(api GET /api/version/update | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).state")" = success ] || fail "API не показывает результат обновления"
node /harness/dump-db.mjs "$PANEL/data/dementia.db" > /tmp/after6.json
node /harness/compare-dumps.mjs /tmp/before6.json /tmp/after6.json sessions || fail "данные изменились при обновлении из панели"
grep_q -x 'TRUST_PROXY=loopback' "$PANEL/server/.env" || fail "переменная .env потеряна при обновлении из панели"

bash "$PANEL/server/dist/scripts/update-panel.sh" "$PANEL" "$PANEL/data/update" "$BROKEN" "$NEXT"
CODE=$?
STRIP < "$PANEL/data/update/update.log" | tail -8
cat "$PANEL/data/update/status.json"
[ "$CODE" -ne 0 ] || fail "несобираемый релиз установился без ошибки"
grep_q '"state":"rolled_back"' "$PANEL/data/update/status.json" || fail "после неудачного обновления нет отката"
VERSION=$(api GET /api/version | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).current")
[ "$VERSION" = "$NEXT" ] || fail "после отката версия $VERSION, ожидалась $NEXT"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3001/sub/$SUB_TOKEN")" = 200 ] || fail "подписка не работает после отката"
node /harness/dump-db.mjs "$PANEL/data/dementia.db" > /tmp/after6b.json
node /harness/compare-dumps.mjs /tmp/before6.json /tmp/after6b.json sessions || fail "данные изменились после отката"

echo
if [ "$FAILED" -eq 0 ]; then echo "=== ОБНОВЛЕНИЕ С $FROM_TAG: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ==="; else echo "=== ОБНОВЛЕНИЕ С $FROM_TAG: ЕСТЬ ПРОВАЛЕННЫЕ ПРОВЕРКИ ==="; fi
exit "$FAILED"
