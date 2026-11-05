import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generate } from 'selfsigned';
import { db, getSetting, initDatabase, setSetting } from '../src/db/index.js';
import { SslService, certPath } from '../src/services/ssl.service.js';
import { CloudflarePanelService } from '../src/services/cloudflare-panel.service.js';
import { PanelIngressService } from '../src/services/panel-ingress.service.js';
import { EventService } from '../src/services/event.service.js';
import { cloudflareClientIp, isCloudflareAddress } from '../src/middleware/cloudflare.js';
import { encryptSecret, isEncrypted } from '../src/services/secrets.service.js';
import { insertClient, insertServer } from './helpers/db.js';
import { createAdminApi } from './helpers/api.js';
import { startTestServer } from './test-app.js';

const ZONE = 'a'.repeat(32), RECORD = 'b'.repeat(32), TOKEN = 'very-secret-cf-token';
const domain = 'panel.example.com', ip = '203.0.113.9';
let env: Awaited<ReturnType<typeof startTestServer>>;
let admin: ReturnType<typeof createAdminApi>;
let panelCert: Awaited<ReturnType<typeof generate>>;
let oldCert: Awaited<ReturnType<typeof generate>>;
beforeAll(async () => {
  initDatabase(); env = await startTestServer(); admin = createAdminApi(env, 'cfadmin');
  panelCert = await generate([{ name: 'commonName', value: domain }], { keySize: 2048 });
  oldCert = await generate([{ name: 'commonName', value: 'old.example.com' }], { keySize: 2048 });
});
afterAll(async () => { await env.close(); });
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  db.exec("DELETE FROM settings WHERE key LIKE 'cf_%' OR key LIKE 'ssl_%' OR key = 'public_url'; DELETE FROM servers; DELETE FROM events");
  SslService.clearCertificate();
});

function cloudflare(options: { existing?: any[]; dnsError?: boolean; rollbackError?: boolean } = {}) {
  const calls: { path: string; method: string; body: any; token: string | null }[] = [];
  let record: any = options.existing?.[0] ?? null;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
    if (String(url).startsWith(env.baseUrl)) return realFetch(url, init);
    expect(String(url)).toMatch(/^https:\/\/api\.cloudflare\.com\/client\/v4/);
    const path = String(url).replace('https://api.cloudflare.com/client/v4', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, method, body, token: new Headers(init?.headers).get('Authorization') });
    let result: any;
    if (path.startsWith('/zones?')) result = [{ id: ZONE, name: 'example.com' }];
    else if (path === '/user/tokens/verify') result = { status: 'active' };
    else if (path.includes('?name=')) result = options.existing ?? [];
    else if (method === 'GET') result = record;
    else if ((options.dnsError && ['POST', 'PATCH'].includes(method)) || (options.rollbackError && method === 'DELETE')) {
      return Response.json({ success: false, errors: [{ message: TOKEN }] });
    } else if (method === 'DELETE') { record = null; result = { id: RECORD }; }
    else { record = { ...(record ?? { id: RECORD }), ...body }; result = record; }
    return Response.json({ success: true, result });
  }));
  vi.spyOn(PanelIngressService, 'open').mockResolvedValue();
  vi.spyOn(PanelIngressService, 'close').mockImplementation(() => {});
  const issue = vi.spyOn(SslService, 'issueLetsEncryptCloudflare').mockImplementation(async (_d, email) => {
    SslService.saveCustomCertificate(panelCert.cert, panelCert.private, domain);
    setSetting('ssl_mode', 'letsencrypt_cf'); setSetting('ssl_email', email);
    return { success: true };
  });
  return { calls, issue, setRecord: (value: any) => { record = value; } };
}
const input = () => ({ domain, origin_ip: ip, token: TOKEN, email: 'a@example.com', port: 443 });

