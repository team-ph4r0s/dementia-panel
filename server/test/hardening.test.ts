import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../src/db/index.js';
import { AuthService } from '../src/services/auth.service.js';
import { CloudflarePanelService } from '../src/services/cloudflare-panel.service.js';
import { sanitizeRemoteNode, sanitizeRemotePeer } from '../src/services/federation-client.service.js';
import { AmneziaKeyError, decodeAmneziaKey, encodeAmneziaKey } from '../src/utils/amnezia-key.js';
import { isValidSignature, sanitizeRemoteParams } from '../src/utils/awg-params.js';
import { CONTENT_SECURITY_POLICY } from '../src/middleware/security-headers.js';
import { startTestServer } from './test-app.js';

/**
 * Результаты аудита: обработка ошибок HTTP, заголовки безопасности, проверка чужих данных, лимиты распаковки.
 */

const KEY = 'A'.repeat(43) + '=';
const PARAMS = { awg_version: 3, jc: 4, jmin: 40, jmax: 70, s1: 36, s2: 124, s3: 15, s4: 16, h1: '100-200', h2: '300-400', h3: '500-600', h4: '700-800' };

describe('обработчик ошибок и заголовки безопасности', () => {
  let env: Awaited<ReturnType<typeof startTestServer>>;
  let token: string;

  beforeAll(async () => {
    initDatabase();
    AuthService.resetAdmin('admin_hardening', 'TestPassword123!');
    token = AuthService.login('admin_hardening', 'TestPassword123!')!.token;
    env = await startTestServer();
  });
  afterAll(async () => {
    await env.close();
  });

  const call = (path: string, init: RequestInit = {}) =>
    env.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });

  it('битая %-кодировка в пути — 400, а не 500', async () => {
    const res = await call('/api/servers/%');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Некорректный запрос');
  });

  it('некорректный JSON — 400, слишком большое тело — 413', async () => {
    const broken = await call('/api/subscribers', { method: 'POST', body: '{' });
    expect(broken.status).toBe(400);
    expect((await broken.json()).error).toContain('JSON');

    const huge = await call('/api/subscribers', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(2_000_000) }) });
    expect(huge.status).toBe(413);
  });

  it('вход без тела и с текстовым телом возвращает JSON-ошибку', async () => {
    for (const options of [{}, { headers: { 'Content-Type': 'text/plain' }, body: 'text' }]) {
      const res = await env.request('/api/auth/login', { method: 'POST', ...options });
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({ error: 'Логин и пароль обязательны' });
    }
  });

  it('роут Cloudflare получает пустой объект без разобранного тела', async () => {
    const configure = vi.spyOn(CloudflarePanelService, 'configure');
    try {
      for (const options of [{}, { headers: { 'Content-Type': 'text/plain' }, body: 'text' }]) {
        const res = await env.request('/api/security/cloudflare', {
          method: 'POST', ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers },
        });
        expect(res.status).toBe(400);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect((await res.json()).error).toEqual(expect.any(String));
        expect(configure).toHaveBeenLastCalledWith({});
      }
    } finally {
      configure.mockRestore();
    }
  });

  it('ответы содержат CSP без внешних источников, запрет iframe и nosniff', async () => {
    const res = await env.request('/api/health');
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|\*/);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('isValidSignature', () => {
  it('принимает цепочку тегов и отклоняет перевод строки', () => {
    expect(isValidSignature('<b 0x0102><r 16><t>')).toBe(true);
    expect(isValidSignature('<b 0x0102> <r 16>')).toBe(true);
    expect(isValidSignature('<b 0x01>\n<r 5>')).toBe(false);
    expect(isValidSignature('<b 0x01>\r\nPostUp = id')).toBe(false);
  });
});

describe('sanitizeRemoteParams', () => {
  it('нормализует корректные параметры и отбрасывает неизвестные дополнительные', () => {
    const params = sanitizeRemoteParams({
      ...PARAMS, h1: ' 100 - 200 ', i1: '<b 0x01>', header_protection_key: KEY,
      extra_params: { RekeyTimeout: 10, Unknown: 'x', RandomTrailers: 'on' },
    });
    expect(params.h1).toBe('100-200');
    expect(params.i1).toBe('<b 0x01>');
    expect(params.extra_params).toEqual({ RekeyTimeout: '10', RandomTrailers: 'on' });
    expect(params.awg_version).toBe(3);
  });

  it('допускает параметры AWG 1.x без необязательных полей', () => {
    const params = sanitizeRemoteParams({ jc: 4, jmin: 40, jmax: 70, s1: 36, s2: 124, h1: '1000', h2: '2000', h3: '3000', h4: '4000' });
    expect(params).toMatchObject({ awg_version: 1, s3: null, s4: null, i1: null, header_protection_key: null, extra_params: {} });
  });

  it.each([
    ['перевод строки в H', { h1: '100\nPostUp = id' }],
    ['директива в H', { h2: '5 PostUp = id' }],
    ['перевод строки в I1', { i1: '<b 0x01>\n<r 5>' }],
    ['не тег в I2', { i2: 'PostUp = id' }],
    ['строка вместо числа', { jc: '4\nPostUp = id' }],
    ['дробное число', { s1: 1.5 }],
    ['слишком большое число', { jmax: 70000 }],
    ['объект вместо числа', { s2: { a: 1 } }],
    ['ключ защиты заголовков', { header_protection_key: 'BAD\nPostUp = id' }],
    ['значение дополнительного параметра', { extra_params: { RekeyTimeout: '10\nPostUp = id' } }],
    ['массив вместо extra_params', { extra_params: ['x'] }],
  ])('отклоняет: %s', (_name, patch) => {
    expect(() => sanitizeRemoteParams({ ...PARAMS, ...patch })).toThrow();
  });

  it('отклоняет не объект', () => {
    for (const value of [null, undefined, 'x', 5, []]) expect(() => sanitizeRemoteParams(value)).toThrow();
  });
});

describe('sanitizeRemoteNode / sanitizeRemotePeer', () => {
  const node = { id: 7, name: 'Нода', host: 'vpn.example.com', port: 51820, public_key: KEY, status: 'online', params: PARAMS };

  it('принимает корректную ноду и очищает название', () => {
    const clean = sanitizeRemoteNode({ ...node, name: '  Нода\n#1\t' });
    expect(clean).toMatchObject({ id: 7, host: 'vpn.example.com', port: 51820, publicKey: KEY, status: 'online' });
    expect(clean.name).toBe('Нода #1');
    expect(sanitizeRemoteNode({ ...node, public_key: null }).publicKey).toBeNull();
  });

  it.each([
    ['хост с переводом строки', { host: '1.2.3.4\nPostUp = id' }],
    ['хост с пробелом и командой', { host: 'a.example.com; id' }],
    ['порт-строка', { port: '51820; id' }],
    ['порт вне диапазона', { port: 70000 }],
    ['ключ с директивой', { public_key: 'x\nPostUp = id' }],
    ['идентификатор не число', { id: 'a' }],
  ])('отклоняет: %s', (_name, patch) => {
    expect(() => sanitizeRemoteNode({ ...node, ...patch })).toThrow();
  });

  it('клиент: проверяет IP, PSK и счётчики', () => {
    const peer = { id: 3, client_ip: '10.50.0.2', preshared_key: KEY, total_rx: 5, total_tx: 6, last_handshake: '2026-01-01T00:00:00.000Z' };
    expect(sanitizeRemotePeer(peer)).toMatchObject({ id: 3, clientIp: '10.50.0.2', presharedKey: KEY, totalRx: 5, totalTx: 6 });
    expect(sanitizeRemotePeer({ ...peer, preshared_key: null, total_rx: 'x', total_tx: -1, last_handshake: { a: 1 } })).toMatchObject({
      presharedKey: null, totalRx: 0, totalTx: 0, lastHandshake: null,
    });
    for (const bad of [{ client_ip: '10.50.0.2/32' }, { client_ip: '10.50.0.2\nPostUp = id' }, { client_ip: '::1' }, { preshared_key: 'short' }, { id: 0 }]) {
      expect(() => sanitizeRemotePeer({ ...peer, ...bad })).toThrow();
    }
  });
});

describe('ключ AmneziaVPN', () => {
  it('«бомба» с огромным распакованным размером отклоняется', () => {
    const bomb = 'vpn://' + Buffer.concat([Buffer.alloc(4), zlib.deflateSync(Buffer.from('{"a":"' + 'A'.repeat(8 * 1024 * 1024) + '"}'))]).toString('base64url');
    expect(() => decodeAmneziaKey(bomb)).toThrow(AmneziaKeyError);
  });

  it('обычный ключ по-прежнему читается', () => {
    const key = encodeAmneziaKey({ hostName: '203.0.113.5', userName: 'root', password: 'secret', port: 22, description: 'Test' });
    expect(decodeAmneziaKey(key)).toMatchObject({ host: '203.0.113.5', username: 'root', password: 'secret', port: 22 });
  });
});
