import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generate } from 'selfsigned';
import { db, getSetting, initDatabase, setSetting } from '../src/db/index.js';
import { BridgeService, buildBridgeRules, expectedRuleCount, panelPort } from '../src/services/bridge.service.js';
import { FailoverService } from '../src/services/failover.service.js';
import { SslService } from '../src/services/ssl.service.js';
import { encryptSecret } from '../src/services/secrets.service.js';
import { createAdminApi } from './helpers/api.js';
import { insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { stubSsh } from './helpers/ssh-stub.js';
import { startTestServer, type TestEnv } from './test-app.js';

/**
 * Мосты как основной путь: режим `main` (мост + запасной прямой адрес в подписке), пересылка порта панели через мост
 * и резервный домен подписок с A-записями мостов (docs/bridges.md). SSH и Cloudflare подменены.
 */

const ZONE = 'a'.repeat(32);
const PANEL_IP = '203.0.113.200';
const FAILOVER = 'sub.example.com';

let env: TestEnv;
let api: ReturnType<typeof createAdminApi>['api'];

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  ({ api } = createAdminApi(env, 'mainadmin', 'MainAdminPass-1'));
});
afterAll(async () => { await env.close(); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.exec(`DELETE FROM bridge_links; DELETE FROM bridges; DELETE FROM clients; DELETE FROM subscribers; DELETE FROM servers;
    DELETE FROM settings WHERE key LIKE 'failover_%' OR key LIKE 'cf_%' OR key LIKE 'ssl_%' OR key = 'panel_origin_ip'`);
});

const decodeLinks = (body: string) => Buffer.from(body, 'base64').toString().split('\n').filter(Boolean);
const linkName = (link: string) => decodeURIComponent(link.split('#')[1] ?? '');
const linkConf = (link: string) => Buffer.from(link.slice('awg://'.length).split('#')[0], 'base64url').toString();

