#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Dementia Panel - Automated Server Deployment Script
#
# Интерактивно:      curl -sSL .../install.sh | sudo bash
# Без вопросов:      curl -sSL .../install.sh | sudo PANEL_PORT=3001 bash
#
# Логин и пароль администратора при первой установке генерируются случайно и показываются в конце установки
# ОДИН РАЗ (в БД хранится только хэш). Свои значения можно передать через PANEL_USER / PANEL_PASSWORD.
# При обновлении существующей панели учётные данные не меняются; PANEL_RESET_CREDENTIALS=1 выдаёт новые случайные.
# Установка не трогает Docker и контейнеры на сервере (в том числе AmneziaWG приложения Amnezia).
#
# Перенос панели с другого сервера (docs/migration.md): на прежней панели «Безопасность → Перенос панели» выдаёт код.
# Затем на новом сервере:  curl -sSL .../install.sh | sudo bash   и выбрать «2) Перенос». Без вопросов:
#   MIGRATE_FROM=https://старая-панель:3001 MIGRATION_CODE=XXXXX-XXXXX-XXXXX-XXXXX-XXXXX   (или MIGRATE_FILE=путь к .dpm)
#   PANEL_CERT_MODE=keep|cf|http|ip|custom|none  PANEL_DOMAIN PANEL_EMAIL CF_API_TOKEN PANEL_CERT_FILE PANEL_KEY_FILE
#   MIGRATE_REPLACE=1  — заменить данные уже установленной на этом сервере панели (резервная копия в data/backups)
# Логин и пароль администратора, ноды, клиенты и подписки переезжают без изменений.
#
# До v0.1.4 проект назывался Demension: /opt/demension-panel и служба demension.service. Обновление переносит такую
# установку в /opt/dementia-panel (на прежнем месте остаётся символическая ссылка), служба становится dementia.service
# с псевдонимом demension.service, переменные DEMENSION_* в server/.env — DEMENTIA_* (старые имена панель тоже читает).
#
# Обновление из интерфейса панели (docs/releases.md): server/src/scripts/update-panel.sh запускает install.sh нового релиза без
# терминала с PANEL_UPDATE_REF=vX.Y.Z — обновление до этого тега вместо головы main. Поддержку этой переменной не удалять.
# ==============================================================================

# Text formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

INSTALL_DIR="/opt/dementia-panel"
REPO_URL="https://github.com/team-ph4r0s/dementia-panel.git"
SERVICE="dementia.service"
# Прежнее имя проекта (до v0.1.4)
LEGACY_DIR="/opt/demension-panel"
LEGACY_SERVICE="demension.service"
# Код прежней установки обновляется на месте, а после остановки службы каталог переносится в INSTALL_DIR
CODE_DIR="$INSTALL_DIR"
RENAME_LEGACY=false
if [ ! -e "$INSTALL_DIR" ] && [ -d "$LEGACY_DIR" ] && [ ! -L "$LEGACY_DIR" ]; then
  CODE_DIR="$LEGACY_DIR"
  RENAME_LEGACY=true
fi
MIN_NODE="22.13.0"

echo -e "${CYAN}${BOLD}"
echo "======================================================================"
echo "          DEMENTIA PANEL - УСТАНОВОЧНЫЙ СКРИПТ ПАНЕЛИ                "
echo "        Управление инфраструктурой серверов AmneziaWG                 "
echo "======================================================================"
echo -e "${NC}"

# Check root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR] Этот скрипт должен быть запущен с правами root (sudo).${NC}"
  exit 1
fi

# При запуске через `curl | bash` stdin занят самим скриптом — вопросы задаём через терминал.
# Узел /dev/tty есть и без терминала (ssh без -t, cron, CI, docker без -t), но открыть его нельзя — поэтому проверяется открытие.
if (exec < /dev/tty) 2>/dev/null && (exec > /dev/tty) 2>/dev/null; then
  TTY=/dev/tty
else
  TTY=""
fi

ask() { # ask VAR "Вопрос" "по умолчанию"
  local __var="$1" __prompt="$2" __default="${3:-}" __reply=""
  if [ -n "${!__var:-}" ]; then return; fi
  if [ -n "$TTY" ]; then
    read -r -p "$__prompt" __reply < "$TTY" || __reply=""
  fi
  printf -v "$__var" '%s' "${__reply:-$__default}"
}

ask_secret() { # ask_secret VAR "Вопрос" — ввод не отображается (коды, токены)
  local __var="$1" __prompt="$2" __reply=""
  if [ -n "${!__var:-}" ]; then return; fi
  if [ -n "$TTY" ]; then
    read -r -s -p "$__prompt" __reply < "$TTY" || __reply=""
    echo > "$TTY"
  fi
  printf -v "$__var" '%s' "$__reply"
}

CREDS_PENDING=false
print_pending_credentials() { # при обрыве установки после создания администратора пароль всё равно показывается
  if [ "$CREDS_PENDING" = true ]; then
    echo -e "\n${YELLOW}Установка прервана. Учётные данные, переданные для настройки администратора:${NC}"
    echo "  Логин:  $PANEL_USER"
    if [ -n "${GENERATED_PASSWORD_VALUE:-}" ]; then echo "  Пароль: $GENERATED_PASSWORD_VALUE"; fi
    echo "  Новый пароль при необходимости: cd ${INSTALL_DIR} && node server/dist/cli/reset-admin.js"
  fi
}
trap print_pending_credentials EXIT

rand_chars() { # rand_chars ДЛИНА НАБОР — случайная строка из /dev/urandom
  local out=""
  while [ "${#out}" -lt "$1" ]; do
    out+=$(head -c 96 /dev/urandom | LC_ALL=C tr -dc "$2" || true)
  done
  printf '%s' "${out:0:$1}"
}

port_listeners() { # port_listeners ПОРТ — строки процессов, слушающих TCP-порт (пусто, если порт свободен)
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$1" 2>/dev/null || true
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null | awk -v port=":$1" '$4 ~ port"$"' || true
  fi
}

