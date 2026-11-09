import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSetting, initDatabase, setSetting } from '../src/db/index.js';
import {
  countryFlag,
  matchStubHits,
  parseHttpResult,
  parseTcpResult,
  parseUdpResult,
  probeStatus,
  ProbeService,
} from '../src/services/probe.service.js';
import { parseStubHits, parseStubPort, stubInstallScript, stubPortCandidates } from '../src/services/stub.service.js';
import { createAdminApi } from './helpers/api.js';
import { insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { stubSsh } from './helpers/ssh-stub.js';
import { installProviderStub, provider, resetProvider, stubNodeResponder, stubNodeState, type StubNodeState } from './helpers/check-host.js';
import { startTestServer, type TestEnv } from './test-app.js';

/**
 * Проверка доступности нод из выбранных стран: заглушка на ноде + check-host.net с подтверждением по журналу ноды.
 * Сеть не используется: fetch к check-host.net подменён (helpers/check-host.ts), SSH — stubSsh.
 */

let env: TestEnv;
let api: ReturnType<typeof createAdminApi>['api'];
let serverId: number;
let subToken: string;
let node: StubNodeState;
let ssh: ReturnType<typeof stubSsh>;

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  ({ api } = createAdminApi(env, 'probeadmin', 'ProbeAdminPass-1'));
  ProbeService.pollDelayMs = 0;
  ProbeService.pollTotalMs = 150;
  serverId = insertServer({ name: 'Frankfurt', host: '203.0.113.9' });
  const subscriberId = insertSubscriber({ name: 'dave' });
  insertClient(serverId, { name: 'dave-phone', subscriberId });
  subToken = (db.prepare('SELECT token FROM subscribers WHERE id = ?').get(subscriberId) as any).token;
});

beforeEach(() => {
  resetProvider();
  installProviderStub();
  ProbeService.resetCountriesCache();
  node = stubNodeState();
  ssh = stubSsh(stubNodeResponder(node));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  ProbeService.pollDelayMs = null;
  await env.close();
});

const decodeLinks = (body: string) =>
  Buffer.from(body, 'base64')
    .toString()
    .split('\n')
    .map((line) => decodeURIComponent(line.split('#')[1] ?? ''));

const decodeHeader = (value: string | null) => Buffer.from((value ?? '').replace(/^base64:/, ''), 'base64').toString();

