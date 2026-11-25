import crypto from 'node:crypto';
import net from 'node:net';
import { db, transaction } from '../db/index.js';
import type { ClientRow, RemotePanelRow, ServerRow, SubscriberRow } from '../db/types.js';
import { decryptSecret, encryptSecret } from './secrets.service.js';
import { paramsToColumns, AwgParams, isWireGuardKey, sanitizeRemoteParams } from '../utils/awg-params.js';
import { HttpError } from '../utils/http.js';
import { normalizePeerName } from '../utils/names.js';
import { isValidHost, isValidPort } from '../utils/net.js';

/**
 * Партнёрский доступ (сторона получателя): ноды другой панели хранятся как серверы с remote_panel_id,
 * клиенты на них создаются здесь (приватный ключ остаётся у нас), а на панель владельца
 * передаётся только публичный ключ.
 */

const API_PREFIX = '/api/federation/v1';
const REQUEST_TIMEOUT_MS = 15000;
/** Временный адрес клиента, пока панель владельца не выдала IP */
export const PENDING_IP_PREFIX = 'pending:';

export class FederationError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface RemoteNode {
  id: number;
  name: string;
  host: string;
  port: number;
  public_key: string | null;
  status: string;
  params: AwgParams;
}

interface RemotePeer {
  id: number;
  node_id: number;
  name: string;
  remote_ref: string | null;
  public_key: string;
  client_ip: string;
  preshared_key: string | null;
  enabled: boolean;
  owner_blocked: boolean;
  total_rx: number;
  total_tx: number;
  last_handshake: string | null;
}

type RemotePanelConnection = Pick<RemotePanelRow, 'base_url' | 'token'>;
type RemotePanelReference = Pick<RemotePanelRow, 'id'>;
type SyncedRemoteClientRow = Omit<ClientRow, 'remote_peer_id'> & {
  remote_peer_id: number;
  sub_enabled: number | null;
  sub_suspended: number | null;
};
type RemoteServerReferenceRow = Pick<ServerRow, 'id'> & { remote_node_id: number };
type DesiredEnabledClient = Pick<ClientRow, 'enabled' | 'subscriber_id'> & {
  sub_enabled?: number | null;
  sub_suspended?: number | null;
};
type SqlValue = string | number | null;
type UnknownFields = Record<string, unknown>;

interface IdProjection {
  id: number;
}

function asFields(value: unknown): UnknownFields {
  return value !== null && typeof value === 'object' ? (value as UnknownFields) : {};
}

function objectMessage(value: unknown): unknown {
  return value === null || value === undefined ? undefined : (value as { message?: unknown }).message;
}

function errorMessage(err: unknown): string {
  return String(objectMessage(err));
}

function responseError(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;
  const error = (data as { error?: unknown }).error;
  return error ? String(error) : null;
}

const pendingSync = new Map<number, Promise<void>>();
const runningSync = new Map<number, Promise<void>>();

/**
 * Данные ноды от панели партнёра попадают в конфиги клиентов (Endpoint, PublicKey, параметры обфускации) —
 * строка с переводом строки позволила бы дописать в чужой .conf любые директивы (например, PostUp).
 * Поэтому адрес, порт, ключ и параметры проверяются по формату; некорректная нода пропускается.
 */
export function sanitizeRemoteNode(node: unknown): {
  id: number; name: string; host: string; port: number; publicKey: string | null; status: string; params: AwgParams;
} {
  const input = asFields(node);
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('некорректный идентификатор ноды');
  if (!isValidHost(input.host)) throw new Error('некорректный адрес ноды');
  const host = input.host;
  if (!isValidPort(input.port)) throw new Error('некорректный порт ноды');
  const port = input.port;
  const rawPublicKey = input.public_key;
  let publicKey: string | null = null;
  if (!(rawPublicKey === null || rawPublicKey === undefined || rawPublicKey === '')) {
    if (!isWireGuardKey(rawPublicKey)) throw new Error('некорректный публичный ключ ноды');
    publicKey = rawPublicKey;
  }
  // eslint-disable-next-line no-control-regex
  const name = String(input.name ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 64) || `Нода #${id}`;
  return {
    id,
    name,
    host: host.trim(),
    port,
    publicKey,
    status: typeof input.status === 'string' ? input.status : 'offline',
    params: sanitizeRemoteParams(input.params),
  };
}

