import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSetting, transaction } from '../db/index.js';
import { HttpError } from '../utils/http.js';
import { formatEndpointHost, isValidHost, shellQuote } from '../utils/net.js';
import { HostKeyMismatchError, SshCredentials, SshService } from './ssh.service.js';
import { decryptSecret, encryptSecret } from './secrets.service.js';
import { OperationResult, runExclusive } from './provision.service.js';
import { ProbeService, ProbeResult } from './probe.service.js';
import { stubPortCandidates } from './stub.service.js';

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
    WHERE l.bridge_id = ? ORDER BY l.listen_port
  `).all(bridgeId) as any[];
}

/** Пересылка панели для моста: включена флагом `panel_forward` и известен IPv4 панели (`panel_origin_ip`) */
function panelForwardOf(bridge: any): PanelForward | null {
  if (!bridge?.panel_forward) return null;
  const ip = getSetting('panel_origin_ip');
  return ip && net.isIPv4(ip) ? { ip, port: panelPort() } : null;
}

function rulesFor(bridge: any): string {
  return buildBridgeRules(ruleLinks(bridge.id), panelForwardOf(bridge));
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

export class BridgeService {
  // ---- Представление ----

  /** Мост для интерфейса — без SSH-пароля и ключа */
  static serialize(bridge: any) {
    const { ssh_password, ssh_key, rules_hash, ...rest } = bridge;
    const links = db.prepare(`
      SELECT l.server_id, s.name AS server_name, s.host AS server_host, s.awg_port, l.listen_port, l.mode, l.check_ok, l.checked_at,
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
          db.prepare(`
            UPDATE bridges SET status = 'online', rules_hash = ?, needs_apply = 0, fail_count = 0, last_error = NULL, last_seen = datetime('now')
            WHERE id = ?
          `).run(sha256(rules), id);
          lastHealth.set(id, Date.now());
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

  private static async doApply(id: number): Promise<OperationResult> {
    const bridge = db.prepare('SELECT * FROM bridges WHERE id = ?').get(id) as any;
    if (!bridge) return { success: false, error: 'Мост удалён' };
    if (bridge.status === 'uninstalled' || bridge.status === 'installing' || installing.has(id)) {
      return { success: false, error: 'Мост не установлен' };
    }
    try {
      const rules = rulesFor(db.prepare('SELECT * FROM bridges WHERE id = ?').get(id));
      const creds = credentials(bridge);
      const write = `umask 077 && mkdir -p /etc/dementia-bridge && cat > /etc/dementia-bridge/rules.sh.new && mv -f /etc/dementia-bridge/rules.sh.new /etc/dementia-bridge/rules.sh && sh /etc/dementia-bridge/rules.sh`;
      const result = await SshService.executeCommand(creds, `${SshService.sudo(creds)}sh -c ${shellQuote(write)}`, { input: rules, timeoutMs: 60000 });
      if (result.code !== 0) throw new Error(`Ошибка применения правил моста: ${result.stderr.trim() || `код ${result.code}`}`);
      db.prepare(`
        UPDATE bridges SET status = 'online', rules_hash = ?, needs_apply = 0, fail_count = 0, last_error = NULL, last_seen = datetime('now')
        WHERE id = ?
      `).run(sha256(rules), id);
      lastHealth.set(id, Date.now());
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
    const result = await this.requestApply(id);
    if (result.success) return result;

    // Мост не принял правила: возвращаем прежние привязки (подписки не должны раздавать неработающий адрес)
    transaction(() => {
      db.prepare('DELETE FROM bridge_links WHERE bridge_id = ?').run(id);
      const insert = db.prepare('INSERT INTO bridge_links (bridge_id, server_id, listen_port, mode, check_ok, checked_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of previous) {
        if (db.prepare('SELECT 1 FROM servers WHERE id = ?').get(l.server_id)) insert.run(id, l.server_id, l.listen_port, l.mode, l.check_ok, l.checked_at);
      }
    });
    return { success: false, error: `${result.error}. Привязки моста возвращены к прежним.` };
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
      await runExclusive(queueKey(bridge.id), () => this.checkHealth(bridge.id, expectedRuleCount(ruleLinks(bridge.id), panelForwardOf(bridge)))).catch(() => {});
    }
    // Мост ушёл в offline или вернулся — A-записи резервного домена подписок следуют за ним (без изменений Cloudflare не трогается)
    const { FailoverService } = await import('./failover.service.js');
    await FailoverService.reconcile().catch(() => {});
  }

  private static async checkHealth(id: number, expectedRules: number): Promise<void> {
    const bridge = db.prepare('SELECT * FROM bridges WHERE id = ?').get(id) as any;
    if (!bridge) return;
    try {
      const creds = credentials(bridge);
      const result = await SshService.executeCommand(creds, `${SshService.sudo(creds)}sh -c ${shellQuote(HEALTH_SCRIPT)}`, { timeoutMs: 30000 });
      if (result.code !== 0) throw new Error(result.stderr.trim() || `код ${result.code}`);
      const health = parseHealth(result.stdout);
      db.prepare("UPDATE bridges SET status = 'online', fail_count = 0, last_seen = datetime('now') WHERE id = ?").run(id);
      // Правила пропали (перезагрузка без systemd, чужой iptables-restore) или переход сдвинут ufw/Docker — применить заново
      if (health.rules !== expectedRules || (expectedRules > 0 && (!health.forwardFirst || !health.prerouting))) {
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

  /**
   * Сквозная проверка пересылки: панель открывает http://мост:порт/ — мост пересылает TCP этого порта на заглушку ноды,
   * и ответ должен содержать метку заглушки. Мост с неработающей пересылкой в подписку не попадает.
   */
  static async checkLinks(): Promise<void> {
    const links = db.prepare(`
      SELECT l.bridge_id, l.server_id, l.listen_port, b.host AS bridge_host, s.stub_token
      FROM bridge_links l JOIN bridges b ON b.id = l.bridge_id JOIN servers s ON s.id = l.server_id
      WHERE b.status = 'online' AND s.stub_port IS NOT NULL AND s.stub_token IS NOT NULL AND l.mode != 'off'
    `).all() as any[];
    await Promise.all(
      links.map(async (l) => {
        let ok = false;
        try {
          const res = await fetch(`http://${formatEndpointHost(l.bridge_host)}:${l.listen_port}/${crypto.randomBytes(8).toString('hex')}`, {
            signal: AbortSignal.timeout(8000),
            redirect: 'manual',
          });
          ok = res.status === 200 && (await res.text()).slice(0, 4096).includes(l.stub_token);
        } catch {
          ok = false;
        }
        db.prepare('UPDATE bridge_links SET check_ok = ?, checked_at = ? WHERE bridge_id = ? AND server_id = ?').run(
          ok ? 1 : 0, new Date().toISOString(), l.bridge_id, l.server_id
        );
      })
    );
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
