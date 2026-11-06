import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generate } from 'selfsigned';
import { db, initDatabase, setSetting } from '../src/db/index.js';
import { XrayService } from '../src/services/xray.service.js';
import { ProvisionService } from '../src/services/provision.service.js';
import { SslService } from '../src/services/ssl.service.js';
import { CdnService } from '../src/services/cdn.service.js';
import { encryptSecret, isEncrypted } from '../src/services/secrets.service.js';
import {
  generateVlessParams, validateVlessParams, vlessParamsFromRow, XRAY_CDN_INBOUND_TAG, XRAY_INBOUND_TAG,
} from '../src/utils/vless-params.js';
import { insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { createAdminApi } from './helpers/api.js';
import { startTestServer } from './test-app.js';

const ZONE = 'a'.repeat(32);
const RECORD = 'c'.repeat(32);
const DOMAIN = 'vpn.example.com';
const NODE_IP = '203.0.113.77';
const UUID = '123e4567-e89b-42d3-a456-426614174000';

let env: Awaited<ReturnType<typeof startTestServer>>;
let admin: ReturnType<typeof createAdminApi>;
let cert: Awaited<ReturnType<typeof generate>>;

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  admin = createAdminApi(env, 'cdnadmin');
  cert = await generate([{ name: 'commonName', value: DOMAIN }], { keySize: 2048, days: 90, extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: DOMAIN }] }] } as any);
});
afterAll(async () => { await env.close(); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.exec("DELETE FROM settings WHERE key LIKE 'cf_%' OR key LIKE 'ssl_%'; DELETE FROM clients; DELETE FROM subscribers; DELETE FROM servers");
});

function vlessNode(overrides: Record<string, unknown> = {}): number {
  const id = insertServer({ name: 'VLESS Нидерланды', host: NODE_IP, awgPort: 443 });
  const params = { ...generateVlessParams(), xhttp_path: '/abc123', ...overrides };
  db.prepare(`UPDATE servers SET protocol = 'vless', container_name = 'dementia-xray', conf_path = '/opt/dementia-xray/config.json',
    reality_sni = ?, reality_dest = ?, reality_short_ids = ?, xray_flow = ?, xray_fingerprint = ?, xray_transport = ?,
    xhttp_path = ?, xhttp_mode = ? WHERE id = ?`).run(
    'dl.google.com', 'dl.google.com:443', JSON.stringify(['0123456789abcdef']), params.xray_flow, params.xray_fingerprint,
    params.xray_transport, params.xhttp_path, params.xhttp_mode, id);
  return id;
}

function withCdn(id: number, extra: Record<string, unknown> = {}) {
  db.prepare(`UPDATE servers SET cdn_enabled = 1, cdn_domain = ?, cdn_port = 8443, cdn_zone = ?, cdn_record = ?, cdn_origin_ip = ?,
    cdn_cert = ?, cdn_key = ?, cdn_address = ? WHERE id = ?`).run(
    DOMAIN, ZONE, RECORD, NODE_IP, cert.cert, encryptSecret(cert.private), (extra.address as string) ?? null, id);
}

function row(id: number): any {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
}

/** Подмена API Cloudflare: записывает вызовы и ведёт одну A-запись */
function cloudflare(options: { existing?: any[] } = {}) {
  const calls: { path: string; method: string; body: any }[] = [];
  let record: any = options.existing?.[0] ?? null;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
    if (String(url).startsWith(env.baseUrl)) return realFetch(url, init);
    const path = String(url).replace('https://api.cloudflare.com/client/v4', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, method, body });
    let result: any;
    if (path.startsWith('/zones?')) result = [{ id: ZONE, name: 'example.com' }];
    else if (path.includes('?name=')) result = options.existing ?? [];
    else if (method === 'GET') result = record;
    else if (method === 'DELETE') { record = null; result = { id: RECORD }; }
    else { record = { ...(record ?? { id: RECORD }), ...body }; result = record; }
    return Response.json({ success: true, result });
  }));
  return calls;
}

