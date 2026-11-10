import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import { generate } from 'selfsigned';
import { db, initDatabase, setSetting } from '../src/db/index.js';
import { BRIDGE_HOLD_MS, BridgeService, buildBridgeRules, expectedRuleCount, parseHealth } from '../src/services/bridge.service.js';
import { decryptSecret, encryptSecret } from '../src/services/secrets.service.js';
import { DEFAULT_REALITY_TARGETS } from '../src/utils/vless-params.js';
import * as realityCheck from '../src/utils/reality-check.js';
import { createAdminApi } from './helpers/api.js';
import { getServer, insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { stubSsh, type SshCall } from './helpers/ssh-stub.js';
import { startTestServer, type TestEnv } from './test-app.js';

/**
 * Мосты в странах пользователей: установка по SSH, правила пересылки из БД, решение «нужен мост» и подмена адреса в подписке.
 * SSH подменён (stubSsh), сеть не используется.
 */

let env: TestEnv;
let api: ReturnType<typeof createAdminApi>['api'];

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  ({ api } = createAdminApi(env, 'bridgeadmin', 'BridgeAdminPass-1'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await env.close();
});

const decode = (b64: string) => Buffer.from(b64, 'base64').toString();
const decodeLinks = (body: string) => decode(body).split('\n').filter(Boolean);
const linkName = (link: string) => decodeURIComponent(link.split('#')[1] ?? '');
const linkConf = (link: string) => Buffer.from(link.slice('awg://'.length).split('#')[0], 'base64url').toString();

/** SSH-ответы моста: установка — успех, проверка — по состоянию `health` */
function bridgeSsh(health = { rules: -1, first: true }, fail?: (call: SshCall) => boolean) {
  return stubSsh((call) => {
    if (fail?.(call)) return { code: 1, stderr: 'iptables: No chain/target/match by that name.' };
    if (call.command.includes('deploy-bridge')) return { stdout: '[1/4] ...\n---DEMENTIA_BRIDGE_OK---\n' };
    if (call.command.includes('RULES $(')) {
      return { stdout: `RULES ${health.rules}\nFIRST ${health.first ? '-A FORWARD -j DEMENTIA-BRIDGE-FWD' : '-A FORWARD -j ufw-before-forward'}\nPRE 1\n` };
    }
    return {};
  });
}

async function withLocalServer<T>(server: net.Server, test: (port: number) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    return await test((server.address() as net.AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('проверка сертификата Reality', () => {
  it('проверяет доверие к цепочке и имя SNI, даже когда подключение идёт по IP', async () => {
    const name = 'mask.example';
    const { private: key, cert } = await generate([{ name: 'commonName', value: name }], {
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: name }] }],
    });
    await withLocalServer(tls.createServer({ key, cert }), async (port) => {
      expect(await realityCheck.checkRealityCertificate('127.0.0.1', port, name, { ca: cert })).toBe(true);
      expect(await realityCheck.checkRealityCertificate('127.0.0.1', port, 'wrong.example', { ca: cert })).toBe(false);
      expect(await realityCheck.checkRealityCertificate('127.0.0.1', port, name)).toBe(false);
    });
  });

  it('закрывает молчащий или слишком большой ответ TLS', async () => {
    await withLocalServer(net.createServer((socket) => socket.resume()), async (port) => {
      expect(await realityCheck.checkRealityCertificate('127.0.0.1', port, 'mask.example', { timeoutMs: 50 })).toBe(false);
    });
    await withLocalServer(net.createServer((socket) => {
      socket.on('error', () => {});
      socket.resume();
      socket.write(Buffer.alloc(256 * 1024));
    }), async (port) => {
      expect(await realityCheck.checkRealityCertificate('127.0.0.1', port, 'mask.example')).toBe(false);
    });
  });

  it('проверяет VLESS из статистического цикла и исключает нерабочий мост из подписок', async () => {
    bridgeSsh();
    const probe = vi.spyOn(realityCheck, 'checkRealityCertificate').mockResolvedValue(false);
    const server = insertServer({ name: 'Reality exit', awgPort: 443 });
    db.prepare("UPDATE servers SET protocol = 'vless', reality_sni = 'mask.example' WHERE id = ?").run(server);
    const result = await api('/api/bridges', 'POST', {
      name: 'Reality entrance', host: 'bridge.example', country: 'nz', ssh_password: 'secret',
      links: [{ server_id: server }],
    });
    const bridge = result.body.bridge.id as number;
    try {
      setSetting('probe_enabled', '0');
      await BridgeService.checkAll();
      expect(probe).toHaveBeenCalledWith('bridge.example', 443, 'mask.example');
      expect(BridgeService.get(bridge).links[0].check_ok).toBe(false);
      expect(BridgeService.routesFor('nz').has(server)).toBe(false);
      await BridgeService.checkAll();
      expect(probe).toHaveBeenCalledTimes(1);

      probe.mockResolvedValue(true);
      await BridgeService.checkLinks('vless');
      expect(BridgeService.get(bridge).links[0].check_ok).toBe(true);
      expect(BridgeService.routesFor('nz').get(server)?.bridge_id).toBe(bridge);
      probe.mockClear();
      const update = db.prepare('UPDATE bridge_links SET cascade_pending = ?, mode = ? WHERE bridge_id = ?');
      update.run(1, 'main', bridge);
      await BridgeService.checkLinks('vless');
      update.run(0, 'off', bridge);
      await BridgeService.checkLinks('vless');
      expect(probe).not.toHaveBeenCalled();
    } finally {
      db.prepare('DELETE FROM bridges WHERE id = ?').run(bridge);
      db.prepare('DELETE FROM servers WHERE id = ?').run(server);
      setSetting('probe_enabled', null);
    }
  });
});