/**
 * Клиент у владельца: IP и PSK подставляются в наш конфиг клиента, поэтому проверяются так же строго
 */
export function sanitizeRemotePeer(peer: unknown): {
  id: number; clientIp: string; presharedKey: string | null; totalRx: number; totalTx: number; lastHandshake: string | null;
} {
  const input = asFields(peer);
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('некорректный идентификатор клиента');
  if (typeof input.client_ip !== 'string' || !net.isIPv4(input.client_ip)) throw new Error('некорректный IP клиента');
  const clientIp = input.client_ip;
  const rawPresharedKey = input.preshared_key;
  let presharedKey: string | null = null;
  if (!(rawPresharedKey === null || rawPresharedKey === undefined || rawPresharedKey === '')) {
    if (!isWireGuardKey(rawPresharedKey)) throw new Error('некорректный PSK клиента');
    presharedKey = rawPresharedKey;
  }
  const counter = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  return {
    id,
    clientIp,
    presharedKey,
    totalRx: counter(input.total_rx),
    totalTx: counter(input.total_tx),
    lastHandshake: typeof input.last_handshake === 'string' && input.last_handshake.length <= 40 ? input.last_handshake : null,
  };
}

export function isPendingIp(ip: string | null | undefined): boolean {
  return typeof ip === 'string' && ip.startsWith(PENDING_IP_PREFIX);
}

export function pendingIp(): string {
  return PENDING_IP_PREFIX + crypto.randomUUID();
}

/**
 * Разбор строки подключения вида https://panel.example.com#dp_xxx
 */
export function parseConnectString(input: string): { baseUrl: string; token: string } {
  const value = String(input ?? '').trim();
  const hash = value.lastIndexOf('#');
  if (hash < 0) throw new HttpError(400, 'Строка подключения должна иметь вид https://адрес-панели#dp_…');
  const token = value.slice(hash + 1).trim();
  if (!/^dp_[A-Za-z0-9_-]{20,}$/.test(token)) throw new HttpError(400, 'Некорректный токен партнёра');

  let url: URL;
  try {
    url = new URL(value.slice(0, hash));
  } catch {
    throw new HttpError(400, 'Некорректный адрес панели партнёра');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && process.env.ALLOW_INSECURE_FEDERATION === '1')) {
    throw new HttpError(400, 'Панель партнёра должна быть доступна по HTTPS — иначе токен передаётся открытым текстом');
  }
  return { baseUrl: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`, token };
}

async function call<T>(panel: RemotePanelConnection, method: string, path: string, body?: unknown): Promise<T> {
  const token = decryptSecret(panel.token);
  let res: Response;
  try {
    res = await fetch(`${panel.base_url}${API_PREFIX}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err: unknown) {
    const cause = err === null || err === undefined ? undefined : (err as { cause?: unknown }).cause;
    const causeMessage = objectMessage(cause);
    throw new FederationError(0, `Панель партнёра недоступна: ${causeMessage ? String(causeMessage) : errorMessage(err)}`);
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new FederationError(res.status, responseError(data) || `Ошибка панели партнёра (HTTP ${res.status})`);
  return data as T;
}

function loadPanel(panelId: number): RemotePanelRow | undefined {
  return db.prepare('SELECT * FROM remote_panels WHERE id = ?').get(panelId) as unknown as RemotePanelRow | undefined;
}

