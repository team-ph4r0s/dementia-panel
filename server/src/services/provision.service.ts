import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, transaction } from '../db/index.js';
import { SshService, SshCredentials, HostKeyMismatchError } from './ssh.service.js';
import { AwgService } from './awg.service.js';
import { decryptSecret } from './secrets.service.js';
import { shellQuote, parseSubnet } from '../utils/net.js';
import { parseServerConfig, paramsToColumns, ParsedServerConfig } from '../utils/awg-params.js';
import { FederationClient } from './federation-client.service.js';
import { EventService } from './event.service.js';
import { MigrationService } from './migration.service.js';
import { HttpError } from '../utils/http.js';
import {
  nodeProtocol,
  XRAY_IMAGE,
  XRAY_CONTAINER,
  XRAY_CONF_DIR,
  XRAY_CONF_PATH,
  XRAY_API_PORT,
  DEFAULT_VLESS_PORT,
  generateVlessParams,
  vlessParamsFromRow,
} from '../utils/vless-params.js';
import { XrayService } from './xray.service.js';
import {
  newStubToken,
  parseStubHits,
  parseStubPort,
  stubInstallScript,
  stubPortCandidates,
  stubReadScript,
  stubRemoveScript,
  StubHit,
} from './stub.service.js';

const REMOTE_NODE_ERROR = 'Это нода партнёра: ею управляет панель владельца';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Контейнер, разворачиваемый панелью */
const PANEL_CONTAINER = 'amnezia-awg';
/** На ноды всегда ставится актуальный образ AmneziaWG (docker pull при каждой установке/переустановке) */
export const AWG_IMAGE = 'amneziavpn/amneziawg-go:latest';
const AWG_DIR = '/opt/amnezia/awg';
const PANEL_CONF = `${AWG_DIR}/awg0.conf`;
/** Сколько неудачных опросов подряд переводят сервер в offline */
const OFFLINE_THRESHOLD = 3;
/** Как часто перечитываются версии ПО AmneziaWG на ноде (после установки и подключения — сразу) */
const NODE_INFO_TTL_MS = 12 * 60 * 60 * 1000;

export interface OperationResult {
  success: boolean;
  error?: string;
}

export interface DetectedContainer {
  name: string;
  image: string;
  running: boolean;
  confPath: string | null;
  tool: 'awg' | 'wg';
  managedBy: 'demension' | 'amnezia';
  config: string | null;
  clientNames: Record<string, string>;
}

export interface ScanResult {
  /** Найден работающий контейнер с конфигурацией, который можно подключить без установки */
  found: boolean;
  containers: { name: string; image: string; running: boolean; managedBy: string }[];
  message: string;
  adopted?: {
    container: string;
    managedBy: string;
    awgVersion: number;
    port: number;
    subnet: string;
    importedPeers: number;
    skippedPeers: number;
  };
}

// Все операции с одной нодой выполняются последовательно (с мостом — по ключу `bridge:<id>`)
const chains = new Map<number | string, Promise<unknown>>();
// Запрошенная, но ещё не начатая синхронизация (повторные запросы объединяются)
const pendingSync = new Map<number, Promise<OperationResult>>();
// То же для применения параметров: каждое применение перезапускает контейнер и рвёт туннели всех клиентов
const pendingApply = new Map<number, Promise<OperationResult>>();
const installing = new Set<number>();
/**
 * Строка сервера, параметры которой заведомо работают на ноде (последнее успешное применение или состояние без needs_apply
 * перед первой правкой). По ней откатываются неудачные правки: несколько правок до применения объединяются в одно, и откат
 * к «прежнему» значению отдельного запроса вернул бы в БД значение, которого на ноде никогда не было (инвариант 28).
 */
const appliedBaseline = new Map<number, Record<string, unknown>>();

export function runExclusive<T>(serverId: number | string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(serverId) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  chains.set(serverId, tail);
  tail.then(() => {
    if (chains.get(serverId) === tail) chains.delete(serverId);
  });
  return next;
}

function loadServer(serverId: number): any {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
  if (!server) throw new Error(`Сервер #${serverId} не найден`);
  return server;
}

/**
 * Сервер — нода партнёрской панели (без SSH-доступа)
 */
function loadLocalServer(serverId: number): any {
  const server = loadServer(serverId);
  if (server.remote_panel_id) throw new Error(REMOTE_NODE_ERROR);
  return server;
}

function remotePanelOf(serverId: number): number | null {
  const row = db.prepare('SELECT remote_panel_id FROM servers WHERE id = ?').get(serverId) as any;
  return row?.remote_panel_id ?? null;
}

