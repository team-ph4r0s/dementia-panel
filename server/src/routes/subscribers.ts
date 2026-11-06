import { Router } from 'express';
import crypto from 'node:crypto';
import { db, transaction } from '../db/index.js';
import { AwgService } from '../services/awg.service.js';
import { XrayService } from '../services/xray.service.js';
import { nodeProtocol } from '../utils/vless-params.js';
import { ProvisionService } from '../services/provision.service.js';
import { SubscriptionService } from '../services/subscription.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler, HttpError, parseId } from '../utils/http.js';
import { pendingIp } from '../services/federation-client.service.js';
import { subscriberPeerName } from '../utils/names.js';
import { EventService } from '../services/event.service.js';

export const subscribersRouter = Router();

// All routes here require authentication
subscribersRouter.use(requireAuth);

function newToken(): string {
  return 'sub_' + crypto.randomBytes(16).toString('hex');
}

function validateName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Имя пользователя обязательно');
  if (name.trim().length > 64) throw new HttpError(400, 'Имя пользователя не длиннее 64 символов');
  return name.trim();
}

function validateServerIds(value: unknown): number[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'server_ids должен быть массивом');
  const ids = value.map((v) => Number(v));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new HttpError(400, 'Некорректный идентификатор сервера');
  return [...new Set(ids)];
}

function validateTrafficLimit(value: unknown): number {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit < 0 || !Number.isInteger(limit)) {
    throw new HttpError(400, 'Лимит трафика должен быть целым неотрицательным числом байт');
  }
  return limit;
}

/** Страна пользователя: по ней подписка выбирает мост (docs/bridges.md); пусто — не задана */
function validateCountry(value: unknown): string | null {
  if (value === null || value === '') return null;
  const code = String(value).trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) throw new HttpError(400, 'Страна пользователя задаётся двухбуквенным кодом (например, ru)');
  return code;
}

function validateExpireAt(value: unknown): string | null {
  if (value === null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'Некорректная дата окончания подписки');
  return date.toISOString();
}

function serializeSubscriber(sub: any, usage = SubscriptionService.getUsage(sub.id), peers?: any[]) {
  peers ??= db.prepare(`
    SELECT c.id, c.server_id, c.client_ip, c.enabled, s.name as server_name, s.host
    FROM clients c
    JOIN servers s ON c.server_id = s.id
    WHERE c.subscriber_id = ?
  `).all(sub.id) as any[];

  return {
    ...sub,
    suspended: Boolean(sub.suspended),
    expired: SubscriptionService.isExpired(sub),
    total_rx: usage.upload,
    total_tx: usage.download,
    traffic_used: usage.used,
    peer_count: peers.length,
    server_ids: peers.map((p) => p.server_id),
    servers: peers.map((p) => ({
      id: p.server_id,
      name: p.server_name,
      host: p.host,
      client_ip: p.client_ip,
      enabled: p.enabled,
    })),
  };
}

function addPeer(subscriberId: number, subscriberName: string, enabled: number, server: any): void {
  const vless = nodeProtocol(server) === 'vless';
  const keyPair = vless ? { publicKey: '', privateKey: '' } : AwgService.generateKeyPair();
  const psk = vless ? null : AwgService.generatePresharedKey();
  const uuid = vless ? XrayService.generateUuid() : null;
  // На ноде партнёра IP выдаёт панель владельца при синхронизации
  const clientIp = vless ? '' : server.remote_panel_id ? pendingIp() : AwgService.getNextClientIp(server.id, server.subnet);
  db.prepare(`
    INSERT INTO clients (
      server_id, subscriber_id, name, client_ip, client_public_key, client_private_key, preshared_key, client_uuid, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(server.id, subscriberId, subscriberPeerName(subscriberName, server.name), clientIp, keyPair.publicKey, keyPair.privateKey, psk, uuid, enabled);
}

/**
 * Синхронизация затронутых нод. Возвращает промис для нод партнёров, чтобы ответ ушёл,
 * когда клиенты уже созданы у владельца (и подписка сразу содержит эти ноды).
 */
function syncServers(serverIds: Iterable<number>): Promise<unknown> {
  const remote: Promise<unknown>[] = [];
  for (const sId of serverIds) {
    const server = db.prepare('SELECT status, remote_panel_id FROM servers WHERE id = ?').get(sId) as any;
    if (!server) continue;
    if (server.remote_panel_id) {
      remote.push(ProvisionService.requestSync(sId));
    } else if (server.status !== 'uninstalled') {
      ProvisionService.requestSync(sId).catch((err) => console.error(`Ошибка синхронизации сервера #${sId}:`, err));
    }
  }
  return Promise.allSettled(remote);
}

function loadServers(ids: number[]): any[] {
  return ids.map((id) => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    if (!server) throw new HttpError(400, `Сервер #${id} не найден`);
    return server;
  });
}