version_ge() { # version_ge 22.13.0 22.5.1
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

# Внешний IPv4 сервера; если определить не удалось — первый адрес интерфейсов
detect_server_ip() {
  local ip="" candidate url
  for url in https://api.ipify.org https://ifconfig.me https://icanhazip.com; do
    candidate="$(curl -s -4 --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$candidate" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      ip="$candidate"
      break
    fi
  done
  if [ -z "$ip" ]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  printf '%s' "${ip:-IP_СЕРВЕРА}"
}

open_firewall_port() { # open_firewall_port ПОРТ — открывает TCP-порт в активном ufw/firewalld
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow "$1/tcp" >/dev/null 2>&1 || true
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$1/tcp" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
  fi
}

# --- Перенос панели: вызовы CLI server/dist/cli/migration.js ---
MIG_OUT=""
run_migration_cli() { # печатает вывод; строки @@ключ=значение сохраняются в MIG_OUT (mig_value ключ)
  local tmp status
  tmp="$(mktemp)"
  set +e
  node "$INSTALL_DIR/server/dist/cli/migration.js" "$@" 2>&1 | tee "$tmp" | { grep -v '^@@' || true; }
  status=${PIPESTATUS[0]}
  set -e
  MIG_OUT="$(grep '^@@' "$tmp" || true)"
  rm -f "$tmp"
  return "$status"
}
mig_value() { printf '%s\n' "$MIG_OUT" | sed -n "s/^@@$1=//p" | head -n1; }

# 1. System packages & Node.js
echo -e "${CYAN}[1/7] Проверка системных компонентов и Node.js...${NC}"
if command -v apt-get >/dev/null 2>&1; then
  PM=apt
  apt-get update -y
  apt-get install -y curl git ca-certificates
elif command -v dnf >/dev/null 2>&1; then
  PM=dnf
  dnf install -y curl git ca-certificates tar
else
  echo -e "${RED}[ERROR] Поддерживаются дистрибутивы на базе Debian/Ubuntu и RHEL/AlmaLinux.${NC}"
  exit 1
fi

NEED_NODE=true
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE=$(node -v | sed 's/^v//')
  if version_ge "$CURRENT_NODE" "$MIN_NODE"; then
    NEED_NODE=false
  fi
fi

if [ "$NEED_NODE" = true ]; then
  echo -e "${YELLOW}Установка Node.js 22 LTS (требуется ≥ ${MIN_NODE})...${NC}"
  if [ "$PM" = apt ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  fi
  CURRENT_NODE=$(node -v | sed 's/^v//')
  if ! version_ge "$CURRENT_NODE" "$MIN_NODE"; then
    echo -e "${RED}[ERROR] Установлен Node.js ${CURRENT_NODE}, требуется ≥ ${MIN_NODE}.${NC}"
    exit 1
  fi
fi
echo -e "${GREEN}✓ Node.js $(node -v) и npm $(npm -v) готовы к работе.${NC}"

# Контейнеры AmneziaWG, уже работающие на сервере (например, от приложения AmneziaVPN): установка панели их не трогает
EXISTING_AWG=""
if command -v docker >/dev/null 2>&1; then
  EXISTING_AWG="$(docker ps -a --format '{{.Names}} ({{.Image}})' 2>/dev/null | grep -i 'amnezia' || true)"
fi

# 2. Detect existing installation
UPDATE=false
if [ -f "$CODE_DIR/server/package.json" ]; then
  UPDATE=true
fi

# 3. Interactive Prompts
echo -e "\n${CYAN}[2/7] Настройка параметров доступа к панели:${NC}"

# Режим: установка (по умолчанию) или перенос панели с другого сервера. Об обновлении уже установленной панели не спрашиваем.
MIGRATE_MODE=false
MIGRATE_DEFAULT_PORT=""
if [ -n "${MIGRATE_FROM:-}" ] || [ -n "${MIGRATE_FILE:-}" ] || [ "${MIGRATE:-}" = "1" ]; then
  MIGRATE_MODE=true
elif [ "$UPDATE" != true ] && [ -n "$TTY" ]; then
  echo "Что нужно сделать?"
  echo "  1) Новая установка панели"
  echo "  2) Перенос панели с другого сервера (администратор, ноды, клиенты, подписки — всё переедет без изменений)"
  INSTALL_MODE=""
  ask INSTALL_MODE "Выбор [1]: " "1"
  if [ "$INSTALL_MODE" = "2" ]; then MIGRATE_MODE=true; fi
fi

if [ "$MIGRATE_MODE" = true ]; then
  echo -e "${CYAN}Перенос панели.${NC} На прежней панели откройте «Безопасность → Перенос панели» и нажмите «Подготовить перенос»:"
  echo "она покажет код переноса. Данные передаются в зашифрованном виде; прежняя панель после переноса отключается."
  if [ -z "${MIGRATE_FILE:-}" ]; then
    ask MIGRATE_FROM "Адрес прежней панели (https://panel.example.com:3001) или путь к скачанному файлу архива: " ""
    if [ -n "$MIGRATE_FROM" ] && [ -f "$MIGRATE_FROM" ]; then
      MIGRATE_FILE="$MIGRATE_FROM"
      MIGRATE_FROM=""
    fi
  fi
  MIGRATE_FROM="${MIGRATE_FROM:-}"
  if [ -z "$MIGRATE_FROM" ] && [ -z "${MIGRATE_FILE:-}" ]; then
    echo -e "${RED}[ERROR] Не указан источник переноса: MIGRATE_FROM=<адрес прежней панели> или MIGRATE_FILE=<файл архива>.${NC}"
    exit 1
  fi
  if [ -n "${MIGRATE_FILE:-}" ] && [ ! -f "$MIGRATE_FILE" ]; then
    echo -e "${RED}[ERROR] Файл архива переноса не найден: ${MIGRATE_FILE}${NC}"
    exit 1
  fi
  ask_secret MIGRATION_CODE "Код переноса (XXXXX-XXXXX-XXXXX-XXXXX-XXXXX, ввод не отображается): "
  if [ -z "${MIGRATION_CODE:-}" ]; then
    echo -e "${RED}[ERROR] Не указан код переноса (MIGRATION_CODE).${NC}"
    exit 1
  fi
  export MIGRATION_CODE
  # Порт новой панели по умолчанию совпадает с прежним: адреса подписок содержат порт
  if [ -n "$MIGRATE_FROM" ]; then
    MIGRATE_DEFAULT_PORT="$(printf '%s' "$MIGRATE_FROM" | sed -nE 's#^https?://(\[[^]]*\]|[^/:]+):([0-9]+).*#\2#p')"
    if [ -z "$MIGRATE_DEFAULT_PORT" ]; then
      case "$MIGRATE_FROM" in https://*) MIGRATE_DEFAULT_PORT=443 ;; http://*) MIGRATE_DEFAULT_PORT=80 ;; esac
    fi
  fi
fi

CURRENT_PORT=""
if [ -f "$CODE_DIR/server/.env" ]; then
  CURRENT_PORT=$(grep -E '^PORT=' "$CODE_DIR/server/.env" | cut -d= -f2 || true)
fi
DEFAULT_PORT="${MIGRATE_DEFAULT_PORT:-${CURRENT_PORT:-3001}}"
ask PANEL_PORT "Порт панели [${DEFAULT_PORT}]: " "$DEFAULT_PORT"
if ! [[ "$PANEL_PORT" =~ ^[0-9]+$ ]] || [ "$PANEL_PORT" -lt 1 ] || [ "$PANEL_PORT" -gt 65535 ]; then
  echo -e "${RED}[ERROR] Некорректный порт: ${PANEL_PORT}${NC}"
  exit 1
fi

# Учётные данные администратора: при первой установке — случайные; при обновлении и переносе остаются прежними
SET_CREDENTIALS=true
if [ "$MIGRATE_MODE" = true ] && [ -z "${PANEL_PASSWORD:-}" ] && [ -z "${PANEL_USER:-}" ] && [ "${PANEL_RESET_CREDENTIALS:-}" != "1" ]; then
  SET_CREDENTIALS=false # логин и пароль приедут вместе с данными прежней панели
elif [ "$UPDATE" = true ] && [ -z "${PANEL_PASSWORD:-}" ] && [ -z "${PANEL_USER:-}" ] && [ "${PANEL_RESET_CREDENTIALS:-}" != "1" ]; then
  CHANGE_CREDS=""
  ask CHANGE_CREDS "Обнаружена установленная панель. Выдать новые случайные логин и пароль администратора? [y/N]: " "n"
  case "$CHANGE_CREDS" in
    y|Y|yes|д|Д) ;;
    *) SET_CREDENTIALS=false ;;
  esac
