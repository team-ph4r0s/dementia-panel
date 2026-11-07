import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { detectFormat } from '../src/routes/subscription.js';
import { renderSubscriptionPage } from '../src/routes/subscription-page.js';
import { BridgeService } from '../src/services/bridge.service.js';
import { XrayService } from '../src/services/xray.service.js';
import { insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { startTestServer } from './test-app.js';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const PUBLIC_KEY = Buffer.alloc(32, 1).toString('base64');

function vlessServer(overrides: Record<string, unknown> = {}) {
  return {
    host: '203.0.113.50',
    awg_port: 443,
    server_public_key: PUBLIC_KEY,
    reality_sni: 'www.microsoft.com',
    reality_short_ids: JSON.stringify(['0123456789abcdef', 'fedcba9876543210']),
    xray_flow: 'xtls-rprx-vision',
    xray_fingerprint: 'chrome',
    ...overrides,
  };
}

let env: Awaited<ReturnType<typeof startTestServer>>;
let token: string;
let vlessId: number;

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  const awgId = insertServer({ name: 'AWG Германия', host: '203.0.113.10' });
  vlessId = insertServer({ name: 'VLESS Финляндия / основной', host: '203.0.113.50', awgPort: 443 });
  db.prepare(`UPDATE servers SET protocol = 'vless', reality_sni = 'www.microsoft.com',
    reality_dest = 'www.microsoft.com:443', reality_short_ids = ?, xray_flow = 'xtls-rprx-vision',
    xray_fingerprint = 'chrome' WHERE id = ?`).run(JSON.stringify(['0123456789abcdef']), vlessId);
  const subscriber = insertSubscriber({ name: 'Смешанный пользователь' });
  db.prepare("UPDATE subscribers SET country = 'ru' WHERE id = ?").run(subscriber);
  token = (db.prepare('SELECT token FROM subscribers WHERE id = ?').get(subscriber) as { token: string }).token;
  insertClient(awgId, { subscriberId: subscriber });
  const vless = insertClient(vlessId, { subscriberId: subscriber });
  db.prepare("UPDATE clients SET client_uuid = ?, client_ip = '', client_public_key = '', client_private_key = '' WHERE id = ?").run(UUID, vless.id);
  const withoutUuid = insertClient(vlessId, { subscriberId: subscriber });
  db.prepare("UPDATE clients SET client_ip = '', client_public_key = '', client_private_key = '' WHERE id = ?").run(withoutUuid.id);
});

