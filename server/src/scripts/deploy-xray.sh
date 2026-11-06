#!/bin/bash
set -euo pipefail

# ==============================================================================
# Dementia Panel - Xray (VLESS + Reality) Remote Deployment Script
#
# Скрипт передаётся панелью через stdin (не сохраняется на диск) с переменными:
#   VLESS_PORT      - TCP-порт Xray (VLESS)
#   XRAY_CONF_B64   - полный config.json в base64
#   XRAY_IMAGE      - Docker-образ Xray-core
#   XRAY_CONTAINER  - имя контейнера (по умолчанию dementia-xray)
#   XRAY_CONF_DIR   - каталог конфигурации (по умолчанию /opt/dementia-xray)
#   PANEL_IP        - IP панели (исключается из блокировок fail2ban)
# ==============================================================================

export DEBIAN_FRONTEND=noninteractive
umask 077

: "${VLESS_PORT:?VLESS_PORT не задан}"
: "${XRAY_CONF_B64:?XRAY_CONF_B64 не задан}"

CONTAINER_NAME="${XRAY_CONTAINER:-dementia-xray}"
IMAGE_NAME="${XRAY_IMAGE:-ghcr.io/xtls/xray-core:latest}"
PANEL_IP="${PANEL_IP:-}"
XRAY_DIR="${XRAY_CONF_DIR:-/opt/dementia-xray}"

case "$CONTAINER_NAME" in
  amnezia*)
    echo "Ошибка: запрещено использовать имя $CONTAINER_NAME (контейнеры amnezia-* принадлежат AmneziaWG)!"
    exit 1
    ;;
esac

echo "[1/6] Проверка системных требований и окружения..."
if [ "$EUID" -ne 0 ]; then
  echo "Ошибка: скрипт должен выполняться с правами root (sudo)!"
  exit 1
fi

# Контейнер с нашим именем, но без метки панели — чужой: ничего не меняем (проверка до любых изменений на хосте)
if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME" && [ ! -f "$XRAY_DIR/dementia.env" ]; then
  echo "Ошибка: контейнер $CONTAINER_NAME уже существует, но метки панели $XRAY_DIR/dementia.env нет — удалите его вручную."
  exit 1
fi

# Detect package manager
if command -v apt-get >/dev/null 2>&1; then
  PM="apt"
elif command -v dnf >/dev/null 2>&1; then
  PM="dnf"
elif command -v yum >/dev/null 2>&1; then
  PM="yum"
else
  echo "Предупреждение: неизвестный менеджер пакетов. Попытка продолжить..."
  PM="unknown"
fi

ARCH=$(uname -m)
if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "amd64" ]; then
  echo "Ошибка: архитектура $ARCH не поддерживается — образ $IMAGE_NAME собран для amd64."
  exit 1
fi

