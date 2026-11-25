import net from 'node:net';
import { isValidHost, shellQuote } from '../utils/net.js';

export interface BridgeRuleLink {
  listen_port: number;
  host: string;
  awg_port: number;
  stub_port: number | null;
  /** Протокол ноды: AWG пересылается по UDP (+ TCP заглушки проверки), VLESS — только по TCP */
  protocol?: string | null;
}

/** Правила пересылки одной привязки: [протокол, порт ноды] */
export function linkForwards(link: BridgeRuleLink): Array<['udp' | 'tcp', number]> {
  if (link.protocol === 'vless') return [['tcp', Number(link.awg_port)]];
  const forwards: Array<['udp' | 'tcp', number]> = [['udp', Number(link.awg_port)]];
  if (link.stub_port) forwards.push(['tcp', Number(link.stub_port)]);
  return forwards;
}

/** Пересылка порта панели через мост (резервный путь к панели и подпискам, docs/bridges.md#panel) */
export interface PanelForward {
  /** IPv4 сервера панели */
  ip: string;
  /** Порт панели (HTTP+HTTPS на одном порту); на мосту слушается тот же номер */
  port: number;
}

/** Порт, на котором работает панель (HTTP и HTTPS на одном порту, инвариант 20) */
export function panelPort(): number {
  return Number(process.env.PORT) || 3001;
}

/**
 * Скрипт правил пересылки. Цепочки панели перестраиваются целиком; переходы в них ставятся первыми, чтобы политика DROP
 * в FORWARD (Docker, ufw) не отбрасывала пересылаемый трафик. DNAT срабатывает только для пакетов на адреса самого моста.
 * Ноды, заданные доменом, разрешаются на мосту при каждом применении (и при загрузке).
 */
export function buildBridgeRules(links: BridgeRuleLink[], panel: PanelForward | null = null): string {
  const lines = [
    '#!/bin/sh',
    '# Сгенерировано Dementia Panel — не редактируйте вручную, правила перезаписываются панелью',
    'set -e',
    'resolve() {',
    '  case "$1" in',
    "    *[!0-9.]*) getent ahostsv4 \"$1\" | awk 'NR == 1 {print $1}' ;;",
    '    *) echo "$1" ;;',
    '  esac',
    '}',
    'sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true',
    'for c in DEMENTIA-BRIDGE DEMENTIA-BRIDGE-POST; do iptables -t nat -N "$c" 2>/dev/null || true; iptables -t nat -F "$c"; done',
    'iptables -N DEMENTIA-BRIDGE-FWD 2>/dev/null || true',
    'iptables -F DEMENTIA-BRIDGE-FWD',
    'while iptables -t nat -D PREROUTING -m addrtype --dst-type LOCAL -j DEMENTIA-BRIDGE 2>/dev/null; do :; done',
    'iptables -t nat -I PREROUTING 1 -m addrtype --dst-type LOCAL -j DEMENTIA-BRIDGE',
    'while iptables -t nat -D POSTROUTING -j DEMENTIA-BRIDGE-POST 2>/dev/null; do :; done',
    'iptables -t nat -I POSTROUTING 1 -j DEMENTIA-BRIDGE-POST',
    'while iptables -D FORWARD -j DEMENTIA-BRIDGE-FWD 2>/dev/null; do :; done',
    'iptables -I FORWARD 1 -j DEMENTIA-BRIDGE-FWD',
    'iptables -A DEMENTIA-BRIDGE-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    'forward() {',
    '  ip=$(resolve "$3")',
    '  if [ -z "$ip" ]; then echo "Не удалось определить IP-адрес ноды $3" >&2; return 1; fi',
    '  iptables -t nat -A DEMENTIA-BRIDGE -p "$1" --dport "$2" -j DNAT --to-destination "$ip:$4"',
    '  iptables -t nat -A DEMENTIA-BRIDGE-POST -p "$1" -d "$ip" --dport "$4" -j MASQUERADE',
    '  iptables -A DEMENTIA-BRIDGE-FWD -p "$1" -d "$ip" --dport "$4" -j ACCEPT',
    '}',
  ];
  for (const link of links) {
    if (!isValidHost(link.host) || net.isIPv6(link.host)) throw new Error(`Адрес ноды ${link.host} не поддерживается мостом (нужен IPv4 или домен)`);
    for (const [proto, port] of linkForwards(link)) {
      lines.push(`forward ${proto} ${Number(link.listen_port)} ${shellQuote(link.host)} ${port}`);
    }
  }
  if (panel) {
    // TCP как есть: TLS панели завершается на самой панели, сертификат остаётся её (мост ничего не расшифровывает)
    if (!net.isIPv4(panel.ip)) throw new Error('Для пересылки панели нужен IPv4-адрес сервера панели');
    lines.push(`forward tcp ${Number(panel.port)} ${shellQuote(panel.ip)} ${Number(panel.port)}`);
  }
  lines.push(`echo "---RULES ${expectedRuleCount(links, panel)}"`);
  return lines.join('\n') + '\n';
}

export function expectedRuleCount(links: BridgeRuleLink[], panel: PanelForward | null = null): number {
  return links.reduce((n, l) => n + linkForwards(l).length, 0) + (panel ? 1 : 0);
}

/** Проверка моста: число правил DNAT и то, что переход в цепочку панели — первое правило FORWARD */
export const HEALTH_SCRIPT = [
  'echo "RULES $(iptables -t nat -S DEMENTIA-BRIDGE 2>/dev/null | grep -c \'^-A DEMENTIA-BRIDGE \' || true)"',
  'echo "FIRST $(iptables -S FORWARD 2>/dev/null | sed -n 2p)"',
  'echo "PRE $(iptables -t nat -S PREROUTING 2>/dev/null | grep -c \'DEMENTIA-BRIDGE$\' || true)"',
].join('\n');

export interface BridgeCheckResult {
  rules: number;
  forwardFirst: boolean;
  prerouting: boolean;
}

export function parseBridgeCheck(output: string): BridgeCheckResult {
  const rules = Number(/^RULES (\d+)$/m.exec(output)?.[1] ?? 0);
  return {
    rules,
    forwardFirst: /^FIRST -A FORWARD -j DEMENTIA-BRIDGE-FWD\s*$/m.test(output),
    prerouting: Number(/^PRE (\d+)$/m.exec(output)?.[1] ?? 0) === 1,
  };
}

/** Прежнее название разбора проверки моста; оставлено для совместимости импортов */
export const parseHealth: typeof parseBridgeCheck = parseBridgeCheck;
