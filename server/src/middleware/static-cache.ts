import path from 'node:path';
import type { ServerResponse } from 'node:http';
import express, { type Express } from 'express';

/**
 * Заголовки кеширования статики интерфейса (в том числе для PWA на телефонах):
 * - `/assets/*` — файлы сборки с хэшем в имени, меняются вместе с именем: кешируются на год;
 * - `sw.js`, `index.html`, `manifest.webmanifest` — всегда с проверкой: иначе телефон не узнает об обновлении панели (сервис-воркер,
 *   который «залип» в кеше, нельзя заменить, а оболочка укажет на уже удалённые файлы);
 * - остальное (иконки, favicon) — час.
 */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'no-cache';
export const SHORT = 'public, max-age=3600';

const ALWAYS_REVALIDATE = new Set(['sw.js', 'index.html', 'manifest.webmanifest']);

export function staticCacheControl(distRoot: string, filePath: string): string {
  const relative = path.relative(distRoot, filePath).split(path.sep);
  if (relative[0] === 'assets') return IMMUTABLE;
  if (relative.length === 1 && ALWAYS_REVALIDATE.has(relative[0])) return REVALIDATE;
  return SHORT;
}

export function staticHeaders(distRoot: string) {
  return (res: ServerResponse, filePath: string): void => {
    res.setHeader('Cache-Control', staticCacheControl(distRoot, filePath));
  };
}

export function serveSpa(app: Express, distRoot: string): void {
  app.use(express.static(distRoot, { setHeaders: staticHeaders(distRoot) }));
  app.get('/{*splat}', (_req, res) => {
    res.setHeader('Cache-Control', REVALIDATE);
    res.sendFile(path.join(distRoot, 'index.html'));
  });
}