fi

GENERATED_PASSWORD=false
if [ "$SET_CREDENTIALS" = true ]; then
  if [ -z "${PANEL_USER:-}" ]; then
    # Логин начинается с буквы: так он однозначно читается и вводится
    PANEL_USER="$(rand_chars 1 'a-z')$(rand_chars 9 'a-z0-9')"
  elif ! [[ "$PANEL_USER" =~ ^[A-Za-z0-9._@-]{1,64}$ ]]; then
    echo -e "${RED}[ERROR] Логин администратора: до 64 символов из A-Z a-z 0-9 . _ @ -${NC}"
    exit 1
  fi
  if [ -z "${PANEL_PASSWORD:-}" ]; then
    PANEL_PASSWORD="$(rand_chars 20 'A-Za-z0-9')"
    GENERATED_PASSWORD=true
  elif [ ${#PANEL_PASSWORD} -lt 8 ]; then
    echo -e "${RED}[ERROR] Пароль должен содержать не менее 8 символов.${NC}"
    exit 1
  fi
fi

# Порт панели должен быть свободен (кроме случая, когда его уже занимает сама обновляемая панель)
if [ -n "$(port_listeners "$PANEL_PORT")" ]; then
  if [ "$UPDATE" = true ] && [ "$PANEL_PORT" = "${CURRENT_PORT:-3001}" ] && { systemctl is-active --quiet "$SERVICE" 2>/dev/null || systemctl is-active --quiet "$LEGACY_SERVICE" 2>/dev/null; }; then
    :
  else
    echo -e "${RED}[ERROR] TCP-порт ${PANEL_PORT} уже занят:${NC}"
    port_listeners "$PANEL_PORT"
    echo -e "Выберите другой порт: PANEL_PORT=<порт> (или освободите этот)."
    exit 1
  fi
fi

# 4. Clone or Update Repository
echo -e "\n${CYAN}[3/7] Развертывание кодовой базы в ${INSTALL_DIR}...${NC}"
# Новый код скачивается, пока панель ещё работает: при ошибке (нет сети, локальные правки) она остаётся запущенной
if [ -d "$CODE_DIR/.git" ]; then
  echo "Обновление существующей установки..."
  # Репозиторий переименован и перенесён в организацию (ghostoftheeleven/demension-panel → team-ph4r0s/dementia-panel):
  # GitHub перенаправляет старые адреса, но храним новый
  if git -c safe.directory="$CODE_DIR" -C "$CODE_DIR" remote get-url origin 2>/dev/null | grep -qE 'ghostoftheeleven/(demension|dementia)-panel'; then
    git -c safe.directory="$CODE_DIR" -C "$CODE_DIR" remote set-url origin "$REPO_URL" || true
  fi
  # safe.directory: каталог мог быть скопирован из клона обычного пользователя, а установщик работает от root.
  # PANEL_UPDATE_REF=vX.Y.Z — обновление до релиза (так обновляет панель из интерфейса, update-panel.sh), а не до головы main.
  if [ -n "${PANEL_UPDATE_REF:-}" ]; then
    if ! [[ "$PANEL_UPDATE_REF" =~ ^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$ ]]; then
      echo -e "${RED}[ERROR] PANEL_UPDATE_REF: ожидается версия вида v1.2.3.${NC}"
      exit 1
    fi
    if ! git -c safe.directory="$CODE_DIR" -C "$CODE_DIR" fetch --no-tags origin "+refs/tags/${PANEL_UPDATE_REF}:refs/tags/${PANEL_UPDATE_REF}" \
      || ! git -c safe.directory="$CODE_DIR" -C "$CODE_DIR" merge --ff-only "refs/tags/${PANEL_UPDATE_REF}"; then
      echo -e "${RED}[ERROR] Не удалось получить релиз ${PANEL_UPDATE_REF}. Панель продолжает работать на прежней версии.${NC}"
      echo -e "Проверьте доступ к GitHub и локальные изменения: git -C ${CODE_DIR} status"
      exit 1
    fi
  elif ! git -c safe.directory="$CODE_DIR" -C "$CODE_DIR" pull --ff-only origin main; then
    echo -e "${RED}[ERROR] Не удалось получить обновление (git pull). Панель продолжает работать на прежней версии.${NC}"
    echo -e "Проверьте доступ к GitHub и локальные изменения: git -C ${CODE_DIR} status"
    exit 1
  fi
fi

if [ "$UPDATE" = true ] || [ "$RENAME_LEGACY" = true ]; then
  systemctl stop "$SERVICE" 2>/dev/null || true
  systemctl stop "$LEGACY_SERVICE" 2>/dev/null || true
fi
if [ "$RENAME_LEGACY" = true ]; then
  # Служба остановлена — каталог прежней установки переезжает; старый путь остаётся ссылкой (им пользуются скрипты и
  # процесс обновления из интерфейса прежней версии)
  mv "$LEGACY_DIR" "$INSTALL_DIR"
  ln -s "$INSTALL_DIR" "$LEGACY_DIR"
  echo -e "${GREEN}✓ Панель перенесена в ${INSTALL_DIR} (проект переименован в Dementia; ${LEGACY_DIR} — ссылка на новый каталог).${NC}"
fi
if [ "$UPDATE" = true ]; then
  if [ -f "$INSTALL_DIR/data/dementia.db" ] || [ -f "$INSTALL_DIR/data/demension.db" ]; then
    BACKUP_DIR="$INSTALL_DIR/data/backups"
    mkdir -p "$BACKUP_DIR"
    STAMP=$(date +%Y%m%d-%H%M%S)
    # Не перезаписываем предыдущий снимок и его WAL/SHM при двух обновлениях за одну секунду.
    while compgen -G "$BACKUP_DIR/dementia.db*.$STAMP" >/dev/null ||
          compgen -G "$BACKUP_DIR/demension.db*.$STAMP" >/dev/null; do
      sleep 1
      STAMP=$(date +%Y%m%d-%H%M%S)
    done
    for db_name in dementia.db demension.db; do
      [ -f "$INSTALL_DIR/data/$db_name" ] || continue
      for suffix in "" "-wal" "-shm"; do
        f="$INSTALL_DIR/data/$db_name$suffix"
        [ -f "$f" ] || continue
        cp -a "$f" "$BACKUP_DIR/$db_name$suffix.$STAMP"
      done
    done
    chmod -R go-rwx "$BACKUP_DIR"
    # Считаем только основные файлы копий обоих имён БД, WAL и SHM удаляем вместе с ними.
    # Каталоги резервных копий переноса и файлы других форматов остаются нетронутыми.
    mapfile -t db_backups < <(
      for f in "$BACKUP_DIR"/{dementia,demension}.db.*; do
        [ -f "$f" ] || continue
        name="${f##*/}"
        if [[ "$name" =~ ^(dementia|demension)\.db\.([0-9]{8}-[0-9]{6})$ ]]; then
          printf '%s %s\n' "${BASH_REMATCH[2]}" "${name%%.*}"
        fi
      done | LC_ALL=C sort -r
    )
    for entry in "${db_backups[@]:5}"; do
      read -r stamp db_prefix <<< "$entry"
      rm -f -- "$BACKUP_DIR/$db_prefix.db.$stamp" "$BACKUP_DIR/$db_prefix.db-wal.$stamp" "$BACKUP_DIR/$db_prefix.db-shm.$stamp"
    done
    echo -e "${GREEN}✓ Резервная копия БД: ${BACKUP_DIR}/dementia.db.${STAMP}${NC}"
  fi
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  : # уже обновлено выше
elif [ -f "$(pwd)/package.json" ] && [ -d "$(pwd)/server" ] && [ "$(pwd)" != "$INSTALL_DIR" ]; then
  echo "Копирование текущей директории в ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR"
  # ./. копирует содержимое каталога, включая скрытые файлы, но не родительский каталог
  cp -a ./. "$INSTALL_DIR/"
  rm -rf "$INSTALL_DIR/server/node_modules" "$INSTALL_DIR/client/node_modules"
elif [ ! -f "$INSTALL_DIR/server/package.json" ]; then
  echo "Клонирование репозитория..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# 5. Install Dependencies and Build
echo -e "\n${CYAN}[4/7] Установка зависимостей и компиляция проектов...${NC}"
npm ci --prefix server
npm ci --prefix client
npm run build

mkdir -p "$INSTALL_DIR/data"
chmod 700 "$INSTALL_DIR/data"

# Пароль в .env не хранится: учётные данные записываются сразу в БД (только хэш).
# Добавленные вручную переменные (DEMENTIA_SECRET_KEY, TRUST_PROXY и т.п.) сохраняются: без DEMENTIA_SECRET_KEY панель
# не расшифровала бы SSH-доступы к нодам. PANEL_USER/PANEL_PASSWORD от старых версий установщика удаляются.
umask 077
ENV_FILE="$INSTALL_DIR/server/.env"
KEPT_ENV=""
if [ -f "$ENV_FILE" ]; then
  KEPT_ENV="$(grep -Ev '^[[:space:]]*(export[[:space:]]+)?(PORT|NODE_ENV|PANEL_USER|PANEL_PASSWORD)[[:space:]]*=' "$ENV_FILE" || true)"
  if [ "$MIGRATE_MODE" = true ]; then
    # Ключ шифрования приезжает вместе с данными прежней панели (data/secret.key); другой ключ в .env сломал бы расшифровку SSH-доступов
    KEPT_ENV="$(printf '%s\n' "$KEPT_ENV" | grep -Ev '^[[:space:]]*(export[[:space:]]+)?DEMEN(TIA|SION)_SECRET_KEY[[:space:]]*=' || true)"
  fi
  # Прежние имена переменных (DEMENSION_*) переводятся на новые; панель понимает и те и другие
  KEPT_ENV="$(printf '%s\n' "$KEPT_ENV" | sed -E 's/^([[:space:]]*(export[[:space:]]+)?)DEMENSION_/\1DEMENTIA_/')"
fi
{
  echo "PORT=${PANEL_PORT}"
  echo "NODE_ENV=production"
  if [ -n "$KEPT_ENV" ]; then printf '%s\n' "$KEPT_ENV"; fi
} > "$ENV_FILE.new"
chmod 600 "$ENV_FILE.new"
mv -f "$ENV_FILE.new" "$ENV_FILE"
unset KEPT_ENV

# --- Перенос панели: данные прежней панели, затем сертификат HTTPS для нового сервера ---
OLD_ADMIN=""
CERT_ENABLED=0
CERT_HOST=""
NEW_URL=""
OLD_SSL_DOMAIN=""
OLD_SSL_EMAIL=""
OLD_SSL_EXPIRES=""
OLD_CERT_OK=0
CF_TOKEN_SAVED=0

valid_domain() { [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; }

cert_attempt() { # cert_attempt НОМЕР_ВАРИАНТА — 0, если сертификат установлен (или выбран режим без HTTPS)
  local choice="$1" domain="${PANEL_DOMAIN:-}" email="${PANEL_EMAIL:-}" token="${CF_API_TOKEN:-}" a_record="" ip="" go="" cert_file="${PANEL_CERT_FILE:-}" key_file="${PANEL_KEY_FILE:-}"
  case "$choice" in
    1)
      ask domain "Домен панели (новый или прежний)${OLD_SSL_DOMAIN:+ [$OLD_SSL_DOMAIN]}: " "$OLD_SSL_DOMAIN"
      if ! valid_domain "$domain"; then echo -e "${RED}Некорректное доменное имя: ${domain}${NC}"; return 1; fi
      ask email "Email для уведомлений Let's Encrypt${OLD_SSL_EMAIL:+ [$OLD_SSL_EMAIL]}: " "$OLD_SSL_EMAIL"
      if [ -z "$email" ]; then echo -e "${RED}Нужен email для Let's Encrypt.${NC}"; return 1; fi
      if [ -z "$token" ] && [ "$CF_TOKEN_SAVED" != 1 ]; then
        ask_secret token "Cloudflare API-токен (права Zone:DNS:Edit, ввод не отображается): "
        if [ -z "$token" ]; then echo -e "${RED}Нужен Cloudflare API-токен.${NC}"; return 1; fi
      elif [ -z "$token" ]; then
        echo "Используется токен Cloudflare, сохранённый в прежней панели."
      fi
      ask a_record "Создать или обновить A-запись ${domain} на IP этого сервера в Cloudflare? [Y/n]: " "y"
      case "$a_record" in n|N|no|н|Н) a_record=no ;; *) a_record=yes ;; esac
      if ! CF_API_TOKEN="$token" run_migration_cli ssl --mode cf --domain "$domain" --email "$email" --a-record "$a_record"; then
        # Сохранённый токен не подошёл (отозван или без прав) — при следующей попытке спросим новый
        if [ -z "$token" ]; then CF_TOKEN_SAVED=0; fi
        return 1
      fi
      ;;
    2)
      ask domain "Домен панели (должен указывать на этот сервер)${OLD_SSL_DOMAIN:+ [$OLD_SSL_DOMAIN]}: " "$OLD_SSL_DOMAIN"
      if ! valid_domain "$domain"; then echo -e "${RED}Некорректное доменное имя: ${domain}${NC}"; return 1; fi
      ask email "Email для уведомлений Let's Encrypt${OLD_SSL_EMAIL:+ [$OLD_SSL_EMAIL]}: " "$OLD_SSL_EMAIL"
      if [ -z "$email" ]; then echo -e "${RED}Нужен email для Let's Encrypt.${NC}"; return 1; fi
      run_migration_cli dns-check --domain "$domain" || true
      if [ "$(mig_value dns_ok)" != 1 ]; then
        echo -e "${YELLOW}Домен ${domain} указывает на «$(mig_value dns_resolved)», а IP этого сервера — $(mig_value public_ip).${NC}"
        echo -e "${YELLOW}Let's Encrypt проверит домен по HTTP и не найдёт здесь панель, пока запись A не указывает на этот сервер.${NC}"
        if [ -z "${PANEL_CERT_MODE:-}" ]; then
          ask go "Всё равно попробовать выпустить сертификат? [y/N]: " "n"
          case "$go" in y|Y|yes|д|Д) ;; *) return 1 ;; esac
        fi
      fi
      open_firewall_port 80
      if ! run_migration_cli ssl --mode http --domain "$domain" --email "$email"; then return 1; fi
      ;;
    3)
      echo -e "${YELLOW}Сертификат на IP-адрес самоподписанный: браузер покажет предупреждение, а ПОДПИСКИ ПО https:// РАБОТАТЬ НЕ БУДУТ —${NC}"
      echo -e "${YELLOW}приложения (Incy, Clash и др.) не принимают такой сертификат. Ссылки http:// работают, но ключи в них идут открытым текстом.${NC}"
      echo -e "${YELLOW}Для подписок нужен домен и сертификат Let's Encrypt (варианты 1 и 2).${NC}"
      if [ -z "${PANEL_CERT_MODE:-}" ]; then
        ask go "Использовать сертификат на IP-адрес? [y/N]: " "n"
        case "$go" in y|Y|yes|д|Д) ;; *) return 1 ;; esac
      fi
      go="$(detect_server_ip)"
      ask ip "IP-адрес сервера для сертификата [${go}]: " "$go"
      if ! run_migration_cli ssl --mode ip --ip "$ip"; then return 1; fi
      ;;
    4)
      ask cert_file "Путь к файлу сертификата (fullchain.pem) на этом сервере: " ""
      ask key_file "Путь к файлу приватного ключа (privkey.pem): " ""
      if [ ! -r "$cert_file" ] || [ ! -r "$key_file" ]; then echo -e "${RED}Файлы сертификата или ключа не найдены/не читаются.${NC}"; return 1; fi
      if ! run_migration_cli ssl --mode custom --cert "$cert_file" --key "$key_file"; then return 1; fi
      ;;
    5)
      if [ "$OLD_CERT_OK" != 1 ]; then echo -e "${RED}В прежней панели нет действующего сертификата.${NC}"; return 1; fi
      if ! run_migration_cli ssl --mode keep; then return 1; fi
      ;;
    6)
      run_migration_cli ssl --mode none || return 1
      ;;
    *)
      echo -e "${RED}Нет такого варианта: ${choice}${NC}"
      return 1
      ;;
  esac
  CERT_ENABLED="$(mig_value ssl_enabled)"
  CERT_HOST="$(mig_value ssl_domain)"
  return 0
}

