import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSetting, transaction } from '../db/index.js';
import { HttpError } from '../utils/http.js';
import { formatEndpointHost, isValidHost, isValidPort, shellQuote } from '../utils/net.js';
import { checkRealityCertificate } from '../utils/reality-check.js';
import { nodeProtocol, vlessParamsFromRow } from '../utils/vless-params.js';
import { HostKeyMismatchError, SshCredentials, SshService } from './ssh.service.js';
import { decryptSecret, encryptSecret } from './secrets.service.js';
import { OperationResult, ProvisionService, runExclusive } from './provision.service.js';
import { ProbeService, ProbeResult } from './probe.service.js';
import { parseExtraPorts } from './extra-ports.service.js';
import { stubPortCandidates } from './stub.service.js';
import {
  CASCADE_XRAY_IMAGE, applyCascadeContainer, cascadeConfigs, cascadeContainer, cascadePortCandidates, cascadePortReachable, cascadeRunning, cascadeSni,
  openCascadeFirewall, pickCascadePort,
  clearBridgeConntrack, generateCascadeSecret, parseCascadeSni, prepareCascadeImage, removeCascadeContainer, requireAwgLoopback, type CascadeLink,
} from './bridge-cascade.service.js';

/**
 * Мосты (docs/bridges.md): серверы в стране пользователей, пересылающие UDP-трафик AmneziaWG на зарубежные ноды правилами
 * iptables DNAT. Шифрование остаётся сквозным — ключей клиентов на мосту нет, а конфигурация клиента отличается только
 * адресом Endpoint. Если проверка доступности или сами клиенты показывают, что нода недоступна из страны пользователя,
 * подписка выдаёт ему адрес моста этой страны.
 *
 * Правила моста генерируются целиком из БД (как конфиг ноды): всё, чего нет в bridge_links, при применении исчезает.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Сколько проверок подряд с проблемой включают мост для страны */
export const FAIL_STREAK_TO_ACTIVATE = 2;
/** Сколько проверок подряд без проблем выключают мост */
export const OK_STREAK_TO_RELEASE = 3;
/** Минимальное время работы через мост после включения: пользователи не должны метаться между адресами */
export const BRIDGE_HOLD_MS = 12 * 60 * 60 * 1000;
/** Как часто мост проверяется по SSH (правила на месте, первые в цепочке FORWARD) */
const HEALTH_INTERVAL_MS = 2 * 60 * 1000;
const OFFLINE_THRESHOLD = 3;

// Сигнал от клиентов (docs/bridges.md, «Сигнал от клиентов»)
/** Сколько минут тишины у всех клиентов страны считается обрывом */
const PASSIVE_SILENCE_MS = 15 * 60 * 1000;
/** Обрывы старше этого не учитываются */
const PASSIVE_LOOKBACK_MS = 6 * 60 * 60 * 1000;
/** Последние рукопожатия «одновременно оборвавшихся» клиентов укладываются в это окно */
const PASSIVE_CLUSTER_MS = 10 * 60 * 1000;
const PASSIVE_MIN_CLIENTS = 3;
/** Нода жива: рукопожатие клиента из другой страны не старше этого */
const PASSIVE_ALIVE_MS = 5 * 60 * 1000;

/**
 * Режим пары мост × нода: `main` — мост основной (запись через мост первой, прямая — запасной следом), `always` — только мост,
 * `auto` — мост, когда для страны действует «нужен мост», `off` — только прямой адрес.
 */
export type LinkMode = 'main' | 'auto' | 'always' | 'off';
const LINK_MODES: LinkMode[] = ['main', 'auto', 'always', 'off'];
/** Режим новых привязок: мосты — основной путь для пользователей страны (docs/bridges.md) */
export const DEFAULT_LINK_MODE: LinkMode = 'main';
const COUNTRY = /^[a-z]{2}$/;

export interface BridgeRuleLink {
  listen_port: number;
  host: string;
  awg_port: number;
  stub_port: number | null;
  /** Протокол ноды: AWG пересылается по UDP (+ TCP заглушки проверки), VLESS — только по TCP */
  protocol?: string | null;
}

/** Правила пересылки одной привязки: [протокол, порт ноды] */
function linkForwards(link: BridgeRuleLink): Array<['udp' | 'tcp', number]> {
  if (link.protocol === 'vless') return [['tcp', Number(link.awg_port)]];
  const forwards: Array<['udp' | 'tcp', number]> = [['udp', Number(link.awg_port)]];
  if (link.stub_port) forwards.push(['tcp', Number(link.stub_port)]);
  return forwards;
}

