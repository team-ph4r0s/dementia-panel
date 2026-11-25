import { db } from '../db/index.js';
import type { SubscriberRow } from '../db/types.js';
import { ProvisionService } from './provision.service.js';

export interface SubscriberUsage {
  upload: number;
  download: number;
  used: number;
}

export class SubscriptionService {
  /**
   * Трафик подписчика по всем нодам: rx сервера = upload клиента, tx сервера = download клиента
   */
  static getUsage(subscriberId: number): SubscriberUsage {
    const row = db.prepare(`
      SELECT COALESCE(SUM(total_rx), 0) AS rx, COALESCE(SUM(total_tx), 0) AS tx
      FROM clients WHERE subscriber_id = ?
    `).get(subscriberId) as { rx: number; tx: number };
    return { upload: row.rx, download: row.tx, used: row.rx + row.tx };
  }

  static isExpired(sub: { expire_at: string | null }): boolean {
    return Boolean(sub.expire_at) && new Date(sub.expire_at as string).getTime() <= Date.now();
  }

  static isOverLimit(sub: { traffic_limit: number }, usage: SubscriberUsage): boolean {
    return sub.traffic_limit > 0 && usage.used >= sub.traffic_limit;
  }

  /**
   * Пересчитать признак приостановки (истёк срок / превышен лимит) и синхронизировать затронутые ноды
   */
  static refreshSuspension(subscriberId?: number): void {
    const subs = (subscriberId
      ? db.prepare('SELECT * FROM subscribers WHERE id = ?').all(subscriberId)
      : db.prepare('SELECT * FROM subscribers').all()) as unknown as SubscriberRow[];

    for (const sub of subs) {
      const usage = this.getUsage(sub.id);
      const suspended = this.isExpired(sub) || this.isOverLimit(sub, usage) ? 1 : 0;
      if (suspended === sub.suspended) continue;

      db.prepare('UPDATE subscribers SET suspended = ? WHERE id = ?').run(suspended, sub.id);
      const servers = db.prepare(`
        SELECT DISTINCT c.server_id FROM clients c JOIN servers s ON s.id = c.server_id
        WHERE c.subscriber_id = ? AND s.status != 'uninstalled'
      `).all(sub.id) as { server_id: number }[];
      for (const { server_id } of servers) {
        ProvisionService.requestSync(server_id).catch(() => {});
      }
      console.log(`[SUB] Подписка "${sub.name}" ${suspended ? 'приостановлена (срок/лимит)' : 'возобновлена'}`);
    }
  }
}