function readDeployScript(): string {
  const candidates = [
    path.resolve(__dirname, '../scripts/deploy-awg.sh'),
    path.resolve(process.cwd(), 'src/scripts/deploy-awg.sh'),
    path.resolve(process.cwd(), 'dist/scripts/deploy-awg.sh'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf-8');
  }
  throw new Error('Установочный скрипт deploy-awg.sh не найден');
}

function readDeployXrayScript(): string {
  const candidates = [
    path.resolve(__dirname, '../scripts/deploy-xray.sh'),
    path.resolve(process.cwd(), 'src/scripts/deploy-xray.sh'),
    path.resolve(process.cwd(), 'dist/scripts/deploy-xray.sh'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf-8');
  }
  throw new Error('Установочный скрипт deploy-xray.sh не найден');
}

/**
 * Разбор вывода скрипта сканирования (маркеры ---CONTAINER / ---CONF / ---TOOL / ---CLIENTS / ---DEMENTIA)
 */
export function parseScanOutput(output: string): DetectedContainer[] {
  const containers: DetectedContainer[] = [];
  let current: DetectedContainer | null = null;
  let mode: 'conf' | 'clients' | null = null;
  let buffer: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (mode) {
      if ((mode === 'conf' && line === '---ENDCONF') || (mode === 'clients' && line === '---ENDCLIENTS')) {
        if (current && mode === 'conf') current.config = buffer.join('\n');
        if (current && mode === 'clients') {
          try {
            const table = JSON.parse(buffer.join('\n'));
            for (const entry of Array.isArray(table) ? table : []) {
              const name = entry?.userData?.clientName;
              if (entry?.clientId && typeof name === 'string' && name.trim()) current.clientNames[entry.clientId] = name.trim();
            }
          } catch {
            // clientsTable не JSON — имена не импортируются
          }
        }
        mode = null;
        buffer = [];
      } else {
        buffer.push(line);
      }
      continue;
    }

    if (line.startsWith('---CONTAINER ')) {
      const [name, image, running] = line.slice('---CONTAINER '.length).split('|');
      current = {
        name,
        image: image || '',
        running: running === 'true',
        confPath: null,
        tool: 'awg',
        managedBy: 'amnezia',
        config: null,
        clientNames: {},
      };
      containers.push(current);
    } else if (current && line.startsWith('---CONF ')) {
      current.confPath = line.slice('---CONF '.length).trim();
      mode = 'conf';
    } else if (current && line.startsWith('---TOOL ')) {
      current.tool = line.includes('awg') ? 'awg' : 'wg';
    } else if (current && line === '---CLIENTS') {
      mode = 'clients';
    } else if (current && line === '---DEMENTIA') {
      current.managedBy = 'demension';
    }
  }
  return containers;
}

export interface NodeInfo {
  awg_go: string | null;
  awg_tools: string | null;
  image: string | null;
  image_created: string | null;
}

/**
 * Разбор вывода команды версий (строки IMAGE / CREATED / GO / TOOLS). Вывод приходит с ноды и показывается в интерфейсе,
 * поэтому берутся только значения строго известного формата.
 */
export function parseNodeInfo(output: string): NodeInfo {
  const line = (key: string) => new RegExp(`^${key} (.*)$`, 'm').exec(output)?.[1]?.trim() ?? '';
  const go = /amneziawg-go\s+v?(\d[\w.+-]{0,40})/.exec(line('GO'))?.[1] ?? null;
  const tools = /(amneziawg-tools|wireguard-tools)\s+v?(\d[\w.+-]{0,40})/.exec(line('TOOLS'));
  const xray = /Xray\s+v?(\d[\w.+-]{0,40})/i.exec(line('XRAY'));
  const image = /^[\w./:@-]{1,200}$/.test(line('IMAGE')) ? line('IMAGE') : null;
  const created = line('CREATED');
  return {
    awg_go: go,
    awg_tools: tools ? `${tools[1]} ${tools[2]}` : (xray ? `Xray ${xray[1]}` : null),
    image,
    image_created: /^\d{4}-\d{2}-\d{2}T/.test(created) && !Number.isNaN(Date.parse(created)) ? new Date(created).toISOString() : null,
  };
}

export interface XrayStatItem {
  email: string;
  uplink: number;
  downlink: number;
}

/**
 * Разбор вывода `xray api statsquery -s 127.0.0.1:10085 -reset`.
 * Вывод ноды — недоверенные данные: строгая фильтрация формата имён user>>><email_or_uuid>>>>traffic>>>uplink|downlink
 * и числовых значений байтов.
 */
export function parseXrayStats(output: string): XrayStatItem[] {
  const map = new Map<string, { uplink: number; downlink: number }>();
  if (!output || typeof output !== 'string') return [];

  const getOrCreate = (email: string) => {
    let entry = map.get(email);
    if (!entry) {
      entry = { uplink: 0, downlink: 0 };
      map.set(email, entry);
    }
    return entry;
  };

  const parseItem = (name: unknown, val: unknown) => {
    if (typeof name !== 'string') return;
    const match = /^user>>>([a-zA-Z0-9_-]{1,64})>>>traffic>>>(uplink|downlink)$/.exec(name.trim());
    if (!match) return;
    const email = match[1];
    const bytes = typeof val === 'number' ? val : parseInt(String(val), 10);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return;

    const entry = getOrCreate(email);
    if (match[2] === 'uplink') {
      entry.uplink += bytes;
    } else {
      entry.downlink += bytes;
    }
  };

  let parsedJson = false;
  try {
    const trimmed = output.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const data = JSON.parse(trimmed);
      const items = Array.isArray(data?.stat) ? data.stat : Array.isArray(data) ? data : null;
      if (items) {
        for (const item of items) {
          parseItem(item?.name, item?.value);
        }
        parsedJson = true;
      }
    }
  } catch {
    // Не JSON — продолжаем разбор регулярным выражением
  }

  if (!parsedJson) {
    const re = /user>>>([a-zA-Z0-9_-]{1,64})>>>traffic>>>(uplink|downlink)[\s":=]+(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      const email = m[1];
      const dir = m[2];
      const bytes = parseInt(m[3], 10);
      if (Number.isSafeInteger(bytes) && bytes > 0) {
        const entry = getOrCreate(email);
        if (dir === 'uplink') entry.uplink += bytes;
        else entry.downlink += bytes;
      }
    }
  }

  return Array.from(map.entries()).map(([email, traffic]) => ({
    email,
    uplink: traffic.uplink,
    downlink: traffic.downlink,
  }));
}

export class ProvisionService {
  static getCredentials(server: any): SshCredentials {
    return {
      host: server.host,
      port: server.ssh_port,
      username: server.ssh_user,
      password: decryptSecret(server.ssh_password),
      privateKey: decryptSecret(server.ssh_key),
      hostKey: server.host_key,
      onNewHostKey: (fingerprint) => {
        db.prepare('UPDATE servers SET host_key = ? WHERE id = ? AND host_key IS NULL').run(fingerprint, server.id);
      },
    };
  }

  /**
   * Клиенты сервера с признаком активности подписчика (выключен/истёк/превышен лимит → 0)
   */
  static getServerClients(serverId: number): any[] {
    // Клиент партнёра активен, пока доступ включён, не приостановлен и нода не отозвана у партнёра
    return db.prepare(`
      SELECT c.*,
        CASE
          WHEN c.owner_blocked = 1 THEN 0
          WHEN c.partner_id IS NOT NULL THEN
            CASE WHEN p.enabled = 1 AND p.suspended = 0 AND pn.server_id IS NOT NULL THEN 1 ELSE 0 END
          WHEN c.subscriber_id IS NULL THEN 1
          WHEN sub.enabled = 1 AND sub.suspended = 0 THEN 1
          ELSE 0
        END AS subscriber_active
      FROM clients c
      LEFT JOIN subscribers sub ON sub.id = c.subscriber_id
      LEFT JOIN partners p ON p.id = c.partner_id
      LEFT JOIN partner_nodes pn ON pn.partner_id = c.partner_id AND pn.server_id = c.server_id
      WHERE c.server_id = ?
    `).all(serverId) as any[];
  }

  static isInstalling(serverId: number): boolean {
    return installing.has(serverId);
  }

  /** Image maintenance shares the node queue and pauses polling during container replacement. */
  static maintainContainer<T>(serverId: number, task: () => Promise<T>): Promise<T> {
    return runExclusive(serverId, async () => {
      if (installing.has(serverId)) throw new Error('Установка уже выполняется');
      installing.add(serverId);
      try { return await task(); } finally { installing.delete(serverId); }
    });
  }

  private static container(server: any) {
    if (nodeProtocol(server) === 'vless') {
      return {
        name: String(server.container_name || XRAY_CONTAINER),
        iface: '',
        confPath: String(server.conf_path || XRAY_CONF_PATH),
        tool: 'xray' as any,
        quick: '',
      };
    }
    const tool = server.awg_tool === 'wg' ? 'wg' : 'awg';
    return {
      name: String(server.container_name || PANEL_CONTAINER),
      iface: String(server.iface || 'awg0'),
      confPath: String(server.conf_path || PANEL_CONF),
      tool,
      quick: `${tool}-quick`,
    };
  }

  /**
   * Команда, атомарно записывающая stdin в конфиг внутри контейнера.
   * Для контейнера панели /opt/amnezia/awg смонтирован с хоста, для контейнера Amnezia — живёт внутри.
   */
  private static writeConfigCommand(credentials: SshCredentials, server: any): string {
    if (nodeProtocol(server) === 'vless') {
      const tmp = `${XRAY_CONF_PATH}.new`;
      return `${SshService.sudo(credentials)}sh -c ${shellQuote(
        `umask 077 && mkdir -p ${XRAY_CONF_DIR} && cat > ${tmp} && chmod 600 ${tmp} && mv -f ${tmp} ${XRAY_CONF_PATH}`
      )}`;
    }
    const c = this.container(server);
    const inner = `umask 077 && cat > ${c.confPath}.new && mv -f ${c.confPath}.new ${c.confPath}`;
    return `${SshService.sudo(credentials)}docker exec -i ${shellQuote(c.name)} sh -c ${shellQuote(inner)}`;
  }

  private static writeHostFileCommand(credentials: SshCredentials, remotePath: string): string {
    const tmp = `${remotePath}.new`;
    return `${SshService.sudo(credentials)}sh -c ${shellQuote(`umask 077 && mkdir -p ${AWG_DIR} && cat > ${tmp} && mv -f ${tmp} ${remotePath}`)}`;
  }