setup_certificate() {
  local choice default_choice=1 interactive=false
  if [ -n "$TTY" ] && [ -z "${PANEL_CERT_MODE:-}" ]; then interactive=true; fi
  if [ "$OLD_CERT_OK" = 1 ]; then default_choice=5; fi

  echo -e "\n${CYAN}Сертификат HTTPS для новой панели${NC}"
  while true; do
    choice=""
    if [ -n "${PANEL_CERT_MODE:-}" ]; then
      case "$PANEL_CERT_MODE" in
        cf) choice=1 ;; http) choice=2 ;; ip) choice=3 ;; custom) choice=4 ;; keep) choice=5 ;; none) choice=6 ;;
        *) echo -e "${RED}[ERROR] PANEL_CERT_MODE: cf, http, ip, custom, keep или none.${NC}"; exit 1 ;;
      esac
    elif [ "$interactive" = true ]; then
      echo "Как получить сертификат для панели?"
      echo "  1) Let's Encrypt через Cloudflare API (DNS-проверка; домен можно указать новый)"
      if [ "$CF_TOKEN_SAVED" = 1 ]; then echo "       токен Cloudflare найден в прежней панели — будет использован"; fi
      echo "  2) Let's Encrypt по HTTP-проверке (домен должен указывать на этот сервер, порт 80 свободен)"
      echo "  3) Сертификат на IP-адрес сервера (самоподписанный; подписки по https:// работать не будут)"
      echo "  4) Свой сертификат: указать путь к файлам сертификата и ключа на этом сервере"
      if [ "$OLD_CERT_OK" = 1 ]; then echo "  5) Оставить сертификат прежней панели (${OLD_SSL_DOMAIN}, до ${OLD_SSL_EXPIRES}; домен должен указывать на этот сервер)"; fi
      echo "  6) Без HTTPS (включить позже в разделе «Безопасность»)"
      ask choice "Выбор [${default_choice}]: " "$default_choice"
    else
      # Без терминала и без PANEL_CERT_MODE: сертификат прежней панели, если он годен, иначе без HTTPS
      if [ "$OLD_CERT_OK" = 1 ]; then choice=5; else choice=6; fi
    fi

    if cert_attempt "$choice"; then return 0; fi
    if [ "$interactive" = true ]; then
      echo -e "${YELLOW}Сертификат не получен. Выберите другой способ.${NC}"
      continue
    fi
    # Данные уже перенесены: неудача с сертификатом не должна оставлять установку на полпути
    echo -e "${YELLOW}Сертификат не получен — панель запустится без HTTPS; включить его можно в разделе «Безопасность».${NC}"
    run_migration_cli ssl --mode none || true
    CERT_ENABLED=0
    CERT_HOST=""
    return 0
  done
}