function bridgeRow(overrides: Record<string, unknown> = {}): number {
  const values = { name: 'Мост Москва', host: '198.51.100.80', ssh_port: 22, ssh_user: 'root', ssh_password: encryptSecret('x'), country: 'ru', status: 'online', ...overrides };
  const keys = Object.keys(values);
  return Number(db.prepare(`INSERT INTO bridges (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...(Object.values(values) as any[])).lastInsertRowid);
}

/** Подмена API Cloudflare: зона example.com, учёт записей и вызовов */
function cloudflare(options: { failPost?: boolean; existing?: any[] } = {}) {
  const calls: { path: string; method: string; body: any }[] = [];
  const records = new Map<string, any>();
  let seq = 0;
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
    else if (method === 'POST') {
      if (options.failPost && seq > 0) return Response.json({ success: false, errors: [{ message: 'nope' }] });
      const id = String(++seq).padStart(32, '0');
      records.set(id, { id, ...body });
      result = records.get(id);
    } else {
      const id = path.split('/').pop()!;
      if (method === 'DELETE') { records.delete(id); result = { id }; } else result = records.get(id) ?? null;
    }
    return Response.json({ success: true, result });
  }));
  return { calls, records };
}

describe('режим «основной» (main)', () => {
  it('подписка выдаёт мост первым и прямой адрес запасной записью; always — только мост', async () => {
    const node = insertServer({ name: 'Финляндия', host: '203.0.113.10' });
    const other = insertServer({ name: 'Германия', host: '203.0.113.11' });
    const bridge = bridgeRow();
    db.prepare("INSERT INTO bridge_links (bridge_id, server_id, listen_port, mode) VALUES (?, ?, 51820, 'main'), (?, ?, 51821, 'always')")
      .run(bridge, node, bridge, other);
    const sub = insertSubscriber({ name: 'Пользователь РФ' });
    db.prepare("UPDATE subscribers SET country = 'ru' WHERE id = ?").run(sub);
    insertClient(node, { subscriberId: sub });
    insertClient(other, { subscriberId: sub });
    const token = (db.prepare('SELECT token FROM subscribers WHERE id = ?').get(sub) as any).token;

    expect(BridgeService.routesFor('ru').get(node)).toMatchObject({ host: '198.51.100.80', port: 51820, keepDirect: true });
    expect(BridgeService.routesFor('ru').get(other)).toMatchObject({ keepDirect: false });

    const links = decodeLinks(await (await env.request(`/sub/${token}`)).text());
    expect(links.map(linkName)).toEqual(['Финляндия · 🌉 🇷🇺', 'Финляндия · напрямую', 'Германия · 🌉 🇷🇺']);
    expect(linkConf(links[0])).toContain('Endpoint = 198.51.100.80:51820');
    expect(linkConf(links[1])).toContain('Endpoint = 203.0.113.10:51820');
    expect(linkConf(links[2])).toContain('Endpoint = 198.51.100.80:51821');

    // Пользователь без страны или из другой страны мост не получает
    db.prepare("UPDATE subscribers SET country = 'kz' WHERE id = ?").run(sub);
    expect(decodeLinks(await (await env.request(`/sub/${token}`)).text()).map(linkName)).toEqual(['Финляндия', 'Германия']);
  });

  it('новые привязки по умолчанию — main, неизвестный режим отклоняется', async () => {
    const node = insertServer({ host: '203.0.113.12' });
    const bridge = bridgeRow({ status: 'uninstalled' });
    expect((await api(`/api/bridges/${bridge}/links`, 'PUT', { links: [{ server_id: node, mode: 'primary' }] })).status).toBe(400);
    const ok = await api(`/api/bridges/${bridge}/links`, 'PUT', { links: [{ server_id: node }] });
    expect(ok.body.bridge.links[0].mode).toBe('main');
  });
});

describe('пересылка порта панели через мост', () => {
  it('правило TCP «порт панели → панель:порт» добавляется к правилам моста', () => {
    const rules = buildBridgeRules([], { ip: PANEL_IP, port: 3001 });
    expect(rules).toContain(`forward tcp 3001 '${PANEL_IP}' 3001`);
    expect(rules).toContain('echo "---RULES 1"');
    expect(expectedRuleCount([], { ip: PANEL_IP, port: 3001 })).toBe(1);
    expect(() => buildBridgeRules([], { ip: '2001:db8::1', port: 3001 })).toThrow(/IPv4/);
  });

  it('включение применяет правила на мосту, конфликт портов отклоняется, при отказе моста — откат', async () => {
    setSetting('panel_origin_ip', PANEL_IP);
    const bridge = bridgeRow();
    const ssh = stubSsh();
    const res = await api(`/api/bridges/${bridge}`, 'PUT', { panel_forward: true });
    expect(res.status).toBe(200);
    expect(res.body.panel_forward).toBe(1);
    expect(ssh.calls.find((c) => c.command.includes('rules.sh.new'))!.input).toContain(`forward tcp ${panelPort()} '${PANEL_IP}' ${panelPort()}`);

    // Порт панели совпадает с SSH-портом моста
    expect((await api(`/api/bridges/${bridge}`, 'PUT', { panel_forward: true, ssh_port: panelPort() })).status).toBe(400);

    // Порт панели уже занят пересылкой ноды
    const busy = bridgeRow({ host: '198.51.100.81' });
    const node = insertServer({ host: '203.0.113.13' });
    db.prepare("INSERT INTO bridge_links (bridge_id, server_id, listen_port, mode) VALUES (?, ?, ?, 'main')").run(busy, node, panelPort());
    expect((await api(`/api/bridges/${busy}`, 'PUT', { panel_forward: true })).status).toBe(409);

    // Мост не принял правила — флаг возвращается
    const broken = bridgeRow({ host: '198.51.100.82' });
    stubSsh(() => ({ code: 1, stderr: 'iptables: Permission denied' }));
    const failed = await api(`/api/bridges/${broken}`, 'PUT', { panel_forward: true });
    expect(failed.status).toBe(502);
    expect((db.prepare('SELECT panel_forward FROM bridges WHERE id = ?').get(broken) as any).panel_forward).toBe(0);
  });

  it('привязка ноды не занимает порт панели на мосту с пересылкой панели', async () => {
    setSetting('panel_origin_ip', PANEL_IP);
    const bridge = bridgeRow({ status: 'uninstalled', panel_forward: 1 });
    const node = insertServer({ host: '203.0.113.14', awgPort: panelPort() });
    const res = await api(`/api/bridges/${bridge}/links`, 'PUT', { links: [{ server_id: node }] });
    expect(res.body.bridge.links[0].listen_port).not.toBe(panelPort());
  });
});

describe('резервный домен подписок', () => {
  async function prepareCert() {
    const cert = await generate([{ name: 'commonName', value: 'panel.example.com' }], { keySize: 2048 });
    return cert;
  }

  it('A-записи DNS only на мосты и панель, имя в сертификате, ссылки подписок с резервным доменом; мост offline — запись убирается', async () => {
    setSetting('panel_origin_ip', PANEL_IP);
    setSetting('cf_token', encryptSecret('cf-token'));
    setSetting('ssl_email', 'admin@example.com');
    const bridge = bridgeRow({ panel_forward: 1 });
    bridgeRow({ host: 'bridge.example.net', name: 'Мост по домену', panel_forward: 1 }); // не IPv4 — в DNS не попадает
    const cf = cloudflare();
    const issue = vi.spyOn(SslService, 'issueLetsEncryptCloudflare').mockResolvedValue({ success: true });

    const res = await api('/api/bridges/failover', 'POST', { domain: FAILOVER });
    expect(res.status).toBe(200);
    expect(issue).toHaveBeenCalledWith(FAILOVER, 'admin@example.com', 'cf-token', false, false);
    expect(JSON.parse(getSetting('ssl_alt_names')!)).toEqual([FAILOVER]);
    const posted = cf.calls.filter((c) => c.method === 'POST').map((c) => c.body);
    expect(posted).toEqual([
      { type: 'A', name: FAILOVER, content: '198.51.100.80', proxied: false, ttl: 60 },
      { type: 'A', name: FAILOVER, content: PANEL_IP, proxied: false, ttl: 60 },
    ]);
    expect(res.body).toMatchObject({ enabled: true, domain: FAILOVER, published: ['198.51.100.80', PANEL_IP] });
    expect(JSON.stringify(res.body)).not.toContain('cf-token');

    const settings = await api('/api/settings');
    expect(settings.body.subscription_url).toBe(`https://${FAILOVER}:${panelPort()}`);

    // Мост ушёл в offline — его адрес удаляется из DNS при сверке
    db.prepare("UPDATE bridges SET status = 'offline' WHERE id = ?").run(bridge);
    await FailoverService.reconcile();
    expect([...cf.records.values()].map((r) => r.content)).toEqual([PANEL_IP]);

    // Выключение удаляет наши записи и имя из сертификата
    const off = await api('/api/bridges/failover', 'DELETE');
    expect(off.body.enabled).toBe(false);
    expect(cf.records.size).toBe(0);
    expect(JSON.parse(getSetting('ssl_alt_names')!)).toEqual([]);
    expect((await api('/api/settings')).body.subscription_url).toBe('');
  });

  it('при ошибке Cloudflare всё откатывается; чужие записи и домен панели не трогаются', async () => {
    setSetting('panel_origin_ip', PANEL_IP);
    setSetting('cf_token', encryptSecret('cf-token'));
    setSetting('ssl_email', 'admin@example.com');
    bridgeRow({ panel_forward: 1 });
    vi.spyOn(SslService, 'issueLetsEncryptCloudflare').mockResolvedValue({ success: true });

    const cf = cloudflare({ failPost: true });
    const res = await api('/api/bridges/failover', 'POST', { domain: FAILOVER });
    expect(res.status).toBe(400);
    expect(getSetting('failover_domain')).toBeNull();
    expect(cf.records.size).toBe(0);

    vi.unstubAllGlobals();
    cloudflare({ existing: [{ id: 'f'.repeat(32), type: 'A', name: FAILOVER, content: '192.0.2.1', proxied: false }] });
    expect((await api('/api/bridges/failover', 'POST', { domain: FAILOVER })).status).toBe(409);
    setSetting('cf_panel_domain', FAILOVER);
    expect((await api('/api/bridges/failover', 'POST', { domain: FAILOVER })).status).toBe(409);
  });

  it('без адресов (нет пересылающих мостов и выключен прямой адрес) — отказ до любых изменений', async () => {
    setSetting('panel_origin_ip', PANEL_IP);
    setSetting('cf_token', encryptSecret('cf-token'));
    const cf = cloudflare();
    const res = await api('/api/bridges/failover', 'POST', { domain: FAILOVER, include_panel: false });
    expect(res.status).toBe(400);
    expect(cf.calls).toHaveLength(0);
  });

  it('сертификат панели выпускается с дополнительными именами из ssl_alt_names (и при продлении)', async () => {
    const cert = await prepareCert();
    setSetting('ssl_alt_names', JSON.stringify([FAILOVER, 'other.zone.org']));
    cloudflare();
    const obtain = vi.spyOn(SslService, 'obtainDns01Certificate').mockResolvedValue({ cert: cert.cert, key: cert.private });
    await SslService.issueLetsEncryptCloudflare('panel.example.com', 'admin@example.com', 'cf-token', false, false);
    // Имя без зоны в аккаунте пропускается, чтобы не сорвать выпуск основного
    expect(obtain).toHaveBeenCalledWith('panel.example.com', 'admin@example.com', 'cf-token', ZONE, [{ name: FAILOVER, zoneId: ZONE }]);
    SslService.clearCertificate();
  });
});