export interface BridgeRoute {
  bridge_id: number;
  bridge_name: string;
  host: string;
  port: number;
  /** Режим `main`: в подписке и запись через мост, и прямая (запасная) */
  keepDirect: boolean;
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

const pendingApply = new Map<number, Promise<OperationResult>>();
const installing = new Set<number>();
const lastHealth = new Map<number, number>();

const queueKey = (bridgeId: number) => `bridge:${bridgeId}`;

function readDeployScript(): string {
  const candidates = [
    path.resolve(__dirname, '../scripts/deploy-bridge.sh'),
    path.resolve(process.cwd(), 'src/scripts/deploy-bridge.sh'),
    path.resolve(process.cwd(), 'dist/scripts/deploy-bridge.sh'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf-8');
  }
  throw new Error('Установочный скрипт deploy-bridge.sh не найден');
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
const HEALTH_SCRIPT = [
  'echo "RULES $(iptables -t nat -S DEMENTIA-BRIDGE 2>/dev/null | grep -c \'^-A DEMENTIA-BRIDGE \' || true)"',
  'echo "FIRST $(iptables -S FORWARD 2>/dev/null | sed -n 2p)"',
  'echo "PRE $(iptables -t nat -S PREROUTING 2>/dev/null | grep -c \'DEMENTIA-BRIDGE$\' || true)"',
].join('\n');

const TEARDOWN_SCRIPT = [
  'while iptables -t nat -D PREROUTING -m addrtype --dst-type LOCAL -j DEMENTIA-BRIDGE 2>/dev/null; do :; done',
  'while iptables -t nat -D POSTROUTING -j DEMENTIA-BRIDGE-POST 2>/dev/null; do :; done',
  'while iptables -D FORWARD -j DEMENTIA-BRIDGE-FWD 2>/dev/null; do :; done',
  'for c in DEMENTIA-BRIDGE DEMENTIA-BRIDGE-POST; do iptables -t nat -F "$c" 2>/dev/null; iptables -t nat -X "$c" 2>/dev/null; done',
  'iptables -F DEMENTIA-BRIDGE-FWD 2>/dev/null; iptables -X DEMENTIA-BRIDGE-FWD 2>/dev/null',
  'if command -v systemctl >/dev/null 2>&1; then systemctl disable dementia-bridge.service >/dev/null 2>&1; fi',
  'rm -f /etc/systemd/system/dementia-bridge.service /etc/sysctl.d/99-dementia-bridge.conf',
  'rm -rf /etc/dementia-bridge',
  'if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload >/dev/null 2>&1; fi',
  'echo done',
].join('\n');

export function parseHealth(output: string): { rules: number; forwardFirst: boolean; prerouting: boolean } {
  const rules = Number(/^RULES (\d+)$/m.exec(output)?.[1] ?? 0);
  return {
    rules,
    forwardFirst: /^FIRST -A FORWARD -j DEMENTIA-BRIDGE-FWD\s*$/m.test(output),
    prerouting: Number(/^PRE (\d+)$/m.exec(output)?.[1] ?? 0) === 1,
  };
}

function loadBridge(id: number): any {
  const bridge = db.prepare('SELECT * FROM bridges WHERE id = ?').get(id) as any;
  if (!bridge) throw new HttpError(404, 'Мост не найден');
  return bridge;
}

function credentials(bridge: any): SshCredentials {
  return {
    host: bridge.host,
    port: bridge.ssh_port,
    username: bridge.ssh_user,
    password: decryptSecret(bridge.ssh_password),
    privateKey: decryptSecret(bridge.ssh_key),
    hostKey: bridge.host_key,
    onNewHostKey: (fingerprint) => {
      db.prepare('UPDATE bridges SET host_key = ? WHERE id = ? AND host_key IS NULL').run(fingerprint, bridge.id);
    },
  };
}

function ruleLinks(bridgeId: number): BridgeRuleLink[] {
  return db.prepare(`
    SELECT l.listen_port, s.host, s.awg_port, s.stub_port, s.protocol
    FROM bridge_links l JOIN servers s ON s.id = l.server_id
    WHERE l.bridge_id = ? AND l.cascade_port IS NULL ORDER BY l.listen_port
  `).all(bridgeId) as any[];
}

function cascadeLinks(bridgeId: number): CascadeLink[] {
  const rows = db.prepare(`
    SELECT l.server_id, l.listen_port, l.cascade_port, l.cascade_secret, l.cascade_pending, s.host, s.protocol,
      COALESCE(s.deployed_port, s.awg_port) AS vpn_port, s.stub_port
    FROM bridge_links l JOIN servers s ON s.id = l.server_id
    WHERE l.bridge_id = ? AND l.cascade_port IS NOT NULL ORDER BY l.server_id
  `).all(bridgeId) as any[];
  return rows.map((row) => ({
    bridgeId, serverId: row.server_id, host: row.host, port: row.cascade_port, listenPort: row.listen_port,
    vpnPort: row.vpn_port, stubPort: row.stub_port, protocol: nodeProtocol(row), secret: JSON.parse(decryptSecret(row.cascade_secret)!),
    pending: Boolean(row.cascade_pending),
  }));
}

/** Пересылка панели для моста: включена флагом `panel_forward` и известен IPv4 панели (`panel_origin_ip`) */
function panelForwardOf(bridge: any): PanelForward | null {
  if (!bridge?.panel_forward) return null;
  const ip = getSetting('panel_origin_ip');
  return ip && net.isIPv4(ip) ? { ip, port: panelPort() } : null;
}

function rulesFor(bridge: any): string {
  const rules = buildBridgeRules(ruleLinks(bridge.id), panelForwardOf(bridge));
  const links = cascadeLinks(bridge.id);
  if (!links.length) return rules;
  const cleanup = links.flatMap((link) => [
    `# XHTTP ${sha256(CASCADE_XRAY_IMAGE + JSON.stringify(cascadeConfigs(link)))}`,
    `clear_bridge_conntrack ${link.protocol === 'awg' ? 'udp' : 'tcp'} ${link.listenPort} --dst-nat`,
    ...(link.protocol === 'awg' && link.stubPort ? [`clear_bridge_conntrack tcp ${link.listenPort} --dst-nat`] : []),
  ]);
  return [rules, clearBridgeConntrack, ...cleanup, ''].join('\n');
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * Правила записаны на мосту. Привязки, у которых каскад применить не удалось (нода недоступна и т. п.), остаются
 * `cascade_pending` — в подписку они не попадают, а остальные привязки моста работают; повтор — в `checkAll`.
 */
function recordApplied(id: number, rules: string, failed: Map<number, string> = new Map()): void {
  const message = failed.size
    ? `Каскад XHTTP не применён: ${[...failed].map(([serverId, error]) => {
      const server = db.prepare('SELECT name FROM servers WHERE id = ?').get(serverId) as { name: string } | undefined;
      return `«${server?.name ?? `#${serverId}`}»: ${error}`;
    }).join('; ')}`.slice(0, 500)
    : null;
  transaction(() => {
    db.prepare(`
      UPDATE bridges SET status = 'online', rules_hash = ?, needs_apply = 0, fail_count = 0, last_error = ?, last_seen = datetime('now')
      WHERE id = ?
    `).run(sha256(rules), message, id);
    for (const link of db.prepare('SELECT server_id FROM bridge_links WHERE bridge_id = ? AND cascade_pending = 1').all(id) as { server_id: number }[]) {
      if (!failed.has(link.server_id)) db.prepare('UPDATE bridge_links SET cascade_pending = 0 WHERE bridge_id = ? AND server_id = ?').run(id, link.server_id);
    }
    for (const serverId of failed.keys()) {
      db.prepare('UPDATE bridge_links SET cascade_pending = 1 WHERE bridge_id = ? AND server_id = ?').run(id, serverId);
    }
  });
  lastHealth.set(id, Date.now());
}

export class BridgeService {
  // ---- Представление ----

  /** Мост для интерфейса — без SSH-пароля и ключа */
  static serialize(bridge: any) {
    const { ssh_password, ssh_key, rules_hash, ...rest } = bridge;
    const links = db.prepare(`
      SELECT l.server_id, s.name AS server_name, s.host AS server_host, s.awg_port, l.listen_port, l.mode, l.check_ok, l.checked_at,
        l.cascade_port, l.cascade_pending,
        COALESCE(st.active, 0) AS active, st.reason, st.changed_at
      FROM bridge_links l
      JOIN servers s ON s.id = l.server_id
      LEFT JOIN bridge_state st ON st.server_id = l.server_id AND st.country = ?
      WHERE l.bridge_id = ? ORDER BY s.sub_order, s.id
    `).all(bridge.country, bridge.id) as any[];
    return {
      ...rest,
      needs_apply: Boolean(bridge.needs_apply),
      installing: installing.has(bridge.id),
      has_ssh_password: Boolean(ssh_password),
      has_ssh_key: Boolean(ssh_key),
      links: links.map((l) => ({
        ...l,
        check_ok: l.check_ok === null ? null : Boolean(l.check_ok),
        cascade_pending: Boolean(l.cascade_pending || (l.cascade_port && bridge.needs_apply)),
        active: Boolean(l.active),
      })),
    };
  }

  static list() {
    return (db.prepare('SELECT * FROM bridges ORDER BY id').all() as any[]).map((b) => this.serialize(b));
  }

  static get(id: number) {
    return this.serialize(loadBridge(id));
  }

  // ---- Создание и правка ----

  static validateCountry(value: unknown): string {
    const code = String(value ?? '').trim().toLowerCase();
    if (!COUNTRY.test(code)) throw new HttpError(400, 'Страна моста задаётся двухбуквенным кодом (например, ru)');
    return code;
  }

  /** Поля моста из тела запроса; SSH-секреты шифруются (инвариант 2) */
  static parseFields(body: any, existing: any | null): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    if (body.name !== undefined || !existing) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'Имя моста обязательно');
      if (body.name.trim().length > 64) throw new HttpError(400, 'Имя моста не длиннее 64 символов');
      fields.name = body.name.trim();
    }
    if (body.host !== undefined || !existing) {
      if (!isValidHost(body.host)) throw new HttpError(400, 'Укажите корректный IP-адрес или домен моста');
      fields.host = String(body.host).trim();
      if (existing && fields.host !== existing.host) this.requireNoCascade('bridge_id', existing.id);
      if (existing && fields.host !== existing.host) fields.host_key = null;
    }
    if (body.ssh_port !== undefined || !existing) {
      const port = Number(body.ssh_port ?? 22);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'SSH-порт должен быть числом от 1 до 65535');
      fields.ssh_port = port;
    }
    if (body.ssh_user !== undefined || !existing) {
      const user = body.ssh_user ?? 'root';
      if (typeof user !== 'string' || !/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user)) throw new HttpError(400, 'Некорректное имя SSH-пользователя');
      fields.ssh_user = user;
    }
    if (body.country !== undefined || !existing) fields.country = this.validateCountry(body.country);

