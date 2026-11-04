#!/bin/bash
# Only panel-managed containers. Never writes configs or keys; keeps the old container for rollback.
set -euo pipefail
umask 077
: "${AWG_CONTAINER:?}" "${AWG_PORT:?}" "${AWG_MODE:?}"
IMAGE=amneziavpn/amneziawg-go:latest
AWG_DIR=/opt/amnezia/awg
BACKUP="${AWG_CONTAINER}-dementia-update-backup"

fail() { echo "Ошибка: $1" >&2; exit 1; }
[[ "$AWG_MODE" = check || "$AWG_MODE" = update ]] || fail 'Неизвестная операция'
if docker inspect "$BACKUP" >/dev/null 2>&1; then
  echo '---DEMENTIA_BACKUP_EXISTS---'
  fail 'Остался резервный контейнер предыдущего обновления; требуется проверка администратора'
fi
[[ "$(docker inspect -f '{{.State.Running}}' "$AWG_CONTAINER")" = true ]] || fail 'Контейнер не запущен'
[[ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/opt/amnezia/awg"}}{{.Source}}{{end}}{{end}}' "$AWG_CONTAINER")" = "$AWG_DIR" ]] || fail 'Неизвестное размещение конфигурации'
[[ "$(docker inspect -f '{{.Path}}' "$AWG_CONTAINER")" = "$AWG_DIR/start.sh" ]] || fail 'Неизвестный способ запуска контейнера'
[[ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$AWG_CONTAINER")" = always ]] || fail 'Неизвестная политика перезапуска'

old_image=$(docker inspect -f '{{.Image}}' "$AWG_CONTAINER")
docker pull "$IMAGE" >/dev/null
new_image=$(docker image inspect -f '{{.Id}}' "$IMAGE")
[[ "$old_image" =~ ^sha256:[a-f0-9]{64}$ && "$new_image" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Не удалось определить образ'
echo "---DEMENTIA_IMAGE--- $old_image $new_image"
if [[ "$AWG_MODE" = check || "$old_image" = "$new_image" ]]; then exit 0; fi

# Ignore counters, handshakes and roaming endpoints, but compare each peer's key, PSK, IPs and keepalive.
# Private material stays in shell memory and is never logged or written to temporary files.
snapshot() {
  docker exec "$1" awg show awg0 dump |
    awk 'NR == 1 { print "interface", $1, $3 } NR > 1 { print "peer", $1, $2, $4, ($8 == "off" ? 0 : $8) }' |
    LC_ALL=C sort
}
before=$(snapshot "$AWG_CONTAINER")
[[ "$before" = *interface* ]] || fail 'Не удалось прочитать интерфейс'
if [[ "$(printf '%s\n' "$before" | awk '$1 == "interface" {print $3}')" != "$AWG_PORT" ]]; then
  echo '---DEMENTIA_CONFIG_MISMATCH---'
  fail 'Порт интерфейса отличается от настроек панели'
fi

# Refuse replacement if runtime-only edits would disappear on restart (including unknown/manual peers).
on_disk=$(docker exec "$AWG_CONTAINER" awg-quick strip "$AWG_DIR/awg0.conf" |
  awk '
    function peer() { if (pub != "") print "peer", pub, (psk == "" ? "(none)" : psk), ips, (keep == "" || keep == "off" ? 0 : keep) }
    /^\[Peer\]/ { peer(); pub = psk = ips = keep = ""; in_peer = 1; next }
    /^\[Interface\]/ { in_peer = 0; next }
    /^[[:space:]]*#/ { next }
    {
      line = $0; sub(/[[:space:]]*#.*/, "", line); split(line, pair, "=")
      key = pair[1]; gsub(/[[:space:]]/, "", key)
      value = substr(line, index(line, "=") + 1); gsub(/[[:space:]]/, "", value)
      if (!in_peer && key == "PrivateKey") priv = value
      if (!in_peer && key == "ListenPort") port = value
      if (in_peer && key == "PublicKey") pub = value
      if (in_peer && key == "PresharedKey") psk = value
      if (in_peer && key == "AllowedIPs") ips = value
      if (in_peer && key == "PersistentKeepalive") keep = value
    }
    END { peer(); print "interface", priv, port }
  ' | LC_ALL=C sort)
if [[ "$on_disk" != "$before" ]]; then
  echo '---DEMENTIA_CONFIG_MISMATCH---'
  fail 'Работающие пиры или ключи отличаются от сохранённого конфига; обновление отменено до остановки'
fi

rollback() {
  local rc=$?
  trap - EXIT HUP INT TERM
  if docker inspect "$BACKUP" >/dev/null 2>&1; then
    # If rename failed, the original still has its original name: do not remove it.
    docker rm -f "$AWG_CONTAINER" >/dev/null 2>&1 || true
    if docker rename "$BACKUP" "$AWG_CONTAINER" &&
       docker update --restart always "$AWG_CONTAINER" >/dev/null &&
       docker start "$AWG_CONTAINER" >/dev/null; then
      for _ in {1..10}; do
        if restored=$(snapshot "$AWG_CONTAINER" 2>/dev/null) && [[ "$restored" = "$before" ]]; then
          echo '---DEMENTIA_ROLLED_BACK---'
          exit "${rc:-1}"
        fi
        sleep 2
      done
    fi
    echo '---DEMENTIA_ROLLBACK_FAILED---' >&2
  else
    docker update --restart always "$AWG_CONTAINER" >/dev/null 2>&1 || true
  fi
  exit "${rc:-1}"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM

# Disabling restart prevents the backup from competing for the port after a host reboot.
docker update --restart no "$AWG_CONTAINER" >/dev/null
docker rename "$AWG_CONTAINER" "$BACKUP"
docker stop "$BACKUP" >/dev/null
docker run -d --name "$AWG_CONTAINER" --restart always \
  --cap-add=NET_ADMIN --cap-add=SYS_MODULE --device /dev/net/tun:/dev/net/tun \
  -p "${AWG_PORT}:${AWG_PORT}/udp" -v /lib/modules:/lib/modules:ro -v "$AWG_DIR:$AWG_DIR" \
  --sysctl=net.ipv4.conf.all.src_valid_mark=1 --sysctl=net.ipv4.ip_forward=1 \
  --entrypoint "$AWG_DIR/start.sh" "$new_image" >/dev/null

for _ in {1..10}; do
  if after=$(snapshot "$AWG_CONTAINER" 2>/dev/null) && [[ "$after" = "$before" ]]; then
    # Require a stable start, rather than observing an interface in a crashing/restarting container.
    sleep 2
    if ! after=$(snapshot "$AWG_CONTAINER" 2>/dev/null) || [[ "$after" != "$before" ]] ||
       [[ "$(docker inspect -f '{{.RestartCount}}' "$AWG_CONTAINER")" != 0 ]]; then
      continue
    fi
    # Disable the rollback only after the interface and every peer match.
    trap - EXIT HUP INT TERM
    docker rm "$BACKUP" >/dev/null
    echo '---DEMENTIA_UPDATED---'
    exit 0
  fi
  sleep 2
done
fail 'Новый контейнер не восстановил интерфейс и всех клиентов; выполняется откат'
