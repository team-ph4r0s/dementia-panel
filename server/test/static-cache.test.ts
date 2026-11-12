import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMMUTABLE, REVALIDATE, SHORT, serveSpa, staticCacheControl } from '../src/middleware/static-cache.js';

/**
 * Кеширование статики интерфейса. Если сервис-воркер или оболочка закешируются надолго, телефоны с установленным приложением
 * перестанут получать обновления панели, поэтому проверяется настоящая раздача через express.static (в том числе тип манифеста).
 */

const root = path.resolve('/srv/dist');

describe('staticCacheControl', () => {
  it('файлы сборки с хэшем — на год, неизменяемые', () => {
    expect(staticCacheControl(root, path.join(root, 'assets', 'index-AbC123.js'))).toBe(IMMUTABLE);
    expect(staticCacheControl(root, path.join(root, 'assets', 'fonts', 'onest.woff2'))).toBe(IMMUTABLE);
  });

  it('сервис-воркер, оболочка и манифест — всегда с проверкой', () => {
    for (const file of ['sw.js', 'index.html', 'manifest.webmanifest']) {
      expect(staticCacheControl(root, path.join(root, file)), file).toBe(REVALIDATE);
    }
  });

  it('файл с таким же именем в подкаталоге не считается сервис-воркером; иконки — на час', () => {
    expect(staticCacheControl(root, path.join(root, 'docs', 'sw.js'))).toBe(SHORT);
    expect(staticCacheControl(root, path.join(root, 'icon-192.png'))).toBe(SHORT);
    expect(staticCacheControl(root, path.join(root, 'favicon.svg'))).toBe(SHORT);
  });
});

describe('раздача через express.static', () => {
  let dir: string;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-static-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(dir, 'sw.js'), 'self.addEventListener("fetch",()=>{});');
    fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), '{"name":"x"}');
    fs.writeFileSync(path.join(dir, 'assets', 'app-1a2b3c.js'), 'console.log(1)');
    const app = express();
    serveSpa(app, dir);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sw.js — JavaScript без долгого кеша; манифест — application/manifest+json', async () => {
    const sw = await fetch(`${base}/sw.js`);
    expect(sw.headers.get('cache-control')).toBe(REVALIDATE);
    expect(sw.headers.get('content-type')).toMatch(/javascript/);
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.headers.get('cache-control')).toBe(REVALIDATE);
    expect(manifest.headers.get('content-type')).toMatch(/application\/manifest\+json/);
  });

  it('файлы сборки отдаются с immutable', async () => {
    const asset = await fetch(`${base}/assets/app-1a2b3c.js`);
    expect(asset.headers.get('cache-control')).toBe(IMMUTABLE);
  });

  it('глубокая ссылка возвращает оболочку SPA с проверкой кеша', async () => {
    const response = await fetch(`${base}/servers/5`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(REVALIDATE);
    expect(await response.text()).toBe('<!doctype html>');
  });
});
