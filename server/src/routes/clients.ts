import { Router } from 'express';
import QRCode from 'qrcode';
import { db, transaction } from '../db/index.js';
import { AwgService } from '../services/awg.service.js';
import { ProvisionService } from '../services/provision.service.js';
import { PartnerService } from '../services/partner.service.js';
import { asyncHandler, contentDisposition, HttpError, parseId } from '../utils/http.js';
import { isPendingIp, pendingIp } from '../services/federation-client.service.js';

export const clientsRouter = Router();

/**
 * Клиент без приватного ключа — ключ нужен только в конфиге/QR
 */
export function serializeClient(c: any) {
  if (!c) return c;
  const { client_private_key, client_uuid, rx_counter, tx_counter, ...rest } = c;
  return {
    ...rest,
    external: Boolean(c.external),
    owner_blocked: Boolean(c.owner_blocked),
    pending: isPendingIp(c.client_ip),
    client_ip: isPendingIp(c.client_ip) ? '' : c.client_ip,
  };
}

function getClientOr404(id: number): any {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as any;
  if (!client) throw new HttpError(404, 'Клиент не найден');
  return client;
}

function validateClientName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Имя клиента обязательно');
  if (name.trim().length > 64) throw new HttpError(400, 'Имя клиента не длиннее 64 символов');
  return name.trim();
}

function syncIfInstalled(serverId: number): void {
  // Нода партнёра: изменения передаются панели владельца (status у неё может быть любым)
  const server = db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId) as { status: string } | undefined;
  if (server && server.status !== 'uninstalled') {
    ProvisionService.requestSync(serverId).catch((err) => console.error(`Ошибка синхронизации сервера #${serverId}:`, err));
  }
}

// GET all clients for server
clientsRouter.get('/servers/:serverId/clients', (req, res) => {
  const clients = db.prepare(`
    SELECT c.*, p.name AS partner_name FROM clients c
    LEFT JOIN partners p ON p.id = c.partner_id
    WHERE c.server_id = ?
    ORDER BY c.id DESC
  `).all(parseId(req.params.serverId));
  res.json(clients.map(serializeClient));
});

// POST create client for server
clientsRouter.post('/servers/:serverId/clients', asyncHandler(async (req, res) => {
  const serverId = parseId(req.params.serverId);
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
  if (!server) throw new HttpError(404, 'Сервер не найден');

  const rawName = req.body?.name;
  const name = rawName === undefined || rawName === '' ? `client-${Date.now().toString().slice(-4)}` : validateClientName(rawName);

  const keyPair = AwgService.generateKeyPair();
  const psk = AwgService.generatePresharedKey();

  if (server.remote_panel_id && server.status === 'uninstalled') throw new HttpError(409, 'Нода партнёра сейчас недоступна');
  const newClient: any = transaction(() => {
    const clientIp = server.remote_panel_id ? pendingIp() : AwgService.getNextClientIp(serverId, server.subnet);
    const result = db.prepare(`
      INSERT INTO clients (
        server_id, name, client_ip, client_public_key, client_private_key, preshared_key, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(serverId, name, clientIp, keyPair.publicKey, keyPair.privateKey, psk);
    return db.prepare('SELECT * FROM clients WHERE id = ?').get(result.lastInsertRowid);
  });

  if (server.remote_panel_id) {
    // Ждём, пока панель владельца выдаст IP, чтобы сразу показать конфиг и QR
    await ProvisionService.requestSync(serverId);
  } else {
    syncIfInstalled(serverId);
  }
  res.status(201).json(serializeClient(db.prepare('SELECT * FROM clients WHERE id = ?').get(newClient.id)));
}));

// PUT update client (toggle enable, change name)
clientsRouter.put('/clients/:id', (req, res) => {
  const id = parseId(req.params.id);
  const client = getClientOr404(id);
  const { name, enabled } = req.body ?? {};

  const newName = name === undefined ? client.name : validateClientName(name);

  if (client.partner_id) {
    const blocked = enabled === undefined ? client.owner_blocked : enabled ? 0 : 1;
    db.prepare('UPDATE clients SET name = ?, owner_blocked = ? WHERE id = ?').run(newName, blocked, id);
    if (blocked !== client.owner_blocked) {
      PartnerService.audit(client.partner_id, blocked ? 'owner_blocked' : 'owner_unblocked', client.name, null);
      syncIfInstalled(client.server_id);
    }
    return res.json(serializeClient(db.prepare('SELECT * FROM clients WHERE id = ?').get(id)));
  }

  const newEnabled = enabled === undefined ? client.enabled : enabled ? 1 : 0;
  db.prepare('UPDATE clients SET name = ?, enabled = ? WHERE id = ?').run(newName, newEnabled, id);
  // На ноде партнёра имя видит и владелец, поэтому переименование тоже передаётся ему
  const remote = Boolean((db.prepare('SELECT remote_panel_id FROM servers WHERE id = ?').get(client.server_id) as any)?.remote_panel_id);
  if (newEnabled !== client.enabled || (remote && newName !== client.name)) syncIfInstalled(client.server_id);

  res.json(serializeClient(db.prepare('SELECT * FROM clients WHERE id = ?').get(id)));
});

// DELETE client
clientsRouter.delete('/clients/:id', (req, res) => {
  const id = parseId(req.params.id);
  const client = getClientOr404(id);
  if (client.partner_id) {
    throw new HttpError(409, 'Клиента партнёра нельзя удалить — партнёр создаст его снова. Заблокируйте клиента или отзовите доступ партнёра.');
  }

  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  syncIfInstalled(client.server_id);

  res.json({ success: true, message: 'Клиент удален' });
});

function loadClientWithServer(id: number) {
  const client = getClientOr404(id);
  if (client.partner_id) {
    throw new HttpError(409, 'Клиент создан панелью партнёра — его конфигурация есть только у партнёра.');
  }
  if (isPendingIp(client.client_ip)) {
    throw new HttpError(409, 'Клиент ещё не создан на ноде партнёра — повторите через минуту.');
  }
  if (client.external) {
    throw new HttpError(409, 'Клиент импортирован из существующей установки — его приватный ключ панели неизвестен. Создайте нового клиента, чтобы получить конфигурацию.');
  }
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(client.server_id) as any;
  if (!server) throw new HttpError(404, 'Сервер не найден');
  return { client, server };
}

// GET client .conf configuration file
clientsRouter.get('/clients/:id/config', (req, res) => {
  const { client, server } = loadClientWithServer(parseId(req.params.id));
  const configText = AwgService.generateClientConfig(server, client);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition('attachment', `${client.name}.conf`));
  res.setHeader('Cache-Control', 'no-store');
  res.send(configText);
});

// GET QR code as base64 Data URL (PNG)
clientsRouter.get('/clients/:id/qrcode', asyncHandler(async (req, res) => {
  const { client, server } = loadClientWithServer(parseId(req.params.id));
  const configText = AwgService.generateClientConfig(server, client);

  const dataUrl = await QRCode.toDataURL(configText, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 380,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  });

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    qrcode: dataUrl,
    config: configText,
    clientName: client.name,
  });
}));