  private static envFileContent(server: any): string {
    return `AWG_NETWORK=${AwgService.getTunnelNetwork(server.subnet)}\nAWG_PORT=${server.awg_port}\n`;
  }

  // ==============================================================================
  // Сканирование ноды и подключение уже установленного AmneziaWG
  // ==============================================================================

  /**
   * Ищет на ноде контейнеры AmneziaWG (панели или приложения Amnezia) и читает их конфигурацию
   */
  static async detectContainers(server: any): Promise<DetectedContainer[]> {
    const script = [
      'command -v docker >/dev/null 2>&1 || exit 0',
      'for c in $(docker ps -a --format "{{.Names}}"); do',
      '  img=$(docker inspect -f "{{.Config.Image}}" "$c" 2>/dev/null)',
      '  case "$c|$img" in *amnezia-awg*|*amneziawg*) ;; *) continue ;; esac',
      '  running=$(docker inspect -f "{{.State.Running}}" "$c" 2>/dev/null)',
      '  echo "---CONTAINER $c|$img|$running"',
      '  [ "$running" = "true" ] || continue',
      `  for f in ${AWG_DIR}/awg0.conf ${AWG_DIR}/wg0.conf; do`,
      '    if docker exec "$c" test -f "$f"; then echo "---CONF $f"; docker exec "$c" cat "$f"; echo; echo "---ENDCONF"; break; fi',
      '  done',
      '  if docker exec "$c" sh -c "command -v awg" >/dev/null 2>&1; then echo "---TOOL awg"; else echo "---TOOL wg"; fi',
      `  if docker exec "$c" test -f ${AWG_DIR}/clientsTable; then echo "---CLIENTS"; docker exec "$c" cat ${AWG_DIR}/clientsTable; echo; echo "---ENDCLIENTS"; fi`,
      // Свой контейнер — только если каталог хоста смонтирован ровно в ${AWG_DIR} (источник и назначение совпадают), как в
      // update-awg.sh: подстрока пути (/opt/amnezia/awg-extra) чужой контейнер своим не делает (инвариант 26)
      `  mnt=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "${AWG_DIR}"}}{{.Source}}{{end}}{{end}}' "$c" 2>/dev/null)`,
      `  if [ "$c" = "${PANEL_CONTAINER}" ] && [ -f ${AWG_DIR}/demension.env ] && [ "$mnt" = "${AWG_DIR}" ]; then echo "---DEMENTIA"; fi`,
      'done',
    ].join('\n');

    const credentials = this.getCredentials(server);
    const result = await SshService.executeCommand(credentials, `${SshService.sudo(credentials)}sh -c ${shellQuote(script)}`, {
      timeoutMs: 60000,
    });
    if (result.code !== 0) {
      const hint = /sudo: a (terminal|password) is required/.test(result.stderr) ? ' (нужен sudo без пароля)' : '';
      throw new Error(`Не удалось просканировать сервер${hint}: ${result.stderr.trim() || `код ${result.code}`}`);
    }
    return parseScanOutput(result.stdout);
  }

  /**
   * Сканирует ноду и, если AmneziaWG уже установлен, подключает его к панели без переустановки
   */
  static async scanAndAdopt(serverId: number): Promise<ScanResult> {
    return runExclusive(serverId, async () => {
      const server = loadLocalServer(serverId);
      if (nodeProtocol(server) === 'vless') {
        return {
          found: false,
          containers: [],
          message: 'Подключение без установки поддерживается только для нод AmneziaWG',
        };
      }
      const detected = await this.detectContainers(server);
      const containers = detected.map((d) => ({ name: d.name, image: d.image, running: d.running, managedBy: d.managedBy }));

      // Предпочтение — контейнеру панели, затем любому работающему с конфигурацией
      const candidates = detected.filter((d) => d.running && d.config);
      const target = candidates.find((d) => d.managedBy === 'demension') || candidates[0];
      if (!target) {
        const stopped = detected.filter((d) => !d.running).map((d) => d.name);
        return {
          found: false,
          containers,
          message: stopped.length
            ? `Найдены остановленные контейнеры AmneziaWG (${stopped.join(', ')}) — требуется установка`
            : 'AmneziaWG на сервере не найден — требуется установка',
        };
      }

      let parsed: ParsedServerConfig;
      try {
        parsed = parseServerConfig(target.config as string);
      } catch (err: any) {
        return { found: false, containers, message: `Контейнер ${target.name} найден, но его конфигурацию не удалось разобрать: ${err.message}` };
      }

      const adopted = this.adoptConfig(server, target, parsed);
      const others = candidates.filter((c) => c !== target).map((c) => c.name);
      const owner = target.managedBy === 'amnezia' ? 'приложения Amnezia' : 'панели';
      return {
        found: true,
        containers,
        adopted,
        message:
          `Найден работающий AmneziaWG ${owner} (контейнер ${target.name}). Сервер подключён без переустановки, ` +
          `импортировано клиентов: ${adopted.importedPeers}.` +
          (others.length ? ` Другие контейнеры AmneziaWG на сервере: ${others.join(', ')}.` : ''),
      };
    });
  }

  private static adoptConfig(server: any, target: DetectedContainer, parsed: ParsedServerConfig): NonNullable<ScanResult['adopted']> {
    // Подсеть Amnezia задаётся адресом сети (10.8.1.0/24) — проверяем мягко
    parseSubnet(parsed.address, false);
    const iface = path.basename(target.confPath as string, '.conf');
    const publicKey = AwgService.derivePublicKey(parsed.privateKey);
    const serverPsk = parsed.peers.find((p) => p.presharedKey)?.presharedKey || server.preshared_key;
    // Сканирование долго ждёт SSH: за это время могли выдать архив переноса. Запись после снимка потерялась бы (инвариант 30)
    if (MigrationService.isBackgroundPaused()) {
      throw new HttpError(423, 'Идёт перенос панели на другой сервер: результат сканирования не сохранён. Завершите или отмените перенос.');
    }
    const columns = paramsToColumns(parsed.params);
    // Параметры берутся с ноды: прежняя база отката больше не соответствует ей
    appliedBaseline.delete(server.id);

    let imported = 0;
    let skipped = 0;
    transaction(() => {
      const assignments = Object.keys(columns).map((k) => `${k} = ?`).join(', ');
      db.prepare(`
        UPDATE servers SET ${assignments},
          awg_port = ?, deployed_port = ?, subnet = ?, server_private_key = ?, server_public_key = ?, preshared_key = ?,
          container_name = ?, iface = ?, conf_path = ?, awg_tool = ?, managed_by = ?,
          status = 'online', needs_sync = 0, needs_apply = 0, fail_count = 0, last_error = NULL, last_seen = datetime('now'), node_info_at = NULL
        WHERE id = ?
      `).run(
        ...(Object.values(columns) as any[]),
        parsed.listenPort, parsed.listenPort, parsed.address, parsed.privateKey, publicKey, serverPsk,
        target.name, iface, target.confPath, target.tool, target.managedBy,
        server.id
      );

      const existing = db.prepare('SELECT client_public_key, client_ip FROM clients WHERE server_id = ?').all(server.id) as any[];
      const knownKeys = new Set(existing.map((c) => c.client_public_key));
      const usedIps = new Set(existing.map((c) => c.client_ip));
      const insert = db.prepare(`
        INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key, preshared_key, enabled, external)
        VALUES (?, ?, ?, ?, '', ?, 1, 1)
      `);
      for (const peer of parsed.peers) {
        if (knownKeys.has(peer.publicKey)) continue;
        if (!peer.ip || usedIps.has(peer.ip)) {
          skipped++;
          continue;
        }
        const name = target.clientNames[peer.publicKey] || `Импорт ${peer.ip}`;
        insert.run(server.id, name.slice(0, 64), peer.ip, peer.publicKey, peer.presharedKey);
        knownKeys.add(peer.publicKey);
        usedIps.add(peer.ip);
        imported++;
      }
    });

    return {
      container: target.name,
      managedBy: target.managedBy,
      awgVersion: parsed.params.awg_version,
      port: parsed.listenPort,
      subnet: parsed.address,
      importedPeers: imported,
      skippedPeers: skipped,
    };
  }