afterAll(async () => {
  await env.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function subscription(format = '', userAgent?: string) {
  const response = await env.request(`/sub/${token}${format}`, userAgent ? { headers: { 'User-Agent': userAgent } } : {});
  return { response, body: await response.text() };
}

function decodeList(body: string) {
  return Buffer.from(body, 'base64').toString('utf-8').split('\n').filter(Boolean);
}

describe('VLESS + Reality в подписках', () => {
  it('строит разбираемую URL-ссылку с параметрами Reality и кодирует имя', () => {
    const link = XrayService.buildVlessLink(vlessServer(), { client_uuid: UUID }, 'Финляндия / основной #1');
    const url = new URL(link);
    expect(url.protocol).toBe('vless:');
    expect(url.username).toBe(UUID);
    expect(url.hostname).toBe('203.0.113.50');
    expect(url.port).toBe('443');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      type: 'tcp',
      security: 'reality',
      pbk: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
      fp: 'chrome',
      sni: 'www.microsoft.com',
      sid: '0123456789abcdef',
      flow: 'xtls-rprx-vision',
      encryption: 'none',
    });
    expect(decodeURIComponent(url.hash.slice(1))).toBe('Финляндия / основной #1');
  });

  it('не добавляет пустой flow и подставляет endpoint моста', () => {
    const server = vlessServer({ xray_flow: '' });
    const link = XrayService.buildVlessLink(server, { client_uuid: UUID }, 'VLESS', '198.51.100.80', 8443);
    const url = new URL(link);
    expect(url.hostname).toBe('198.51.100.80');
    expect(url.port).toBe('8443');
    expect(url.searchParams.has('flow')).toBe(false);
    expect(XrayService.buildMihomoProxy(server, { client_uuid: UUID }, 'VLESS')).not.toHaveProperty('flow');
  });

  it('добавляет VLESS-прокси mihomo с reality-opts', () => {
    expect(XrayService.buildMihomoProxy(vlessServer(), { client_uuid: UUID }, 'VLESS')).toEqual({
      name: 'VLESS',
      type: 'vless',
      server: '203.0.113.50',
      port: 443,
      uuid: UUID,
      network: 'tcp',
      tls: true,
      udp: true,
      flow: 'xtls-rprx-vision',
      servername: 'www.microsoft.com',
      'client-fingerprint': 'chrome',
      'reality-opts': { 'public-key': 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', 'short-id': '0123456789abcdef' },
    });
  });

  it.each(['v2rayN/7.0', 'v2rayNG/1.9', 'Hiddify/3.0', 'Streisand/1.6', 'Happ/2.0', 'NekoBox/1.3'])(
    'выбирает v2ray для User-Agent %s', (userAgent) => {
      expect(detectFormat(undefined, userAgent)).toBe('v2ray');
      expect(detectFormat('awg', userAgent)).toBe('awg');
    }
  );

  it('не принимает похожее имя приложения за Happ', () => {
    expect(detectFormat(undefined, 'HappyBrowser/1.0')).toBe('awg');
  });

  it('смешанный подписчик получает AWG и VLESS в Incy и JSON', async () => {
    const incy = decodeList((await subscription()).body);
    expect(incy).toHaveLength(2);
    expect(incy.some((link) => link.startsWith('awg://'))).toBe(true);
    expect(incy.some((link) => link.startsWith('vless://'))).toBe(true);

    const json = JSON.parse((await subscription('?format=json')).body);
    expect(json.servers).toHaveLength(2);
    expect(json.servers.find((entry: any) => entry.protocol === 'vless')).toMatchObject({
      name: 'VLESS Финляндия / основной',
      protocol: 'vless',
      link: expect.stringMatching(/^vless:\/\//),
    });
    expect(json.servers.find((entry: any) => entry.protocol !== 'vless').config).toEqual(expect.any(String));
  });

  it('смешанный mihomo содержит оба прокси и оба имени в группе', async () => {
    const config = JSON.parse((await subscription('?format=clash')).body);
    expect(config.proxies.map((proxy: any) => proxy.type)).toEqual(['wireguard', 'vless']);
    expect(config.proxies[1]['reality-opts']).toEqual({
      'public-key': expect.any(String),
      'short-id': '0123456789abcdef',
    });
    expect(config['proxy-groups'][0].proxies).toEqual(config.proxies.map((proxy: any) => proxy.name));
  });

  it('v2ray по параметру и User-Agent отдаёт только VLESS и пропускает клиента без UUID', async () => {
    for (const request of [subscription('?format=v2ray'), subscription('', 'v2rayNG/1.9.0')]) {
      const { response, body } = await request;
      expect(response.headers.get('content-type')).toContain('text/plain');
      const links = decodeList(body);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatch(/^vless:\/\//);
      expect(body).not.toContain('awg://');
    }
  });

  it('подменяет адрес VLESS через BridgeService.routesFor во всех форматах', async () => {
    vi.spyOn(BridgeService, 'routesFor').mockReturnValue(new Map([[vlessId, { host: '198.51.100.80', port: 8443 }]]));
    for (const format of ['', '?format=json', '?format=v2ray']) {
      const { body } = await subscription(format);
      const link = format === '?format=json'
        ? JSON.parse(body).servers.find((entry: any) => entry.protocol === 'vless').link
        : decodeList(body).find((entry) => entry.startsWith('vless://'))!;
      const url = new URL(link);
      expect(url.hostname).toBe('198.51.100.80');
      expect(url.port).toBe('8443');
    }
    const clash = JSON.parse((await subscription('?format=clash')).body);
    expect(clash.proxies.find((proxy: any) => proxy.type === 'vless')).toMatchObject({ server: '198.51.100.80', port: 8443 });
  });

  it('возвращает только ASCII-заголовки для смешанной подписки', async () => {
    const { response } = await subscription('?format=v2ray');
    for (const [name, value] of response.headers) expect(value, name).toMatch(/^[\x20-\x7e]*$/);
  });

  it('страница предлагает VLESS-подписку и совместимые приложения', () => {
    const html = renderSubscriptionPage({ title: 'VPN', status: 'Активна', active: true, expire: 0, used: 0, limit: 0, nodes: [], url: 'https://p.example/sub/t' });
    expect(html).toContain('?format=v2ray');
    for (const app of ['v2rayNG', 'Hiddify', 'Streisand', 'Happ', 'v2rayN']) expect(html).toContain(app);
  });
});
