import crypto from 'node:crypto';
import { db } from '../db/index.js';
import type { ClientRow, PartnerRow, ServerRow } from '../db/types.js';
import { paramsFromRow } from '../utils/awg-params.js';
import { ProvisionService } from './provision.service.js';

/**
 * Партнёрский доступ (сторона владельца нод): другая панель по токену создаёт клиентов на выбранных нодах.
 * Приватные ключи клиентов партнёра сюда не передаются — только публичные.
 */

export const TOKEN_PREFIX = 'dp_';

export function hashPartnerToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generatePartnerToken(): { token: string; hash: string; hint: string } {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashPartnerToken(token), hint: `${token.slice(0, 7)}…${token.slice(-4)}` };
}

export interface PartnerUsage {
  clients: number;
  upload: number;
  download: number;
  used: number;
}

interface ServerIdProjection {
  server_id: number;
}

interface PartnerUsageProjection {
  clients: number;
  rx: number;
  tx: number;
}

export class PartnerService {
  static findByToken(token: string): PartnerRow | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    return (db.prepare('SELECT * FROM partners WHERE token_hash = ?').get(hashPartnerToken(token)) as unknown as PartnerRow | undefined) || null;
  }

  static usage(partnerId: number): PartnerUsage {
    const row = db.prepare(`
      SELECT COUNT(*) AS clients, COALESCE(SUM(total_rx), 0) AS rx, COALESCE(SUM(total_tx), 0) AS tx
      FROM clients WHERE partner_id = ?
    `).get(partnerId) as unknown as PartnerUsageProjection;
    return { clients: row.clients, upload: row.rx, download: row.tx, used: row.rx + row.tx };
  }

  static isExpired(partner: { expire_at: string | null }): boolean {
    return Boolean(partner.expire_at) && new Date(partner.expire_at as string).getTime() <= Date.now();
  }

  static nodeIds(partnerId: number): number[] {
    return (db.prepare('SELECT server_id FROM partner_nodes WHERE partner_id = ? ORDER BY server_id').all(partnerId) as unknown as ServerIdProjection[]).map(
      (r) => r.server_id
    );
  }

  static audit(partnerId: number, action: string, details: string | null, ip: string | null): void {
    db.prepare('INSERT INTO partner_audit (partner_id, action, details, ip) VALUES (?, ?, ?, ?)').run(partnerId, action, details, ip);
    // Журнал ограничен последними 1000 записями на партнёра
    db.prepare(`
      DELETE FROM partner_audit WHERE partner_id = ? AND id NOT IN (
        SELECT id FROM partner_audit WHERE partner_id = ? ORDER BY id DESC LIMIT 1000
      )
    `).run(partnerId, partnerId);
  }

  /**
   * Синхронизация нод, на которых есть клиенты партнёра (после отзыва, блокировки, удаления)
   */
  static syncPartnerServers(partnerId: number, extraServerIds: number[] = []): void {
    const ids = new Set<number>(extraServerIds);
    for (const row of db.prepare('SELECT DISTINCT server_id FROM clients WHERE partner_id = ?').all(partnerId) as unknown as ServerIdProjection[]) {
      ids.add(row.server_id);
    }
    for (const id of ids) {
      const server = db.prepare('SELECT status FROM servers WHERE id = ?').get(id) as unknown as Pick<ServerRow, 'status'> | undefined;
      if (server && server.status !== 'uninstalled') ProvisionService.requestSync(id).catch(() => {});
    }
  }

  /**
   * Пересчёт приостановки партнёров по сроку и лимиту трафика; клиенты приостановленного партнёра
   * снимаются с нод (см. ProvisionService.getServerClients)
   */
  static refreshSuspension(): void {
    for (const partner of db.prepare('SELECT * FROM partners').all() as unknown as PartnerRow[]) {
      const usage = this.usage(partner.id);
      const suspended = this.isExpired(partner) || (partner.traffic_limit > 0 && usage.used >= partner.traffic_limit) ? 1 : 0;
      if (suspended === partner.suspended) continue;
      db.prepare('UPDATE partners SET suspended = ? WHERE id = ?').run(suspended, partner.id);
      this.audit(partner.id, suspended ? 'suspended' : 'resumed', suspended ? 'срок истёк или исчерпан лимит трафика' : null, null);
      this.syncPartnerServers(partner.id);
    }
  }

  /**
   * Описание ноды для панели партнёра: адрес, ключ и параметры обфускации (без приватных данных)
   */
  static nodePayload(server: ServerRow) {
    const params = paramsFromRow(server);
    return {
      id: server.id,
      name: server.sub_name || server.name,
      host: server.host,
      port: server.awg_port,
      public_key: server.server_public_key,
      status: server.status,
      params,
    };
  }

  static peerPayload(client: ClientRow) {
    return {
      id: client.id,
      node_id: client.server_id,
      name: client.name,
      remote_ref: client.remote_ref,
      public_key: client.client_public_key,
      client_ip: client.client_ip,
      preshared_key: client.preshared_key,
      enabled: Boolean(client.enabled),
      owner_blocked: Boolean(client.owner_blocked),
      total_rx: client.total_rx,
      total_tx: client.total_tx,
      last_handshake: client.last_handshake,
    };
  }
}