describe('параметры XHTTP', () => {
  it('проверяет транспорт, путь и режим', () => {
    const base = generateVlessParams();
    expect(base.xray_transport).toBe('tcp');
    expect(base.xhttp_path).toMatch(/^\/[0-9a-f]{16}$/);
    expect(validateVlessParams({ ...base, xray_transport: 'xhttp' })).toBeNull();
    expect(validateVlessParams({ ...base, xray_transport: 'ws' as any })).toMatch(/Транспорт/);
    // Перевод строки и кавычки в пути попали бы в config.json, ссылки и YAML
    for (const path of ['abc', '/a b', '/a\nPostUp', '/a"b', '/a?x=1', `/${'a'.repeat(64)}`]) {
      expect(validateVlessParams({ ...base, xhttp_path: path })).toMatch(/Путь XHTTP/);
    }
    expect(validateVlessParams({ ...base, xhttp_mode: 'stream' as any })).toMatch(/Режим XHTTP/);
  });

  it('Reality-вход с XHTTP: network xhttp, путь, сервер принимает любой режим; без CDN второго входа нет', () => {
    const id = vlessNode({ xray_transport: 'xhttp', xhttp_mode: 'stream-one' });
    const config = JSON.parse(XrayService.generateServerConfig(row(id), [{ id: 5, client_uuid: UUID, enabled: 1 }]));
    const inbound = config.inbounds.find((i: any) => i.tag === XRAY_INBOUND_TAG);
    expect(inbound.streamSettings).toMatchObject({ network: 'xhttp', security: 'reality', xhttpSettings: { path: '/abc123', mode: 'auto' } });
    expect(inbound.settings.clients).toEqual([{ id: UUID, flow: 'xtls-rprx-vision', email: 'c5', level: 0 }]);
    expect(config.inbounds.find((i: any) => i.tag === XRAY_CDN_INBOUND_TAG)).toBeUndefined();
  });

  it('ссылка и прокси mihomo для XHTTP + Reality', () => {
    const id = vlessNode({ xray_transport: 'xhttp', xhttp_mode: 'packet-up' });
    const url = new URL(XrayService.buildVlessLink(row(id), { client_uuid: UUID }, 'Нода'));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      type: 'xhttp', path: '/abc123', host: 'dl.google.com', mode: 'packet-up', security: 'reality', sni: 'dl.google.com',
    });
    expect(XrayService.buildMihomoProxy(row(id), { client_uuid: UUID }, 'Нода')).toMatchObject({
      network: 'xhttp', 'xhttp-opts': { path: '/abc123', host: 'dl.google.com', mode: 'packet-up' }, 'reality-opts': expect.any(Object),
    });
  });

  it('«Сгенерировать новые» не меняет транспорт и режим', async () => {
    const id = vlessNode({ xray_transport: 'xhttp', xhttp_mode: 'stream-one' });
    db.prepare("UPDATE servers SET status = 'uninstalled' WHERE id = ?").run(id);
    const res = await admin.api(`/api/servers/${id}/randomize-params`, 'POST');
    expect(res.status).toBe(200);
    expect(vlessParamsFromRow(row(id))).toMatchObject({ xray_transport: 'xhttp', xhttp_mode: 'stream-one' });
    expect(row(id).xhttp_path).not.toBe('/abc123');
  });

  it('PUT меняет транспорт с проверкой формата', async () => {
    const id = vlessNode();
    db.prepare("UPDATE servers SET status = 'uninstalled' WHERE id = ?").run(id);
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { xhttp_path: '/bad path' })).status).toBe(400);
    const ok = await admin.api(`/api/servers/${id}`, 'PUT', { xray_transport: 'xhttp', xhttp_mode: 'stream-up' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ xray_transport: 'xhttp', xhttp_mode: 'stream-up' });
  });
});

