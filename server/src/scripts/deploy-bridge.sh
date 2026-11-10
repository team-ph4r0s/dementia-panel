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

# Каждая команда с явным `|| return 1`: функция вызывается в условии `if`, где `set -e` не действует.
install_docker_official() {
  local pm=$1 os_id codename
  case "$pm" in
    apt-get)
      apt-get update -y </dev/null || echo '[каскад] apt-get update завершился с ошибкой, продолжаю' >&2
      apt-get install -y ca-certificates curl gnupg </dev/null || return 1
      install -m 0755 -d /etc/apt/keyrings || return 1
      os_id=$(. /etc/os-release && echo "$ID")
      codename=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
      case "$os_id" in
        ubuntu|debian) ;;
        *) if grep -qi ubuntu /etc/os-release; then os_id=ubuntu; else os_id=debian; fi ;;
      esac
      [ -n "$codename" ] || return 1
      curl -fsSL --connect-timeout 15 --max-time 120 "https://download.docker.com/linux/${os_id}/gpg" |
        gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg || return 1
      chmod a+r /etc/apt/keyrings/docker.gpg || return 1
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/%s %s stable\n' \
        "$(dpkg --print-architecture)" "$os_id" "$codename" > /etc/apt/sources.list.d/docker.list || return 1
      chmod 644 /etc/apt/sources.list.d/docker.list
      if ! apt-get update -y </dev/null || ! apt-get install -y docker-ce docker-ce-cli containerd.io </dev/null; then
        rm -f /etc/apt/sources.list.d/docker.list # битый репозиторий не должен ломать дальнейшие apt-get
        return 1
      fi
      ;;
    dnf)
      dnf install -y dnf-plugins-core </dev/null || return 1
      dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo </dev/null || return 1
      dnf install -y docker-ce docker-ce-cli containerd.io </dev/null || return 1
      ;;
    yum)
      yum install -y yum-utils </dev/null || return 1
      yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo </dev/null || return 1
      yum install -y docker-ce docker-ce-cli containerd.io </dev/null || return 1
      ;;
    apk) apk add --no-cache docker </dev/null || return 1 ;;
    *) echo '[каскад] Не удалось установить Docker: неизвестный менеджер пакетов' >&2; return 1 ;;
  esac
}

install_docker_distro() {
  case "$1" in
    apt-get) apt-get update -y </dev/null || true; apt-get install -y docker.io </dev/null ;;
    dnf) dnf install -y docker </dev/null || dnf install -y moby-engine </dev/null ;;
    yum) yum install -y docker </dev/null ;;
    apk) apk add --no-cache docker </dev/null ;;
    *) return 1 ;;
  esac
}

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
      apt-get) apt-get update -y </dev/null || echo '[каскад] apt-get update завершился с ошибкой, продолжаю' >&2; apt-get install -y "${packages[@]}" </dev/null ;;
      dnf|yum) "$pm" install -y "${packages[@]}" </dev/null ;;
      apk) apk add --no-cache "${packages[@]}" </dev/null ;;
      *) echo 'Не удалось установить conntrack и iproute2: неизвестный менеджер пакетов' >&2; return 1 ;;
    esac
  fi

  if ! command -v docker >/dev/null 2>&1; then
    # Сначала репозиторий Docker CE (как в deploy-awg.sh); если он недоступен (download.docker.com часто закрыт
    # в России) или не подошёл — пакет из репозиториев самого дистрибутива.
    if ! install_docker_official "$pm"; then
      echo '[каскад] Репозиторий Docker CE недоступен, ставлю Docker из репозиториев дистрибутива' >&2
      install_docker_distro "$pm" || { echo '[каскад] Не удалось установить Docker ни из download.docker.com, ни из репозиториев дистрибутива' >&2; return 1; }
    fi
  fi

  if ! docker info >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then
      systemctl enable --now docker </dev/null || echo '[каскад] systemctl enable --now docker завершился с ошибкой' >&2
    elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
      rc-update add docker default </dev/null || true
      rc-service docker start </dev/null || echo '[каскад] rc-service docker start завершился с ошибкой' >&2
    fi
  fi
  command -v conntrack >/dev/null 2>&1 || { echo '[каскад] conntrack не установлен' >&2; return 1; }
  ip -o -4 addr show >/dev/null 2>&1 || { echo '[каскад] нет утилиты ip (iproute2)' >&2; return 1; }
  docker info >/dev/null 2>&1 || { echo '[каскад] Docker установлен, но не запускается (docker info завершился с ошибкой; на OpenVZ/LXC без вложенных контейнеров Docker не работает)' >&2; return 1; }
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