    const key = typeof body.ssh_key === 'string' && body.ssh_key.trim() ? body.ssh_key : null;
    const password = typeof body.ssh_password === 'string' && body.ssh_password ? body.ssh_password : null;
    if (key) {
      if (!key.includes('PRIVATE KEY')) throw new HttpError(400, 'SSH-ключ должен быть в формате PEM/OpenSSH (-----BEGIN ... PRIVATE KEY-----)');
      fields.ssh_key = encryptSecret(key.trim() + '\n');
      fields.ssh_password = null;
    } else if (password) {
      fields.ssh_password = encryptSecret(password);
      fields.ssh_key = null;
    } else if (!existing) {
      throw new HttpError(400, 'Укажите SSH-пароль или приватный ключ');
    }
    if (body.reset_host_key === true) fields.host_key = null;
    if (body.panel_forward !== undefined) {
      if (typeof body.panel_forward !== 'boolean') throw new HttpError(400, 'panel_forward — true или false');
      fields.panel_forward = body.panel_forward ? 1 : 0;
      if (body.panel_forward) {
        const port = panelPort();
        const sshPort = Number(fields.ssh_port ?? existing?.ssh_port ?? 22);
        if (sshPort === port) throw new HttpError(400, `Порт панели ${port} совпадает с SSH-портом моста`);
        const busy = existing && db.prepare('SELECT 1 FROM bridge_links WHERE bridge_id = ? AND listen_port = ?').get(existing.id, port);
        if (busy) throw new HttpError(409, `Порт ${port} на мосту уже занят пересылкой ноды — пересылку панели включить нельзя`);
      }
    }
    return fields;
  }

  static create(body: any): number {
    const fields = this.parseFields(body ?? {}, null);
    const duplicate = db.prepare('SELECT id FROM bridges WHERE LOWER(host) = LOWER(?)').get(fields.host as string);
    if (duplicate) throw new HttpError(409, `Мост ${fields.host} уже добавлен в панель`);
    const keys = Object.keys(fields);
    const result = db.prepare(`INSERT INTO bridges (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(
      ...(keys.map((k) => fields[k]) as any[])
    );
    return Number(result.lastInsertRowid);
  }

  static update(id: number, body: any): void {
    const bridge = loadBridge(id);
    const fields = this.parseFields(body ?? {}, bridge);
    if (fields.host !== undefined && String(fields.host).toLowerCase() !== String(bridge.host).toLowerCase()) {
      const duplicate = db.prepare('SELECT id FROM bridges WHERE LOWER(host) = LOWER(?) AND id != ?').get(fields.host as string, id);
      if (duplicate) throw new HttpError(409, `Мост ${fields.host} уже добавлен в панель`);
    }
    const keys = Object.keys(fields);
    if (keys.length) {
      db.prepare(`UPDATE bridges SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(keys.map((k) => fields[k]) as any[]), id);
    }
  }

  // ---- Установка, применение правил, удаление ----

  static isInstalling(id: number): boolean {
    return installing.has(id);
  }

  static requireNoCascade(by: 'bridge_id' | 'server_id', id: number): void {
    if (db.prepare(`SELECT 1 FROM bridge_links WHERE ${by} = ? AND cascade_port IS NOT NULL`).get(id)) {
      throw new HttpError(409, 'Сначала отключите каскад XHTTP у привязанных нод');
    }
  }

  private static async withNode(serverId: number, action: (creds: SshCredentials) => Promise<void>): Promise<void> {
    await runExclusive(serverId, async () => {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
      if (!server || server.remote_panel_id) throw new Error('Нужна локальная нода с доступом по SSH');
      await action(ProvisionService.getCredentials(server));
    });
  }

  private static withCascadeNode(link: CascadeLink, action: (creds: SshCredentials) => Promise<void>): Promise<void> {
    return this.withNode(link.serverId, action);
  }

  /**
   * TCP-порты, которые панель считает занятыми на хосте ноды: порты всех локальных нод с тем же адресом (VPN, заглушка, CDN, SSH,
   * запасные) и порты каскадов других мостов. Реально слушающие порты проверяются отдельно на самой ноде (`pickCascadePort`).
   */
  private static reservedNodePorts(server: any, bridgeId: number): Set<number> {
    const reserved = new Set<number>();
    const peers = db.prepare(
      'SELECT * FROM servers WHERE remote_panel_id IS NULL AND (id = ? OR lower(host) = lower(?))'
    ).all(server.id, server.host) as any[];
    for (const peer of peers) {
      for (const value of [peer.ssh_port, peer.awg_port, peer.deployed_port, peer.stub_port, peer.cdn_port, ...parseExtraPorts(peer.extra_ports)]) {
        if (Number.isInteger(value)) reserved.add(value);
      }
      const others = db.prepare('SELECT cascade_port FROM bridge_links WHERE server_id = ? AND bridge_id != ? AND cascade_port IS NOT NULL')
        .all(peer.id, bridgeId) as { cascade_port: number }[];
      for (const other of others) reserved.add(other.cascade_port);
    }
    return reserved;
  }

  private static changeCascadeNode(link: CascadeLink, apply: boolean): Promise<void> {
    return this.withCascadeNode(link, async (creds) => {
      const name = cascadeContainer(link, 'node');
      if (apply) {
        if (link.protocol === 'awg') await requireAwgLoopback(creds, link.vpnPort);
        // Порт каскада открывается в ufw/firewalld/iptables при каждом применении: идемпотентно и чинит порт, закрытый вручную
        await openCascadeFirewall(creds, link.port, name);
        await applyCascadeContainer(creds, name, cascadeConfigs(link).node);
      } else {
        await removeCascadeContainer(creds, name);
      }
    });
  }

  /**
   * Зависимости и образ на мосту — общие: сбой здесь отменяет применение. Остальное идёт по привязкам: недоступная нода
   * одной привязки не должна блокировать правила и другие привязки моста, её ошибка возвращается в `failed`.
   * Привязка `strictServerId` (её сейчас настраивает администратор) при сбое бросает исключение, как и раньше.
   */
  private static async applyCascades(bridge: any, creds: SshCredentials, strictServerId?: number): Promise<Map<number, string>> {
    const failed = new Map<number, string>();
    const links = cascadeLinks(bridge.id);
    if (links.length) {
      const command = `${SshService.sudo(creds)}timeout -s TERM -k 30 600 bash -s -- --cascade-dependencies`;
      const message = 'Не удалось установить зависимости каскада на мосту (Docker, conntrack, iproute2). Проверьте доступ к репозиториям и запуск Docker.';
      const result = await SshService.executeCommand(creds, command, { input: readDeployScript(), timeoutMs: 12 * 60 * 1000 })
        .catch((err: unknown) => { throw new Error(message, { cause: err }); });
      if (result.code !== 0) {
        // Причина — в хвосте вывода скрипта (строки с меткой [каскад], затем последние строки apt/dnf): без неё не понять, что сломалось
        const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const marked = lines.filter((line) => line.startsWith('[каскад]'));
        const detail = (marked.length ? marked : lines).slice(-2).join(' ').slice(0, 300);
        throw new Error(detail ? `${message} Подробности: ${detail}` : message);
      }
      await prepareCascadeImage(creds);
    }
    const attempt = async (link: CascadeLink, step: () => Promise<void>) => {
      if (failed.has(link.serverId)) return;
      try {
        await step();
      } catch (err: any) {
        if (link.serverId === strictServerId) throw err;
        failed.set(link.serverId, String(err?.message ?? err).slice(0, 200));
      }
    };
    for (const link of links) await attempt(link, () => this.withCascadeNode(link, prepareCascadeImage));
    for (const link of links) {
      await attempt(link, async () => {
        await this.changeCascadeNode(link, true);
        await applyCascadeContainer(creds, cascadeContainer(link, 'bridge'), cascadeConfigs(link).bridge);
        const result = await SshService.executeCommand(creds, cascadePortReachable(link.host, link.port), { timeoutMs: 10000 });
        if (result.code !== 0) throw new Error(`С моста недоступен TCP-порт каскада ${link.host}:${link.port}`);
      });
    }
    return failed;
  }

  /** Установка моста: пересылка пакетов, правила из БД, автозапуск правил. Возвращает журнал установки. */
  static async install(id: number): Promise<OperationResult & { log: string }> {
    loadBridge(id);
    if (installing.has(id)) throw new HttpError(409, 'Установка этого моста уже выполняется');
    installing.add(id);
    let log = '';
    try {
      return await runExclusive(queueKey(id), async () => {
        const bridge = loadBridge(id);
        db.prepare("UPDATE bridges SET status = 'installing', last_error = NULL WHERE id = ?").run(id);
        try {
          const rules = rulesFor(db.prepare('SELECT * FROM bridges WHERE id = ?').get(id));
          const script = [`export RULES_B64=${shellQuote(Buffer.from(rules).toString('base64'))}`, readDeployScript()].join('\n');
          const creds = credentials(bridge);
          const failed = await this.applyCascades(bridge, creds);
          const result = await SshService.executeCommand(
            creds,
            `${SshService.sudo(creds)}bash -c 'script=$(cat); exec bash -c "$script" deploy-bridge'`,
            { input: script, onData: (chunk) => (log += chunk), timeoutMs: 10 * 60 * 1000 }
          );
          // Без потокового вывода (onData не вызывался) журнал — итоговый stdout
          if (!log) log = result.stdout;
          if (result.code !== 0 || !result.stdout.includes('---DEMENTIA_BRIDGE_OK---')) {
            const hint = /sudo: a (terminal|password) is required/.test(result.stderr) ? ' Пользователю нужен sudo без пароля (NOPASSWD) или используйте root.' : '';
            const detail = result.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
            throw new Error(`Скрипт установки моста завершился с ошибкой (код ${result.code}).${hint}${detail ? ` ${detail}` : ''}`);
          }
          recordApplied(id, rules, failed);
          return { success: true, log };
        } catch (err: any) {
          db.prepare("UPDATE bridges SET status = 'error', last_error = ? WHERE id = ?").run(err.message, id);
          return { success: false, error: err.message, log: log + `\n❌ ${err.message}\n` };
        }
      });
    } finally {
      installing.delete(id);
    }
  }

  /** Применить правила из БД на мосту; повторные запросы до начала применения объединяются */
  static requestApply(id: number): Promise<OperationResult> {
    db.prepare('UPDATE bridges SET needs_apply = 1 WHERE id = ?').run(id);
    const existing = pendingApply.get(id);
    if (existing) return existing;
    const promise = runExclusive(queueKey(id), async () => {
      pendingApply.delete(id);
      return this.doApply(id);
    });
    pendingApply.set(id, promise);
    return promise;
  }

  private static async doApply(id: number, removedCascade?: CascadeLink, strictServerId?: number): Promise<OperationResult> {
    const bridge = db.prepare('SELECT * FROM bridges WHERE id = ?').get(id) as any;
    if (!bridge) return { success: false, error: 'Мост удалён' };
    if (bridge.status === 'uninstalled' || bridge.status === 'installing' || installing.has(id)) {
      return { success: false, error: 'Мост не установлен' };
    }
    try {
      const rules = rulesFor(db.prepare('SELECT * FROM bridges WHERE id = ?').get(id));
      const creds = credentials(bridge);
      const failed = await this.applyCascades(bridge, creds, strictServerId);
      const write = [
        'set -e',
        'umask 077',
        'mkdir -p /etc/dementia-bridge',
        'cat > /etc/dementia-bridge/rules.sh.new',
        'sh /etc/dementia-bridge/rules.sh.new',
        ...(removedCascade ? [
          clearBridgeConntrack,
          `clear_bridge_conntrack ${removedCascade.protocol === 'awg' ? 'udp' : 'tcp'} ${removedCascade.listenPort}`,
          ...(removedCascade.protocol === 'awg' && removedCascade.stubPort ? [`clear_bridge_conntrack tcp ${removedCascade.listenPort}`] : []),
        ] : []),
        'mv -f /etc/dementia-bridge/rules.sh.new /etc/dementia-bridge/rules.sh',
      ].join('\n');
      const result = await SshService.executeCommand(creds, `${SshService.sudo(creds)}sh -c ${shellQuote(write)}`, { input: rules, timeoutMs: 60000 });
      if (result.code !== 0) throw new Error(`Ошибка применения правил моста: ${result.stderr.trim() || `код ${result.code}`}`);
      recordApplied(id, rules, failed);
      return { success: true };
    } catch (err: any) {
      db.prepare('UPDATE bridges SET last_error = ? WHERE id = ?').run(err.message, id);
      return { success: false, error: err.message };
    }
  }

  static async teardown(id: number): Promise<OperationResult> {
    return runExclusive(queueKey(id), async () => {
      const bridge = loadBridge(id);
      try {
        const creds = credentials(bridge);
        const result = await SshService.executeCommand(creds, `${SshService.sudo(creds)}sh -c ${shellQuote(TEARDOWN_SCRIPT)}`, { timeoutMs: 60000 });
        if (result.code !== 0) throw new Error(result.stderr.trim() || `код ${result.code}`);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });
  }

  static async testSsh(id: number) {
    return SshService.testConnection(credentials(loadBridge(id)));
  }

  // ---- Привязка к нодам ----

  /**
   * Задаёт список нод моста. Порт на мосту для новой ноды — её порт AmneziaWG, если он свободен на этом мосту, иначе
   * случайный; у уже привязанных нод порт не меняется (иначе выданные через мост конфиги перестанут работать).
   * Если применить правила на мосту не удалось, прежний список возвращается.
   */
  static async setLinks(id: number, links: unknown): Promise<OperationResult> {
    return runExclusive(queueKey(id), () => this.updateLinks(id, links));
  }

  private static async updateLinks(id: number, links: unknown): Promise<OperationResult> {
    const bridge = loadBridge(id);
    if (!Array.isArray(links)) throw new HttpError(400, 'links должен быть массивом');
    const wanted = new Map<number, LinkMode>();
    for (const item of links) {
      const serverId = Number((item as any)?.server_id);
      const mode = ((item as any)?.mode ?? DEFAULT_LINK_MODE) as LinkMode;
      if (!Number.isInteger(serverId) || serverId <= 0) throw new HttpError(400, 'Некорректный идентификатор ноды');
      if (!LINK_MODES.includes(mode)) throw new HttpError(400, 'Режим моста: main, auto, always или off');
      wanted.set(serverId, mode);
    }

    const previous = db.prepare('SELECT * FROM bridge_links WHERE bridge_id = ?').all(id) as any[];
    if (previous.some((link) => link.cascade_port !== null && !wanted.has(link.server_id))) {
      throw new HttpError(409, 'Перед отвязкой ноды отключите её каскад XHTTP');
    }
    transaction(() => {
      for (const serverId of wanted.keys()) {
        const server = db.prepare('SELECT id, host, awg_port, status FROM servers WHERE id = ?').get(serverId) as any;
        if (!server) throw new HttpError(404, `Нода #${serverId} не найдена`);
        if (net.isIPv6(server.host)) throw new HttpError(400, `Нода ${server.host}: мост поддерживает только IPv4-адреса и домены`);
      }
      const keep = [...wanted.keys()];
      if (keep.length) {
        db.prepare(`DELETE FROM bridge_links WHERE bridge_id = ? AND server_id NOT IN (${keep.map(() => '?').join(',')})`).run(id, ...keep);
      } else {
        db.prepare('DELETE FROM bridge_links WHERE bridge_id = ?').run(id);
      }
      for (const [serverId, mode] of wanted) {
        const existing = db.prepare('SELECT listen_port FROM bridge_links WHERE bridge_id = ? AND server_id = ?').get(id, serverId);
        if (existing) {
          db.prepare('UPDATE bridge_links SET mode = ? WHERE bridge_id = ? AND server_id = ?').run(mode, id, serverId);
          continue;
        }
        const used = (db.prepare('SELECT listen_port FROM bridge_links WHERE bridge_id = ?').all(id) as any[]).map((r) => r.listen_port);
        const server = db.prepare('SELECT awg_port FROM servers WHERE id = ?').get(serverId) as any;
        // Порт панели занят пересылкой панели, если она включена на этом мосту
        const exclude = [...used, bridge.ssh_port, ...(bridge.panel_forward ? [panelPort()] : [])];
        const port = exclude.includes(server.awg_port) ? stubPortCandidates(exclude, null, 1)[0] : server.awg_port;
        db.prepare('INSERT INTO bridge_links (bridge_id, server_id, listen_port, mode) VALUES (?, ?, ?, ?)').run(id, serverId, port, mode);
      }
    });

    if (bridge.status === 'uninstalled') return { success: true };
    db.prepare('UPDATE bridges SET needs_apply = 1 WHERE id = ?').run(id);
    const result = await this.doApply(id);
    if (result.success) return result;

    // Мост не принял правила: возвращаем прежние привязки (подписки не должны раздавать неработающий адрес)
    transaction(() => {
      db.prepare('DELETE FROM bridge_links WHERE bridge_id = ?').run(id);
      const insert = db.prepare(`
        INSERT INTO bridge_links (bridge_id, server_id, listen_port, mode, check_ok, checked_at, cascade_port, cascade_secret, cascade_pending)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const l of previous) {
        if (db.prepare('SELECT 1 FROM servers WHERE id = ?').get(l.server_id)) {
          insert.run(id, l.server_id, l.listen_port, l.mode, l.check_ok, l.checked_at, l.cascade_port, l.cascade_secret, l.cascade_pending);
        }
      }
    });
    return { success: false, error: `${result.error}. Привязки моста возвращены к прежним.` };
  }

  static setCascade(id: number, serverId: number, port: unknown, requestedSni?: unknown): Promise<OperationResult> {
    const auto = port === 'auto';
    if (port !== null && !auto && (typeof port !== 'number' || !isValidPort(port))) throw new HttpError(400, 'Укажите TCP-порт каскада от 1 до 65535 или выберите автоматический подбор');
    const sni = port === null ? undefined : parseCascadeSni(requestedSni);
    return runExclusive(queueKey(id), async () => {
      const bridge = loadBridge(id);
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
      const link = db.prepare('SELECT * FROM bridge_links WHERE bridge_id = ? AND server_id = ?').get(id, serverId) as any;
      if (!link || !server) throw new HttpError(404, 'Привязка к ноде не найдена');
      const previous = cascadeLinks(id).find((item) => item.serverId === serverId);
      if (port === null && !previous) return { success: true };
      if (bridge.status === 'uninstalled' || installing.has(id)) throw new HttpError(409, 'Сначала установите мост');
      if (auto && previous) port = previous.port; // повторное применение уже включённого каскада: порт не меняется
      if (port !== null) {
        if (server.remote_panel_id || server.status !== 'online' || !server.deployed_port || ProvisionService.isInstalling(serverId)) {
          throw new HttpError(400, 'Для каскада нужна работающая локальная нода с доступом по SSH');
        }
        if (bridge.host.toLowerCase() === server.host.toLowerCase()) throw new HttpError(400, 'Мост и нода должны быть на разных хостах');
        if (!isValidHost(server.host) || net.isIPv6(server.host)) throw new HttpError(400, 'Для каскада нужен IPv4-адрес или домен ноды');
        if (previous && port !== previous.port) throw new HttpError(409, 'Для смены порта сначала отключите каскад');
        if (previous && sni && sni !== cascadeSni(previous.secret)) throw new HttpError(409, 'Для смены сайта маскировки сначала отключите каскад');
        const reserved = this.reservedNodePorts(server, id);
        const busy = [server.ssh_port, server.stub_port, server.cdn_port,
          ...(nodeProtocol(server) === 'vless' ? [server.awg_port, server.deployed_port] : [])];
        if (auto && !previous) {
          // Свободный порт выбирает сама нода: из кандидатов без известных панели занятых, по списку реально слушающих (ss)
          const candidates = cascadePortCandidates(reserved);
          await this.withNode(serverId, async (creds) => { port = await pickCascadePort(creds, candidates); });
        } else if (!previous) {
          if (busy.includes(port as number) || (reserved.has(port as number) && !(nodeProtocol(server) === 'awg' && port === server.awg_port))) {
            throw new HttpError(409, 'TCP-порт каскада на ноде уже используется');
          }
          await this.withNode(serverId, async (creds) => { await pickCascadePort(creds, [port as number]); });
        }
      }

      const cascadePort = port as number | null;
      const update = db.prepare(`
        UPDATE bridge_links SET cascade_port = ?, cascade_secret = ?, check_ok = ?, checked_at = ?
        WHERE bridge_id = ? AND server_id = ?
      `);
      transaction(() => {
        db.prepare('UPDATE bridges SET needs_apply = 1 WHERE id = ?').run(id);
        db.prepare('UPDATE bridge_links SET cascade_pending = 1 WHERE bridge_id = ? AND server_id = ?').run(id, serverId);
      });
      if (cascadePort === null && previous) {
        // До удаления записи держим секрет и идентификаторы, чтобы повторить очистку при недоступности одной стороны.
        try {
          await this.changeCascadeNode(previous, false);
          await removeCascadeContainer(credentials(bridge), cascadeContainer(previous, 'bridge'));
        } catch (err: any) {
          db.prepare('UPDATE bridges SET last_error = ? WHERE id = ?').run(err.message, id);
          return { success: false, error: err.message };
        }
      }
      const secret = cascadePort === null ? null : (link.cascade_secret || encryptSecret(JSON.stringify(generateCascadeSecret(sni))));
      update.run(cascadePort, secret, null, null, id, serverId);
      const result = await this.doApply(id, cascadePort === null ? previous : undefined, cascadePort === null ? undefined : serverId);
      if (result.success) return result;

      // Сначала снимаем новый каскад. Если очистка прервалась, запись остаётся доступной для повторного отключения.
      const created = !previous && cascadeLinks(id).find((item) => item.serverId === serverId);
      if (created) {
        try {
          await this.changeCascadeNode(created, false);
          await removeCascadeContainer(credentials(bridge), cascadeContainer(created, 'bridge'));
        } catch {
          return { success: false, error: `${result.error}. Каскад применён не полностью. Повторите настройку или отключите каскад.` };
        }
      }
      update.run(link.cascade_port, link.cascade_secret, link.check_ok, link.checked_at, id, serverId);
      const restored = await this.doApply(id);
      return { success: false, error: restored.success ? result.error : `${result.error}. Не удалось восстановить прежнюю пересылку: ${restored.error}` };
    });
  }

  // ---- Фоновая проверка ----

  /**
   * Опрос мостов (из цикла статистики): если правила в БД изменились (порт или адрес ноды, заглушка, удалённая нода) —
   * применить заново; раз в две минуты — проверить по SSH, что правила на месте.
   */
  static async checkAll(): Promise<void> {
    const bridges = db.prepare("SELECT * FROM bridges WHERE status IN ('online', 'offline')").all() as any[];
    for (const bridge of bridges) {
      if (installing.has(bridge.id)) continue;
      let expected: string;
      try {
        expected = rulesFor(bridge);
      } catch (err: any) {
        db.prepare('UPDATE bridges SET last_error = ? WHERE id = ?').run(err.message, bridge.id);
        continue;
      }
      if (bridge.needs_apply || bridge.rules_hash !== sha256(expected)) {
        await this.requestApply(bridge.id).catch(() => {});
        continue;
      }
      if (Date.now() - (lastHealth.get(bridge.id) ?? 0) < HEALTH_INTERVAL_MS) continue;
      lastHealth.set(bridge.id, Date.now());
      // Каскад привязки не применился (нода была недоступна) — повторная попытка раз в интервал проверки, не чаще
      if (db.prepare('SELECT 1 FROM bridge_links WHERE bridge_id = ? AND cascade_port IS NOT NULL AND cascade_pending = 1').get(bridge.id)) {
        await this.requestApply(bridge.id).catch(() => {});
        continue;
      }
      await runExclusive(queueKey(bridge.id), () => this.checkHealth(bridge.id, expectedRuleCount(ruleLinks(bridge.id), panelForwardOf(bridge)))).catch(() => {});
    }
    await this.checkLinks('vless', HEALTH_INTERVAL_MS);
    // Мост ушёл в offline или вернулся — A-записи резервного домена подписок следуют за ним (без изменений Cloudflare не трогается)
    const { FailoverService } = await import('./failover.service.js');
    await FailoverService.reconcile().catch(() => {});
  }

  private static async checkHealth(id: number, expectedRules: number): Promise<void> {
    const bridge = db.prepare('SELECT * FROM bridges WHERE id = ?').get(id) as any;
    if (!bridge) return;
    try {
      const creds = credentials(bridge);
      const cascades = cascadeLinks(id);
      const checks = cascades.map((link) => [
        `if ${cascadeRunning(cascadeContainer(link, 'bridge'))} && ${cascadePortReachable(link.host, link.port)};`,
        `then echo "CASCADE ${link.serverId}"; fi &`,
      ].join(' '));
      const script = [HEALTH_SCRIPT, ...checks, ...(checks.length ? ['wait'] : [])].join('\n');
      const result = await SshService.executeCommand(creds, `${SshService.sudo(creds)}sh -c ${shellQuote(script)}`, { timeoutMs: 30000 });
      if (result.code !== 0) throw new Error(result.stderr.trim() || `код ${result.code}`);
      const health = parseHealth(result.stdout);
      db.prepare("UPDATE bridges SET status = 'online', fail_count = 0, last_seen = datetime('now') WHERE id = ?").run(id);
      // Правила пропали (перезагрузка без systemd, чужой iptables-restore) или переход сдвинут ufw/Docker — применить заново
      const cascadeMissing = cascades.some((link) => !link.pending && !result.stdout.split(/\r?\n/).includes(`CASCADE ${link.serverId}`));
      if (cascadeMissing || health.rules !== expectedRules || (expectedRules > 0 && (!health.forwardFirst || !health.prerouting))) {
        db.prepare('UPDATE bridges SET needs_apply = 1 WHERE id = ?').run(id);
      } else if (bridge.last_error) {
        db.prepare('UPDATE bridges SET last_error = NULL WHERE id = ?').run(id);
      }
    } catch (err: any) {
      if (err instanceof HostKeyMismatchError) {
        db.prepare("UPDATE bridges SET status = 'error', last_error = ? WHERE id = ?").run(err.message, id);
        return;
      }
      db.prepare(`
        UPDATE bridges SET fail_count = fail_count + 1, last_error = ?,
          status = CASE WHEN fail_count + 1 >= ? THEN 'offline' ELSE status END
        WHERE id = ?
      `).run(err.message, OFFLINE_THRESHOLD, id);
    }
  }

  /** AWG подтверждается меткой заглушки, VLESS — доверенным сертификатом Reality. */
  static async checkLinks(protocol: 'awg' | 'vless' = 'awg', intervalMs = 0): Promise<void> {
    const cutoff = intervalMs ? new Date(Date.now() - intervalMs).toISOString() : null;
    const links = db.prepare(`
      SELECT l.bridge_id, l.server_id, l.listen_port, l.cascade_port, b.host AS bridge_host, s.stub_token,
        s.reality_sni, s.reality_dest, s.awg_port
      FROM bridge_links l JOIN bridges b ON b.id = l.bridge_id JOIN servers s ON s.id = l.server_id
      WHERE b.status = 'online' AND l.mode != 'off'
        AND l.cascade_pending = 0 AND (l.cascade_port IS NULL OR b.needs_apply = 0)
        AND COALESCE(s.protocol, 'awg') = ?
        AND CASE WHEN s.protocol = 'vless' THEN b.needs_apply = 0
                 ELSE s.stub_port IS NOT NULL AND s.stub_token IS NOT NULL END
        AND (? IS NULL OR l.checked_at IS NULL OR l.checked_at <= ?)
    `).all(protocol, cutoff, cutoff) as {
      bridge_id: number; server_id: number; listen_port: number; cascade_port: number | null;
      bridge_host: string; stub_token: string | null; reality_sni: string | null; reality_dest: string | null; awg_port: number;
    }[];
    const check = async (link: typeof links[number]) => {
      let ok = false;
      if (protocol === 'vless') {
        ok = await checkRealityCertificate(link.bridge_host, link.listen_port, vlessParamsFromRow(link).reality_sni);
      } else {
        try {
          const res = await fetch(`http://${formatEndpointHost(link.bridge_host)}:${link.listen_port}/${crypto.randomBytes(8).toString('hex')}`, {
            signal: AbortSignal.timeout(8000),
            redirect: 'manual',
          });
          ok = res.status === 200 && (await res.text()).slice(0, 4096).includes(link.stub_token!);
        } catch {
          ok = false;
        }
      }
      db.prepare(`
        UPDATE bridge_links SET check_ok = ?, checked_at = ?
        WHERE bridge_id = ? AND server_id = ? AND listen_port = ? AND cascade_port IS ? AND cascade_pending = 0 AND mode != 'off'
          AND EXISTS (SELECT 1 FROM bridges WHERE id = bridge_id AND host = ? AND status = 'online'
            AND (needs_apply = 0 OR (bridge_links.cascade_port IS NULL AND ? = 'awg')))
          AND EXISTS (SELECT 1 FROM servers WHERE id = server_id AND awg_port = ? AND COALESCE(protocol, 'awg') = ?
            AND reality_sni IS ? AND reality_dest IS ?)
      `).run(ok ? 1 : 0, new Date().toISOString(), link.bridge_id, link.server_id, link.listen_port, link.cascade_port,
        link.bridge_host, protocol, link.awg_port, protocol, link.reality_sni, link.reality_dest);
    };
    // Проверки VLESS идут из статистического цикла. Не открываем одновременно сокет для каждой привязки.
    const batchSize = protocol === 'vless' ? 8 : Math.max(links.length, 1);
    for (let i = 0; i < links.length; i += batchSize) {
      await Promise.all(links.slice(i, i + batchSize).map(check));
    }
  }

  // ---- Решение: кому нужен мост ----

  /**
   * Сигнал от клиентов: у клиентов страны рукопожатия с нодой одновременно прекратились, а у клиентов других стран идут.
   * Одновременность отличает сетевой сбой на маршруте от того, что пользователи по одному отключились (например, на ночь).
   */
  static passiveSuspect(serverId: number, country: string, now = Date.now()): boolean {
    const rows = db.prepare(`
      SELECT c.last_handshake, sub.country FROM clients c JOIN subscribers sub ON sub.id = c.subscriber_id
      WHERE c.server_id = ? AND c.enabled = 1 AND c.last_handshake IS NOT NULL
    `).all(serverId) as { last_handshake: string; country: string | null }[];
    const own: number[] = [];
    let othersAlive = false;
    for (const r of rows) {
      const at = Date.parse(r.last_handshake);
      if (!Number.isFinite(at)) continue;
      if (r.country === country) {
        if (now - at <= PASSIVE_LOOKBACK_MS) own.push(at);
      } else if (now - at <= PASSIVE_ALIVE_MS) {
        othersAlive = true;
      }
    }
    if (!othersAlive || own.length < PASSIVE_MIN_CLIENTS) return false;
    const last = Math.max(...own);
    if (now - last < PASSIVE_SILENCE_MS) return false;
    const cluster = own.filter((t) => t >= last - PASSIVE_CLUSTER_MS).length;
    const activeHour = own.filter((t) => t >= last - 60 * 60 * 1000).length;
    return cluster >= PASSIVE_MIN_CLIENTS && cluster >= 0.6 * activeHour;
  }

  /**
   * Пересчёт состояния «нужен мост» для каждой пары нода × страна, у которой есть мост в режиме auto.
   * fromProbe — вызов после проверки из стран: только тогда считаются серии проверок (каждая проверка — один шаг).
   */
  static evaluate(fromProbe: boolean, now = Date.now()): void {
    const pairs = db.prepare(`
      SELECT DISTINCT l.server_id, b.country, s.status
      FROM bridge_links l JOIN bridges b ON b.id = l.bridge_id JOIN servers s ON s.id = l.server_id
      WHERE l.mode = 'auto'
    `).all() as { server_id: number; country: string; status: string }[];
    if (pairs.length === 0) return;

    const settings = ProbeService.readSettings();
    const results = new Map<string, ProbeResult>();
    for (const r of ProbeService.allResults()) results.set(`${r.server_id}:${r.country}`, r);

    const select = db.prepare('SELECT * FROM bridge_state WHERE server_id = ? AND country = ?');
    const upsert = db.prepare(`
      INSERT INTO bridge_state (server_id, country, active, fail_streak, ok_streak, reason, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, country) DO UPDATE SET active = excluded.active, fail_streak = excluded.fail_streak,
        ok_streak = excluded.ok_streak, reason = excluded.reason, changed_at = excluded.changed_at
    `);
    transaction(() => {
      for (const pair of pairs) {
        // Нода не отвечает панели — мост тут не поможет, состояние не меняется
        if (pair.status !== 'online') continue;
        const state = (select.get(pair.server_id, pair.country) as any) ?? { active: 0, fail_streak: 0, ok_streak: 0, reason: null, changed_at: null };
        let { active, fail_streak: fail, ok_streak: ok, reason, changed_at: changedAt } = state;

        const probed = settings.enabled && settings.countries.includes(pair.country);
        const probe = results.get(`${pair.server_id}:${pair.country}`);
        const probeProblem = probe ? probe.total_nodes > 0 && probe.ok_nodes * 2 < probe.total_nodes : false;
        const passive = this.passiveSuspect(pair.server_id, pair.country, now);

        if (fromProbe && probe) {
          if (probeProblem) {
            fail++;
            ok = 0;
          } else {
            ok++;
            fail = 0;
          }
        }

        if (!active && (passive || fail >= FAIL_STREAK_TO_ACTIVATE)) {
          active = 1;
          reason = passive ? 'clients' : 'probe';
          changedAt = new Date(now).toISOString();
        } else if (active && !passive && !probeProblem) {
          const held = !changedAt || now - Date.parse(changedAt) >= BRIDGE_HOLD_MS;
          // Без проверки из этой страны мост выключается по истечении срока, если клиенты больше не обрываются
          if (held && (probed ? ok >= OK_STREAK_TO_RELEASE : true)) {
            active = 0;
            reason = null;
            changedAt = new Date(now).toISOString();
          }
        }
        upsert.run(pair.server_id, pair.country, active, fail, ok, reason, changedAt);
      }
    });
  }

  /** После проверки из стран: сквозная проверка мостов и пересчёт состояния */
  static async afterProbeRun(): Promise<void> {
    await this.checkLinks();
    this.evaluate(true);
  }

  /**
   * Мосты для подписки пользователя из страны country: нода → адрес моста. Мост берётся, если он в стране пользователя,
   * работает, пересылка не провалила проверку и для ноды включён режим always или auto с активным состоянием.
   */
  static routesFor(country: string | null): Map<number, BridgeRoute> {
    const routes = new Map<number, BridgeRoute>();
    if (!country || !COUNTRY.test(country)) return routes;
    const rows = db.prepare(`
      SELECT l.server_id, l.listen_port, l.mode, b.id AS bridge_id, b.name AS bridge_name, b.host
      FROM bridge_links l
      JOIN bridges b ON b.id = l.bridge_id
      LEFT JOIN bridge_state st ON st.server_id = l.server_id AND st.country = b.country
      WHERE b.country = ? AND b.status = 'online' AND COALESCE(l.check_ok, 1) = 1
        AND l.cascade_pending = 0 AND (l.cascade_port IS NULL OR b.needs_apply = 0)
        AND (l.mode IN ('main', 'always') OR (l.mode = 'auto' AND st.active = 1))
      ORDER BY b.id
    `).all(country) as any[];
    for (const r of rows) {
      if (!routes.has(r.server_id)) {
        routes.set(r.server_id, {
          bridge_id: r.bridge_id, bridge_name: r.bridge_name, host: r.host, port: r.listen_port, keepDirect: r.mode === 'main',
        });
      }
    }
    return routes;
  }
}
