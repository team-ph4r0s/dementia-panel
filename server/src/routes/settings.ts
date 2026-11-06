import { Router } from 'express';
import net from 'node:net';
import { getSetting, setSetting, transaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { HttpError } from '../utils/http.js';
import { FailoverService } from '../services/failover.service.js';

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

export interface PanelSettings {
  public_url: string;
  /** База ссылок подписок: резервный домен (FailoverService), если включён, иначе пусто — ссылки от public_url */
  subscription_url: string;
  client_dns: string;
  client_mtu: number;
}

function readSettings(): PanelSettings {
  return {
    public_url: getSetting('public_url') || '',
    subscription_url: FailoverService.subscriptionBaseUrl() || '',
    client_dns: getSetting('client_dns') || '1.1.1.1, 8.8.8.8',
    client_mtu: Number(getSetting('client_mtu')) || 1280,
  };
}

settingsRouter.get('/', (req, res) => {
  res.json(readSettings());
});

settingsRouter.put('/', (req, res) => {
  const body = req.body ?? {};
  // Сначала проверяются все поля, затем записываются вместе: отклонённый запрос ничего не меняет
  const updates: [string, string | null][] = [];

  if (body.public_url !== undefined) {
    const value = String(body.public_url).trim().replace(/\/+$/, '');
    if (value) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new HttpError(400, 'Публичный адрес должен быть URL вида https://panel.example.com');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Допустимы только http:// и https://');
    }
    updates.push(['public_url', value || null]);
  }

  if (body.client_dns !== undefined) {
    const servers = String(body.client_dns).split(',').map((s) => s.trim()).filter(Boolean);
    if (servers.length === 0 || servers.length > 4 || servers.some((s) => !net.isIP(s))) {
      throw new HttpError(400, 'DNS: от 1 до 4 IP-адресов через запятую');
    }
    updates.push(['client_dns', servers.join(', ')]);
  }

  if (body.client_mtu !== undefined) {
    const mtu = Number(body.client_mtu);
    if (!Number.isInteger(mtu) || mtu < 576 || mtu > 1500) throw new HttpError(400, 'MTU должен быть от 576 до 1500');
    updates.push(['client_mtu', String(mtu)]);
  }

  transaction(() => {
    for (const [key, value] of updates) setSetting(key, value);
  });
  res.json(readSettings());
});