  // ==============================================================================
  // Установка
  // ==============================================================================

  /**
   * Run remote AmneziaWG installation via Docker and configure firewall & interface
   */
  static async installServer(serverId: number, onLog?: (chunk: string) => void): Promise<OperationResult> {
    const server = loadLocalServer(serverId);
    if (installing.has(serverId)) {
      throw new Error('Установка этого сервера уже выполняется');
    }
    installing.add(serverId);
    pendingSync.delete(serverId);

    try {
      return await runExclusive(serverId, () => this.doInstall(server.id, onLog));
    } finally {
      installing.delete(serverId);
    }
  }

  /**
   * Контейнер AmneziaWG приложения Amnezia, который установка панели уничтожила бы: скрипт развёртывания удаляет контейнер
   * с именем amnezia-awg (имя совпадает с контейнером приложения), а конфигурация и клиенты Amnezia лежат внутри контейнера.
   * Контейнер, уже подключённый к этому серверу (managed_by = amnezia), заменять можно — его клиенты хранятся в БД панели.
   * Занятый тем же UDP-портом контейнер тоже мешает: после удаления своего контейнера docker run упал бы на порту.
   */
  static async findForeignContainer(server: any): Promise<DetectedContainer | null> {
    const adopted = server.managed_by === 'amnezia' ? String(server.container_name) : null;
    for (const container of await this.detectContainers(server)) {
      if (container.managedBy !== 'amnezia' || container.name === adopted) continue;
      const port = Number(/^\s*ListenPort\s*=\s*(\d+)/im.exec(container.config ?? '')?.[1]);
      if (container.name === PANEL_CONTAINER || port === Number(server.awg_port)) return container;
    }
    return null;
  }

  private static async doInstall(serverId: number, onLog?: (chunk: string) => void): Promise<OperationResult> {
    const server = loadServer(serverId);
    const log = (text: string) => onLog?.(text);
    if (nodeProtocol(server) === 'vless') {
      return this.doInstallVless(serverId, server, onLog);
    }

    // Проверка до любых изменений: чужой контейнер не трогаем, статус сервера не меняется
    try {
      const foreign = await this.findForeignContainer(server);
      if (foreign) {
        const error =
          `На сервере уже работает AmneziaWG приложения Amnezia (контейнер ${foreign.name}). Установка удалила бы его вместе с клиентами. ` +
          'Нажмите «Сканировать», чтобы подключить его без переустановки, либо удалите контейнер вручную, если он не нужен.';
        log(`\r\n❌ Ошибка: ${error}\r\n`);
        return { success: false, error };
      }
    } catch (err: any) {
      db.prepare("UPDATE servers SET status = 'error', last_error = ? WHERE id = ?").run(err.message, serverId);
      log(`\r\n❌ Ошибка: ${err.message}\r\n`);
      return { success: false, error: err.message };
    }

    db.prepare("UPDATE servers SET status = 'installing', last_error = NULL WHERE id = ?").run(serverId);
    log(`=== Запуск установки AmneziaWG на ${server.name} (${server.host}) ===\r\n`);

    try {
      let privKey = server.server_private_key;
      let psk = server.preshared_key;
      if (!privKey) {
        privKey = AwgService.generateKeyPair().privateKey;
      }
      if (!psk) {
        psk = AwgService.generatePresharedKey();
      }
      const pubKey = AwgService.derivePublicKey(privKey);
      const fullServer = { ...server, server_private_key: privKey, server_public_key: pubKey, preshared_key: psk };

      // Ранее подключённый чужой контейнер (например, приложения Amnezia) заменяется контейнером панели —
      // ключи, параметры и клиенты переносятся из БД, поэтому выданные конфигурации продолжают работать
      const replaceContainer =
        server.container_name && server.container_name !== PANEL_CONTAINER ? String(server.container_name) : '';
      if (replaceContainer) log(`Контейнер ${replaceContainer} будет заменён контейнером панели ${PANEL_CONTAINER}\r\n`);

      const conf = AwgService.generateServerConfig(fullServer, this.getServerClients(serverId));
      const script = [
        `export AWG_PORT=${shellQuote(server.awg_port)}`,
        `export AWG_NETWORK=${shellQuote(AwgService.getTunnelNetwork(server.subnet))}`,
        `export AWG_CONF_B64=${shellQuote(Buffer.from(conf).toString('base64'))}`,
        `export AWG_IMAGE=${shellQuote(AWG_IMAGE)}`,
        `export REPLACE_CONTAINER=${shellQuote(replaceContainer)}`,
        readDeployScript(),
      ].join('\n');

      const credentials = this.getCredentials(server);
      log('Подключение по SSH и запуск скрипта развертывания...\r\n');

      // Скрипт передаётся через stdin и не сохраняется на диске ноды.
      // PANEL_IP (адрес, с которого подключилась панель) добавляется в ignoreip fail2ban,
      // чтобы панель не заблокировала сама себя.
      const result = await SshService.executeCommand(
        credentials,
        `${SshService.sudo(credentials)}env PANEL_IP="\${SSH_CLIENT%% *}" bash -c 'script=$(cat); exec bash -c "$script" deploy-awg'`,
        { input: script, onData: log, timeoutMs: 20 * 60 * 1000 }
      );

      if (result.code !== 0) {
        const hint = /sudo: a (terminal|password) is required/.test(result.stderr)
          ? ' Пользователю нужен sudo без пароля (NOPASSWD) или используйте root.'
          : '';
        throw new Error(`Скрипт завершился с кодом ошибки ${result.code}.${hint}`);
      }
      if (!result.stdout.includes('---DEMENTIA_OK---')) {
        throw new Error('Скрипт не подтвердил успешный запуск AmneziaWG');
      }

      db.prepare(`
        UPDATE servers
        SET status = 'online',
            server_public_key = ?,
            server_private_key = ?,
            preshared_key = ?,
            deployed_port = awg_port,
            container_name = ?,
            iface = 'awg0',
            conf_path = ?,
            awg_tool = 'awg',
            managed_by = 'demension',
            needs_sync = 0,
            needs_apply = 0,
            fail_count = 0,
            last_error = NULL,
            last_seen = datetime('now'),
            node_info_at = NULL
        WHERE id = ?
      `).run(pubKey, privKey, psk, PANEL_CONTAINER, PANEL_CONF, serverId);

      // После установки на ноде ровно то, что в БД: это новая база для отката неудачных правок
      appliedBaseline.set(serverId, { ...(db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any) });
      log('\r\n=== AmneziaWG успешно установлен и готов к работе! ===\r\n');
      EventService.log('info', 'server.installed', `AmneziaWG установлен на ноде «${server.name}»`, { kind: 'server', id: serverId });
      return { success: true };
    } catch (err: any) {
      db.prepare("UPDATE servers SET status = 'error', last_error = ? WHERE id = ?").run(err.message, serverId);
      EventService.log('error', 'server.install_failed', `Не удалось установить ноду «${server.name}»: ${err.message}`, { kind: 'server', id: serverId });
      log(`\r\n❌ Ошибка: ${err.message}\r\n`);
      return { success: false, error: err.message };
    }
  }