describe('правила пересылки', () => {
  it('DNAT только для пакетов на адреса моста, UDP на порт AmneziaWG, TCP — на заглушку ноды', () => {
    const rules = buildBridgeRules([
      { listen_port: 51820, host: '203.0.113.9', awg_port: 51820, stub_port: 34567 },
      { listen_port: 40001, host: 'de.example.com', awg_port: 51820, stub_port: null },
    ]);
    expect(rules).toContain('iptables -t nat -I PREROUTING 1 -m addrtype --dst-type LOCAL -j DEMENTIA-BRIDGE');
    expect(rules).toContain('iptables -I FORWARD 1 -j DEMENTIA-BRIDGE-FWD');
    expect(rules).toContain("forward udp 51820 '203.0.113.9' 51820");
    expect(rules).toContain("forward tcp 51820 '203.0.113.9' 34567");
    expect(rules).toContain("forward udp 40001 'de.example.com' 51820");
    expect(rules).not.toContain("forward tcp 40001");
    expect(rules).toContain('echo "---RULES 3"');
  });

  it('нода VLESS пересылается только по TCP на свой порт, без заглушки', () => {
    const links = [
      { listen_port: 443, host: '203.0.113.10', awg_port: 443, stub_port: 34567, protocol: 'vless' },
      { listen_port: 51820, host: '203.0.113.9', awg_port: 51820, stub_port: null, protocol: 'awg' },
    ];
    const rules = buildBridgeRules(links);
    expect(rules).toContain("forward tcp 443 '203.0.113.10' 443");
    expect(rules).not.toContain("forward udp 443");
    expect(rules).not.toContain('34567');
    expect(rules).toContain("forward udp 51820 '203.0.113.9' 51820");
    expect(rules).toContain('echo "---RULES 2"');
    expect(expectedRuleCount(links)).toBe(2);
  });

  it('адрес ноды проверяется до подстановки в скрипт; IPv6 не поддерживается', () => {
    expect(() => buildBridgeRules([{ listen_port: 1, host: "1.2.3.4'; reboot; '", awg_port: 2, stub_port: null }])).toThrow(/не поддерживается/);
    expect(() => buildBridgeRules([{ listen_port: 1, host: '2001:db8::1', awg_port: 2, stub_port: null }])).toThrow(/не поддерживается/);
  });

  it('разбор проверки: число правил, переход первым в FORWARD, переход из PREROUTING', () => {
    expect(parseHealth('RULES 3\nFIRST -A FORWARD -j DEMENTIA-BRIDGE-FWD\nPRE 1\n')).toEqual({ rules: 3, forwardFirst: true, prerouting: true });
    expect(parseHealth('RULES 0\nFIRST -A FORWARD -j DOCKER-USER\nPRE 0\n')).toEqual({ rules: 0, forwardFirst: false, prerouting: false });
  });
});