// GET /api/subscribers
subscribersRouter.get('/', (req, res) => {
  const subscribers = db.prepare('SELECT * FROM subscribers ORDER BY id DESC').all() as any[];
  const usageRows = db.prepare(`
    SELECT subscriber_id, COALESCE(SUM(total_rx), 0) AS rx, COALESCE(SUM(total_tx), 0) AS tx
    FROM clients WHERE subscriber_id IS NOT NULL GROUP BY subscriber_id
  `).all() as any[];
  const peers = db.prepare(`
    SELECT c.id, c.subscriber_id, c.server_id, c.client_ip, c.enabled, s.name as server_name, s.host
    FROM clients c JOIN servers s ON c.server_id = s.id
    WHERE c.subscriber_id IS NOT NULL ORDER BY c.id
  `).all() as any[];
  const usage = new Map(usageRows.map((row) => [row.subscriber_id, { upload: row.rx, download: row.tx, used: row.rx + row.tx }]));
  const peersBySubscriber = new Map<number, any[]>();
  for (const peer of peers) {
    const list = peersBySubscriber.get(peer.subscriber_id) ?? [];
    list.push(peer);
    peersBySubscriber.set(peer.subscriber_id, list);
  }
  res.json(subscribers.map((sub) => serializeSubscriber(
    sub,
    usage.get(sub.id) ?? { upload: 0, download: 0, used: 0 },
    peersBySubscriber.get(sub.id) ?? [],
  )));
});

// POST /api/subscribers
subscribersRouter.post('/', asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const name = validateName(body.name);
  const serverIds = validateServerIds(body.server_ids ?? []);
  const trafficLimit = body.traffic_limit === undefined ? 0 : validateTrafficLimit(body.traffic_limit);
  const expireAt = body.expire_at === undefined ? null : validateExpireAt(body.expire_at);
  const country = body.country === undefined ? null : validateCountry(body.country);
  const servers = loadServers(serverIds);

  const subscriberId = transaction(() => {
    const result = db.prepare(`
      INSERT INTO subscribers (name, token, enabled, traffic_limit, expire_at, country)
      VALUES (?, ?, 1, ?, ?, ?)
    `).run(name, newToken(), trafficLimit, expireAt, country);
    const id = Number(result.lastInsertRowid);
    for (const server of servers) addPeer(id, name, 1, server);
    return id;
  });

  SubscriptionService.refreshSuspension(subscriberId);
  await syncServers(serverIds);

  const created = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(subscriberId);
  EventService.log('info', 'subscriber.created', `Создан пользователь «${name}»`, { kind: 'subscriber', id: subscriberId });
  res.status(201).json(serializeSubscriber(created));
}));

// PUT /api/subscribers/:id
subscribersRouter.put('/:id', asyncHandler(async (req, res) => {
  const subscriberId = parseId(req.params.id);
  const subscriber = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(subscriberId) as any;
  if (!subscriber) throw new HttpError(404, 'Пользователь не найден');

  const body = req.body ?? {};
  const name = body.name === undefined ? subscriber.name : validateName(body.name);
  const enabled = body.enabled === undefined ? subscriber.enabled : body.enabled ? 1 : 0;
  const trafficLimit = body.traffic_limit === undefined ? subscriber.traffic_limit : validateTrafficLimit(body.traffic_limit);
  const expireAt = body.expire_at === undefined ? subscriber.expire_at : validateExpireAt(body.expire_at);
  const country = body.country === undefined ? subscriber.country : validateCountry(body.country);
  const targetIds = body.server_ids === undefined ? null : validateServerIds(body.server_ids);
  const targetServers = targetIds ? loadServers(targetIds) : [];

  const affectedServers = new Set<number>();

  transaction(() => {
    db.prepare('UPDATE subscribers SET name = ?, enabled = ?, traffic_limit = ?, expire_at = ?, country = ? WHERE id = ?').run(
      name, enabled, trafficLimit, expireAt, country, subscriberId
    );

    const existingPeers = db.prepare('SELECT server_id FROM clients WHERE subscriber_id = ?').all(subscriberId) as any[];
    const currentServerIds = new Set<number>(existingPeers.map((p) => p.server_id));

    if (enabled !== subscriber.enabled) {
      currentServerIds.forEach((id) => affectedServers.add(id));
    }

    if (name !== subscriber.name) {
      const peers = db.prepare(`
        SELECT c.id, c.server_id, s.name AS server_name, s.remote_panel_id FROM clients c JOIN servers s ON s.id = c.server_id WHERE c.subscriber_id = ?
      `).all(subscriberId) as { id: number; server_id: number; server_name: string; remote_panel_id: number | null }[];
      const rename = db.prepare('UPDATE clients SET name = ? WHERE id = ?');
      for (const peer of peers) {
        rename.run(subscriberPeerName(name, peer.server_name), peer.id);
        // Новое имя нужно владельцу нод партнёра; в конфигурации локальных нод имён нет, их синхронизировать незачем
        if (peer.remote_panel_id) affectedServers.add(peer.server_id);
      }
    }

    if (targetIds) {
      const targetSet = new Set(targetIds);
      for (const curId of currentServerIds) {
        if (!targetSet.has(curId)) {
          db.prepare('DELETE FROM clients WHERE subscriber_id = ? AND server_id = ?').run(subscriberId, curId);
          affectedServers.add(curId);
        }
      }
      for (const server of targetServers) {
        if (!currentServerIds.has(server.id)) {
          addPeer(subscriberId, name, 1, server);
          affectedServers.add(server.id);
        }
      }
    }
  });

  // Пересчёт срока/лимита сам синхронизирует ноды при смене статуса
  SubscriptionService.refreshSuspension(subscriberId);
  await syncServers(affectedServers);

  const updated = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(subscriberId);
  EventService.log('info', 'subscriber.updated', `Изменён пользователь «${name}»`, { kind: 'subscriber', id: subscriberId });
  res.json(serializeSubscriber(updated));
}));