describe('домен панели с Cloudflare', () => {
  it('создаёт только проксируемую A-запись панели, сохраняет токен зашифрованным и не меняет VPN-клиентов', async () => {
    const id = insertServer({ host: ip }); insertClient(id, { external: 1 });
    const before = db.prepare('SELECT * FROM clients').all();
    const server = db.prepare('SELECT * FROM servers').all();
    const cf = cloudflare();
    const r = await admin.api('/api/security/cloudflare', 'POST', input());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, domain, url: `https://${domain}`, token_saved: true });
    expect(cf.issue).toHaveBeenCalledWith(domain, 'a@example.com', TOKEN, false, false);
    expect(cf.calls.find((c) => c.method === 'POST')?.body).toEqual({ type: 'A', name: domain, content: ip, proxied: true, ttl: 1 });
    expect(cf.calls.every((c) => c.token === `Bearer ${TOKEN}`)).toBe(true);
    expect(isEncrypted(getSetting('cf_token'))).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    expect(JSON.stringify((await admin.api('/api/security/ssl')).body)).not.toContain(TOKEN);
    expect((await admin.api('/api/security/ssl')).body.cfTokenSaved).toBe(true);
    expect(getSetting('public_url')).toBe(`https://${domain}`);
    expect(db.prepare('SELECT * FROM clients').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM servers').all()).toEqual(server);
  });

  it('использует сохранённый токен, существующий сертификат и непустой HTTPS-порт без повторного выпуска', async () => {
    setSetting('cf_token', encryptSecret(TOKEN));
    SslService.saveCustomCertificate(panelCert.cert, panelCert.private, domain);
    const cf = cloudflare({ existing: [{ id: RECORD, type: 'A', name: domain, content: ip, proxied: false, ttl: 120 }] });
    const r = await admin.api('/api/security/cloudflare', 'POST', { domain, origin_ip: ip, port: 8443 });
    expect(r.status).toBe(200); expect(cf.issue).not.toHaveBeenCalled();
    expect(cf.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ proxied: true, ttl: 1 });
    expect(r.body.url).toBe(`https://${domain}:8443`);
  });

  it.each([
    [{ id: RECORD, type: 'A', name: domain, content: '203.0.113.88' }],
    [{ id: RECORD, type: 'CNAME', name: domain, content: 'elsewhere.example.com' }],
    [{ id: RECORD, type: 'AAAA', name: domain, content: '2001:db8::1' }],
  ])('не перезаписывает чужую адресную запись: %j', async (record) => {
    const cf = cloudflare({ existing: [record] });
    expect((await admin.api('/api/security/cloudflare', 'POST', input())).status).toBe(409);
    expect(cf.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(PanelIngressService.open).not.toHaveBeenCalled();
  });

  it('не включает оранжевое облако для домена VPN-ноды', async () => {
    insertServer({ host: domain }); const cf = cloudflare();
    const r = await admin.api('/api/security/cloudflare', 'POST', input());
    expect(r.status).toBe(409); expect(r.body.error).toContain('отдельный поддомен');
    expect(cf.calls).toHaveLength(0);
  });

  it('ошибка открытия порта не меняет DNS, сертификат и публичный адрес', async () => {
    SslService.saveCustomCertificate(oldCert.cert, oldCert.private, 'old.example.com');
    setSetting('public_url', 'https://old.example.com:3001');
    const before = fs.readFileSync(certPath, 'utf8'); const cf = cloudflare();
    vi.mocked(PanelIngressService.open).mockRejectedValue(new Error('Порт занят'));
    expect((await admin.api('/api/security/cloudflare', 'POST', input())).status).toBe(400);
    expect(cf.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(fs.readFileSync(certPath, 'utf8')).toBe(before);
    expect(getSetting('public_url')).toBe('https://old.example.com:3001');
  });

  it('при ошибке DNS возвращает прежний сертификат, токен, адрес и закрывает новый вход', async () => {
    SslService.saveCustomCertificate(oldCert.cert, oldCert.private, 'old.example.com');
    setSetting('cf_token', encryptSecret('old-token')); setSetting('public_url', 'https://old.example.com');
    const oldToken = getSetting('cf_token'); const cert = fs.readFileSync(certPath, 'utf8');
    cloudflare({ dnsError: true });
    const r = await admin.api('/api/security/cloudflare', 'POST', input());
    expect(r.status).toBe(400); expect(r.body.error).not.toContain(TOKEN);
    expect(fs.readFileSync(certPath, 'utf8')).toBe(cert);
    expect(getSetting('cf_token')).toBe(oldToken); expect(getSetting('public_url')).toBe('https://old.example.com');
    expect(PanelIngressService.close).toHaveBeenCalledWith(443);
  });

  it('откатывает созданную DNS-запись, если после её создания настройка прервана', async () => {
    const cf = cloudflare(); vi.spyOn(EventService, 'log').mockImplementationOnce(() => { throw new Error('storage failure'); });
    expect((await admin.api('/api/security/cloudflare', 'POST', input())).status).toBe(400);
    expect(cf.calls.some((c) => c.method === 'DELETE' && c.path.endsWith(RECORD))).toBe(true);
    expect(getSetting('cf_panel_enabled')).toBeNull(); expect(getSetting('cf_token')).toBeNull();
  });

  it('при отключении меняет только proxied/ttl, сохраняет HTTPS и URL; изменённую снаружи запись не трогает', async () => {
    const cf = cloudflare(); await admin.api('/api/security/cloudflare', 'POST', input());
    const r = await admin.api('/api/security/cloudflare', 'DELETE');
    expect(r.status).toBe(200); expect(r.body.enabled).toBe(false);
    expect(cf.calls.at(-1)?.body).toEqual({ proxied: false, ttl: 120 });
    expect(getSetting('public_url')).toBe(`https://${domain}`); expect(SslService.isActive()).toBe(true);
    expect(PanelIngressService.close).not.toHaveBeenCalled();
  });

  it('сохранённый токен можно проверить без повторного ввода; без токена и с портом 3001 — отказ', async () => {
    cloudflare();
    expect((await admin.api('/api/security/ssl/verify-cf', 'POST', {})).status).toBe(400);
    setSetting('cf_token', encryptSecret(TOKEN));
    const r = await admin.api('/api/security/ssl/verify-cf', 'POST', {});
    expect(r.status).toBe(200); expect(r.body.valid).toBe(true);
    expect((await admin.api('/api/security/cloudflare', 'POST', { ...input(), port: 3001 })).status).toBe(400);
    expect((await env.request('/api/security/cloudflare')).status).toBe(401);
  });

  it('позволяет явно сменить IPv4 ранее сохранённой записи панели после переноса', async () => {
    SslService.saveCustomCertificate(panelCert.cert, panelCert.private, domain);
    for (const [key, value] of Object.entries({ cf_panel_zone: ZONE, cf_panel_record: RECORD, cf_panel_domain: domain, cf_panel_ip: ip })) setSetting(key, value);
    const cf = cloudflare({ existing: [{ id: RECORD, name: domain, type: 'A', content: ip, proxied: true, ttl: 1 }] });
    const r = await admin.api('/api/security/cloudflare', 'POST', { ...input(), origin_ip: '203.0.113.10' });
    expect(r.status).toBe(200); expect(r.body.origin_ip).toBe('203.0.113.10');
    expect(cf.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ content: '203.0.113.10', proxied: true, ttl: 1 });
  });

  it('при отключении не трогает запись, которую изменили вне панели', async () => {
    const cf = cloudflare(); await admin.api('/api/security/cloudflare', 'POST', input());
    cf.setRecord({ id: RECORD, name: domain, type: 'A', content: '203.0.113.99', proxied: true, ttl: 1 });
    const before = cf.calls.length;
    const r = await admin.api('/api/security/cloudflare', 'DELETE');
    expect(r.status).toBe(409); expect(getSetting('cf_panel_enabled')).toBe('1');
    expect(cf.calls.slice(before).every((c) => c.method === 'GET')).toBe(true);
  });

  it('повторный выпуск сертификата не выключает оранжевое облако', async () => {
    const writes: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
      if (String(url).startsWith('https://api.ipify.org')) return Response.json({ ip });
      if (String(url).includes('/zones?')) return Response.json({ success: true, result: [{ id: ZONE, name: 'example.com' }] });
      if (!init?.method) return Response.json({ success: true, result: [{ id: RECORD, proxied: true }] });
      writes.push(JSON.parse(String(init.body))); return Response.json({ success: true });
    }));
    vi.spyOn(SslService as any, 'getAcmeClient').mockRejectedValue(new Error('stop before ACME'));
    await expect(SslService.issueLetsEncryptCloudflare(domain, 'a@example.com', TOKEN)).rejects.toThrow('stop before ACME');
    expect(writes).toEqual([{ type: 'A', name: domain, content: ip, proxied: true, ttl: 1 }]);
  });

  it('запрещает CDN-кэширование API, включая нечувствительные к регистру маршруты Express', async () => {
    const r = await admin.api('/API/security/ssl');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
    expect(r.headers.get('cdn-cache-control')).toBe('no-store');
  });
});