  private static async doInstallVless(serverId: number, server: any, onLog?: (chunk: string) => void): Promise<OperationResult> {
    const log = (text: string) => onLog?.(text);
    const port = Number(server.awg_port || DEFAULT_VLESS_PORT);
    const credentials = this.getCredentials(server);

    // Проверка до любых изменений: если на TCP-порту уже слушает кто-то, кроме нашего контейнера, — ошибка
    try {
      const checkScript = [
        `port=${shellQuote(port)}`,
        `c=${shellQuote(XRAY_CONTAINER)}`,
        `marker=${shellQuote(`${XRAY_CONF_DIR}/dementia.env`)}`,
        'if docker ps -a --format "{{.Names}}" 2>/dev/null | grep -Eq "^${c}\$"; then',
        '  if [ ! -f "$marker" ]; then echo "FOREIGN_CONTAINER"; exit 0; fi',
        'fi',
        'listening=0',
        'if command -v ss >/dev/null 2>&1; then',
        '  if ss -tln 2>/dev/null | grep -Eq "[: ]${port}\\b"; then listening=1; fi',
        'elif command -v netstat >/dev/null 2>&1; then',
        '  if netstat -tln 2>/dev/null | grep -Eq "[: ]${port}\\b"; then listening=1; fi',
        'elif (echo > "/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1; then',
        '  listening=1',
        'fi',
        'if [ "$listening" -eq 0 ]; then echo "OK"; exit 0; fi',
        'if [ -f "$marker" ] && [ "$(docker inspect -f \'{{.State.Running}}\' "$c" 2>/dev/null)" = "true" ]; then',
        '  echo "OK"; exit 0',
        'fi',
        'echo "PORT_IN_USE"',
      ].join('\n');

      const check = await SshService.executeCommand(
        credentials,
        `${SshService.sudo(credentials)}sh -c ${shellQuote(checkScript)}`,
        { timeoutMs: 30000 }
      );
      if (check.code !== 0) {
        const hint = /sudo: a (terminal|password) is required/.test(check.stderr) ? ' (нужен sudo без пароля)' : '';
        throw new Error(`Не удалось проверить сервер${hint}: ${check.stderr.trim() || `код ${check.code}`}`);
      }
      if (check.stdout.includes('FOREIGN_CONTAINER')) {
        const error = `На сервере уже существует контейнер ${XRAY_CONTAINER}, но он не принадлежит панели. Удалите его вручную перед установкой.`;
        log(`\r\n❌ Ошибка: ${error}\r\n`);
        return { success: false, error };
      }
      if (check.stdout.includes('PORT_IN_USE')) {
        const error = `TCP-порт ${port} уже занят другой службой или контейнером на сервере. Освободите порт перед установкой.`;
        log(`\r\n❌ Ошибка: ${error}\r\n`);
        return { success: false, error };
      }
    } catch (err: any) {
      db.prepare("UPDATE servers SET status = 'error', last_error = ? WHERE id = ?").run(err.message, serverId);
      log(`\r\n❌ Ошибка: ${err.message}\r\n`);
      return { success: false, error: err.message };
    }

    db.prepare("UPDATE servers SET status = 'installing', last_error = NULL WHERE id = ?").run(serverId);
    log(`=== Запуск установки Xray (VLESS) на ${server.name} (${server.host}) ===\r\n`);

    try {
      let privKey = server.server_private_key;
      let pubKey = server.server_public_key;
      if (!privKey) {
        const pair = AwgService.generateKeyPair();
        privKey = pair.privateKey;
        pubKey = pair.publicKey;
      } else if (!pubKey) {
        pubKey = AwgService.derivePublicKey(privKey);
      }

      const params = (!server.reality_sni || !server.reality_dest || !server.reality_short_ids)
        ? generateVlessParams()
        : vlessParamsFromRow(server);

      const fullServer = {
        ...server,
        server_private_key: privKey,
        server_public_key: pubKey,
        awg_port: port,
        ...params,
      };

      const conf = XrayService.generateServerConfig(fullServer, this.getServerClients(serverId));
      const script = [
        `export VLESS_PORT=${shellQuote(port)}`,
        `export XRAY_CONF_B64=${shellQuote(Buffer.from(conf).toString('base64'))}`,
        `export XRAY_IMAGE=${shellQuote(XRAY_IMAGE)}`,
        `export XRAY_CONTAINER=${shellQuote(XRAY_CONTAINER)}`,
        `export XRAY_CONF_DIR=${shellQuote(XRAY_CONF_DIR)}`,
        readDeployXrayScript(),
      ].join('\n');

      log('Подключение по SSH и запуск скрипта развертывания Xray...\r\n');
      const result = await SshService.executeCommand(
        credentials,
        `${SshService.sudo(credentials)}env PANEL_IP="\${SSH_CLIENT%% *}" bash -c 'script=$(cat); exec bash -c "$script" deploy-xray'`,
        { input: script, onData: log, timeoutMs: 20 * 60 * 1000 }
      );

      if (result.code !== 0) {
        const hint = /sudo: a (terminal|password) is required/.test(result.stderr)
          ? ' Пользователю нужен sudo без пароля (NOPASSWD) или используйте root.'
          : '';
        throw new Error(`Скрипт завершился с кодом ошибки ${result.code}.${hint}`);
      }
      if (!result.stdout.includes('---DEMENTIA_OK---')) {
        throw new Error('Скрипт не подтвердил успешный запуск Xray');
      }

      db.prepare(`
        UPDATE servers
        SET status = 'online',
            server_public_key = ?,
            server_private_key = ?,
            awg_port = ?,
            deployed_port = ?,
            container_name = ?,
            conf_path = ?,
            managed_by = 'demension',
            reality_sni = ?,
            reality_dest = ?,
            reality_short_ids = ?,
            xray_flow = ?,
            xray_fingerprint = ?,
            needs_sync = 0,
            needs_apply = 0,
            fail_count = 0,
            last_error = NULL,
            last_seen = datetime('now'),
            node_info_at = NULL
        WHERE id = ?
      `).run(
        pubKey,
        privKey,
        port,
        port,
        XRAY_CONTAINER,
        XRAY_CONF_PATH,
        params.reality_sni,
        params.reality_dest,
        JSON.stringify(params.reality_short_ids),
        params.xray_flow,
        params.xray_fingerprint,
        serverId
      );

      appliedBaseline.set(serverId, { ...(db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any) });
      log('\r\n=== Xray (VLESS) успешно установлен и готов к работе! ===\r\n');
      EventService.log('info', 'server.installed', `Xray (VLESS) установлен на ноде «${server.name}»`, { kind: 'server', id: serverId });
      return { success: true };
    } catch (err: any) {
      db.prepare("UPDATE servers SET status = 'error', last_error = ? WHERE id = ?").run(err.message, serverId);
      EventService.log('error', 'server.install_failed', `Не удалось установить Xray на ноду «${server.name}»: ${err.message}`, { kind: 'server', id: serverId });
      log(`\r\n❌ Ошибка: ${err.message}\r\n`);
      return { success: false, error: err.message };
    }
  }

  // ==============================================================================
  // Синхронизация пиров и применение параметров
  // ==============================================================================