describe('каскад XHTTP', () => {
  const fixtures: { bridge: number; server: number }[] = [];
  afterEach(() => {
    for (const { bridge, server } of fixtures.splice(0)) {
      db.prepare('DELETE FROM bridges WHERE id = ?').run(bridge);
      db.prepare('DELETE FROM servers WHERE id = ?').run(server);
    }
  });

  const setup = async () => {
    const server = insertServer({ name: 'Cascade exit', awgPort: 52301 });
    const result = await api('/api/bridges', 'POST', {
      name: 'Cascade entrance', host: `bridge-${server}.example.com`, country: 'ca', ssh_password: 'secret',
      links: [{ server_id: server }],
    });
    expect(result.body.success).toBe(true);
    const bridge = result.body.bridge.id as number;
    fixtures.push({ bridge, server });
    const endpoint = `/api/bridges/${bridge}/links/${server}/cascade`;
    return { server, bridge, endpoint };
  };

  it('заменяет DNAT без смены порта, ограничивает назначение и скрывает ключи от API', async () => {
    const ssh = bridgeSsh();
    const { server, bridge, endpoint } = await setup();
    db.prepare('UPDATE servers SET stub_port = 30881 WHERE id = ?').run(server);
    expect((await api(endpoint, 'PUT', { port: '8443' })).status).toBe(400);
    expect((await api(endpoint, 'PUT', { port: 22 })).status).toBe(409);
    const result = await api(endpoint, 'PUT', { port: 8443 });
    expect(result.status).toBe(200);
    expect(result.body.bridge.links[0]).toMatchObject({ cascade_port: 8443, listen_port: 52301 });
    const configs = ssh.calls.filter((call) => call.command.includes('config.new.json')).map((call) => JSON.parse(call.input!));
    expect(configs).toHaveLength(2);
    expect(configs[0].outbounds[0].protocol).toBe('blackhole');
    expect(configs[0].outbounds[1].settings.finalRules).toEqual([
      { action: 'allow', network: 'udp', ip: ['127.0.0.1'], port: 52301 },
      { action: 'allow', network: 'tcp', ip: ['127.0.0.1'], port: 30881 },
      { action: 'block' },
    ]);
    expect(configs[0].routing.rules).toEqual([
      { type: 'field', network: 'udp', ip: ['127.0.0.1'], port: 52301, outboundTag: 'loopback' },
      { type: 'field', network: 'tcp', ip: ['127.0.0.1'], port: 30881, outboundTag: 'loopback' },
    ]);
    expect(configs[1].inbounds.map((inbound: any) => inbound.port)).toEqual([52301, 52301]);
    const { id, privateKey } = {
      id: configs[0].inbounds[0].settings.clients[0].id,
      privateKey: configs[0].inbounds[0].streamSettings.realitySettings.privateKey,
    };
    const stored = db.prepare('SELECT cascade_secret FROM bridge_links WHERE bridge_id = ?').get(bridge) as { cascade_secret: string };
    expect(stored.cascade_secret).toMatch(/^enc:v1:/);
    expect(JSON.stringify(result.body)).not.toContain(id);
    expect(JSON.stringify(result.body)).not.toContain(privateKey);
    expect(ssh.calls.map((call) => call.command).join('\n')).not.toContain(id);
    const applied = ssh.calls.findLast((call) => call.command.includes('rules.sh.new'))?.input;
    expect(applied).toContain('clear_bridge_conntrack udp 52301 --dst-nat');
    expect(applied).not.toContain('forward udp 52301');
    expect(BridgeService.routesFor('ca').get(server)?.port).toBe(52301);

    expect((await api(`/api/bridges/${bridge}/links`, 'PUT', { links: [] })).status).toBe(409);
    expect((await api(`/api/servers/${server}`, 'DELETE')).status).toBe(409);
    expect((await api(endpoint, 'PUT', { port: null })).status).toBe(200);
    expect(ssh.calls.findLast((call) => call.command.includes('rules.sh.new'))?.input).toContain('forward udp 52301');
    expect(BridgeService.get(bridge).links[0].cascade_port).toBeNull();
  });

  it('снимает частично развёрнутый каскад и восстанавливает прежнюю пересылку после сбоя', async () => {
    const ssh = bridgeSsh(undefined, (call) => call.command.includes('/dev/tcp/'));
    const { server, bridge, endpoint } = await setup();
    const result = await api(endpoint, 'PUT', { port: 8443 });
    expect(result.status).toBe(502);
    expect(result.body.bridge).toMatchObject({ needs_apply: false, links: [{ server_id: server, cascade_port: null }] });
    expect(ssh.calls.filter((call) => call.command.includes('rmdir "/etc/dementia-cascade/'))).toHaveLength(2);
    expect(ssh.calls.findLast((call) => call.command.includes('rules.sh.new'))?.input).toContain('forward udp 52301');
    expect(BridgeService.routesFor('ca').get(server)?.bridge_id).toBe(bridge);
  });

  it('недоступная нода одной привязки не блокирует правила и другие привязки моста', async () => {
    bridgeSsh();
    const { server, bridge, endpoint } = await setup();
    expect((await api(endpoint, 'PUT', { port: 8443 })).status).toBe(200);
    const second = insertServer({ name: 'Second exit', host: `second-${server}.example.com`, awgPort: 52302 });
    fixtures.push({ bridge: 0, server: second });

    // нода первой привязки перестала отвечать по SSH
    const nodeHost = (db.prepare('SELECT host FROM servers WHERE id = ?').get(server) as { host: string }).host;
    const offline = stubSsh((call) => {
      if (call.host === nodeHost) throw new Error('connect ETIMEDOUT');
      if (call.command.includes('deploy-bridge')) return { stdout: '---DEMENTIA_BRIDGE_OK---' };
      return {};
    });
    const result = await api(`/api/bridges/${bridge}/links`, 'PUT', { links: [{ server_id: server }, { server_id: second }] });
    expect(result.status).toBe(200);
    const stored = BridgeService.get(bridge);
    expect(stored.links.map((l: any) => l.server_id).sort()).toEqual([server, second].sort());
    // каскад проблемной привязки помечен неприменённым и в подписку не выдаётся; новая привязка применена
    expect(stored.links.find((l: any) => l.server_id === server)).toMatchObject({ cascade_port: 8443, cascade_pending: true });
    expect(stored.last_error).toContain('Каскад XHTTP не применён');
    expect(stored.needs_apply).toBe(false);
    expect(BridgeService.routesFor('ca').get(server)).toBeUndefined();
    expect(BridgeService.routesFor('ca').get(second)?.bridge_id).toBe(bridge);
    expect(offline.calls.findLast((call) => call.command.includes('rules.sh.new'))?.input).toContain(`forward udp 52302`);

    // нода вернулась — следующая попытка применяет каскад и снимает пометку
    bridgeSsh();
    expect((await BridgeService.requestApply(bridge)).success).toBe(true);
    expect(BridgeService.get(bridge).links.find((l: any) => l.server_id === server)).toMatchObject({ cascade_pending: false });
    expect(BridgeService.get(bridge).last_error).toBeNull();
  });

  it('ждёт скачивания образа на обеих сторонах до замены контейнеров и DNAT', async () => {
    const pullStarted = Promise.withResolvers<void>();
    const pullFinished = Promise.withResolvers<void>();
    let pulls = 0;
    const ssh = stubSsh(async (call) => {
      if (call.command.includes('deploy-bridge')) return { stdout: '---DEMENTIA_BRIDGE_OK---' };
      if (call.command.includes('docker pull') && ++pulls === 2) {
        pullStarted.resolve();
        await pullFinished.promise;
      }
    });
    const { endpoint } = await setup();
    const applying = api(endpoint, 'PUT', { port: 8443 });
    try {
      await Promise.race([pullStarted.promise, applying.then(() => { throw new Error('Каскад завершился до загрузки образа'); })]);
      expect(ssh.calls.some((call) => call.command.includes('config.new.json') || call.command.includes('rules.sh.new'))).toBe(false);
      const downloads = ssh.spy.mock.calls.filter(([, command]) => command.includes('docker pull'));
      expect(downloads).toHaveLength(2);
      for (const [, command, options] of downloads) {
        expect(command).toContain('timeout -s TERM -k 30 1080 docker pull');
        expect(options).toMatchObject({ timeoutMs: 20 * 60 * 1000 });
      }
    } finally {
      pullFinished.resolve();
    }
    expect((await applying).body.success).toBe(true);
  });

  it.each([
    ['docker pull', 'Не удалось скачать образ Xray'],
    ['/proc/net/udp', 'включите userland-proxy'],
    ['--cascade-dependencies', 'Не удалось установить зависимости каскада'],
  ])('возвращает DNAT, если предварительная проверка %s не прошла', async (command, error) => {
    const ssh = bridgeSsh(undefined, (call) => call.command.includes(command));
    const { bridge, endpoint, server } = await setup();
    const result = await api(endpoint, 'PUT', { port: 8443 });
    expect(result.status).toBe(502);
    expect(result.body.error).toContain(error);
    expect(result.body.bridge).toMatchObject({ needs_apply: false, links: [{ cascade_port: null, listen_port: 52301 }] });
    expect(ssh.calls.some((call) => call.input?.startsWith('{"log":'))).toBe(false);
    expect(ssh.calls.findLast((call) => call.command.includes('rules.sh.new'))?.input).toContain('forward udp 52301');
    expect(BridgeService.routesFor('ca').get(server)?.bridge_id).toBe(bridge);
  });

  it('проверяет и устанавливает зависимости только для каскада до скачивания Xray', async () => {
    const ssh = bridgeSsh();
    const { endpoint } = await setup();
    expect(ssh.calls.some((call) => call.command.includes('--cascade-dependencies'))).toBe(false);
    expect((await api(endpoint, 'PUT', { port: 8443 })).status).toBe(200);
    const dependencyCheck = ssh.calls.findIndex((call) => call.command.includes('--cascade-dependencies'));
    const download = ssh.calls.findIndex((call) => call.command.includes('docker pull'));
    expect(dependencyCheck).toBeGreaterThanOrEqual(0);
    expect(download).toBeGreaterThan(dependencyCheck);
    expect(ssh.calls[dependencyCheck].input).toContain('install_cascade_dependencies');
  });

  it('API каскада передаёт сайт маскировки из запроса; неверное имя — 400 без обращения к серверам', async () => {
    const ssh = bridgeSsh();
    const { bridge, server } = await setup();
    const before = ssh.calls.length;
    const bad = await api(`/api/bridges/${bridge}/links/${server}/cascade`, 'PUT', { port: 8443, sni: 'https://mask.example' });
    expect(bad.status).toBe(400);
    expect(ssh.calls).toHaveLength(before);
    const ok = await api(`/api/bridges/${bridge}/links/${server}/cascade`, 'PUT', { port: 8443, sni: 'api.mask.example' });
    expect(ok.status).toBe(200);
    const configs = ssh.calls.filter((call) => call.input?.startsWith('{"log":')).map((call) => JSON.parse(call.input!));
    expect(configs[0].inbounds[0].streamSettings.realitySettings.serverNames).toEqual(['api.mask.example']);
    // Имя сайта маскировки хранится только в зашифрованном секрете и в ответе API не раскрывается
    expect(JSON.stringify(ok.body)).not.toContain('api.mask.example');
  });

  it('сохраняет выбранный SNI зашифрованным и использует его на обеих сторонах', async () => {
    const ssh = bridgeSsh();
    const { bridge, server } = await setup();
    for (const bad of [42, 'localhost', '127.0.0.1', 'test.example:443', 'https://test.example', 'test.example\nother']) {
      expect(() => BridgeService.setCascade(bridge, server, 8443, bad)).toThrow(/Сайт маскировки/);
    }
    expect(await BridgeService.setCascade(bridge, server, 8443, ' Mask.Example ')).toEqual({ success: true });
    const configs = ssh.calls.filter((call) => call.input?.startsWith('{"log":')).map((call) => JSON.parse(call.input!));
    expect(configs[0].inbounds[0].streamSettings.realitySettings).toMatchObject({ dest: 'mask.example:443', serverNames: ['mask.example'] });
    expect(configs[1].outbounds[0].streamSettings.realitySettings.serverName).toBe('mask.example');
    const stored = db.prepare('SELECT cascade_secret FROM bridge_links WHERE bridge_id = ?').get(bridge) as { cascade_secret: string };
    expect(stored.cascade_secret).toMatch(/^enc:v1:/);
    expect(JSON.parse(decryptSecret(stored.cascade_secret)!).sni).toBe('mask.example');
    expect(JSON.stringify(BridgeService.get(bridge))).not.toContain('mask.example');
    await expect(BridgeService.setCascade(bridge, server, 8443, 'other.example')).rejects.toThrow(/сначала отключите/);
  });

  it('выбирает SNI из списка только для новой привязки и оставляет прежний SNI старой', async () => {
    const ssh = bridgeSsh();
    const { bridge, server, endpoint } = await setup();
    expect((await api(endpoint, 'PUT', { port: 8443 })).status).toBe(200);
    const row = db.prepare('SELECT cascade_secret FROM bridge_links WHERE bridge_id = ?').get(bridge) as { cascade_secret: string };
    const secret = JSON.parse(decryptSecret(row.cascade_secret)!);
    expect(DEFAULT_REALITY_TARGETS).toContain(secret.sni);
    delete secret.sni;
    const legacy = encryptSecret(JSON.stringify(secret));
    db.prepare('UPDATE bridge_links SET cascade_secret = ? WHERE bridge_id = ?').run(legacy, bridge);
    expect((await api(endpoint, 'PUT', { port: 8443 })).status).toBe(200);
    const nodeConfig = ssh.calls.findLast((call) => call.input?.startsWith('{"log":') && call.input.includes('"inbounds"') && call.input.includes('"privateKey"'))?.input;
    expect(JSON.parse(nodeConfig!).inbounds[0].streamSettings.realitySettings.dest).toBe('dl.google.com:443');
    expect(db.prepare('SELECT cascade_secret FROM bridge_links WHERE bridge_id = ? AND server_id = ?').get(bridge, server)).toEqual({ cascade_secret: legacy });
  });
});