describe('диагностика пути «мост → панель»', () => {
  async function tlsPanel(name: string) {
    const https = await import('node:https');
    const cert = await generate([{ name: 'commonName', value: name }], {
      keySize: 2048, extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: name }] }],
    } as any);
    const server = https.createServer({ key: cert.private, cert: cert.cert }, (req, res) => {
      if (req.url === '/api/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"status":"ok"}'); return; }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, cert, port: (server.address() as any).port as number };
  }

  it('все шаги зелёные: TCP до моста, TLS с именем резервного домена, ответ панели', async () => {
    const panel = await tlsPanel(FAILOVER);
    const previous = process.env.PORT;
    process.env.PORT = String(panel.port);
    try {
      setSetting('failover_domain', FAILOVER);
      vi.spyOn(SslService, 'isActive').mockReturnValue(true);
      const bridge = bridgeRow({ host: '127.0.0.1', panel_forward: 1 });
      const res = await FailoverService.checkBridge(bridge, { ca: panel.cert.cert });
      expect(res.steps.map((s) => [s.title, s.ok])).toEqual([
        ['Пересылка панели включена', true],
        ['Правила применены на мосту', true],
        [`TCP до моста 127.0.0.1:${panel.port}`, true],
        [`TLS с именем ${FAILOVER}`, true],
        ['Ответ панели через мост', true],
      ]);
      expect(res.ok).toBe(true);
    } finally {
      process.env.PORT = previous;
      panel.server.close();
    }
  });

  it('сертификат не на то имя — шаг TLS красный с объяснением', async () => {
    const panel = await tlsPanel('panel.example.com');
    const previous = process.env.PORT;
    process.env.PORT = String(panel.port);
    try {
      setSetting('failover_domain', FAILOVER);
      vi.spyOn(SslService, 'isActive').mockReturnValue(true);
      const bridge = bridgeRow({ host: '127.0.0.1', panel_forward: 1 });
      const res = await FailoverService.checkBridge(bridge, { ca: panel.cert.cert });
      expect(res.ok).toBe(false);
      const step = res.steps.find((s) => s.title.startsWith('TLS'))!;
      expect(step.ok).toBe(false);
      expect(step.detail).toContain(`не выписан на ${FAILOVER}`);
    } finally {
      process.env.PORT = previous;
      panel.server.close();
    }
  });

  it('порт закрыт — TCP красный с подсказкой; выключенная пересылка — первый шаг', async () => {
    const closed = await new Promise<number>((resolve) => {
      const srv = require('node:net').createServer();
      srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
    });
    const previous = process.env.PORT;
    process.env.PORT = String(closed);
    try {
      const bridge = bridgeRow({ host: '127.0.0.1', panel_forward: 1 });
      const res = await FailoverService.checkBridge(bridge, { timeoutMs: 2000 });
      const tcp = res.steps.find((s) => s.title.startsWith('TCP'))!;
      expect(tcp.ok).toBe(false);
      expect(tcp.detail).toContain('ECONNREFUSED');

      const off = bridgeRow({ host: '198.51.100.99' });
      const api2 = await api(`/api/bridges/${off}/panel-check`, 'POST');
      expect(api2.status).toBe(200);
      expect(api2.body.steps).toHaveLength(1);
      expect(api2.body.steps[0]).toMatchObject({ ok: false, title: 'Пересылка панели включена' });
    } finally {
      process.env.PORT = previous;
    }
  });
});