  /**
   * Запросить синхронизацию пиров. Повторные запросы до начала выполнения объединяются.
   * При недоступности ноды флаг needs_sync остаётся, и фоновая задача повторит попытку.
   */
  static requestSync(serverId: number): Promise<OperationResult> {
    // Клиенты на нодах партнёра создаются и меняются через API панели владельца
    const remotePanelId = remotePanelOf(serverId);
    if (remotePanelId) {
      return FederationClient.requestSync(remotePanelId).then(() => {
        const panel = db.prepare('SELECT status, last_error FROM remote_panels WHERE id = ?').get(remotePanelId) as any;
        return panel?.status === 'online' && !panel.last_error
          ? { success: true }
          : { success: false, error: panel?.last_error || 'Панель партнёра недоступна' };
      });
    }
    db.prepare('UPDATE servers SET needs_sync = 1 WHERE id = ?').run(serverId);
    const existing = pendingSync.get(serverId);
    if (existing) return existing;

    const promise = runExclusive(serverId, async () => {
      pendingSync.delete(serverId);
      return this.doSync(serverId);
    });
    pendingSync.set(serverId, promise);
    return promise;
  }

  /**
   * Синхронно дождаться синхронизации (для ручной кнопки в UI)
   */
  static async syncPeers(serverId: number): Promise<OperationResult> {
    return this.requestSync(serverId);
  }

  private static async doSync(serverId: number): Promise<OperationResult> {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    if (!server) return { success: false, error: 'Сервер удалён' };
    if (installing.has(serverId) || server.status === 'uninstalled' || server.status === 'installing') {
      return { success: false, error: 'Сервер не установлен' };
    }
    if (server.needs_apply) {
      return this.doApply(serverId);
    }
    if (nodeProtocol(server) === 'vless') {
      return this.doSyncVless(serverId, server);
    }

    try {
      const conf = AwgService.generateServerConfig(server, this.getServerClients(serverId));
      const credentials = this.getCredentials(server);
      const c = this.container(server);
      const command = [
        this.writeConfigCommand(credentials, server),
        `${SshService.sudo(credentials)}docker exec ${shellQuote(c.name)} sh -c ${shellQuote(
          `umask 077; ${c.quick} strip ${c.confPath} > /tmp/awg.stripped && ${c.tool} syncconf ${c.iface} /tmp/awg.stripped; rc=$?; rm -f /tmp/awg.stripped; exit $rc`
        )}`,
      ].join(' && ');

      const result = await SshService.executeCommand(credentials, command, { input: conf, timeoutMs: 60000 });
      if (result.code !== 0) {
        throw new Error(`Ошибка синхронизации конфигурации: ${result.stderr.trim() || `код ${result.code}`}`);
      }
      db.prepare('UPDATE servers SET needs_sync = 0, last_error = NULL WHERE id = ?').run(serverId);
      return { success: true };
    } catch (err: any) {
      db.prepare('UPDATE servers SET last_error = ? WHERE id = ?').run(err.message, serverId);
      return { success: false, error: err.message };
    }
  }

  private static async doSyncVless(serverId: number, server: any): Promise<OperationResult> {
    try {
      const conf = XrayService.generateServerConfig(server, this.getServerClients(serverId));
      const credentials = this.getCredentials(server);
      const c = this.container(server);
      const writeCmd = this.writeConfigCommand(credentials, server);
      const restartCmd = `${SshService.sudo(credentials)}docker restart ${shellQuote(c.name)}`;
      const command = `${writeCmd} && ${restartCmd}`;

      const result = await SshService.executeCommand(credentials, command, { input: conf, timeoutMs: 60000 });
      if (result.code !== 0) {
        throw new Error(`Ошибка синхронизации конфигурации: ${result.stderr.trim() || `код ${result.code}`}`);
      }
      db.prepare('UPDATE servers SET needs_sync = 0, last_error = NULL WHERE id = ?').run(serverId);
      return { success: true };
    } catch (err: any) {
      db.prepare('UPDATE servers SET last_error = ? WHERE id = ?').run(err.message, serverId);
      return { success: false, error: err.message };
    }
  }

  /**
   * Применить параметры интерфейса (обфускация) — требует перезапуска интерфейса.
   * Смена порта или подсети требует пересоздания контейнера (переустановка контейнером панели).
   */
  static requestApply(serverId: number): Promise<OperationResult> {
    if (remotePanelOf(serverId)) return Promise.resolve({ success: false, error: REMOTE_NODE_ERROR });
    db.prepare('UPDATE servers SET needs_apply = 1 WHERE id = ?').run(serverId);
    // Повторные запросы до начала применения объединяются: doApply читает актуальные параметры из БД
    const existing = pendingApply.get(serverId);
    if (existing) return existing;

    const promise = runExclusive(serverId, async () => {
      pendingApply.delete(serverId);
      return this.doApply(serverId);
    });
    pendingApply.set(serverId, promise);
    return promise;
  }

  /**
   * Переустановка с актуальным образом (обновление AmneziaWG или переход на новую версию протокола)
   */
  static requestReinstall(serverId: number): Promise<OperationResult> {
    if (remotePanelOf(serverId)) return Promise.resolve({ success: false, error: REMOTE_NODE_ERROR });
    if (installing.has(serverId)) return Promise.resolve({ success: false, error: 'Установка уже выполняется' });
    installing.add(serverId);
    return runExclusive(serverId, () => this.doInstall(serverId)).finally(() => installing.delete(serverId));
  }

  private static async doApply(serverId: number): Promise<OperationResult> {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    if (!server) return { success: false, error: 'Сервер удалён' };
    if (installing.has(serverId) || server.status === 'uninstalled' || server.status === 'installing') {
      return { success: false, error: 'Сервер не установлен' };
    }

    // Порт проброшен при создании контейнера; NAT контейнера Amnezia настроен на исходную подсеть
    if (server.deployed_port !== server.awg_port) {
      return this.doInstall(serverId);
    }
    if (nodeProtocol(server) === 'vless') {
      return this.doApplyVless(serverId, server);
    }

    try {
      const conf = AwgService.generateServerConfig(server, this.getServerClients(serverId));
      const credentials = this.getCredentials(server);
      const c = this.container(server);

      if (server.managed_by === 'demension') {
        const env = await SshService.executeCommand(credentials, this.writeHostFileCommand(credentials, `${AWG_DIR}/demension.env`), {
          input: this.envFileContent(server),
          timeoutMs: 60000,
        });
        if (env.code !== 0) throw new Error(env.stderr.trim() || `код ${env.code}`);
      }

      const result = await SshService.executeCommand(
        credentials,
        `${this.writeConfigCommand(credentials, server)} && ${SshService.sudo(credentials)}docker restart ${shellQuote(c.name)}`,
        { input: conf, timeoutMs: 120000 }
      );
      if (result.code !== 0) {
        throw new Error(`Ошибка применения параметров: ${result.stderr.trim() || `код ${result.code}`}`);
      }
      db.prepare('UPDATE servers SET needs_apply = 0, needs_sync = 0, last_error = NULL WHERE id = ?').run(serverId);
      appliedBaseline.set(serverId, { ...server });
      return { success: true };
    } catch (err: any) {
      db.prepare('UPDATE servers SET last_error = ? WHERE id = ?').run(err.message, serverId);
      return { success: false, error: err.message };
    }
  }

