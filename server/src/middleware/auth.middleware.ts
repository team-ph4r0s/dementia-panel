import { Request, Response, NextFunction } from 'express';
import { AuthService, type SessionUser } from '../services/auth.service.js';

export interface AuthenticatedRequest extends Request {
  user?: SessionUser;
}

export function getBearerToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  return undefined;
}

/**
 * Гостю разрешено только чтение этих адресов (белый список: новый маршрут по умолчанию для гостя закрыт).
 * Нет здесь намеренно: конфиги и QR клиентов, ссылки подписок, резервные копии, перенос панели, Telegram,
 * настройки HTTPS и входа, список сессий, журнал обновления — всё, из чего можно получить секрет или управлять панелью.
 */
const GUEST_READABLE: RegExp[] = [
  /^\/api\/auth\/me$/,
  /^\/api\/servers$/,
  /^\/api\/servers\/\d+$/,
  /^\/api\/servers\/\d+\/clients$/,
  /^\/api\/subscribers$/,
  /^\/api\/settings$/,
  /^\/api\/probes$/,
  /^\/api\/probes\/countries$/,
  /^\/api\/bridges$/,
  /^\/api\/events$/,
  /^\/api\/partners$/,
  /^\/api\/partners\/\d+\/(clients|audit)$/,
  /^\/api\/remote-panels$/,
  /^\/api\/version$/,
];

/** Поля, которые гость не видит ни в одном ответе (токены подписок дают рабочие конфиги с приватными ключами) */
const GUEST_HIDDEN_FIELDS = new Set([
  'token', 'token_hash', 'preshared_key', 'client_private_key', 'server_private_key', 'client_uuid',
  'ssh_password', 'ssh_key', 'password', 'private_key', 'stub_token',
]);

function redactForGuest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForGuest);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!GUEST_HIDDEN_FIELDS.has(key)) result[key] = redactForGuest(item);
    }
    return result;
  }
  return value;
}

export function isGuestAllowed(method: string, path: string): boolean {
  if (method === 'POST' && path === '/api/auth/logout') return true;
  if (method !== 'GET' && method !== 'HEAD') return false;
  return GUEST_READABLE.some((pattern) => pattern.test(path));
}

// Токен принимается только из заголовка Authorization: в URL он утекает в историю браузера и логи прокси
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }

  const user = AuthService.validateSession(token);
  if (!user) {
    return res.status(401).json({ error: 'Сессия истекла или недействительна' });
  }

  if (user.role === 'guest') {
    // Путь без строки запроса и без хвостового слэша; всё, что не совпало дословно (регистр, %-коды), отклоняется
    const path = req.originalUrl.split('?')[0].replace(/(.)\/+$/, '$1');
    if (!isGuestAllowed(req.method, path)) {
      return res.status(403).json({ error: 'Гостевой доступ: только просмотр', guest: true });
    }
    const json = res.json.bind(res);
    res.json = (body?: unknown) => json(redactForGuest(body));
  }

  req.user = user;
  AuthService.touchSession(token);
  next();
}
