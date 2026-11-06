import { NextFunction, Request, Response, Router } from 'express';
import { db, transaction } from '../db/index.js';
import { AwgService } from '../services/awg.service.js';
import { PartnerService } from '../services/partner.service.js';
import { ProvisionService } from '../services/provision.service.js';
import { FailureLimiter } from '../middleware/rate-limit.js';
import { getBearerToken } from '../middleware/auth.middleware.js';
import { HttpError, parseId } from '../utils/http.js';
import { nodeProtocol } from '../utils/vless-params.js';

/**
 * API партнёрского доступа (сторона владельца нод): /api/federation/v1
 * Авторизация — токен партнёра в заголовке Authorization: Bearer dp_...
 */
export const federationRouter = Router();

export const FEDERATION_API_VERSION = 1;

// Подбор токенов: 20 неверных попыток за 15 минут с одного IP
const badTokenLimiter = new FailureLimiter(20, 15 * 60 * 1000);
// Не более 300 запросов в минуту на одного партнёра
const requestCounters = new Map<number, { count: number; resetAt: number }>();
const REQUESTS_PER_MINUTE = 300;

export function cleanupFederationLimits(): void {
  badTokenLimiter.cleanup();
  const now = Date.now();
  for (const [id, counter] of requestCounters) if (counter.resetAt <= now) requestCounters.delete(id);
}

interface PartnerRequest extends Request {
  partner?: any;
}

/**
 * Без HTTPS токен партнёра передаётся открытым текстом. Для локальной разработки — ALLOW_INSECURE_FEDERATION=1.
 */
function isSecure(req: Request): boolean {
  return req.secure || process.env.ALLOW_INSECURE_FEDERATION === '1';
}

function authenticatePartner(req: PartnerRequest, res: Response, next: NextFunction) {
  if (!isSecure(req)) {
    return res.status(403).json({ error: 'Партнёрский доступ работает только по HTTPS' });
  }
  const ip = req.ip || 'unknown';
  const blocked = badTokenLimiter.blockedFor(ip);
  if (blocked > 0) {
    res.setHeader('Retry-After', Math.ceil(blocked / 1000));
    return res.status(429).json({ error: 'Слишком много неверных токенов' });
  }

  const token = getBearerToken(req);
  const partner = token ? PartnerService.findByToken(token) : null;
  if (!partner) {
    badTokenLimiter.registerFailure(ip);
    return res.status(401).json({ error: 'Неверный токен партнёра' });
  }
  if (!partner.enabled) {
    return res.status(403).json({ error: 'Доступ отключён владельцем нод' });
  }

  const now = Date.now();
  const counter = requestCounters.get(partner.id);
  if (!counter || counter.resetAt <= now) {
    requestCounters.set(partner.id, { count: 1, resetAt: now + 60000 });
  } else if (++counter.count > REQUESTS_PER_MINUTE) {
    res.setHeader('Retry-After', Math.ceil((counter.resetAt - now) / 1000));
    return res.status(429).json({ error: 'Превышен лимит запросов' });
  }

  db.prepare("UPDATE partners SET last_used_at = datetime('now'), last_ip = ? WHERE id = ?").run(ip, partner.id);
  req.partner = partner;
  next();
}

federationRouter.use(authenticatePartner);

function allowedNode(partner: any, nodeId: number): any {
  const server = db.prepare(`
    SELECT s.* FROM servers s
    JOIN partner_nodes pn ON pn.server_id = s.id AND pn.partner_id = ?
    WHERE s.id = ?
  `).get(partner.id, nodeId) as any;
  if (!server) throw new HttpError(404, 'Нода недоступна по этому токену');
  if (nodeProtocol(server) === 'vless') throw new HttpError(400, 'Партнёрский доступ недоступен для VLESS');
  return server;
}

function ownPeer(partner: any, peerId: number): any {
  const client = db.prepare(`
    SELECT c.*, s.protocol FROM clients c JOIN servers s ON s.id = c.server_id
    WHERE c.id = ? AND c.partner_id = ?
  `).get(peerId, partner.id) as any;
  if (!client) throw new HttpError(404, 'Клиент не найден');
  if (nodeProtocol(client) === 'vless') throw new HttpError(400, 'Партнёрский доступ недоступен для VLESS');
  return client;
}

function syncNode(serverId: number) {
  const server = db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId) as any;
  if (server && server.status !== 'uninstalled') ProvisionService.requestSync(serverId).catch(() => {});
}

function limitsPayload(partner: any) {
  const usage = PartnerService.usage(partner.id);
  return {
    max_clients: partner.max_clients,
    traffic_limit: partner.traffic_limit,
    expire_at: partner.expire_at,
    suspended: Boolean(partner.suspended),
    usage,
  };
}

// GET /info — проверка токена и лимиты
federationRouter.get('/info', (req: PartnerRequest, res) => {
  res.json({ api_version: FEDERATION_API_VERSION, partner_name: req.partner.name, limits: limitsPayload(req.partner) });
});

// GET /nodes — доступные ноды с параметрами для генерации конфигов
federationRouter.get('/nodes', (req: PartnerRequest, res) => {
  const servers = db.prepare(`
    SELECT s.* FROM servers s
    JOIN partner_nodes pn ON pn.server_id = s.id AND pn.partner_id = ?
    WHERE s.protocol = 'awg'
    ORDER BY s.sub_order, s.id
  `).all(req.partner.id) as any[];
  res.json({ nodes: servers.map((s) => PartnerService.nodePayload(s)), limits: limitsPayload(req.partner) });
});