describe('IP пользователя за Cloudflare', () => {
  it.each(['173.245.48.1', '::ffff:173.245.48.1', '2606:4700::1'])('доверяет заголовку только от реального узла %s', (peer) => {
    setSetting('cf_panel_enabled', '1');
    const req: any = { ip: peer, socket: { remoteAddress: peer }, headers: { 'cf-connecting-ip': '198.51.100.9' } };
    cloudflareClientIp(req, {} as any, vi.fn()); expect(req.ip).toBe('198.51.100.9');
  });
  it('игнорирует поддельные CF-Connecting-IP, X-Forwarded-For и X-Forwarded-Proto при прямом запросе', () => {
    setSetting('cf_panel_enabled', '1');
    const req: any = { ip: '203.0.113.9', secure: false, socket: { remoteAddress: '203.0.113.9' }, headers: {
      'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '198.51.100.9', 'x-forwarded-proto': 'https' } };
    cloudflareClientIp(req, {} as any, vi.fn()); expect(req.ip).toBe('203.0.113.9'); expect(req.secure).toBe(false);
    expect(isCloudflareAddress('127.0.0.1')).toBe(false);
  });
});

describe('дополнительный вход панели', () => {
  it('поднимает отдельный listener и сообщает о занятом порте', async () => {
    const primary = http.createServer((_req, res) => res.end('panel'));
    PanelIngressService.configure(() => primary);
    const probe = net.createServer();
    // Порт занимается на всех адресах, как его слушает сама панель: в Windows занятый 127.0.0.1 не мешает
    // слушать «::», и ошибка не возникла бы (#65)
    await new Promise<void>((r) => probe.listen(0, r));
    const port = (probe.address() as net.AddressInfo).port;
    await expect(PanelIngressService.open(port)).rejects.toThrow('Не удалось открыть');
    await new Promise<void>((r) => probe.close(() => r()));
    await PanelIngressService.open(port); expect(PanelIngressService.isOpen(port)).toBe(true);
    const result = await new Promise<string>((resolve, reject) => http.get(`http://127.0.0.1:${port}`, { agent: false }, (res) => {
      let body = ''; res.on('data', (s) => body += s); res.on('end', () => resolve(body));
    }).on('error', reject));
    expect(result).toBe('panel'); PanelIngressService.close(port);
  });
});