if [ "$MIGRATE_MODE" = true ]; then
  echo -e "\n${CYAN}Перенос данных прежней панели...${NC}"
  MIG_ARGS=()
  if [ -n "${MIGRATE_FILE:-}" ]; then MIG_ARGS=(file --path "$MIGRATE_FILE"); else MIG_ARGS=(pull --from "$MIGRATE_FROM"); fi
  MIG_STATUS=0
  run_migration_cli "${MIG_ARGS[@]}" || MIG_STATUS=$?
  if [ "$MIG_STATUS" = 3 ]; then
    # Код 3: на этом сервере уже есть панель с данными — заменяем только с подтверждения (копия сохраняется в data/backups)
    ask MIGRATE_REPLACE "На этом сервере уже установлена панель с данными. Перенос заменит их (резервная копия — в ${INSTALL_DIR}/data/backups). Продолжить? [y/N]: " "n"
    case "${MIGRATE_REPLACE:-n}" in
      1|y|Y|yes|д|Д)
        MIG_STATUS=0
        run_migration_cli "${MIG_ARGS[@]}" --replace || MIG_STATUS=$?
        ;;
      *)
        echo -e "${RED}Перенос отменён: данные установленной панели не менялись.${NC}"
        if [ "$UPDATE" = true ]; then echo -e "Панель на этом сервере остановлена на время установки: systemctl start dementia"; fi
        exit 1
        ;;
    esac
  fi
  if [ "$MIG_STATUS" != 0 ]; then
    echo -e "${RED}[ERROR] Перенос данных не выполнен. На прежней панели ничего не изменилось: при необходимости отмените перенос в разделе «Безопасность».${NC}"
    if [ "$UPDATE" = true ]; then echo -e "Установленная на этом сервере панель остановлена и не менялась: systemctl start dementia"; fi
    exit 1
  fi
  OLD_ADMIN="$(mig_value old_admin)"
  OLD_SSL_DOMAIN="$(mig_value ssl_domain)"
  OLD_SSL_EMAIL="$(mig_value ssl_email)"
  OLD_SSL_EXPIRES="$(mig_value ssl_expires)"
  OLD_CERT_OK="$(mig_value ssl_cert_ok)"
  CF_TOKEN_SAVED="$(mig_value cf_token_saved)"
  echo -e "${GREEN}✓ Данные перенесены: логин администратора «${OLD_ADMIN}» и пароль остались прежними.${NC}"

  setup_certificate

  NEW_HOST=""
  if [ "$CERT_ENABLED" = 1 ] && [ -n "$CERT_HOST" ]; then NEW_HOST="$CERT_HOST"; else NEW_HOST="$(detect_server_ip)"; fi
  if [ "$NEW_HOST" != "IP_СЕРВЕРА" ]; then
    run_migration_cli url --host "$NEW_HOST" --port "$PANEL_PORT" || true
    NEW_URL="$(mig_value new_url)"
  fi