describe('разбор ответов check-host.net и журнала заглушки', () => {
  it('http: [[1, …]] — успех с задержкой в мс, [[0, …]] — отказ, прочее — нет результата', () => {
    expect(parseHttpResult([[1, 0.13, 'OK', '200', '1.2.3.4']])).toEqual({ ok: true, rtt: 130 });
    expect(parseHttpResult([[0, 0.07, 'No such device or address', null, null]])).toEqual({ ok: false, rtt: null });
    expect(parseHttpResult(null)).toBeNull();
    expect(parseHttpResult([[null]])).toBeNull();
    expect(parseHttpResult('garbage')).toBeNull();
  });

  it('tcp: объект со временем — успех, с error — отказ, прочее — нет результата', () => {
    expect(parseTcpResult([{ time: 0.031, address: '1.2.3.4' }])).toEqual({ ok: true, rtt: 31 });
    expect(parseTcpResult([{ error: 'Connection timed out' }])).toEqual({ ok: false, rtt: null });
    expect(parseTcpResult(null)).toBeNull();
    expect(parseTcpResult([{}])).toBeNull();
  });

  it('udp: {timeout} — ответа нет (реальный формат check-host.net), {time} — ответ пришёл', () => {
    expect(parseUdpResult([{ address: '1.1.1.1', timeout: 1 }])).toEqual({ ok: false, rtt: null });
    expect(parseUdpResult([{ address: '1.1.1.1', time: 0.05 }])).toEqual({ ok: true, rtt: 50 });
    expect(parseUdpResult(null)).toBeNull();
  });

  it('статус страны и флаг', () => {
    expect(probeStatus(2, 2)).toBe('ok');
    expect(probeStatus(1, 2)).toBe('partial');
    expect(probeStatus(0, 2)).toBe('fail');
    expect(countryFlag('ru')).toBe('🇷🇺');
    expect(countryFlag('KZ')).toBe('🇰🇿');
  });

  it('журнал: берутся только строки строгого формата, IPv4 из IPv6-сокета приводится к обычному виду', () => {
    const parsed = parseStubHits(
      ['RUNNING true', '1761400000 tcp ::ffff:198.51.100.1 /abc123', '1761400001 udp 198.51.100.2 -', '1761400002 tcp 1.2.3.4 /$(reboot)', 'x'].join('\n')
    );
    expect(parsed.running).toBe(true);
    expect(parsed.hits).toEqual([
      { at: 1761400000, proto: 'tcp', ip: '198.51.100.1', path: '/abc123' },
      { at: 1761400001, proto: 'udp', ip: '198.51.100.2', path: '' },
    ]);
    expect(parseStubHits('RUNNING false').running).toBe(false);
    expect(parseStubPort('...\n---STUB_PORT 34567\n')).toBe(34567);
    expect(parseStubPort('---STUB_PORT 99999')).toBeNull();
  });

  it('сопоставление: метка проверки обязательна, незнакомый адрес с меткой засчитывается узлу, сообщившему об успехе', () => {
    const nodes = new Map([
      ['a', { ip: '198.51.100.1' }],
      ['b', { ip: '198.51.100.2' }],
    ]);
    const hits = [
      { at: 100, proto: 'tcp' as const, ip: '198.51.100.1', path: '/other' },
      { at: 100, proto: 'tcp' as const, ip: '203.0.113.50', path: '/nonce1' },
      { at: 100, proto: 'udp' as const, ip: '203.0.113.50', path: '' },
      { at: 10, proto: 'udp' as const, ip: '198.51.100.1', path: '' },
    ];
    const matched = matchStubHits(hits, 'nonce1', 50, nodes, (id) => id === 'b');
    expect([...matched.tcp]).toEqual(['b']);
    expect([...matched.udp]).toEqual(['b']);
  });

  it('порт заглушки: не из распространённых, не порт AmneziaWG/SSH; текущий порт — первым кандидатом', () => {
    const candidates = stubPortCandidates([51820, 22], 31111, 50);
    expect(candidates[0]).toBe(31111);
    expect(new Set(candidates).size).toBe(50);
    for (const p of candidates) {
      expect(p).toBeGreaterThanOrEqual(20000);
      expect(p).toBeLessThanOrEqual(60999);
      expect([51820, 22, 25565, 32400, 51821]).not.toContain(p);
    }
    const script = stubInstallScript([31111, 42222], 'deadbeef');
    expect(script).toContain('for p in 31111 42222; do');
    expect(script).toContain('--network host');
    expect(script).not.toContain('amnezia-awg');
  });
});

