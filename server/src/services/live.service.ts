import type { NextFunction, Request, Response } from 'express';
import { WebSocket } from 'ws';

/**
 * Живое обновление интерфейса: открытые WebSocket администраторов получают сообщение {type: 'changed'}, когда в панели что-то
 * изменилось (ответ API на запись, итог опроса нод, проверок из стран, синхронизации с партнёрами), и сами перезапрашивают
 * данные обычными защищёнными запросами. В сообщении нет данных — ни секретов, ни состояния нод, поэтому его нечем утечь, а
 * гостевой доступ (инвариант 41) не затрагивается: гость WebSocket не открывает и продолжает опрашивать API.
 */
export type LiveScope = 'servers' | 'clients' | 'subscribers' | 'bridges' | 'settings' | 'migration' | 'security' | 'other';

interface LiveClient {
  ws: WebSocket;
  /** Сессия по-прежнему действительна: сокет закрывается, когда администратор вышел или сессию отозвали */
  valid: () => boolean;
  alive: boolean;
}

const DEBOUNCE_MS = 250;
const PING_INTERVAL_MS = 30_000;

const clients = new Set<LiveClient>();
let timer: NodeJS.Timeout | null = null;
let pinger: NodeJS.Timeout | null = null;
let pendingScopes = new Set<LiveScope>();
let pendingFull = false;

export function scopesForApiPath(apiPath: string): LiveScope[] {
  const normalized = apiPath.replace(/^\/api(?=\/|$)/, '') || '/';
  if (normalized === '/servers' || normalized.startsWith('/servers/')) return ['servers', 'clients'];
  if (normalized === '/clients' || normalized.startsWith('/clients/')) return ['clients', 'servers'];
  if (normalized === '/subscribers' || normalized.startsWith('/subscribers/')) return ['subscribers', 'servers'];
  if (normalized === '/bridges' || normalized.startsWith('/bridges/')) return ['bridges', 'servers'];
  if (normalized === '/probes' || normalized.startsWith('/probes/')) return ['servers', 'bridges'];
  if (normalized === '/settings' || normalized.startsWith('/settings/') || normalized === '/subscription-settings' || normalized.startsWith('/subscription-settings/')) {
    return ['settings'];
  }
  if (normalized === '/migration' || normalized.startsWith('/migration/')) return ['migration'];
  if (normalized === '/security' || normalized.startsWith('/security/')) return ['security', 'settings'];
  if (normalized === '/partners' || normalized.startsWith('/partners/') || normalized === '/remote-panels' || normalized.startsWith('/remote-panels/')) {
    return ['servers', 'other'];
  }
  return ['other'];
}

function broadcast(): void {
  timer = null;
  const payload = !pendingFull && pendingScopes.size > 0
    ? JSON.stringify({ type: 'changed', scopes: [...pendingScopes] })
    : JSON.stringify({ type: 'changed' });
  pendingScopes.clear();
  pendingFull = false;

  for (const client of [...clients]) {
    if (client.ws.readyState !== WebSocket.OPEN) {
      clients.delete(client);
    } else if (!client.valid()) {
      client.ws.close(4401, 'session expired');
      clients.delete(client);
    } else {
      client.ws.send(payload);
    }
  }
}

function startPinger(): void {
  if (pinger) return;
  // Обрыв без закрытия (спящий ноутбук, пропавший Wi-Fi) иначе держал бы сокет вечно
  pinger = setInterval(() => {
    for (const client of [...clients]) {
      if (!client.alive) {
        client.ws.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        client.ws.terminate();
        clients.delete(client);
      }
    }
    if (clients.size === 0 && pinger) {
      clearInterval(pinger);
      pinger = null;
    }
  }, PING_INTERVAL_MS);
  pinger.unref();
}

export class LiveService {
  /** Подписывает уже авторизованный сокет администратора */
  static add(ws: WebSocket, valid: () => boolean): void {
    const client: LiveClient = { ws, valid, alive: true };
    clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('close', () => clients.delete(client));
    startPinger();
  }

  /** Сообщает подписчикам об изменениях; подряд идущие вызовы сливаются в одну рассылку */
  static notify(scope?: LiveScope | LiveScope[]): void {
    if (!scope) {
      pendingFull = true;
    } else if (!pendingFull) {
      const list = Array.isArray(scope) ? scope : [scope];
      for (const item of list) pendingScopes.add(item);
    }
    if (clients.size === 0) {
      pendingScopes.clear();
      pendingFull = false;
      return;
    }
    if (timer) return;
    timer = setTimeout(broadcast, DEBOUNCE_MS);
    timer.unref();
  }

  /** Сразу закрывает сокеты, чья сессия больше не действительна (выход, отзыв сессии, смена пароля или логина) */
  static dropInvalid(): void {
    for (const client of [...clients]) {
      if (client.ws.readyState === WebSocket.OPEN && client.valid()) continue;
      if (client.ws.readyState === WebSocket.OPEN) client.ws.close(4401, 'session expired');
      clients.delete(client);
    }
  }

  /** Завершение работы сервера: останавливает таймеры и закрывает открытые сокеты */
  static shutdown(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pinger) {
      clearInterval(pinger);
      pinger = null;
    }
    pendingScopes.clear();
    pendingFull = false;
    for (const client of [...clients]) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.close(1001, 'server shutting down');
      }
      clients.delete(client);
    }
  }

  static get subscribers(): number {
    return clients.size;
  }

  /** Express: после успешной записи через API (не GET) интерфейсы всех администраторов обновляются сразу */
  static middleware(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      const scopes = scopesForApiPath(req.path);
      res.on('finish', () => {
        if (res.statusCode < 400) LiveService.notify(scopes);
      });
    }
    next();
  }
}