describe('вход через CDN: конфиг ноды и подписка', () => {
  it('второй inbound XHTTP + TLS с сертификатом в config.json, без flow, с тем же email', () => {
    const id = vlessNode();
    withCdn(id);
    const config = JSON.parse(XrayService.generateServerConfig(row(id), [{ id: 7, client_uuid: UUID, enabled: 1 }]));
    const cdn = config.inbounds.find((i: any) => i.tag === XRAY_CDN_INBOUND_TAG);
    expect(cdn).toMatchObject({
      port: 8443,
      protocol: 'vless',
      settings: { clients: [{ id: UUID, flow: '', email: 'c7', level: 0 }], decryption: 'none' },
      streamSettings: { network: 'xhttp', security: 'tls', xhttpSettings: { path: '/abc123', mode: 'auto' } },
    });
    const pem = cdn.streamSettings.tlsSettings.certificates[0];
    expect(pem.certificate.join('\n')).toBe(cert.cert.trim().replace(/\r/g, ''));
    expect(pem.key[0]).toMatch(/-----BEGIN .*PRIVATE KEY-----/);
    // Reality-вход не изменился
    expect(config.inbounds.find((i: any) => i.tag === XRAY_INBOUND_TAG).streamSettings.network).toBe('tcp');
  });

  it('без сертификата или при выключенном входе второго inbound нет', () => {
    const id = vlessNode();
    withCdn(id);
    db.prepare('UPDATE servers SET cdn_enabled = 0 WHERE id = ?').run(id);
    expect(JSON.parse(XrayService.generateServerConfig(row(id), [])).inbounds).toHaveLength(2);
    db.prepare('UPDATE servers SET cdn_enabled = 1, cdn_key = NULL WHERE id = ?').run(id);
    expect(JSON.parse(XrayService.generateServerConfig(row(id), [])).inbounds).toHaveLength(2);
  });

  it('подписка: отдельная запись «· CDN» с адресом Cloudflare; секреты не попадают в API и гостю', async () => {
    const id = vlessNode();
    withCdn(id, { address: '104.16.1.1' });
    const subscriber = insertSubscriber({ name: 'Пользователь CDN' });
    const client = insertClient(id, { subscriberId: subscriber });
    db.prepare("UPDATE clients SET client_uuid = ?, client_ip = '', client_public_key = '', client_private_key = '' WHERE id = ?").run(UUID, client.id);
    const token = (db.prepare('SELECT token FROM subscribers WHERE id = ?').get(subscriber) as any).token;

    const res = await env.request(`/sub/${token}?format=v2ray`);
    const links = Buffer.from(await res.text(), 'base64').toString('utf-8').split('\n').filter(Boolean);
    expect(links).toHaveLength(2);
    const cdn = new URL(links[1]);
    expect(cdn.hostname).toBe('104.16.1.1');
    expect(cdn.port).toBe('8443');
    expect(decodeURIComponent(cdn.hash)).toBe('#VLESS Нидерланды · CDN');
    expect(Object.fromEntries(cdn.searchParams)).toEqual({
      type: 'xhttp', path: '/abc123', host: DOMAIN, mode: 'auto', security: 'tls', sni: DOMAIN, alpn: 'h2,http/1.1',
      fp: 'chrome', encryption: 'none',
    });

    const clash = JSON.parse(await (await env.request(`/sub/${token}?format=clash`)).text());
    expect(clash.proxies[1]).toMatchObject({
      name: 'VLESS Нидерланды · CDN', server: '104.16.1.1', port: 8443, network: 'xhttp', tls: true, servername: DOMAIN,
    });
    expect(clash.proxies[1]['reality-opts']).toBeUndefined();

    const api = await admin.api(`/api/servers/${id}`);
    expect(api.body).toMatchObject({ cdn_enabled: true, cdn_cert_ready: true, cdn_domain: DOMAIN, cdn_port: 8443 });
    expect(api.body.cdn_key).toBeUndefined();
    expect(api.body.cdn_cert).toBeUndefined();
    expect(JSON.stringify(api.body)).not.toContain('PRIVATE KEY');
  });
});