describe('настройки и страны', () => {
  it('по умолчанию проверка выключена, результатов нет, адреса нод никуда не отправляются', async () => {
    const res = await api('/api/probes');
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ enabled: false, countries: [], interval_minutes: 30, show_in_name: true, show_in_description: true, globalping: false });
    expect(res.body.results).toEqual([]);
    expect(res.body.servers).toEqual([expect.objectContaining({ id: serverId, host: '203.0.113.9', probe_port: null, stub_port: null })]);
    expect(provider.calls).toEqual([]);
    // Пока проверка выключена, заглушка на ноды не ставится
    expect(ssh.calls).toEqual([]);

    expect((await api('/api/servers')).body[0].probes).toEqual([]);
    expect((await env.request('/api/probes')).status).toBe(401);
  });

  it('список стран берётся у провайдера, группируется по странам и кэшируется', async () => {
    const first = await api('/api/probes/countries');
    expect(first.status).toBe(200);
    expect(first.body).toEqual([
      { code: 'de', name: 'Germany', nodes: ['de1.node.check-host.net'], cities: ['Nuremberg'] },
      { code: 'kz', name: 'Kazakhstan', nodes: ['kz1.node.check-host.net'], cities: ['Karaganda'] },
      { code: 'ru', name: 'Russia', nodes: ['ru1.node.check-host.net', 'ru2.node.check-host.net', 'ru3.node.check-host.net'], cities: ['Moscow', 'Saint Petersburg', 'Novosibirsk'] },
    ]);
    await api('/api/probes/countries');
    expect(provider.calls.filter((c) => c.path === '/nodes/hosts')).toHaveLength(1);
  });

  it('недоступность провайдера — 502 с понятным текстом; чужие идентификаторы узлов игнорируются', async () => {
    provider.failNodesList = true;
    const down = await api('/api/probes/countries');
    expect(down.status).toBe(502);
    expect(down.body.error).toContain('check-host.net');

    provider.failNodesList = false;
    provider.nodes['evil.example.com'] = ['ru', 'Russia', 'X'];
    provider.nodes['ru9.node.check-host.net'] = ['<script>', 'Bad', 'X'] as any;
    ProbeService.resetCountriesCache();
    const list = (await api('/api/probes/countries')).body as any[];
    expect(list.flatMap((c) => c.nodes)).not.toContain('evil.example.com');
    expect(list.map((c) => c.code)).toEqual(['de', 'kz', 'ru']);
  });

  it('валидация настроек: страна — двухбуквенный код, не более 8, интервал 10–1440, включение требует стран', async () => {
    expect((await api('/api/probes', 'PUT', { settings: { enabled: true } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { settings: { countries: ['russia'] } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { settings: { countries: ['ru; DROP'] } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { settings: { countries: 'ru' } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { settings: { countries: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh', 'ii'] } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { settings: { interval_minutes: 5 } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { settings: { interval_minutes: 2000 } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { servers: [{ id: serverId, probe_port: 70000 }] })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { servers: [{ id: 99999, probe_port: 22 }] })).status).toBe(404);
    expect(ProbeService.readSettings().enabled).toBe(false);
  });

  it('настройки сохраняются: коды приводятся к нижнему регистру, дубли убираются', async () => {
    const res = await api('/api/probes', 'PUT', { settings: { enabled: true, countries: ['RU', 'kz', 'ru'], interval_minutes: 15, show_in_description: false } });
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ enabled: true, countries: ['ru', 'kz'], interval_minutes: 15, show_in_name: true, show_in_description: false, globalping: false });
    expect(getSetting('probe_countries')).toBe('["ru","kz"]');
  });
});

describe('проверка нод заглушкой', () => {
  beforeAll(async () => {
    await api('/api/probes', 'PUT', { settings: { enabled: true, countries: ['ru', 'kz'], interval_minutes: 30, show_in_description: true } });
  });

  it('первый обход ставит заглушку на ноду; узлы обращаются к ней по HTTP с меткой и по UDP', async () => {
    const result = await ProbeService.runAll();
    expect(result).toEqual({ checked: 1, errors: [] });
    expect(node.installs).toBe(1);
    expect(db.prepare('SELECT stub_port, stub_token FROM servers WHERE id = ?').get(serverId)).toEqual({ stub_port: 34567, stub_token: expect.stringMatching(/^[0-9a-f]{24}$/) });

    const http = provider.calls.find((c) => c.path === '/check-http')!;
    expect(http.host).toMatch(/^http:\/\/203\.0\.113\.9:34567\/[0-9a-f]{16}$/);
    // по два узла от каждой страны (ru3 не берётся)
    expect(http.nodes).toEqual(['ru1.node.check-host.net', 'ru2.node.check-host.net', 'kz1.node.check-host.net']);
    expect(provider.calls.find((c) => c.path === '/check-udp')!.host).toBe('203.0.113.9:34567');
    expect(provider.calls.some((c) => c.path === '/check-ping')).toBe(false);
    // контейнер AmneziaWG заглушка не трогает
    const install = ssh.calls.find((c) => c.command.includes('---STUB_PORT'))!;
    expect(install.command).toContain('dementia-probe');
    expect(install.command).not.toContain('amnezia-awg');
  });

  it('доступность считается по журналу ноды: подменённый ответ не засчитывается', async () => {
    db.prepare('UPDATE servers SET stub_port = 34567 WHERE id = ?').run(serverId);
    await ProbeService.runAll();
    // повторной установки нет: заглушка уже стоит
    expect(node.installs).toBe(0);

    const probes = (await api('/api/servers')).body[0].probes;
    expect(probes).toEqual([
      // ru1 дошёл по TCP и UDP; ru2 «ответил», но в журнале его нет — подмена
      expect.objectContaining({ country: 'ru', method: 'stub', ok_nodes: 1, total_nodes: 2, tcp_ok: 1, udp_ok: 1, spoofed: 1, verified: true, status: 'partial', rtt_ms: 40 }),
      expect.objectContaining({ country: 'kz', ok_nodes: 0, total_nodes: 1, tcp_ok: 0, udp_ok: 0, spoofed: 1, verified: true, status: 'fail' }),
    ]);
    expect(getSetting('probe_error')).toBeNull();
    expect((await api('/api/probes')).body.status.running).toBe(false);
  });

  it('check-host.net не доставил ни одного UDP-пакета (как на реальной ноде) — нода доступна по TCP, UDP неизвестен', async () => {
    provider.reach = {
      tcp: new Set(['ru1.node.check-host.net', 'ru2.node.check-host.net', 'kz1.node.check-host.net']),
      udp: new Set(),
    };
    await ProbeService.runAll();
    const probes = (await api('/api/servers')).body[0].probes;
    expect(probes).toEqual([
      expect.objectContaining({ country: 'ru', ok_nodes: 2, total_nodes: 2, tcp_ok: 2, udp_ok: null, spoofed: 0, status: 'ok' }),
      expect.objectContaining({ country: 'kz', ok_nodes: 1, total_nodes: 1, tcp_ok: 1, udp_ok: null, status: 'ok' }),
    ]);
  });

  it('до ноды дошёл только UDP (TCP оборвался по дороге) — нода доступна с этого узла', async () => {
    provider.http['kz1.node.check-host.net'] = [[0, 5.1, 'Broken pipe', null, '203.0.113.9']];
    provider.reach = { tcp: new Set(['ru1.node.check-host.net']), udp: new Set(['ru1.node.check-host.net', 'kz1.node.check-host.net']) };
    await ProbeService.runAll();
    const kz = (await api('/api/servers')).body[0].probes.find((p: any) => p.country === 'kz');
    expect(kz).toMatchObject({ ok_nodes: 1, total_nodes: 1, tcp_ok: 0, udp_ok: 1, spoofed: 0, status: 'ok' });
  });

  it('узел вышел в сеть с другого адреса: обращение с меткой засчитывается ему, UDP с того же адреса — тоже', async () => {
    provider.egress['ru2.node.check-host.net'] = '203.0.113.77';
    provider.reach.tcp.add('ru2.node.check-host.net');
    provider.reach.udp.add('ru2.node.check-host.net');
    await ProbeService.runAll();
    const ru = (await api('/api/servers')).body[0].probes.find((p: any) => p.country === 'ru');
    expect(ru).toMatchObject({ ok_nodes: 2, total_nodes: 2, spoofed: 0, status: 'ok' });
  });

  it('узлы, ещё не закончившие проверку, опрашиваются повторно', async () => {
    provider.pendingPolls = 2;
    provider.reach.udp.add('kz1.node.check-host.net');
    expect(await ProbeService.runAll()).toEqual({ checked: 1, errors: [] });
    expect(provider.polls.httpreq1).toBe(3);
    const kz = (await api('/api/servers')).body[0].probes.find((p: any) => p.country === 'kz');
    expect(kz).toMatchObject({ ok_nodes: 1, total_nodes: 1, status: 'ok' });
  });

  it('UDP-проверку запустить не удалось — решает TCP по журналу', async () => {
    provider.failUdpStart = true;
    provider.reach.tcp.add('kz1.node.check-host.net');
    await ProbeService.runAll();
    const probes = (await api('/api/servers')).body[0].probes;
    expect(probes.find((p: any) => p.country === 'kz')).toMatchObject({ ok_nodes: 1, total_nodes: 1, udp_ok: null, tcp_ok: 1 });
  });

  it('журнал не прочитан — засчитываются ответы узлов без подтверждения, это отмечается в ошибке', async () => {
    node.readFails = true;
    const result = await ProbeService.runAll();
    expect(result.checked).toBe(1);
    expect(result.errors[0]).toContain('не подтверждён');
    const ru = (await api('/api/servers')).body[0].probes.find((p: any) => p.country === 'ru');
    expect(ru).toMatchObject({ ok_nodes: 2, total_nodes: 2, verified: false, spoofed: 0 });
  });

  it('контейнер заглушки пропал — порт сбрасывается, следующий обход ставит её заново', async () => {
    const token = (db.prepare('SELECT stub_token FROM servers WHERE id = ?').get(serverId) as any).stub_token;
    node.running = false;
    const first = await ProbeService.runAll();
    expect(first.errors.join(' ')).toContain('будет установлена заново');
    expect(db.prepare('SELECT stub_port FROM servers WHERE id = ?').get(serverId)).toEqual({ stub_port: null });

    node.port = 45678;
    await ProbeService.runAll();
    expect(node.installs).toBe(1);
    expect(db.prepare('SELECT stub_port FROM servers WHERE id = ?').get(serverId)).toEqual({ stub_port: 45678 });
    // метка страницы сохраняется: по ней проверяется пересылка через мосты
    expect(db.prepare('SELECT stub_token FROM servers WHERE id = ?').get(serverId)).toEqual({ stub_token: token });
  });

  it('заглушку поставить не удалось: нода с TCP-портом проверяется по TCP, без него — ошибка с причиной', async () => {
    db.prepare('UPDATE servers SET stub_port = NULL WHERE id = ?').run(serverId);
    node.installFails = true;
    const failed = await ProbeService.runAll();
    expect(failed.checked).toBe(0);
    expect(failed.errors.join(' ')).toContain('Не удалось запустить заглушку');

    await api('/api/probes', 'PUT', { servers: [{ id: serverId, probe_port: 443 }] });
    const tcp = await ProbeService.runAll();
    expect(tcp.checked).toBe(1);
    expect(provider.calls.filter((c) => c.path === '/check-tcp').pop()!.host).toBe('203.0.113.9:443');
    const probes = (await api('/api/servers')).body[0].probes;
    expect(probes).toEqual([
      expect.objectContaining({ country: 'ru', method: 'tcp', ok_nodes: 2, total_nodes: 2, verified: false, status: 'ok', rtt_ms: 38 }),
      expect.objectContaining({ country: 'kz', method: 'tcp', ok_nodes: 0, total_nodes: 1, status: 'fail' }),
    ]);
    await api('/api/probes', 'PUT', { servers: [{ id: serverId, probe_port: null }] });
    db.prepare('UPDATE servers SET stub_port = 34567 WHERE id = ?').run(serverId);
  });

  it('нода партнёра (без SSH): заглушка не ставится, проверка по TCP-порту (IPv6 — в скобках) или ошибка', async () => {
    const panel = db.prepare("INSERT INTO remote_panels (name, base_url, token, status) VALUES ('P', 'https://p.example', 'x', 'online')").run();
    const partnerNode = insertServer({ name: 'Partner', host: '2001:db8::1' });
    db.prepare('UPDATE servers SET remote_panel_id = ?, remote_node_id = 1 WHERE id = ?').run(panel.lastInsertRowid, partnerNode);
    try {
      const noPort = await ProbeService.runAll();
      expect(noPort.errors).toContain('Partner: нода партнёра — укажите TCP-порт для проверки');
      expect(ssh.calls.every((c) => !c.command.includes('---STUB_PORT'))).toBe(true);

      await api('/api/probes', 'PUT', { servers: [{ id: partnerNode, probe_port: 443 }] });
      await ProbeService.runAll();
      expect(provider.calls.filter((c) => c.path === '/check-tcp').pop()!.host).toBe('[2001:db8::1]:443');
    } finally {
      db.prepare('DELETE FROM servers WHERE id = ?').run(partnerNode);
      db.prepare('DELETE FROM remote_panels WHERE id = ?').run(panel.lastInsertRowid);
    }
  });

  it('ответ провайдера с чужим request_id или без ok отклоняется, ошибка сохраняется, результаты не портятся', async () => {
    await ProbeService.runAll();
    const before = JSON.stringify((await api('/api/servers')).body[0].probes);

    provider.startReply = { ok: 1, request_id: '../../etc/passwd', nodes: {} };
    const bad = await ProbeService.runAll();
    expect(bad.checked).toBe(0);
    expect(bad.errors[0]).toContain('Frankfurt');
    expect(getSetting('probe_error')).toContain('Frankfurt');
    expect(JSON.stringify((await api('/api/servers')).body[0].probes)).toBe(before);

    provider.startReply = { ok: 0, error: 'limit exceeded' };
    expect((await ProbeService.runAll()).errors[0]).toContain('limit exceeded');
  });

  it('недоступный провайдер не ломает цикл: ошибка записывается, прежние результаты на месте', async () => {
    await ProbeService.runAll();
    provider.failNodesList = true;
    ProbeService.resetCountriesCache();
    const result = await ProbeService.runAll();
    expect(result.checked).toBe(0);
    expect(getSetting('probe_error')).toContain('check-host.net');
    expect((await api('/api/servers')).body[0].probes.length).toBeGreaterThan(0);
  });

  it('страна без проверяющих узлов отмечается в ошибке, остальные проверяются', async () => {
    await api('/api/probes', 'PUT', { settings: { countries: ['ru', 'zz'] } });
    const result = await ProbeService.runAll();
    expect(result.checked).toBe(1);
    expect(result.errors).toEqual(['нет проверяющих узлов в странах: ZZ']);
    await api('/api/probes', 'PUT', { settings: { countries: ['ru', 'kz'] } });
  });

  it('после обхода вызывается обработчик мостов; его ошибка не ломает проверку', async () => {
    const calls: number[] = [];
    ProbeService.afterRun = async () => {
      calls.push(1);
      throw new Error('boom');
    };
    try {
      expect((await ProbeService.runAll()).checked).toBe(1);
      expect(calls).toEqual([1]);
    } finally {
      ProbeService.afterRun = null;
    }
  });

  it('ручной запуск: 202 и фоновая проверка; повторный в течение минуты — 429; без включения — 400', async () => {
    setSetting('probe_last_run', new Date().toISOString());
    expect((await api('/api/probes/run', 'POST')).status).toBe(429);
    setSetting('probe_last_run', new Date(Date.now() - 5 * 60000).toISOString());
    const started = await api('/api/probes/run', 'POST');
    expect(started.status).toBe(202);
    await vi.waitFor(() => expect(ProbeService.getStatus().running).toBe(false));
    await vi.waitFor(() => expect(Date.now() - new Date(getSetting('probe_last_run')!).getTime()).toBeLessThan(5000));

    await api('/api/probes', 'PUT', { settings: { enabled: false } });
    expect((await api('/api/probes/run', 'POST')).status).toBe(400);
    await api('/api/probes', 'PUT', { settings: { enabled: true } });
  });

  it('очередной обход по расписанию: пора только когда прошёл интервал', () => {
    setSetting('probe_last_run', new Date().toISOString());
    expect(ProbeService.isDue()).toBe(false);
    setSetting('probe_last_run', new Date(Date.now() - 31 * 60000).toISOString());
    expect(ProbeService.isDue()).toBe(true);
    setSetting('probe_last_run', null);
    expect(ProbeService.isDue()).toBe(true);
  });
});

describe('доступность в подписке', () => {
  beforeAll(async () => {
    resetProvider();
    installProviderStub();
    await api('/api/probes', 'PUT', { settings: { enabled: true, countries: ['ru', 'kz'], show_in_name: true, show_in_description: true } });
    await api('/api/subscription-settings', 'PUT', { settings: { description: 'Быстрые серверы' } });
    setSetting('probe_last_run', null);
    db.prepare('UPDATE servers SET stub_port = 34567 WHERE id = ?').run(serverId);
    const s = stubSsh(stubNodeResponder(stubNodeState()));
    await ProbeService.runAll();
    s.spy.mockRestore();
  });

  it('к названию ноды дописываются флаги стран и статусы, к описанию — пояснение', async () => {
    const res = await env.request(`/sub/${subToken}`);
    expect(res.status).toBe(200);
    expect(decodeLinks(await res.text())).toEqual(['Frankfurt · 🇷🇺⚠️ 🇰🇿❌']);

    const description = decodeHeader(res.headers.get('profile-description'));
    expect(description).toContain('Быстрые серверы');
    expect(description).toContain('Доступность нод из стран: 🇷🇺 Россия, 🇰🇿 Казахстан');
    expect(description).toContain('✅ доступна');
    expect(description).toMatch(/Проверено \d{2}\.\d{2} \d{2}:\d{2} UTC\./);
    // Заголовки только ASCII (инвариант 19): значение передано как base64
    expect(res.headers.get('profile-description')).toMatch(/^base64:[A-Za-z0-9+/=]+$/);
  });

  it('те же названия в JSON-контейнере и в формате mihomo', async () => {
    const json = (await (await env.request(`/sub/${subToken}?format=json`)).json()) as any;
    expect(json.servers.map((s: any) => s.name)).toEqual(['Frankfurt · 🇷🇺⚠️ 🇰🇿❌']);
    const clash = JSON.parse(await (await env.request(`/sub/${subToken}?format=clash`)).text());
    expect(clash.proxies.map((p: any) => p.name)).toEqual(['Frankfurt · 🇷🇺⚠️ 🇰🇿❌']);
  });

  it('отображаемое имя сервера (sub_name) сохраняется, пометки добавляются после него', async () => {
    db.prepare('UPDATE servers SET sub_name = ? WHERE id = ?').run('🇩🇪 Германия', serverId);
    try {
      const res = await env.request(`/sub/${subToken}`);
      expect(decodeLinks(await res.text())).toEqual(['🇩🇪 Германия · 🇷🇺⚠️ 🇰🇿❌']);
    } finally {
      db.prepare('UPDATE servers SET sub_name = NULL WHERE id = ?').run(serverId);
    }
  });

  it('переключатели: без пометок в названии и/или без пояснения в описании', async () => {
    await api('/api/probes', 'PUT', { settings: { show_in_name: false } });
    const noName = await env.request(`/sub/${subToken}`);
    expect(decodeLinks(await noName.text())).toEqual(['Frankfurt']);
    expect(decodeHeader(noName.headers.get('profile-description'))).toContain('Доступность нод из стран');

    await api('/api/probes', 'PUT', { settings: { show_in_name: true, show_in_description: false } });
    const noLegend = await env.request(`/sub/${subToken}`);
    expect(decodeLinks(await noLegend.text())).toEqual(['Frankfurt · 🇷🇺⚠️ 🇰🇿❌']);
    expect(decodeHeader(noLegend.headers.get('profile-description'))).toBe('Быстрые серверы');
    await api('/api/probes', 'PUT', { settings: { show_in_description: true } });
  });

  it('устаревшие результаты в подписку не попадают, выключенная проверка — тоже', async () => {
    db.prepare('UPDATE probe_results SET checked_at = ?').run(new Date(Date.now() - 4 * 3600 * 1000).toISOString());
    const stale = await env.request(`/sub/${subToken}`);
    expect(decodeLinks(await stale.text())).toEqual(['Frankfurt']);
    expect(decodeHeader(stale.headers.get('profile-description'))).toBe('Быстрые серверы');
    expect((await api('/api/servers')).body[0].probes).toEqual([]);

    await ProbeService.runAll();
    expect(decodeLinks(await (await env.request(`/sub/${subToken}`)).text())).toEqual(['Frankfurt · 🇷🇺⚠️ 🇰🇿❌']);

    await api('/api/probes', 'PUT', { settings: { enabled: false } });
    const off = await env.request(`/sub/${subToken}`);
    expect(decodeLinks(await off.text())).toEqual(['Frankfurt']);
    expect(decodeHeader(off.headers.get('profile-description'))).toBe('Быстрые серверы');
  });

  it('страна, убранная из списка, пропадает из результатов сразу', async () => {
    await api('/api/probes', 'PUT', { settings: { enabled: true, countries: ['ru', 'kz'] } });
    await ProbeService.runAll();
    await api('/api/probes', 'PUT', { settings: { countries: ['kz'] } });
    expect(db.prepare('SELECT country FROM probe_results').all()).toEqual([{ country: 'kz' }]);
    expect(decodeLinks(await (await env.request(`/sub/${subToken}`)).text())).toEqual(['Frankfurt · 🇰🇿❌']);
  });

  it('удаление сервера удаляет и его результаты', async () => {
    const tempId = insertServer({ name: 'Temp', host: '203.0.113.77' });
    db.prepare('INSERT INTO probe_results (server_id, country, ok_nodes, total_nodes, rtt_ms, checked_at) VALUES (?, ?, 1, 1, 10, ?)').run(tempId, 'kz', new Date().toISOString());
    db.prepare('DELETE FROM servers WHERE id = ?').run(tempId);
    expect(db.prepare('SELECT COUNT(*) AS c FROM probe_results WHERE server_id = ?').get(tempId)).toEqual({ c: 0 });
  });
});


