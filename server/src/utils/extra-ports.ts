import crypto from 'node:crypto';
import { shellQuote } from './net.js';

/**
 * Запасные порты ноды AmneziaWG — чистые функции (правила для хоста ноды). Описание — services/extra-ports.service.ts
 * и docs/node-management.md.
 */

export const MAX_EXTRA_PORTS = 4;
const RULES_DIR = '/etc/dementia-ports';
const UNIT = '/etc/systemd/system/dementia-ports.service';
const CHAIN = 'DEMENTIA-PORTS';

export const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** Запасные порты из колонки servers.extra_ports (JSON); всё некорректное отбрасывается */
export function parseExtraPorts(value: unknown): number[] {
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const ports = list.filter((p): p is number => Number.isInteger(p) && p >= 1 && p <= 65535);
  return [...new Set(ports)].slice(0, MAX_EXTRA_PORTS);
}

/**
 * Скрипт правил для хоста ноды. Имя контейнера и порты подставляются только после проверки (числа и shellQuote).
 * Без портов скрипт убирает цепочку. Последняя строка вывода — `---PORTS <число правил> <адрес контейнера>`.
 */
export function buildPortRules(container: string, awgPort: number, ports: number[]): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) throw new Error('Некорректное имя контейнера AmneziaWG');
  const target = Number(awgPort);
  if (!Number.isInteger(target) || target < 1 || target > 65535) throw new Error('Некорректный порт AmneziaWG');
  const lines = [
    '#!/bin/sh',
    '# Сгенерировано Dementia Panel — не редактируйте вручную, правила перезаписываются панелью',
    'set -e',
    `iptables -t nat -N ${CHAIN} 2>/dev/null || true`,
    `iptables -t nat -F ${CHAIN}`,
    `while iptables -t nat -D PREROUTING -m addrtype --dst-type LOCAL -j ${CHAIN} 2>/dev/null; do :; done`,
  ];
  if (ports.length === 0) {
    lines.push(`iptables -t nat -X ${CHAIN} 2>/dev/null || true`, 'echo "---PORTS 0 -"');
    return lines.join('\n') + '\n';
  }
  lines.push(
    // Адрес контейнера в сети Docker: туда же ведёт правило самого Docker для основного порта, поэтому пересылку
    // разрешают его же правила FORWARD, а AmneziaWG видит настоящий адрес клиента
    `ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${shellQuote(container)} 2>/dev/null | awk '{print $1}')`,
    `if [ -z "$ip" ]; then echo "Контейнер ${container} не запущен или работает без сети Docker" >&2; exit 1; fi`,
    // Первым в PREROUTING — до правил Docker; только для пакетов на адреса самого сервера
    `iptables -t nat -I PREROUTING 1 -m addrtype --dst-type LOCAL -j ${CHAIN}`,
  );
  for (const port of ports) {
    lines.push(`iptables -t nat -A ${CHAIN} -p udp --dport ${Number(port)} -j DNAT --to-destination "$ip:${target}"`);
  }
  lines.push(`echo "---PORTS ${ports.length} $ip"`);
  return lines.join('\n') + '\n';
}

/** Проверка на ноде: адрес контейнера сейчас, число правил на этот адрес и наличие перехода в PREROUTING */
export function healthScript(container: string, awgPort: number): string {
  return [
    `ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${shellQuote(container)} 2>/dev/null | awk '{print $1}')`,
    `echo "RULES $(iptables -t nat -S ${CHAIN} 2>/dev/null | grep -c -- "--to-destination $ip:${Number(awgPort)}\\$" || true)"`,
    `echo "PRE $(iptables -t nat -S PREROUTING 2>/dev/null | grep -c -- '-j ${CHAIN}$' || true)"`,
  ].join('\n');
}

export function parsePortsHealth(output: string): { rules: number; prerouting: boolean } {
  return {
    rules: Number(/^RULES (\d+)$/m.exec(output)?.[1] ?? 0),
    prerouting: Number(/^PRE (\d+)$/m.exec(output)?.[1] ?? 0) === 1,
  };
}

/** Снятие правил и автозапуска с ноды (удаление ноды с очисткой, пустой список портов) */
export function extraPortsRemoveScript(): string {
  return [
    `while iptables -t nat -D PREROUTING -m addrtype --dst-type LOCAL -j ${CHAIN} 2>/dev/null; do :; done`,
    `iptables -t nat -F ${CHAIN} 2>/dev/null; iptables -t nat -X ${CHAIN} 2>/dev/null`,
    'if command -v systemctl >/dev/null 2>&1; then systemctl disable dementia-ports.service >/dev/null 2>&1; fi',
    `rm -f ${UNIT}; rm -rf ${RULES_DIR}`,
    'if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload >/dev/null 2>&1; fi',
    'true',
  ].join('\n');
}

/** Установка на ноду: файл правил, запуск, служба systemd для применения после перезагрузки (после Docker) */
export function installScript(rules: string): string {
  const unit = [
    '[Unit]',
    'Description=Dementia Panel extra AmneziaWG ports',
    'After=network-online.target docker.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    // Контейнер поднимается не сразу после Docker: несколько попыток, пока у него не появится адрес
    `ExecStart=/bin/sh -c 'for i in 1 2 3 4 5 6; do /bin/sh ${RULES_DIR}/rules.sh && exit 0; sleep 10; done; exit 1'`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
  return [
    'set -e',
    'umask 077',
    'command -v iptables >/dev/null 2>&1 || { echo "На ноде нет iptables" >&2; exit 1; }',
    `mkdir -p ${RULES_DIR}`,
    `echo ${shellQuote(Buffer.from(rules).toString('base64'))} | base64 -d > ${RULES_DIR}/rules.sh.new`,
    `mv -f ${RULES_DIR}/rules.sh.new ${RULES_DIR}/rules.sh`,
    `sh ${RULES_DIR}/rules.sh`,
    'if command -v systemctl >/dev/null 2>&1; then',
    `  echo ${shellQuote(Buffer.from(unit).toString('base64'))} | base64 -d > ${UNIT}`,
    `  chmod 644 ${UNIT}`,
    '  systemctl daemon-reload >/dev/null 2>&1 || true',
    '  systemctl enable dementia-ports.service >/dev/null 2>&1 || true',
    'fi',
  ].join('\n');
}