describe('CdnService.enable / disable', () => {
  function prepare() {
    setSetting('cf_token', encryptSecret('cf-secret-token'));
    setSetting('ssl_email', 'admin@example.com');
    const issue = vi.spyOn(SslService, 'obtainDns01Certificate').mockResolvedValue({ cert: cert.cert, key: cert.private });
    const reinstall = vi.spyOn(ProvisionService, 'requestReinstall').mockResolvedValue({ success: true });
    return { issue, reinstall };
  }

  it('выпускает сертификат, создаёт A-запись с проксированием, сохраняет ключ зашифрованным и переустанавливает ноду', async () => {
    const id = vlessNode();
    const { issue, reinstall } = prepare();
    const calls = cloudflare();
    const res = await admin.api(`/api/servers/${id}/cdn`, 'POST', { domain: DOMAIN, port: 2053 });
    expect(res.status).toBe(200);
    expect(issue).toHaveBeenCalledWith(DOMAIN, 'admin@example.com', 'cf-secret-token', ZONE);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ type: 'A', name: DOMAIN, content: NODE_IP, proxied: true, ttl: 1 });
    expect(reinstall).toHaveBeenCalledWith(id);
    const saved = row(id);
    expect(saved).toMatchObject({ cdn_enabled: 1, cdn_domain: DOMAIN, cdn_port: 2053, cdn_zone: ZONE, cdn_record: RECORD, cdn_origin_ip: NODE_IP });
    expect(isEncrypted(saved.cdn_key)).toBe(true);
    expect(saved.cdn_expires_at).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
  });

  it('если переустановка не удалась — настройки и DNS возвращаются как были', async () => {
    const id = vlessNode();
    const { reinstall } = prepare();
    reinstall.mockResolvedValue({ success: false, error: 'TCP-порт занят' });
    const calls = cloudflare();
    const res = await admin.api(`/api/servers/${id}/cdn`, 'POST', { domain: DOMAIN });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('TCP-порт занят');
    expect(row(id)).toMatchObject({ cdn_enabled: 0, cdn_domain: null, cdn_key: null });
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith(`/dns_records/${RECORD}`))).toBe(true);
  });

  it('не трогает чужую запись, домен панели и неверные порты', async () => {
    const id = vlessNode();
    prepare();
    cloudflare({ existing: [{ id: 'd'.repeat(32), type: 'A', name: DOMAIN, content: '198.51.100.1', proxied: false }] });
    expect((await admin.api(`/api/servers/${id}/cdn`, 'POST', { domain: DOMAIN })).status).toBe(409);
    setSetting('cf_panel_domain', DOMAIN);
    expect((await admin.api(`/api/servers/${id}/cdn`, 'POST', { domain: DOMAIN })).status).toBe(409);
    setSetting('cf_panel_domain', null);
    expect((await admin.api(`/api/servers/${id}/cdn`, 'POST', { domain: 'other.example.com', port: 443 })).status).toBe(400); // порт VLESS
    expect((await admin.api(`/api/servers/${id}/cdn`, 'POST', { domain: 'other.example.com', port: 9443 })).status).toBe(400);
    expect(row(id).cdn_enabled).toBe(0);
  });

  it('недоступно для нод AmneziaWG', async () => {
    const id = insertServer({ name: 'AWG' });
    expect((await admin.api(`/api/servers/${id}/cdn`, 'POST', { domain: DOMAIN })).status).toBe(400);
  });

  it('выключение убирает inbound синхронизацией и удаляет только свою запись', async () => {
    const id = vlessNode();
    withCdn(id);
    setSetting('cf_token', encryptSecret('cf-secret-token'));
    const sync = vi.spyOn(ProvisionService, 'requestSync').mockResolvedValue({ success: true });
    const calls = cloudflare({ existing: [{ id: RECORD, type: 'A', name: DOMAIN, content: NODE_IP, proxied: true }] });
    const res = await admin.api(`/api/servers/${id}/cdn`, 'DELETE');
    expect(res.status).toBe(200);
    expect(sync).toHaveBeenCalledWith(id);
    expect(row(id)).toMatchObject({ cdn_enabled: 0, cdn_record: null, cdn_domain: DOMAIN });
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('продление: сертификат, срок которого подходит к концу, перевыпускается и уходит на ноду', async () => {
    const id = vlessNode();
    withCdn(id);
    db.prepare("UPDATE servers SET cdn_expires_at = ? WHERE id = ?").run(new Date(Date.now() + 5 * 86400000).toISOString(), id);
    setSetting('cf_token', encryptSecret('cf-secret-token'));
    setSetting('ssl_email', 'admin@example.com');
    const issue = vi.spyOn(SslService, 'obtainDns01Certificate').mockResolvedValue({ cert: cert.cert, key: cert.private });
    const sync = vi.spyOn(ProvisionService, 'requestSync').mockResolvedValue({ success: true });
    await CdnService.renewAll();
    expect(issue).toHaveBeenCalledWith(DOMAIN, 'admin@example.com', 'cf-secret-token', ZONE);
    expect(sync).toHaveBeenCalledWith(id);
    expect(new Date(row(id).cdn_expires_at).getTime()).toBeGreaterThan(Date.now() + 60 * 86400000);
  });
});