  private static async doApplyVless(serverId: number, server: any): Promise<OperationResult> {
    try {
      const conf = XrayService.generateServerConfig(server, this.getServerClients(serverId));
      const credentials = this.getCredentials(server);
      const c = this.container(server);
      const writeCmd = this.writeConfigCommand(credentials, server);
      const restartCmd = `${SshService.sudo(credentials)}docker restart ${shellQuote(c.name)}`;
      const command = `${writeCmd} && ${restartCmd}`;

      const result = await SshService.executeCommand(credentials, command, { input: conf, timeoutMs: 120000 });
      if (result.code !== 0) {
        throw new Error(`Ошибка применения параметров: ${result.stderr.trim() || `код ${result.code}`}`);
      }
      db.prepare('UPDATE servers SET needs_apply = 0, needs_sync = 0, last_error = NULL WHERE id = ?').run(serverId);
      appliedBaseline.set(serverId, { ...server });
      return { success: true };
    } catch (err: any) {
      db.prepare('UPDATE servers SET last_error = ? WHERE id = ?').run(err.message, serverId);
      return { success: false, error: err.message };
    }
  }

  /** Запоминает работающие на ноде параметры перед первой правкой (если неприменённых изменений нет) */
  static noteAppliedBaseline(server: any): void {
    if (!appliedBaseline.has(server.id) && !server.needs_apply) appliedBaseline.set(server.id, { ...server });
  }

  /** Значения, к которым откатывать неудачное применение; undefined — неизвестно (тогда откат к значению запроса) */
  static appliedBaselineOf(serverId: number): Record<string, unknown> | undefined {
    return appliedBaseline.get(serverId);
  }