// GET /peers — клиенты этого партнёра с трафиком и состоянием
federationRouter.get('/peers', (req: PartnerRequest, res) => {
  const clients = db.prepare(`
    SELECT c.* FROM clients c JOIN servers s ON s.id = c.server_id
    WHERE c.partner_id = ? AND s.protocol = 'awg' ORDER BY c.id
  `).all(req.partner.id) as any[];
  res.json({ peers: clients.map((c) => PartnerService.peerPayload(c)) });
});

function validatePublicKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').length !== 32) {
    throw new HttpError(400, 'public_key должен быть ключом WireGuard в base64');
  }
  return key;
}

function validateName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/[\r\n]/g, ' ').trim() : '';
  if (!name || name.length > 64) throw new HttpError(400, 'Имя клиента: от 1 до 64 символов');
  return name;
}

// POST /peers — создать клиента: { node_id, public_key, name, remote_ref?, enabled? }
federationRouter.post('/peers', (req: PartnerRequest, res) => {
  const partner = req.partner;
  const body = req.body ?? {};
  const nodeId = parseId(body.node_id);
  const server = allowedNode(partner, nodeId);
  if (server.status === 'uninstalled' || !server.server_public_key) throw new HttpError(409, 'Нода ещё не установлена');
  if (partner.suspended) throw new HttpError(403, 'Доступ приостановлен: истёк срок или исчерпан лимит трафика');

  const publicKey = validatePublicKey(body.public_key);
  const name = validateName(body.name);
  const remoteRef = body.remote_ref === undefined || body.remote_ref === null ? null : String(body.remote_ref).slice(0, 64);
  const enabled = body.enabled === undefined ? 1 : body.enabled ? 1 : 0;

  const result = transaction(() => {
    // Повтор запроса (например, после таймаута) возвращает уже созданного клиента
    if (remoteRef) {
      const existing = db.prepare('SELECT * FROM clients WHERE partner_id = ? AND server_id = ? AND remote_ref = ?').get(
        partner.id,
        nodeId,
        remoteRef
      ) as any;
      if (existing) {
        if (existing.client_public_key !== publicKey) {
          // Ключ другого клиента ноды занять нельзя: две секции [Peer] с одним ключом перехватили бы его трафик
          const taken = db.prepare('SELECT 1 FROM clients WHERE server_id = ? AND client_public_key = ? AND id != ?').get(
            nodeId,
            publicKey,
            existing.id
          );
          if (taken) throw new HttpError(409, 'Клиент с таким ключом уже есть на ноде');
          db.prepare('UPDATE clients SET client_public_key = ?, rx_counter = 0, tx_counter = 0 WHERE id = ?').run(publicKey, existing.id);
        }
        return { client: db.prepare('SELECT * FROM clients WHERE id = ?').get(existing.id) as any, created: false };
      }
    }

    if (partner.max_clients > 0 && PartnerService.usage(partner.id).clients >= partner.max_clients) {
      throw new HttpError(403, `Достигнут лимит клиентов (${partner.max_clients})`);
    }
    const duplicate = db.prepare('SELECT 1 FROM clients WHERE server_id = ? AND client_public_key = ?').get(nodeId, publicKey);
    if (duplicate) throw new HttpError(409, 'Клиент с таким ключом уже есть на ноде');

    const clientIp = AwgService.getNextClientIp(nodeId, server.subnet);
    const psk = AwgService.generatePresharedKey();
    const inserted = db.prepare(`
      INSERT INTO clients (server_id, partner_id, remote_ref, name, client_ip, client_public_key, client_private_key, preshared_key, enabled)
      VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)
    `).run(nodeId, partner.id, remoteRef, name, clientIp, publicKey, psk, enabled);
    return { client: db.prepare('SELECT * FROM clients WHERE id = ?').get(inserted.lastInsertRowid) as any, created: true };
  });

  if (result.created) {
    PartnerService.audit(partner.id, 'peer_created', `${result.client.name} · ${server.name} · ${result.client.client_ip}`, req.ip || null);
  }
  syncNode(nodeId);
  res.status(result.created ? 201 : 200).json({ peer: PartnerService.peerPayload(result.client), node: PartnerService.nodePayload(server) });
});

// PATCH /peers/:id — { enabled?, name? }. owner_blocked партнёру недоступен: флаг enabled сохраняется как желание партнёра,
// но заблокированный владельцем клиент остаётся выключенным на ноде (ProvisionService.getServerClients) до снятия блокировки.
federationRouter.patch('/peers/:id', (req: PartnerRequest, res) => {
  const client = ownPeer(req.partner, parseId(req.params.id));
  const body = req.body ?? {};
  const name = body.name === undefined ? client.name : validateName(body.name);
  const enabled = body.enabled === undefined ? client.enabled : body.enabled ? 1 : 0;

  db.prepare('UPDATE clients SET name = ?, enabled = ? WHERE id = ?').run(name, enabled, client.id);
  if (enabled !== client.enabled) {
    PartnerService.audit(req.partner.id, enabled ? 'peer_enabled' : 'peer_disabled', client.name, req.ip || null);
    syncNode(client.server_id);
  }
  res.json({ peer: PartnerService.peerPayload(db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id)) });
});

// DELETE /peers/:id
federationRouter.delete('/peers/:id', (req: PartnerRequest, res) => {
  const client = ownPeer(req.partner, parseId(req.params.id));
  db.prepare('DELETE FROM clients WHERE id = ?').run(client.id);
  PartnerService.audit(req.partner.id, 'peer_deleted', `${client.name} · ${client.client_ip}`, req.ip || null);
  syncNode(client.server_id);
  res.json({ success: true });
});