fi

GENERATED_PASSWORD_VALUE=""
if [ "$GENERATED_PASSWORD" = true ]; then GENERATED_PASSWORD_VALUE="$PANEL_PASSWORD"; fi
if [ "$SET_CREDENTIALS" = true ]; then
  CREDS_PENDING=true
  PANEL_USER="$PANEL_USER" PANEL_PASSWORD="$PANEL_PASSWORD" node "$INSTALL_DIR/server/dist/cli/reset-admin.js"
fi
unset PANEL_PASSWORD

# 6. Setup Systemd Service
echo -e "\n${CYAN}[5/7] Создание и запуск системной службы systemd...${NC}"
NODE_BIN=$(command -v node)

# Служба прежнего имени заменяется псевдонимом новой (systemctl restart demension продолжит работать)
if [ -f "/etc/systemd/system/$LEGACY_SERVICE" ] && [ ! -L "/etc/systemd/system/$LEGACY_SERVICE" ]; then
  systemctl disable "$LEGACY_SERVICE" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$LEGACY_SERVICE"
fi

cat > /etc/systemd/system/dementia.service <<EOF
[Unit]
Description=Dementia Panel - AmneziaWG Management Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/server/.env
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server/dist/index.js
Restart=always
RestartSec=5
UMask=0077
PrivateTmp=true
ProtectHome=read-only
LockPersonality=true
RestrictRealtime=true