export class FederationClient {
  /**
   * Подключить панель партнёра по строке подключения
   */
  static async connect(input: string, name?: string): Promise<number> {
    const { baseUrl, token } = parseConnectString(input);
    const probe = { base_url: baseUrl, token: encryptSecret(token)! };
    const info = await call<{ partner_name: string; limits: unknown }>(probe, 'GET', '/info').catch((err: FederationError) => {
      throw new HttpError(err.status === 401 || err.status === 403 ? 400 : 502, err.message);
    });

    const exists = db.prepare('SELECT id FROM remote_panels WHERE base_url = ?').get(baseUrl) as unknown as IdProjection | undefined;
    if (exists) throw new HttpError(409, 'Эта панель уже подключена');

    const label = (name || '').trim().slice(0, 64) || new URL(baseUrl).host;
    const result = db.prepare(`
      INSERT INTO remote_panels (name, base_url, token, partner_name, status, limits) VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(label, baseUrl, probe.token, info.partner_name, JSON.stringify(info.limits ?? null));
    const id = Number(result.lastInsertRowid);
    await this.requestSync(id);
    return id;
  }

  /**
   * Отключить панель: клиенты на её нодах удаляются у владельца (по возможности) и локально
   */
  static async disconnect(panelId: number): Promise<{ remoteCleanup: boolean }> {
    const panel = loadPanel(panelId);
    if (!panel) throw new HttpError(404, 'Панель не найдена');
    let remoteCleanup = true;
    try {
      const { peers } = await call<{ peers: RemotePeer[] }>(panel, 'GET', '/peers');
      for (const peer of peers) await call(panel, 'DELETE', `/peers/${peer.id}`).catch(() => (remoteCleanup = false));
    } catch {
      remoteCleanup = false;
    }
    // Серверы панели и их клиенты удаляются каскадом
    db.prepare('DELETE FROM remote_panels WHERE id = ?').run(panelId);
    return { remoteCleanup };
  }

  /**
   * Запросить синхронизацию панели; повторные запросы, пришедшие во время синхронизации, объединяются в одну следующую
   */
  static requestSync(panelId: number): Promise<void> {
    const pending = pendingSync.get(panelId);
    if (pending) return pending;
    const previous = runningSync.get(panelId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => {
        pendingSync.delete(panelId);
        return this.doSync(panelId);
      });
    pendingSync.set(panelId, next);
    runningSync.set(panelId, next);
    next.finally(() => {
      if (runningSync.get(panelId) === next) runningSync.delete(panelId);
    }).catch(() => {});
    return next;
  }

  static async syncAll(): Promise<void> {
    const panels = db.prepare('SELECT id FROM remote_panels').all() as unknown as IdProjection[];
    await Promise.allSettled(panels.map((p) => this.requestSync(p.id)));
  }

  private static async doSync(panelId: number): Promise<void> {
    const panel = loadPanel(panelId);
    if (!panel) return;
    try {
      // 1. Ноды: обновление адресов, ключей и параметров обфускации
      const { nodes, limits } = await call<{ nodes: RemoteNode[]; limits: unknown }>(panel, 'GET', '/nodes');
      const errors: string[] = this.upsertNodes(panel, Array.isArray(nodes) ? nodes : []);
      db.prepare('UPDATE remote_panels SET limits = ? WHERE id = ?').run(JSON.stringify(limits ?? null), panelId);

      // 2. Клиенты, ещё не созданные у владельца
      const servers = db.prepare("SELECT * FROM servers WHERE remote_panel_id = ? AND status != 'uninstalled'").all(panelId) as unknown as ServerRow[];
      for (const server of servers) {
        const pending = db.prepare(`
          SELECT c.* FROM clients c WHERE c.server_id = ? AND c.remote_peer_id IS NULL
        `).all(server.id) as unknown as ClientRow[];
        for (const client of pending) {
          try {
            const response = await call<{ peer: RemotePeer }>(panel, 'POST', '/peers', {
              node_id: server.remote_node_id,
              public_key: client.client_public_key,
              name: normalizePeerName(client.name),
              remote_ref: String(client.id),
              enabled: this.desiredEnabled(client),
            });
            const peer = sanitizeRemotePeer(response?.peer);
            db.prepare('UPDATE clients SET remote_peer_id = ?, client_ip = ?, preshared_key = ?, remote_state = NULL WHERE id = ?').run(
              peer.id,
              peer.clientIp,
              peer.presharedKey,
              client.id
            );
          } catch (err: unknown) {
            db.prepare('UPDATE clients SET remote_state = ? WHERE id = ?').run(`error: ${errorMessage(err)}`.slice(0, 300), client.id);
            errors.push(`${client.name}: ${errorMessage(err)}`);
          }
        }
      }

      // 3. Состояние клиентов у владельца: трафик, блокировки, включение/выключение, удалённые локально
      const { peers: remotePeers } = await call<{ peers: RemotePeer[] }>(panel, 'GET', '/peers');
      const peers = Array.isArray(remotePeers) ? remotePeers : [];
      const local = db.prepare(`
        SELECT c.*, sub.enabled AS sub_enabled, sub.suspended AS sub_suspended
        FROM clients c
        JOIN servers s ON s.id = c.server_id
        LEFT JOIN subscribers sub ON sub.id = c.subscriber_id
        WHERE s.remote_panel_id = ? AND c.remote_peer_id IS NOT NULL
      `).all(panelId) as unknown as SyncedRemoteClientRow[];
      const byPeerId = new Map(local.map((c) => [c.remote_peer_id, c]));
      const remoteIds = new Set<number>();

      for (const peer of peers) {
        remoteIds.add(peer.id);
        const client = byPeerId.get(peer.id);
        if (!client) {
          // Клиент удалён у нас (вместе с пользователем, нодой из подписки и т.п.) — удаляем у владельца
          await call(panel, 'DELETE', `/peers/${peer.id}`).catch((err: unknown) => errors.push(errorMessage(err)));
          continue;
        }
        let state: ReturnType<typeof sanitizeRemotePeer>;
        try {
          state = sanitizeRemotePeer(peer);
        } catch (err: unknown) {
          // Некорректные данные не сохраняются: IP и PSK подставляются в конфиг клиента
          errors.push(`${client.name}: ${errorMessage(err)}`);
          continue;
        }
        db.prepare(`
          UPDATE clients SET total_rx = ?, total_tx = ?, last_handshake = ?, client_ip = ?, preshared_key = COALESCE(?, preshared_key), remote_state = ? WHERE id = ?
        `).run(state.totalRx, state.totalTx, state.lastHandshake, state.clientIp, state.presharedKey, peer.owner_blocked ? 'blocked' : null, client.id);
        const patch: { enabled?: boolean; name?: string } = {};
        const desired = this.desiredEnabled(client);
        // Заблокированного владельцем клиента включить нельзя — состояние выровняется после снятия блокировки
        if (desired !== peer.enabled && !(desired && peer.owner_blocked)) patch.enabled = desired;
        // Переименование у нас (клиента или пользователя) передаётся владельцу, иначе у него остаётся прежнее имя
        const name = normalizePeerName(client.name);
        if (name !== peer.name) patch.name = name;
        if (Object.keys(patch).length > 0) {
          await call(panel, 'PATCH', `/peers/${peer.id}`, patch).catch((err: unknown) => errors.push(errorMessage(err)));
        }
      }

      // Пир пропал у владельца (удалён им) — клиент будет создан заново при следующей синхронизации
      for (const client of local) {
        if (!remoteIds.has(client.remote_peer_id)) {
          db.prepare('UPDATE clients SET remote_peer_id = NULL, client_ip = ? WHERE id = ?').run(pendingIp(), client.id);
        }
      }

      db.prepare("UPDATE remote_panels SET status = 'online', last_sync_at = datetime('now'), last_error = ? WHERE id = ?").run(
        errors.length ? errors.slice(0, 3).join('; ') : null,
        panelId
      );
    } catch (err: unknown) {
      const revoked = err instanceof FederationError && (err.status === 401 || err.status === 403);
      db.prepare('UPDATE remote_panels SET status = ?, last_error = ? WHERE id = ?').run(revoked ? 'revoked' : 'error', errorMessage(err), panelId);
      if (revoked) {
        // Доступ отозван: ноды убираются из подписок, клиенты остаются до решения администратора
        db.prepare("UPDATE servers SET status = 'uninstalled', last_error = ? WHERE remote_panel_id = ?").run(errorMessage(err), panelId);
      }
    }
  }

  /**
   * Клиент должен быть включён у владельца, если он включён у нас и его пользователь активен
   */
  private static desiredEnabled(client: DesiredEnabledClient): boolean {
    if (!client.enabled) return false;
    if (client.subscriber_id === null || client.subscriber_id === undefined) return true;
    const sub =
      client.sub_enabled !== undefined
        ? { enabled: client.sub_enabled, suspended: client.sub_suspended }
        : (db.prepare('SELECT enabled, suspended FROM subscribers WHERE id = ?').get(client.subscriber_id) as unknown as Pick<SubscriberRow, 'enabled' | 'suspended'> | undefined);
    return Boolean(sub && sub.enabled && !sub.suspended);
  }

  /**
   * Обновление нод партнёра; возвращает описания пропущенных нод с некорректными данными
   */
  private static upsertNodes(panel: RemotePanelReference, nodes: RemoteNode[]): string[] {
    const problems: string[] = [];
    transaction(() => {
      const seen = new Set<number>();
      for (const raw of nodes) {
        const remoteId = Number(raw?.id);
        let node: ReturnType<typeof sanitizeRemoteNode>;
        try {
          node = sanitizeRemoteNode(raw);
        } catch (err: unknown) {
          // Нода не удаляется, но недоступна для подписок, пока владелец не исправит данные
          problems.push(`нода #${Number.isInteger(remoteId) ? remoteId : '?'}: ${errorMessage(err)}`);
          if (Number.isInteger(remoteId)) {
            seen.add(remoteId);
            db.prepare("UPDATE servers SET status = 'uninstalled', last_error = ? WHERE remote_panel_id = ? AND remote_node_id = ?").run(
              `Панель партнёра отдала некорректные данные ноды: ${errorMessage(err)}`.slice(0, 300),
              panel.id,
              remoteId
            );
          }
          continue;
        }
        seen.add(node.id);
        const status = node.status === 'uninstalled' || !node.publicKey ? 'uninstalled' : node.status === 'online' ? 'online' : 'offline';
        const columns = paramsToColumns(node.params);
        const existing = db.prepare('SELECT id FROM servers WHERE remote_panel_id = ? AND remote_node_id = ?').get(panel.id, node.id) as unknown as IdProjection | undefined;
        const common: Record<string, SqlValue> = {
          name: node.name,
          host: node.host,
          awg_port: node.port,
          server_public_key: node.publicKey,
          status,
          last_error: null,
          ...columns,
        };
        const keys = Object.keys(common);
        if (existing) {
          db.prepare(`UPDATE servers SET ${keys.map((k) => `${k} = ?`).join(', ')}, last_seen = datetime('now') WHERE id = ?`).run(
            ...keys.map((k) => common[k]),
            existing.id
          );
        } else {
          db.prepare(`
            INSERT INTO servers (${keys.join(', ')}, remote_panel_id, remote_node_id, ssh_user, managed_by, last_seen)
            VALUES (${keys.map(() => '?').join(', ')}, ?, ?, 'partner', 'partner', datetime('now'))
          `).run(...keys.map((k) => common[k]), panel.id, node.id);
        }
      }
      // Ноды, которые владелец больше не предоставляет, убираются из подписок
      const rows = db.prepare('SELECT id, remote_node_id FROM servers WHERE remote_panel_id = ?').all(panel.id) as unknown as RemoteServerReferenceRow[];
      for (const row of rows) {
        if (!seen.has(row.remote_node_id)) {
          db.prepare("UPDATE servers SET status = 'uninstalled', last_error = 'Нода больше не предоставляется партнёром' WHERE id = ?").run(row.id);
        }
      }
    });
    return problems;
  }
}
