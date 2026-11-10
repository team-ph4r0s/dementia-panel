#!/bin/bash
set -euo pipefail

# ==============================================================================
# Dementia Panel - установка моста (docs/bridges.md)
#
# Мост — сервер в стране пользователей, который пересылает UDP-трафик AmneziaWG на зарубежную ноду (iptables DNAT).
# Шифрование остаётся сквозным: ключей клиентов на мосту нет. Docker нужен только для каскада.
#
# Скрипт передаётся панелью через stdin (не сохраняется на диск) с переменными:
#   RULES_B64 - скрипт правил пересылки (генерирует панель из БД) в base64
# ==============================================================================

export DEBIAN_FRONTEND=noninteractive
umask 077

BRIDGE_DIR="/etc/dementia-bridge"
UNIT="/etc/systemd/system/dementia-bridge.service"

echo "[1/4] Проверка окружения..."
if [ "$EUID" -ne 0 ]; then
  echo "Ошибка: скрипт должен выполняться с правами root (sudo)!"
  exit 1
fi

install_cascade_dependencies() {
  local pm='' conntrack_package='conntrack' ip_package='iproute2'
  local os_id codename
  local -a packages=()
  if command -v apt-get >/dev/null 2>&1; then
    pm=apt-get
  elif command -v dnf >/dev/null 2>&1; then
    pm=dnf
  elif command -v yum >/dev/null 2>&1; then
    pm=yum
  elif command -v apk >/dev/null 2>&1; then
    pm=apk
  fi
  if [[ "$pm" != apt-get ]]; then conntrack_package=conntrack-tools; fi
  if [[ "$pm" == dnf || "$pm" == yum ]]; then ip_package=iproute; fi
  command -v conntrack >/dev/null 2>&1 || packages+=("$conntrack_package")
  ip -o -4 addr show >/dev/null 2>&1 || packages+=("$ip_package")

  if (( ${#packages[@]} )); then
    case "$pm" in
      apt-get) apt-get update -y </dev/null; apt-get install -y "${packages[@]}" </dev/null ;;
      dnf|yum) "$pm" install -y "${packages[@]}" </dev/null ;;
      apk) apk add --no-cache "${packages[@]}" </dev/null ;;
      *) echo 'Не удалось установить conntrack и iproute2: неизвестный менеджер пакетов' >&2; return 1 ;;
    esac
  fi

  if ! command -v docker >/dev/null 2>&1; then
    # Debian/Ubuntu и EL используют те же репозитории Docker CE, что deploy-awg.sh.
    case "$pm" in
      apt-get)
        apt-get update -y </dev/null
        apt-get install -y ca-certificates curl gnupg </dev/null
        install -m 0755 -d /etc/apt/keyrings
        os_id=$(. /etc/os-release && echo "$ID")
        codename=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
        case "$os_id" in
          ubuntu|debian) ;;
          *) if grep -qi ubuntu /etc/os-release; then os_id=ubuntu; else os_id=debian; fi ;;
        esac
        curl -fsSL "https://download.docker.com/linux/${os_id}/gpg" | gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
        printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/%s %s stable\n' \
          "$(dpkg --print-architecture)" "$os_id" "$codename" > /etc/apt/sources.list.d/docker.list
        chmod 644 /etc/apt/sources.list.d/docker.list
        apt-get update -y </dev/null
        apt-get install -y docker-ce docker-ce-cli containerd.io </dev/null
        ;;
      dnf)
        dnf install -y dnf-plugins-core </dev/null
        dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo </dev/null
        dnf install -y docker-ce docker-ce-cli containerd.io </dev/null
        ;;
      yum)
        yum install -y yum-utils </dev/null
        yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo </dev/null
        yum install -y docker-ce docker-ce-cli containerd.io </dev/null
        ;;
      apk) apk add --no-cache docker </dev/null ;;
      *) echo 'Не удалось установить Docker: неизвестный менеджер пакетов' >&2; return 1 ;;
    esac
  fi

  if ! docker info >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then
      systemctl enable --now docker </dev/null
    elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
      rc-update add docker default </dev/null
      rc-service docker start </dev/null
    fi
  fi
  command -v conntrack >/dev/null 2>&1
  ip -o -4 addr show >/dev/null 2>&1
  docker info >/dev/null 2>&1
}

if [[ "${1:-}" == --cascade-dependencies ]]; then
  install_cascade_dependencies
  exit 0
fi

: "${RULES_B64:?RULES_B64 не задан}"

if ! command -v iptables >/dev/null 2>&1; then
  echo "Установка iptables..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y </dev/null
    apt-get install -y iptables </dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y iptables </dev/null || dnf install -y iptables-nft </dev/null
  elif command -v yum >/dev/null 2>&1; then
    yum install -y iptables </dev/null
  else
    echo "Ошибка: iptables не найден, и его не удалось установить"
    exit 1
  fi
fi
if ! command -v getent >/dev/null 2>&1; then
  echo "Ошибка: нет утилиты getent (нужна для адресов нод, заданных доменом)"
  exit 1
fi

echo "[2/4] Включение пересылки пакетов (sysctl)..."
mkdir -p /etc/sysctl.d
printf 'net.ipv4.ip_forward = 1\n' > /etc/sysctl.d/99-dementia-bridge.conf
chmod 644 /etc/sysctl.d/99-dementia-bridge.conf
sysctl -w net.ipv4.ip_forward=1 >/dev/null

echo "[3/4] Правила пересылки..."
mkdir -p "$BRIDGE_DIR"
chmod 700 "$BRIDGE_DIR"
echo "$RULES_B64" | base64 -d > "$BRIDGE_DIR/rules.sh.new"
mv -f "$BRIDGE_DIR/rules.sh.new" "$BRIDGE_DIR/rules.sh"
chmod 700 "$BRIDGE_DIR/rules.sh"
sh "$BRIDGE_DIR/rules.sh"

echo "[4/4] Автозапуск правил после перезагрузки..."
if command -v systemctl >/dev/null 2>&1; then
  cat > "$UNIT" <<EOF
[Unit]
Description=Dementia Panel bridge forwarding rules
After=network-online.target docker.service firewalld.service ufw.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh $BRIDGE_DIR/rules.sh

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$UNIT"
  systemctl daemon-reload
  systemctl enable dementia-bridge.service >/dev/null 2>&1
else
  echo "Предупреждение: systemd не найден — после перезагрузки правила восстановит панель при очередном опросе"
fi

echo "================================================================="
echo "🎉 УСПЕХ: мост настроен"
echo "================================================================="
echo "---DEMENTIA_BRIDGE_OK---"