[Install]
WantedBy=multi-user.target
Alias=demension.service
EOF
chmod 644 /etc/systemd/system/dementia.service

systemctl daemon-reload
systemctl enable dementia.service
systemctl restart dementia.service

# 7. Firewall Configuration
echo -e "\n${CYAN}[6/7] Настройка сетевого экрана (Firewall)...${NC}"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "${PANEL_PORT}/tcp" >/dev/null 2>&1 || true
  echo -e "${GREEN}✓ Порт ${PANEL_PORT}/tcp открыт в UFW.${NC}"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${PANEL_PORT}/tcp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  echo -e "${GREEN}✓ Порт ${PANEL_PORT}/tcp открыт в firewalld.${NC}"
else
  echo "Активный фаервол не обнаружен — порт ${PANEL_PORT}/tcp открывать не требуется."
fi
echo -e "${YELLOW}Для выпуска сертификата Let's Encrypt методом HTTP-01 должен быть доступен порт 80/tcp.${NC}"

# 8. Fail2ban SSH Protection — необязательный шаг: его сбой не должен обрывать установку уже работающей панели
setup_fail2ban() {
  local HAD_FAIL2BAN=false SSH_PORT BACKEND
  echo -e "\n${CYAN}[7/7] Настройка защиты SSH от перебора (Fail2ban)...${NC}"
  if command -v fail2ban-client >/dev/null 2>&1; then
    HAD_FAIL2BAN=true
  else
    if [ "$PM" = apt ]; then
      apt-get install -y fail2ban || true
    else
      dnf install -y epel-release || true
      dnf install -y fail2ban || true
    fi
  fi

  if [ "$HAD_FAIL2BAN" = true ]; then
    echo "Fail2ban уже установлен на сервере — его настройки не менялись (защиту sshd можно включить в разделе «Безопасность» панели)."
  elif command -v fail2ban-client >/dev/null 2>&1; then
  SSH_PORT=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}' || true)
  SSH_PORT=${SSH_PORT:-ssh}
  if [ -f /var/log/auth.log ] || [ -f /var/log/secure ]; then BACKEND=auto; else BACKEND=systemd; fi
  mkdir -p /etc/fail2ban/jail.d
  cat > /etc/fail2ban/jail.d/dementia-sshd.local <<EOF
[sshd]
enabled = true
port = ${SSH_PORT}
filter = sshd
backend = ${BACKEND}
maxretry = 4
findtime = 600
bantime = 86400
EOF
  chmod 644 /etc/fail2ban/jail.d/dementia-sshd.local
  systemctl enable fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban >/dev/null 2>&1 || true
  echo -e "${GREEN}✓ Защита SSH (Fail2ban) активирована (порт ${SSH_PORT}, maxretry=4, bantime=24ч).${NC}"
  fi
}
setup_fail2ban || echo -e "${YELLOW}Не удалось настроить fail2ban — это не мешает работе панели (настройка есть в разделе «Безопасность»).${NC}"

# Панель должна ответить, прежде чем объявлять об успехе
echo -e "\n${CYAN}Проверка запуска панели...${NC}"
PANEL_UP=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PANEL_PORT}/api/health" >/dev/null 2>&1; then
    PANEL_UP=true
    break
  fi
  sleep 1
done
if [ "$PANEL_UP" != true ]; then
  echo -e "${RED}[ERROR] Панель не отвечает на порту ${PANEL_PORT}. Последние строки журнала:${NC}"
  journalctl -u dementia.service -n 40 --no-pager 2>/dev/null || true
  echo -e "Повторить запуск: systemctl restart dementia; журнал: journalctl -u dementia -f"
  exit 1
fi
echo -e "${GREEN}✓ Панель запущена.${NC}"