describe('API мостов', () => {
  let nodeA: number;
  let nodeB: number;
  let bridgeId: number;

  beforeAll(() => {
    nodeA = insertServer({ name: 'Frankfurt', host: '203.0.113.10' });
    nodeB = insertServer({ name: 'Helsinki', host: '203.0.113.11' });
  });

  it('проверка полей: страна — код из двух букв, нужен SSH-пароль или ключ, адрес — IP или домен', async () => {
    expect((await api('/api/bridges', 'POST', { name: 'M', host: '198.51.100.50', ssh_password: 'x', country: 'russia' })).status).toBe(400);
    expect((await api('/api/bridges', 'POST', { name: 'M', host: '198.51.100.50', country: 'ru' })).status).toBe(400);
    expect((await api('/api/bridges', 'POST', { name: 'M', host: 'bad host; rm', ssh_password: 'x', country: 'ru' })).status).toBe(400);
    expect((await api('/api/bridges', 'POST', { name: '', host: '198.51.100.50', ssh_password: 'x', country: 'ru' })).status).toBe(400);
    expect((await env.request('/api/bridges')).status).toBe(401);
  });

  it('добавление сразу устанавливает мост: скрипт по stdin, статус online, SSH-пароль хранится зашифрованным и не отдаётся', async () => {
    const ssh = bridgeSsh();
    const res = await api('/api/bridges', 'POST', {
      name: 'Москва', host: '198.51.100.50', ssh_password: 'S3cret!', country: 'RU', links: [{ server_id: nodeA }],
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.log).toContain('DEMENTIA_BRIDGE_OK');
    bridgeId = res.body.bridge.id;
    expect(res.body.bridge).toMatchObject({ name: 'Москва', country: 'ru', status: 'online', has_ssh_password: true });
    expect(res.body.bridge).not.toHaveProperty('ssh_password');
    expect(res.body.bridge).not.toHaveProperty('ssh_key');
    expect(JSON.stringify((await api('/api/bridges')).body)).not.toContain('S3cret!');

    const row = db.prepare('SELECT ssh_password, rules_hash FROM bridges WHERE id = ?').get(bridgeId) as any;
    expect(row.ssh_password).not.toBe('S3cret!');
    expect(decryptSecret(row.ssh_password)).toBe('S3cret!');
    expect(row.rules_hash).toMatch(/^[0-9a-f]{64}$/);

    // Скрипт передаётся через stdin, правила — в base64 внутри него
    const install = ssh.calls.find((c) => c.command.includes('deploy-bridge'))!;
    const rulesB64 = /RULES_B64='([A-Za-z0-9+/=]+)'/.exec(install.input!)![1];
    expect(decode(rulesB64)).toContain("forward udp 51820 '203.0.113.10' 51820");
    // Режим по умолчанию — «основной» (main): мост первым, прямой адрес запасным
    expect(res.body.bridge.links).toEqual([expect.objectContaining({ server_id: nodeA, listen_port: 51820, mode: 'main', active: false, check_ok: null })]);

    expect((await api('/api/bridges', 'POST', { name: 'Дубль', host: '198.51.100.50', ssh_password: 'x', country: 'ru' })).status).toBe(409);
  });

  it('ошибка установки: статус error с причиной, журнал возвращается', async () => {
    stubSsh((call) => (call.command.includes('deploy-bridge') ? { code: 1, stderr: 'sudo: a password is required' } : {}));
    const res = await api('/api/bridges', 'POST', { name: 'Плохой', host: '198.51.100.60', ssh_user: 'ubuntu', ssh_password: 'x', country: 'ru' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('sudo без пароля');
    expect(res.body.bridge.status).toBe('error');
    await api(`/api/bridges/${res.body.bridge.id}`, 'DELETE');
  });

  it('привязка нод: порт моста — порт AmneziaWG ноды, если свободен, иначе случайный; у привязанных порт не меняется', async () => {
    const ssh = bridgeSsh();
    const res = await api(`/api/bridges/${bridgeId}/links`, 'PUT', { links: [{ server_id: nodeA }, { server_id: nodeB, mode: 'always' }] });
    expect(res.status).toBe(200);
    const links = res.body.bridge.links;
    expect(links.find((l: any) => l.server_id === nodeA)).toMatchObject({ listen_port: 51820, mode: 'main' });
    const portB = links.find((l: any) => l.server_id === nodeB).listen_port;
    expect(portB).not.toBe(51820);
    expect(portB).toBeGreaterThanOrEqual(20000);
    // правила применены на мосту (stdin команды записи rules.sh)
    const apply = ssh.calls.find((c) => c.command.includes('rules.sh.new'))!;
    expect(apply.input).toContain(`forward udp ${portB} '203.0.113.11' 51820`);

    const again = await api(`/api/bridges/${bridgeId}/links`, 'PUT', { links: [{ server_id: nodeA, mode: 'off' }, { server_id: nodeB, mode: 'always' }] });
    expect(again.body.bridge.links.find((l: any) => l.server_id === nodeB).listen_port).toBe(portB);
    expect(again.body.bridge.links.find((l: any) => l.server_id === nodeA).mode).toBe('off');

    expect((await api(`/api/bridges/${bridgeId}/links`, 'PUT', { links: [{ server_id: nodeA, mode: 'sometimes' }] })).status).toBe(400);
    expect((await api(`/api/bridges/${bridgeId}/links`, 'PUT', { links: [{ server_id: 99999 }] })).status).toBe(404);
  });

  it('мост не принял правила — привязки возвращаются к прежним', async () => {
    const before = (await api('/api/bridges')).body.find((b: any) => b.id === bridgeId).links;
    bridgeSsh(undefined, (call) => call.command.includes('rules.sh.new'));
    const res = await api(`/api/bridges/${bridgeId}/links`, 'PUT', { links: [] });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('возвращены к прежним');
    expect(res.body.bridge.links).toEqual(before);
  });

  it('пустой список отвязывает все ноды', async () => {
    const id = Number(db.prepare("INSERT INTO bridges (name, host, ssh_password, country) VALUES ('Пустой', '198.51.100.99', 'x', 'ru')").run().lastInsertRowid);
    db.prepare("INSERT INTO bridge_links (bridge_id, server_id, listen_port) VALUES (?, ?, 51820), (?, ?, 40000)").run(id, nodeA, id, nodeB);
    expect((await BridgeService.setLinks(id, [])).success).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS c FROM bridge_links WHERE bridge_id = ?').get(id)).toEqual({ c: 0 });
    db.prepare('DELETE FROM bridges WHERE id = ?').run(id);
  });

  it('нода с IPv6-адресом не привязывается', async () => {
    const v6 = insertServer({ name: 'V6', host: '2001:db8::5' });
    bridgeSsh();
    const res = await api(`/api/bridges/${bridgeId}/links`, 'PUT', { links: [{ server_id: v6 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('IPv4');
    db.prepare('DELETE FROM servers WHERE id = ?').run(v6);
  });

  it('фоновый опрос: изменился порт ноды — правила применяются заново; правила пропали с моста — тоже', async () => {
    let ssh = bridgeSsh();
    db.prepare('UPDATE servers SET awg_port = 51999 WHERE id = ?').run(nodeB);
    await BridgeService.checkAll();
    const apply = ssh.calls.find((c) => c.command.includes('rules.sh.new'))!;
    expect(apply.input).toMatch(/forward udp \d+ '203\.0\.113\.11' 51999/);
    vi.restoreAllMocks();

    // Ничего не изменилось — повторного применения нет
    ssh = bridgeSsh({ rules: 0, first: false });
    await BridgeService.checkAll();
    expect(ssh.calls.some((c) => c.command.includes('rules.sh.new'))).toBe(false);
    vi.restoreAllMocks();

    // Проверка по SSH раз в две минуты: правил нет (перезагрузка без systemd) — пометка needs_apply
    vi.useFakeTimers({ now: Date.now() + 3 * 60 * 1000, toFake: ['Date'] });
    try {
      ssh = bridgeSsh({ rules: 0, first: false });
      await BridgeService.checkAll();
      expect(ssh.calls.some((c) => c.command.includes('RULES $('))).toBe(true);
      expect((db.prepare('SELECT needs_apply FROM bridges WHERE id = ?').get(bridgeId) as any).needs_apply).toBe(1);
      await BridgeService.checkAll();
      expect(ssh.calls.some((c) => c.command.includes('rules.sh.new'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('удаление моста с очисткой сервера убирает цепочки и автозапуск; при ошибке — 502 без force', async () => {
    const temp = (await (async () => {
      bridgeSsh();
      return api('/api/bridges', 'POST', { name: 'Temp', host: '198.51.100.70', ssh_password: 'x', country: 'kz' });
    })()).body.bridge.id;
    vi.restoreAllMocks();

    bridgeSsh(undefined, (call) => call.command.includes('DEMENTIA-BRIDGE-FWD 2>/dev/null; iptables -X'));
    expect((await api(`/api/bridges/${temp}?teardown=1`, 'DELETE')).status).toBe(502);
    vi.restoreAllMocks();

    const ssh = bridgeSsh();
    expect((await api(`/api/bridges/${temp}?teardown=1`, 'DELETE')).status).toBe(200);
    const cleanup = ssh.calls[0].command;
    expect(cleanup).toContain('iptables -t nat -X');
    expect(cleanup).toContain('rm -rf /etc/dementia-bridge');
    expect(db.prepare('SELECT 1 FROM bridges WHERE id = ?').get(temp)).toBeUndefined();
  });
});

describe('кому нужен мост', () => {
  let node: number;
  let bridge: number;

  const state = () => db.prepare('SELECT * FROM bridge_state WHERE server_id = ? AND country = ?').get(node, 'ru') as any;
  const setProbe = (ok: number, total: number) => {
    db.prepare(`
      INSERT INTO probe_results (server_id, country, method, ok_nodes, total_nodes, verified, checked_at) VALUES (?, 'ru', 'stub', ?, ?, 1, ?)
      ON CONFLICT(server_id, country) DO UPDATE SET ok_nodes = excluded.ok_nodes, total_nodes = excluded.total_nodes, checked_at = excluded.checked_at
    `).run(node, ok, total, new Date().toISOString());
  };

  beforeAll(() => {
    setSetting('probe_enabled', '1');
    setSetting('probe_countries', '["ru","kz"]');
    node = insertServer({ name: 'Amsterdam', host: '203.0.113.20' });
    bridge = Number(
      db.prepare("INSERT INTO bridges (name, host, ssh_password, country, status) VALUES ('MSK', '198.51.100.80', 'x', 'ru', 'online')").run().lastInsertRowid
    );
    db.prepare("INSERT INTO bridge_links (bridge_id, server_id, listen_port, mode) VALUES (?, ?, 51820, 'auto')").run(bridge, node);
  });

  afterAll(() => {
    setSetting('probe_enabled', null);
    setSetting('probe_countries', null);
    db.prepare('DELETE FROM servers WHERE id = ?').run(node);
    db.prepare('DELETE FROM bridges WHERE id = ?').run(bridge);
  });

  it('проверка из страны: мост включается после двух проблемных проверок подряд, одна — не повод', () => {
    setProbe(0, 2);
    BridgeService.evaluate(true);
    expect(state()).toMatchObject({ active: 0, fail_streak: 1 });
    // Промежуточные пересчёты (без новой проверки) серию не увеличивают
    BridgeService.evaluate(false);
    expect(state()).toMatchObject({ active: 0, fail_streak: 1 });
    BridgeService.evaluate(true);
    expect(state()).toMatchObject({ active: 1, fail_streak: 2, reason: 'probe' });
    expect(BridgeService.routesFor('ru').get(node)).toMatchObject({ host: '198.51.100.80', port: 51820 });
    expect(BridgeService.routesFor('kz').size).toBe(0);
  });

  it('выключение — только после трёх проверок без проблем и не раньше срока удержания', () => {
    setProbe(2, 2);
    for (let i = 0; i < 3; i++) BridgeService.evaluate(true);
    expect(state()).toMatchObject({ active: 1, ok_streak: 3 });
    const later = Date.now() + BRIDGE_HOLD_MS + 60000;
    BridgeService.evaluate(true, later);
    expect(state()).toMatchObject({ active: 0 });
    expect(BridgeService.routesFor('ru').has(node)).toBe(false);
  });

  it('половина узлов страны недоступна — ещё не проблема, большинство — проблема', () => {
    setProbe(1, 2);
    BridgeService.evaluate(true);
    expect(state().fail_streak).toBe(0);
    setProbe(1, 3);
    BridgeService.evaluate(true);
    expect(state().fail_streak).toBe(1);
  });

  it('нода недоступна панели — мост не включается (он не поможет)', () => {
    db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(node);
    setProbe(0, 2);
    const before = state();
    BridgeService.evaluate(true);
    BridgeService.evaluate(true);
    expect(state()).toEqual(before);
    db.prepare("UPDATE servers SET status = 'online' WHERE id = ?").run(node);
    db.prepare('DELETE FROM bridge_state').run();
    db.prepare('DELETE FROM probe_results WHERE server_id = ?').run(node);
  });

  describe('сигнал от клиентов', () => {
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
    let ruSub: number;
    let kzSub: number;
    const clients: number[] = [];

    beforeAll(() => {
      ruSub = insertSubscriber({ name: 'ru-users' });
      kzSub = insertSubscriber({ name: 'kz-users' });
      db.prepare("UPDATE subscribers SET country = 'ru' WHERE id = ?").run(ruSub);
      db.prepare("UPDATE subscribers SET country = 'kz' WHERE id = ?").run(kzSub);
      for (let i = 0; i < 4; i++) clients.push(insertClient(node, { subscriberId: ruSub, ip: `10.8.0.${100 + i}` }).id);
      clients.push(insertClient(node, { subscriberId: kzSub, ip: '10.8.0.120' }).id);
    });

    const handshakes = (ru: number[], kz: number) => {
      ru.forEach((m, i) => db.prepare('UPDATE clients SET last_handshake = ? WHERE id = ?').run(ago(m), clients[i]));
      db.prepare('UPDATE clients SET last_handshake = ? WHERE id = ?').run(ago(kz), clients[4]);
    };

    it('у клиентов страны рукопожатия оборвались одновременно, у других идут — мост включается сразу', () => {
      handshakes([20, 21, 22, 24], 1);
      expect(BridgeService.passiveSuspect(node, 'ru')).toBe(true);
      BridgeService.evaluate(false);
      expect(state()).toMatchObject({ active: 1, reason: 'clients' });
    });

    it('клиенты выключали VPN по одному (вечером) — не сигнал', () => {
      handshakes([20, 80, 150, 230], 1);
      expect(BridgeService.passiveSuspect(node, 'ru')).toBe(false);
    });

    it('ещё не прошло 15 минут тишины, клиентов мало или вся нода молчит — не сигнал', () => {
      handshakes([5, 6, 7, 8], 1);
      expect(BridgeService.passiveSuspect(node, 'ru')).toBe(false);
      handshakes([20, 21, 22, 24], 30);
      expect(BridgeService.passiveSuspect(node, 'ru')).toBe(false);
      db.prepare('UPDATE clients SET last_handshake = NULL WHERE id IN (?, ?)').run(clients[2], clients[3]);
      db.prepare('UPDATE clients SET last_handshake = ? WHERE id = ?').run(ago(1), clients[4]);
      expect(BridgeService.passiveSuspect(node, 'ru')).toBe(false);
    });
  });
});

describe('мост в подписке', () => {
  let node: number;
  let other: number;
  let bridge: number;
  let ruToken: string;
  let kzToken: string;
  let noneToken: string;

  const fetchSub = async (token: string, format = '') => {
    const res = await env.request(`/sub/${token}${format}`);
    return res.text();
  };

  beforeAll(() => {
    db.prepare('DELETE FROM bridges').run();
    db.prepare('DELETE FROM bridge_state').run();
    node = insertServer({ name: 'Paris', host: '203.0.113.30' });
    other = insertServer({ name: 'Riga', host: '203.0.113.31' });
    bridge = Number(
      db.prepare("INSERT INTO bridges (name, host, ssh_password, country, status) VALUES ('SPB', '198.51.100.90', 'x', 'ru', 'online')").run().lastInsertRowid
    );
    db.prepare("INSERT INTO bridge_links (bridge_id, server_id, listen_port, mode) VALUES (?, ?, 40404, 'auto')").run(bridge, node);
    db.prepare("INSERT INTO bridge_state (server_id, country, active, changed_at) VALUES (?, 'ru', 1, ?)").run(node, new Date().toISOString());

    const make = (name: string, country: string | null) => {
      const id = insertSubscriber({ name });
      db.prepare('UPDATE subscribers SET country = ? WHERE id = ?').run(country, id);
      insertClient(node, { subscriberId: id });
      insertClient(other, { subscriberId: id });
      return (db.prepare('SELECT token FROM subscribers WHERE id = ?').get(id) as any).token;
    };
    ruToken = make('ivan', 'ru');
    kzToken = make('aigul', 'kz');
    noneToken = make('nobody', null);
  });

  afterAll(() => {
    db.prepare('DELETE FROM bridges').run();
  });

  it('пользователю из страны моста выдаётся адрес моста — только для ноды, где мост нужен; ключи не меняются', async () => {
    const links = decodeLinks(await fetchSub(ruToken));
    expect(links.map(linkName)).toEqual(['Paris · 🌉 🇷🇺', 'Riga']);
    const viaBridge = linkConf(links[0]);
    expect(viaBridge).toContain('Endpoint = 198.51.100.90:40404');
    expect(viaBridge).toContain(`PublicKey = ${getServer(node).server_public_key}`);
    expect(linkConf(links[1])).toContain('Endpoint = 203.0.113.31:51820');
  });

  it('пользователям другой страны и без страны — прямой адрес', async () => {
    for (const token of [kzToken, noneToken]) {
      const links = decodeLinks(await fetchSub(token));
      expect(links.map(linkName)).toEqual(['Paris', 'Riga']);
      expect(linkConf(links[0])).toContain('Endpoint = 203.0.113.30:51820');
    }
  });

  it('mihomo и JSON получают тот же адрес моста', async () => {
    const clash = JSON.parse(await fetchSub(ruToken, '?format=clash'));
    expect(clash.proxies[0]).toMatchObject({ name: 'Paris · 🌉 🇷🇺', server: '198.51.100.90', port: 40404 });
    const json = JSON.parse(await fetchSub(ruToken, '?format=json'));
    expect(Buffer.from(json.servers[0].config, 'base64url').toString()).toContain('Endpoint = 198.51.100.90:40404');
  });

  it('мост не выдаётся: режим off, пересылка не прошла проверку, мост офлайн, состояние выключено', async () => {
    const direct = async () => linkConf(decodeLinks(await fetchSub(ruToken))[0]).includes('Endpoint = 203.0.113.30:51820');

    db.prepare("UPDATE bridge_links SET mode = 'off' WHERE bridge_id = ?").run(bridge);
    expect(await direct()).toBe(true);
    db.prepare("UPDATE bridge_links SET mode = 'auto', check_ok = 0 WHERE bridge_id = ?").run(bridge);
    expect(await direct()).toBe(true);
    db.prepare('UPDATE bridge_links SET check_ok = 1 WHERE bridge_id = ?').run(bridge);
    db.prepare("UPDATE bridges SET status = 'offline' WHERE id = ?").run(bridge);
    expect(await direct()).toBe(true);
    db.prepare("UPDATE bridges SET status = 'online' WHERE id = ?").run(bridge);
    db.prepare("UPDATE bridge_state SET active = 0 WHERE server_id = ?").run(node);
    expect(await direct()).toBe(true);
  });

  it('режим always — мост всегда, независимо от проверок', async () => {
    db.prepare("UPDATE bridge_links SET mode = 'always' WHERE bridge_id = ?").run(bridge);
    expect(linkConf(decodeLinks(await fetchSub(ruToken))[0])).toContain('Endpoint = 198.51.100.90:40404');
    db.prepare("UPDATE bridge_links SET mode = 'auto' WHERE bridge_id = ?").run(bridge);
  });

  it('сквозная проверка пересылки: ответ заглушки ноды через мост с её меткой — исправен, иначе мост не выдаётся', async () => {
    db.prepare("UPDATE servers SET stub_port = 34567, stub_token = 'tok123' WHERE id = ?").run(node);
    const requested: string[] = [];
    let body = '<html><!-- tok123 --></html>';
    vi.stubGlobal('fetch', async (input: any) => {
      requested.push(String(input));
      return new Response(body, { status: 200 });
    });
    await BridgeService.checkLinks();
    expect(requested[0]).toMatch(/^http:\/\/198\.51\.100\.90:40404\/[0-9a-f]{16}$/);
    expect((db.prepare('SELECT check_ok FROM bridge_links WHERE bridge_id = ?').get(bridge) as any).check_ok).toBe(1);

    body = '<html>чужой сайт</html>';
    await BridgeService.checkLinks();
    expect((db.prepare('SELECT check_ok FROM bridge_links WHERE bridge_id = ?').get(bridge) as any).check_ok).toBe(0);
    db.prepare("UPDATE bridge_state SET active = 1 WHERE server_id = ?").run(node);
    expect(BridgeService.routesFor('ru').size).toBe(0);
  });
});

describe('страна пользователя', () => {
  it('задаётся кодом из двух букв, приводится к нижнему регистру, очищается пустым значением', async () => {
    const created = await api('/api/subscribers', 'POST', { name: 'olga', country: 'RU' });
    expect(created.status).toBe(201);
    expect(created.body.country).toBe('ru');
    expect((await api(`/api/subscribers/${created.body.id}`, 'PUT', { country: 'Russia' })).status).toBe(400);
    expect((await api(`/api/subscribers/${created.body.id}`, 'PUT', { country: '' })).body.country).toBeNull();
    expect((await api(`/api/subscribers/${created.body.id}`, 'PUT', { name: 'olga2' })).body.country).toBeNull();
  });
});


