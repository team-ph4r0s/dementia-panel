import type { NextFunction, Request, Response } from 'express';
import type { TLSSocket } from 'node:tls';

/**
 * Интерфейс собран в один скрипт и один CSS без внешних ресурсов; QR-коды — data:-изображения,
 * логи установки — WebSocket. Всё остальное, включая внешние скрипты и встраивание в iframe, запрещено.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  if (/^\/(api|sub)(\/|$)/i.test(req.path ?? req.originalUrl ?? req.url ?? '')) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
    res.setHeader('CDN-Cache-Control', 'no-store');
  }
  if ((req.socket as TLSSocket).encrypted) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
}