# Перенос: новая панель работает — прежняя замораживается, а её ссылки подписок перенаправляются на новый адрес.
# Без терминала адрес прежней панели берётся только из MIGRATE_FROM (при переносе из файла его может и не быть).
OLD_PANEL_FROZEN=false
if [ "$MIGRATE_MODE" = true ]; then
  if [ -z "$MIGRATE_FROM" ] && [ -n "$TTY" ]; then
    ask MIGRATE_FROM "Адрес прежней панели, чтобы завершить перенос на ней и перенаправить её ссылки подписок (Enter — пропустить): " ""
  fi
  if [ -n "$MIGRATE_FROM" ]; then
    echo -e "\n${CYAN}Завершение переноса на прежней панели...${NC}"
    FINISH_ARGS=(finish --from "$MIGRATE_FROM")
    if [ -n "$NEW_URL" ]; then FINISH_ARGS+=(--new-url "$NEW_URL"); fi
    if run_migration_cli "${FINISH_ARGS[@]}"; then
      OLD_PANEL_FROZEN=true
    else
      echo -e "${YELLOW}Не удалось уведомить прежнюю панель. Остановите её вручную (systemctl disable --now dementia, на версиях до v0.1.4 — demension) или отмените перенос в её разделе «Безопасность».${NC}"
    fi
  fi
fi
unset MIGRATION_CODE

# Адрес для браузера: внешний IPv4 сервера; если определить не удалось — первый адрес интерфейсов
SERVER_IP="$(detect_server_ip)"
PANEL_ADDRESS="http://${SERVER_IP}:${PANEL_PORT}"
if [ "$MIGRATE_MODE" = true ] && [ -n "$NEW_URL" ]; then PANEL_ADDRESS="$NEW_URL"; fi

echo -e "\n${GREEN}${BOLD}======================================================================${NC}"
if [ "$MIGRATE_MODE" = true ]; then
  echo -e "${GREEN}${BOLD}🎉 УСПЕХ: панель перенесена на этот сервер и запущена!${NC}"
else
  echo -e "${GREEN}${BOLD}🎉 УСПЕХ: Dementia Panel установлена и запущена!${NC}"
fi
echo -e "${GREEN}${BOLD}======================================================================${NC}"
echo -e "Адрес панели:         ${BOLD}${CYAN}${PANEL_ADDRESS}${NC}"
echo -e "Версия панели:        ${BOLD}v$(node -p "require('${INSTALL_DIR}/package.json').version" 2>/dev/null || echo '?')${NC}"
if [ "$MIGRATE_MODE" = true ] && [ "$SET_CREDENTIALS" != true ]; then
  echo -e "Логин администратора: ${BOLD}${OLD_ADMIN}${NC} (прежний)"
  echo -e "Пароль администратора: прежний (перенесён без изменений)"
elif [ "$SET_CREDENTIALS" = true ]; then
  echo -e "Логин администратора: ${BOLD}${PANEL_USER}${NC}"
  if [ "$GENERATED_PASSWORD" = true ]; then
    echo -e "Пароль администратора: ${BOLD}${GENERATED_PASSWORD_VALUE}${NC}"
    echo -e "${YELLOW}Сохраните логин и пароль сейчас: пароль нигде не хранится и больше показан не будет.${NC}"
  else
    echo -e "Пароль администратора: заданный вами (PANEL_PASSWORD)"
  fi
else
  echo -e "Логин и пароль:       не менялись (прежние)"
fi
echo -e "Служба systemd:       ${BOLD}systemctl status dementia${NC}"
echo -e "Новый пароль:         ${BOLD}cd ${INSTALL_DIR} && node server/dist/cli/reset-admin.js${NC}  (выдаст случайный)"
echo -e "Директория:           ${BOLD}${INSTALL_DIR}${NC} (данные и ключ шифрования — ${INSTALL_DIR}/data, делайте его резервную копию)"
echo -e "======================================================================"
CREDS_PENDING=false
if [ -n "$EXISTING_AWG" ]; then
  echo -e "${YELLOW}На сервере уже есть контейнеры AmneziaWG — панель их не трогала:${NC}"
  echo "$EXISTING_AWG" | sed 's/^/  • /'
  echo -e "Чтобы управлять ими из панели: «Добавить сервер» (адрес этого сервера и SSH-доступ) — панель найдёт контейнер и"
  echo -e "подключит его вместе с клиентами. Не нажимайте «Установить», пока не подключите существующий контейнер."
fi
if [ "$MIGRATE_MODE" = true ]; then
  echo -e "${YELLOW}После переноса:${NC}"
  echo "  • Проверьте ноды в разделе «Серверы»: статусы появятся после первого опроса (до минуты)."
  if [ "$OLD_PANEL_FROZEN" = true ]; then
    echo "  • Прежняя панель заморожена; её ссылки подписок перенаправляются на новый адрес, пока она включена."
    echo "    Не выключайте её, если домен или порт панели изменились, пока пользователи не получат новые ссылки."
  else
    echo "  • Прежняя панель ещё не отключена: остановите её (systemctl disable --now dementia, на версиях до v0.1.4 — demension) — две панели не должны управлять одними нодами."
  fi
  echo "  • Если домен панели остался прежним, переключите его запись A на IP этого сервера (${SERVER_IP}): ссылки подписок продолжат работать."
  echo "  • Партнёры, подключённые к вашим нодам, и панели, к которым подключены вы, должны обновить адрес, если он изменился."
  if [ "$CERT_ENABLED" != 1 ]; then
    echo -e "${YELLOW}HTTPS не включён: пароль передаётся открытым текстом — включите его в разделе «Безопасность».${NC}"
  fi
else
  echo -e "${YELLOW}Первый вход по http:// передаёт пароль открытым текстом: сразу включите HTTPS в разделе «Безопасность»${NC}"
  echo -e "${YELLOW}или откройте панель через SSH-туннель: ssh -L ${PANEL_PORT}:127.0.0.1:${PANEL_PORT} root@${SERVER_IP}  →  http://127.0.0.1:${PANEL_PORT}${NC}"
fi