echo "[2/6] Проверка и установка Docker..."
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден. Запуск автоматической установки Docker..."
  if [ "$PM" = "apt" ]; then
    apt-get update -y </dev/null
    apt-get install -y ca-certificates curl gnupg </dev/null
    install -m 0755 -d /etc/apt/keyrings
    OS_ID=$(. /etc/os-release && echo "$ID")
    OS_CODENAME=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
    case "$OS_ID" in
      ubuntu|debian) ;;
      *) if grep -qi ubuntu /etc/os-release; then OS_ID=ubuntu; else OS_ID=debian; fi ;;
    esac
    curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${OS_ID} ${OS_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
    chmod 644 /etc/apt/sources.list.d/docker.list
    apt-get update -y </dev/null
    apt-get install -y docker-ce docker-ce-cli containerd.io </dev/null
  elif [ "$PM" = "dnf" ] || [ "$PM" = "yum" ]; then
    $PM install -y dnf-plugins-core </dev/null >/dev/null 2>&1 || $PM install -y yum-utils </dev/null >/dev/null 2>&1 || true
    if command -v dnf >/dev/null 2>&1; then
      dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    else
      yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    fi
    $PM install -y docker-ce docker-ce-cli containerd.io </dev/null
  else
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker
  echo "Docker успешно установлен!"
else
  echo "Docker уже установлен: $(docker --version)"
fi

echo "[3/6] Загрузка официального образа Xray-core..."
docker pull "$IMAGE_NAME"

echo "[4/6] Подготовка конфигурации Xray-core..."
mkdir -p "$XRAY_DIR"
chmod 700 "$XRAY_DIR"
echo "$XRAY_CONF_B64" | base64 -d > "$XRAY_DIR/config.new.json"
chmod 600 "$XRAY_DIR/config.new.json"
# Образ distroless запускается не от root: конфиг 600 и порты < 1024 требуют --user 0:0
if ! docker run --rm --user 0:0 -v "$XRAY_DIR:/etc/xray:ro" "$IMAGE_NAME" run -test -c /etc/xray/config.new.json; then
  rm -f "$XRAY_DIR/config.new.json"
  echo "Ошибка: Xray отклонил сгенерированную конфигурацию, работающий контейнер не тронут."
  exit 1
fi
mv -f "$XRAY_DIR/config.new.json" "$XRAY_DIR/config.json"
printf 'VLESS_PORT=%s\nXRAY_IMAGE=%s\n' "$VLESS_PORT" "$IMAGE_NAME" > "$XRAY_DIR/dementia.env.new"
chmod 600 "$XRAY_DIR/dementia.env.new"
mv -f "$XRAY_DIR/dementia.env.new" "$XRAY_DIR/dementia.env"

# Удаляется только свой контейнер (метка проверена на шаге 1); контейнеры AmneziaWG не трогаем
if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  echo "Остановка и удаление старого контейнера $CONTAINER_NAME..."
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

echo "[5/6] Запуск контейнера $CONTAINER_NAME..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart always \
  --network host \
  --user 0:0 \
  -v "$XRAY_DIR:/etc/xray" \
  "$IMAGE_NAME" \
  run -c /etc/xray/config.json >/dev/null

# Открытие TCP-порта в активном фаерволе хоста
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${VLESS_PORT}/tcp" >/dev/null 2>&1 || true
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${VLESS_PORT}/tcp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

echo "[6/6] Настройка защиты SSH от перебора паролей (fail2ban)..."
if ! command -v fail2ban-client >/dev/null 2>&1; then
  if [ "$PM" = "apt" ]; then
    apt-get install -y fail2ban </dev/null || true
  elif [ "$PM" = "dnf" ] || [ "$PM" = "yum" ]; then
    $PM install -y epel-release </dev/null >/dev/null 2>&1 || true
    $PM install -y fail2ban </dev/null || true
  fi
fi

if command -v fail2ban-client >/dev/null 2>&1; then
  SSH_PORT=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}' || true)
  SSH_PORT=${SSH_PORT:-ssh}
  if [ -f /var/log/auth.log ] || [ -f /var/log/secure ]; then BACKEND=auto; else BACKEND=systemd; fi
  IGNORE_IP="127.0.0.1/8 ::1"
  case "$PANEL_IP" in
    *[!0-9a-fA-F.:]*|"") ;;
    *) IGNORE_IP="$IGNORE_IP $PANEL_IP" ;;
  esac
  mkdir -p /etc/fail2ban/jail.d
  rm -f /etc/fail2ban/jail.d/demension-sshd.local
  cat > /etc/fail2ban/jail.d/dementia-sshd.local <<EOF
[sshd]
enabled = true
port = ${SSH_PORT}
filter = sshd
backend = ${BACKEND}
ignoreip = ${IGNORE_IP}
maxretry = 4
findtime = 600
bantime = 86400
EOF
  chmod 644 /etc/fail2ban/jail.d/dementia-sshd.local
  systemctl enable fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban >/dev/null 2>&1 || true
  echo "✓ Защита SSH (fail2ban) активирована (порт ${SSH_PORT}, maxretry=4, bantime=24h)"
fi

port_listening() {
  if command -v ss >/dev/null 2>&1; then
    if ss -tln 2>/dev/null | grep -Eq "[: ]${VLESS_PORT}\b"; then
      return 0
    fi
  fi
  if command -v netstat >/dev/null 2>&1; then
    if netstat -tln 2>/dev/null | grep -Eq "[: ]${VLESS_PORT}\b"; then
      return 0
    fi
  fi
  if (echo > "/dev/tcp/127.0.0.1/${VLESS_PORT}") >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Ожидание поднятия порта (до 20 с)
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)" = "true" ] && port_listening; then
    echo "================================================================="
    echo "🎉 УСПЕХ: Xray (VLESS) успешно запущен и слушает порт $VLESS_PORT!"
    echo "================================================================="
    echo "---DEMENTIA_OK---"
    exit 0
  fi
  sleep 2
done

echo "Ошибка: порт $VLESS_PORT не слушается спустя 20 с. Логи контейнера:"
docker logs --tail 30 "$CONTAINER_NAME" 2>&1 || true
exit 1