// POST /api/subscribers/:id/reset-traffic
subscribersRouter.post('/:id/reset-traffic', (req, res) => {
  const subscriberId = parseId(req.params.id);
  const subscriber = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(subscriberId) as any;
  if (!subscriber) throw new HttpError(404, 'Пользователь не найден');

  db.prepare('UPDATE clients SET total_rx = 0, total_tx = 0 WHERE subscriber_id = ?').run(subscriberId);
  SubscriptionService.refreshSuspension(subscriberId);
  EventService.log('info', 'subscriber.traffic_reset', `Сброшен трафик пользователя «${subscriber.name}»`, { kind: 'subscriber', id: subscriberId });
  res.json(serializeSubscriber(db.prepare('SELECT * FROM subscribers WHERE id = ?').get(subscriberId)));
});

// DELETE /api/subscribers/:id
subscribersRouter.delete('/:id', asyncHandler(async (req, res) => {
  const subscriberId = parseId(req.params.id);
  const subscriber = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(subscriberId) as any;
  if (!subscriber) throw new HttpError(404, 'Пользователь не найден');

  // Find all affected server IDs before deleting
  const peers = db.prepare('SELECT DISTINCT server_id FROM clients WHERE subscriber_id = ?').all(subscriberId) as any[];

  // Delete subscriber (cascades to clients)
  db.prepare('DELETE FROM subscribers WHERE id = ?').run(subscriberId);
  await syncServers(peers.map((p) => p.server_id));

  EventService.log('info', 'subscriber.deleted', `Удалён пользователь «${subscriber.name}»`, { kind: 'subscriber', id: subscriberId });
  res.json({ success: true, message: 'Пользователь и его пиры удалены' });
}));

// POST /api/subscribers/:id/reset-token
subscribersRouter.post('/:id/reset-token', asyncHandler(async (req, res) => {
  const subscriberId = parseId(req.params.id);
  const subscriber = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(subscriberId);
  if (!subscriber) throw new HttpError(404, 'Пользователь не найден');

  // Вместе со ссылкой перевыпускаются ключи пиров: иначе тот, кто успел скачать старую подписку,
  // сохранил бы доступ к VPN
  const token = newToken();
  const peers = db.prepare(`
    SELECT c.id, c.server_id, s.remote_panel_id, s.protocol FROM clients c JOIN servers s ON s.id = c.server_id WHERE c.subscriber_id = ?
  `).all(subscriberId) as any[];
  transaction(() => {
    db.prepare('UPDATE subscribers SET token = ? WHERE id = ?').run(token, subscriberId);
    for (const peer of peers) {
      if (nodeProtocol(peer) === 'vless') {
        db.prepare('UPDATE clients SET client_uuid = ?, rx_counter = 0, tx_counter = 0 WHERE id = ?')
          .run(XrayService.generateUuid(), peer.id);
        continue;
      }
      const keyPair = AwgService.generateKeyPair();
      if (peer.remote_panel_id) {
        db.prepare(`
          UPDATE clients SET client_public_key = ?, client_private_key = ?, preshared_key = NULL,
            remote_peer_id = NULL, client_ip = ?, rx_counter = 0, tx_counter = 0
          WHERE id = ?
        `).run(keyPair.publicKey, keyPair.privateKey, pendingIp(), peer.id);
        continue;
      }
      db.prepare(`
        UPDATE clients SET client_public_key = ?, client_private_key = ?, preshared_key = ?, rx_counter = 0, tx_counter = 0
        WHERE id = ?
      `).run(keyPair.publicKey, keyPair.privateKey, AwgService.generatePresharedKey(), peer.id);
    }
  });
  // Ноды партнёров ждём: пока владелец не выдал IP новым ключам, они не попадают в подписку
  await syncServers(new Set(peers.map((p) => p.server_id)));

  EventService.log('warning', 'subscriber.token_reset', `Перевыпущена подписка пользователя #${subscriberId}`, { kind: 'subscriber', id: subscriberId });
  res.json({ success: true, token });
}));
