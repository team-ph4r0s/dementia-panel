import { Request, Router } from 'express';
import { db, getSetting, transaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { generatePartnerToken, PartnerService } from '../services/partner.service.js';
import { HttpError, parseId } from '../utils/http.js';
import { nodeProtocol } from '../utils/vless-params.js';

/**
 * Управление выданными партнёрскими доступами (сторона владельца нод): /api/partners
 */
export const partnersRouter = Router();

partnersRouter.use(requireAuth);

function validateName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 64) throw new HttpError(400, 'Название партнёра: от 1 до 64 символов');
  return name;
}

function validateNodeIds(value: unknown): number[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'node_ids должен быть массивом');
  const ids = [...new Set(value.map((v) => Number(v)))];
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Некорректный идентификатор ноды');
    const server = db.prepare('SELECT remote_panel_id, protocol FROM servers WHERE id = ?').get(id) as any;
    if (!server) throw new HttpError(400, `Нода #${id} не найдена`);
    if (nodeProtocol(server) === 'vless') throw new HttpError(400, 'Нельзя передавать партнёру ноды VLESS');
    if (server.remote_panel_id) throw new HttpError(400, 'Нельзя передавать партнёру чужие (партнёрские) ноды');
  }
  return ids;
}

function validateNonNegativeInt(value: unknown, label: string): number {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${label}: целое неотрицательное число`);
  return n;
}

function validateExpireAt(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'Некорректная дата окончания доступа');
  return date.toISOString();
}

/**
 * Строка подключения для партнёра: адрес панели и токен (токен — во фрагменте URL, он не уходит в запросы)
 */
function connectString(req: Request, token: string): string {
  const base = (getSetting('public_url') || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}#${token}`;
}

function serializePartner(p: any) {
  const { token_hash, ...rest } = p;
  return {
    ...rest,
    enabled: Boolean(p.enabled),
    suspended: Boolean(p.suspended),
    expired: PartnerService.isExpired(p),
    node_ids: PartnerService.nodeIds(p.id),
    usage: PartnerService.usage(p.id),
  };
}

function getPartnerOr404(id: number): any {
  const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(id) as any;
  if (!partner) throw new HttpError(404, 'Партнёр не найден');
  return partner;
}

function setNodes(partnerId: number, nodeIds: number[]) {
  db.prepare('DELETE FROM partner_nodes WHERE partner_id = ?').run(partnerId);
  const insert = db.prepare('INSERT INTO partner_nodes (partner_id, server_id) VALUES (?, ?)');
  for (const id of nodeIds) insert.run(partnerId, id);
}

partnersRouter.get('/', (req, res) => {
  const partners = db.prepare('SELECT * FROM partners ORDER BY id DESC').all() as any[];
  res.json(partners.map(serializePartner));
});

partnersRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  const name = validateName(body.name);
  const nodeIds = validateNodeIds(body.node_ids ?? []);
  const maxClients = validateNonNegativeInt(body.max_clients, 'Лимит клиентов');
  const trafficLimit = validateNonNegativeInt(body.traffic_limit, 'Лимит трафика');
  const expireAt = validateExpireAt(body.expire_at);
  const { token, hash, hint } = generatePartnerToken();

  const id = transaction(() => {
    const result = db.prepare(`
      INSERT INTO partners (name, token_hash, token_hint, max_clients, traffic_limit, expire_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, hash, hint, maxClients, trafficLimit, expireAt);
    const partnerId = Number(result.lastInsertRowid);
    setNodes(partnerId, nodeIds);
    return partnerId;
  });
  PartnerService.audit(id, 'created', `ноды: ${nodeIds.join(', ') || '—'}`, null);

  // Токен показывается один раз: в БД хранится только его хэш
  res.status(201).json({ partner: serializePartner(getPartnerOr404(id)), token, connect_string: connectString(req, token) });
});

partnersRouter.put('/:id', (req, res) => {
  const id = parseId(req.params.id);
  const partner = getPartnerOr404(id);
  const body = req.body ?? {};
  const name = body.name === undefined ? partner.name : validateName(body.name);
  const maxClients = body.max_clients === undefined ? partner.max_clients : validateNonNegativeInt(body.max_clients, 'Лимит клиентов');
  const trafficLimit =
    body.traffic_limit === undefined ? partner.traffic_limit : validateNonNegativeInt(body.traffic_limit, 'Лимит трафика');
  const expireAt = body.expire_at === undefined ? partner.expire_at : validateExpireAt(body.expire_at);
  const enabled = body.enabled === undefined ? partner.enabled : body.enabled ? 1 : 0;
  const nodeIds = body.node_ids === undefined ? null : validateNodeIds(body.node_ids);
  const previousNodes = PartnerService.nodeIds(id);

  transaction(() => {
    db.prepare('UPDATE partners SET name = ?, max_clients = ?, traffic_limit = ?, expire_at = ?, enabled = ? WHERE id = ?').run(
      name, maxClients, trafficLimit, expireAt, enabled, id
    );
    if (nodeIds) setNodes(id, nodeIds);
  });

  const changes: string[] = [];
  if (enabled !== partner.enabled) changes.push(enabled ? 'доступ включён' : 'доступ отключён');
  if (nodeIds && nodeIds.join(',') !== previousNodes.join(',')) changes.push(`ноды: ${nodeIds.join(', ') || '—'}`);
  if (maxClients !== partner.max_clients || trafficLimit !== partner.traffic_limit || expireAt !== partner.expire_at) {
    changes.push('лимиты изменены');
  }
  if (changes.length) PartnerService.audit(id, 'updated', changes.join('; '), null);

  PartnerService.refreshSuspension();
  // Отключение доступа или отзыв нод снимает клиентов партнёра с нод
  PartnerService.syncPartnerServers(id, previousNodes);
  res.json(serializePartner(getPartnerOr404(id)));
});

partnersRouter.post('/:id/regenerate-token', (req, res) => {
  const id = parseId(req.params.id);
  getPartnerOr404(id);
  const { token, hash, hint } = generatePartnerToken();
  db.prepare('UPDATE partners SET token_hash = ?, token_hint = ? WHERE id = ?').run(hash, hint, id);
  PartnerService.audit(id, 'token_regenerated', null, null);
  res.json({ partner: serializePartner(getPartnerOr404(id)), token, connect_string: connectString(req, token) });
});

partnersRouter.delete('/:id', (req, res) => {
  const id = parseId(req.params.id);
  getPartnerOr404(id);
  const servers = (db.prepare('SELECT DISTINCT server_id FROM clients WHERE partner_id = ?').all(id) as any[]).map((r) => r.server_id);
  // Клиенты партнёра удаляются каскадом и снимаются с нод
  db.prepare('DELETE FROM partners WHERE id = ?').run(id);
  PartnerService.syncPartnerServers(id, servers);
  res.json({ success: true });
});

partnersRouter.get('/:id/clients', (req, res) => {
  const id = parseId(req.params.id);
  getPartnerOr404(id);
  const clients = db.prepare(`
    SELECT c.id, c.server_id, s.name AS server_name, c.name, c.client_ip, c.enabled, c.owner_blocked,
      c.total_rx, c.total_tx, c.last_handshake, c.created_at
    FROM clients c JOIN servers s ON s.id = c.server_id
    WHERE c.partner_id = ? ORDER BY c.id DESC
  `).all(id) as any[];
  res.json(clients.map((c) => ({ ...c, enabled: Boolean(c.enabled), owner_blocked: Boolean(c.owner_blocked) })));
});

partnersRouter.get('/:id/audit', (req, res) => {
  const id = parseId(req.params.id);
  getPartnerOr404(id);
  res.json(db.prepare('SELECT id, action, details, ip, created_at FROM partner_audit WHERE partner_id = ? ORDER BY id DESC LIMIT 200').all(id));
});