  /**
   * Остановить и удалить контейнер AmneziaWG или Xray на ноде
   */
  static async teardown(serverId: number): Promise<OperationResult> {
    return runExclusive(serverId, async () => {
      const server = loadLocalServer(serverId);
      try {
        const credentials = this.getCredentials(server);
        if (nodeProtocol(server) === 'vless') {
          const marker = `${XRAY_CONF_DIR}/dementia.env`;
          const cName = server.container_name || XRAY_CONTAINER;
          const cmd = `docker rm -f ${shellQuote(cName)} >/dev/null 2>&1; if [ -f ${shellQuote(marker)} ]; then rm -rf ${shellQuote(XRAY_CONF_DIR)}; fi; echo done`;
          const result = await SshService.executeCommand(
            credentials,
            `${SshService.sudo(credentials)}sh -c ${shellQuote(cmd)}`,
            { timeoutMs: 120000 }
          );
          if (result.code !== 0) throw new Error(result.stderr.trim() || `код ${result.code}`);
          return { success: true };
        }
        const c = this.container(server);
        const cleanup = server.managed_by === 'demension' ? `; rm -rf ${AWG_DIR}` : '';
        // Заглушка проверки доступности удаляется вместе с AmneziaWG
        const result = await SshService.executeCommand(
          credentials,
          `${SshService.sudo(credentials)}sh -c ${shellQuote(`docker rm -f ${c.name} >/dev/null 2>&1${cleanup}; ${stubRemoveScript()}; echo done`)}`,
          { timeoutMs: 120000 }
        );
        if (result.code !== 0) throw new Error(result.stderr.trim() || `код ${result.code}`);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });
  }

  // ==============================================================================
  // Заглушка проверки доступности (docs/probes.md)
  // ==============================================================================

  /**
   * Ставит (или переставляет) заглушку dementia-probe на ноду и запоминает её порт. Порт меняется, только если прежний
   * занят. Контейнер AmneziaWG не затрагивается. Возвращает порт.
   */
  static ensureProbeStub(serverId: number): Promise<number> {
    return runExclusive(serverId, async () => {
      const server = loadLocalServer(serverId);
      if (nodeProtocol(server) === 'vless') {
        throw new Error('Проверки доступности не поддерживаются для VLESS-нод');
      }
      if (server.status === 'uninstalled' || server.status === 'installing' || installing.has(serverId)) {
        throw new Error('Сервер не установлен');
      }
      const token = server.stub_token || newStubToken();
      const exclude = [server.awg_port, server.ssh_port, server.deployed_port].map(Number).filter(Number.isInteger);
      const script = stubInstallScript(stubPortCandidates(exclude, server.stub_port ?? null), token);
      const credentials = this.getCredentials(server);
      const result = await SshService.executeCommand(credentials, `${SshService.sudo(credentials)}sh -c ${shellQuote(script)}`, {
        timeoutMs: 180000,
      });
      const port = result.code === 0 ? parseStubPort(result.stdout) : null;
      if (!port) {
        const detail = result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        throw new Error(`Не удалось запустить заглушку проверки: ${detail || `код ${result.code}`}`);
      }
      db.prepare('UPDATE servers SET stub_port = ?, stub_token = ? WHERE id = ?').run(port, token, serverId);
      return port;
    });
  }

  /**
   * Журнал обращений к заглушке. Если её контейнер пропал (переустановка системы, ручное удаление), порт сбрасывается —
   * при следующей проверке заглушка поставится заново.
   */
  static readProbeHits(serverId: number): Promise<StubHit[]> {
    return runExclusive(serverId, async () => {
      const server = loadLocalServer(serverId);
      if (nodeProtocol(server) === 'vless') {
        throw new Error('Проверки доступности не поддерживаются для VLESS-нод');
      }
      const credentials = this.getCredentials(server);
      const result = await SshService.executeCommand(credentials, `${SshService.sudo(credentials)}sh -c ${shellQuote(stubReadScript())}`, {
        timeoutMs: 30000,
      });
      if (result.code !== 0) throw new Error(result.stderr.trim() || `код ${result.code}`);
      const parsed = parseStubHits(result.stdout);
      if (!parsed.running) {
        db.prepare('UPDATE servers SET stub_port = NULL WHERE id = ?').run(serverId);
        throw new Error('заглушка проверки на ноде не запущена и будет установлена заново');
      }
      return parsed.hits;
    });
  }

  // ==============================================================================
  // Мониторинг
  // ==============================================================================

  /**
   * Poll live interface stats (rx/tx, handshake), accumulate traffic and update server status
   */
  static async fetchServerStats(serverId: number): Promise<void> {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    if (!server || server.remote_panel_id || server.status === 'uninstalled' || server.status === 'installing' || installing.has(serverId)) return;

    try {
      const credentials = this.getCredentials(server);
      const isVless = nodeProtocol(server) === 'vless';
      const c = this.container(server);

      if (isVless) {
        const result = await SshService.executeCommand(
          credentials,
          `${SshService.sudo(credentials)}docker exec ${shellQuote(c.name)} xray api statsquery -s 127.0.0.1:10085 -reset`,
          { timeoutMs: 30000 }
        );
        if (result.code !== 0) {
          throw new Error(`Xray statsquery недоступен: ${result.stderr.trim() || `код ${result.code}`}`);
        }
        this.applyXrayStats(serverId, result.stdout);
      } else {
        const result = await SshService.executeCommand(
          credentials,
          `${SshService.sudo(credentials)}docker exec ${shellQuote(c.name)} ${c.tool} show ${c.iface} dump`,
          { timeoutMs: 30000 }
        );
        if (result.code !== 0) {
          throw new Error(`Интерфейс ${c.iface} недоступен: ${result.stderr.trim() || `код ${result.code}`}`);
        }

        this.applyDump(serverId, result.stdout);
      }

      const wasOnline = server.status === 'online';
      db.prepare(`
        UPDATE servers SET status = 'online', fail_count = 0, last_seen = datetime('now'),
          last_error = CASE WHEN needs_sync = 0 AND needs_apply = 0 THEN NULL ELSE last_error END
        WHERE id = ?
      `).run(serverId);
      if (!wasOnline) EventService.log('info', 'server.online', `Нода «${server.name}» снова доступна`, { kind: 'server', id: serverId });

      const infoAge = server.node_info_at ? Date.now() - Date.parse(server.node_info_at) : Infinity;
      if (!(infoAge < NODE_INFO_TTL_MS)) await this.fetchNodeInfo(server);

      const fresh = db.prepare('SELECT needs_sync, needs_apply FROM servers WHERE id = ?').get(serverId) as any;
      if (fresh?.needs_apply) {
        this.requestApply(serverId).catch(() => {});
      } else if (fresh?.needs_sync || !wasOnline) {
        this.requestSync(serverId).catch(() => {});
      }
    } catch (err: any) {
      if (err instanceof HostKeyMismatchError) {
        db.prepare("UPDATE servers SET status = 'error', last_error = ? WHERE id = ?").run(err.message, serverId);
        return;
      }
      db.prepare(`
        UPDATE servers SET fail_count = fail_count + 1, last_error = ?,
          status = CASE WHEN fail_count + 1 >= ? THEN 'offline' ELSE status END
        WHERE id = ?
      `).run(err.message, OFFLINE_THRESHOLD, serverId);
      if (server.status !== 'offline' && server.fail_count + 1 >= OFFLINE_THRESHOLD) {
        EventService.log('error', 'server.offline', `Нода «${server.name}» недоступна: ${err.message}`, { kind: 'server', id: serverId });
      }
    }
  }

  /**
   * Версии ПО на ноде: для AWG — amneziawg-go и awg/wg, для VLESS — xray version, а также образ с датой сборки.
   * Только чтение; ошибка не влияет на статус ноды (версии останутся прежними, повтор — при следующем опросе).
   */
  static async fetchNodeInfo(server: any): Promise<void> {
    const c = this.container(server);
    const isVless = nodeProtocol(server) === 'vless';
    const script = isVless
      ? [
          `c=${shellQuote(c.name)}`,
          'echo "IMAGE $(docker inspect -f "{{.Config.Image}}" "$c" 2>/dev/null)"',
          'echo "CREATED $(docker image inspect -f "{{.Created}}" "$(docker inspect -f "{{.Image}}" "$c" 2>/dev/null)" 2>/dev/null)"',
          `echo "XRAY $(docker exec "$c" sh -c 'xray version 2>/dev/null | head -n 1')"`,
        ].join('\n')
      : [
          `c=${shellQuote(c.name)}`,
          'echo "IMAGE $(docker inspect -f "{{.Config.Image}}" "$c" 2>/dev/null)"',
          'echo "CREATED $(docker image inspect -f "{{.Created}}" "$(docker inspect -f "{{.Image}}" "$c" 2>/dev/null)" 2>/dev/null)"',
          `echo "GO $(docker exec "$c" sh -c 'amneziawg-go --version 2>/dev/null | head -n 1')"`,
          `echo "TOOLS $(docker exec "$c" sh -c 'awg --version 2>/dev/null || wg --version 2>/dev/null' | head -n 1)"`,
        ].join('\n');
    try {
      const credentials = this.getCredentials(server);
      const result = await SshService.executeCommand(credentials, `${SshService.sudo(credentials)}sh -c ${shellQuote(script)}`, {
        timeoutMs: 30000,
      });
      if (result.code !== 0) return;
      const info = parseNodeInfo(result.stdout);
      db.prepare(`
        UPDATE servers SET node_awg_go = ?, node_awg_tools = ?, node_image = ?, node_image_created = ?, node_info_at = ?
        WHERE id = ?
      `).run(info.awg_go, info.awg_tools, info.image, info.image_created, new Date().toISOString(), server.id);
    } catch {
      // нода могла стать недоступной между запросами — версии перечитаются позже
    }
  }

  /**
   * Разбор вывода `xray api statsquery` с накоплением трафика.
   * Вызов с флагом -reset сбрасывает счётчики в памяти Xray, поэтому полученные значения — дельта.
   * uplink = отправлено клиентом (total_rx), downlink = получено клиентом (total_tx).
   */
  static applyXrayStats(serverId: number, output: string): void {
    const stats = parseXrayStats(output);
    if (stats.length === 0) return;

    const selectById = db.prepare('SELECT id FROM clients WHERE id = ? AND server_id = ?');
    const selectByUuid = db.prepare('SELECT id FROM clients WHERE client_uuid = ? AND server_id = ?');
    const update = db.prepare(`
      UPDATE clients
      SET total_rx = total_rx + ?,
          total_tx = total_tx + ?,
          last_handshake = CASE WHEN (? > 0 OR ? > 0) THEN ? ELSE last_handshake END
      WHERE id = ?
    `);

    const now = new Date().toISOString();

    transaction(() => {
      for (const stat of stats) {
        if (stat.uplink <= 0 && stat.downlink <= 0) continue;
        let client: { id: number } | undefined;
        const matchId = /^c(\d+)$/.exec(stat.email);
        if (matchId) {
          const clientId = parseInt(matchId[1], 10);
          if (Number.isSafeInteger(clientId) && clientId > 0) {
            client = selectById.get(clientId, serverId) as { id: number } | undefined;
          }
        } else if (/^[0-9a-fA-F-]{36}$/.test(stat.email)) {
          client = selectByUuid.get(stat.email, serverId) as { id: number } | undefined;
        }

        if (!client) continue;

        update.run(stat.uplink, stat.downlink, stat.uplink, stat.downlink, now, client.id);
      }
    });
  }

  /**
   * Разбор `awg show <iface> dump` с накоплением трафика: счётчики интерфейса сбрасываются
   * при перезапуске, поэтому к итогу прибавляется только прирост.
   * rx/tx — с точки зрения сервера: rx = отправлено клиентом (upload), tx = получено клиентом (download).
   */
  static applyDump(serverId: number, dump: string): void {
    const lines = dump.trim().split('\n');
    const select = db.prepare('SELECT id, rx_counter, tx_counter FROM clients WHERE server_id = ? AND client_public_key = ?');
    const update = db.prepare(`
      UPDATE clients SET total_rx = total_rx + ?, total_tx = total_tx + ?, rx_counter = ?, tx_counter = ?, last_handshake = COALESCE(?, last_handshake)
      WHERE id = ?
    `);

    // Одна транзакция на весь дамп: иначе каждый UPDATE — отдельный коммит с fsync, а ошибка посреди списка оставляет
    // часть клиентов обновлённой
    transaction(() => {
      // Line 0 is interface info; lines 1..N are peers:
      // peerPublicKey psk endpoint allowedIPs latestHandshake rxBytes txBytes persistentKeepalive
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split('\t');
        if (parts.length < 7) continue;
        const client = select.get(serverId, parts[0]) as { id: number; rx_counter: number; tx_counter: number } | undefined;
        if (!client) continue;

        const rx = parseInt(parts[5], 10) || 0;
        const tx = parseInt(parts[6], 10) || 0;
        const deltaRx = rx >= client.rx_counter ? rx - client.rx_counter : rx;
        const deltaTx = tx >= client.tx_counter ? tx - client.tx_counter : tx;
        const handshakeEpoch = parseInt(parts[4], 10);
        const handshake = handshakeEpoch > 0 ? new Date(handshakeEpoch * 1000).toISOString() : null;

        update.run(deltaRx, deltaTx, rx, tx, handshake, client.id);
      }
    });
  }
}
