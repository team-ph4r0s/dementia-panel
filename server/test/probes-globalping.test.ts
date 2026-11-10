import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSetting, initDatabase } from '../src/db/index.js';
import { ProbeService } from '../src/services/probe.service.js';
import { createAdminApi } from './helpers/api.js';
import { insertServer } from './helpers/db.js';
import { stubSsh, type SshCall } from './helpers/ssh-stub.js';
import { installProviderStub, provider, resetProvider, stubNodeResponder, stubNodeState, type StubNodeState } from './helpers/check-host.js';
import { startTestServer, type TestEnv } from './test-app.js';

/**
 * Второй источник проверки из стран — Globalping: пробы в сетях провайдеров, у каждой страны своя метка запроса,
 * доступность засчитывается по журналу заглушки ноды. Сеть не используется: api.globalping.io подменён.
 */

let env: TestEnv;
let api: ReturnType<typeof createAdminApi>['api'];
let serverId: number;
let node: StubNodeState;

/** Сценарий Globalping */
const gp = {
  /** Пробы сервиса: страна и есть ли метка сети провайдера */
  probes: [] as { country: string; eyeball: boolean }[],
  /** Сколько проб страны на самом деле дошло до ноды и сколько сообщило об ответе 200 */
  reach: {} as Record<string, number>,
  claimed: {} as Record<string, number>,
  /** Все пробы выходят с одного адреса (CGNAT) */
  sameIp: false,
  rateLimited: false,
  down: false,
  /** Созданные измерения: тело запроса и метка из пути */
  created: [] as { id: string; country: string; eyeball: boolean; probes: number; nonce: string; body: any }[],
  calls: [] as string[],
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function globalpingStub(url: URL, init?: any): Response | null {
  if (url.origin !== 'https://api.globalping.io') return null;
  gp.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  if (gp.down) return new Response('down', { status: 503 });
  if (url.pathname === '/v1/probes') {
    return json(200, gp.probes.map((p) => ({ location: { country: p.country.toUpperCase() }, tags: [p.eyeball ? 'eyeball-network' : 'datacenter-network'] })));
  }
  if (url.pathname === '/v1/measurements' && init?.method === 'POST') {
    if (gp.rateLimited) return json(429, { error: { type: 'too_many_probes' } });
    const body = JSON.parse(init.body);
    const location = body.locations[0];
    const country = String(location.country).toLowerCase();
    const eyeball = Array.isArray(location.tags) && location.tags.includes('eyeball-network');
    const available = gp.probes.filter((p) => p.country === country && (!eyeball || p.eyeball)).length;
    if (available === 0) return json(422, { error: { type: 'no_probes_found' } });
    const id = `meas${gp.created.length + 1}abc`;
    const probes = Math.min(available, location.limit);
    gp.created.push({ id, country, eyeball, probes, nonce: String(body.measurementOptions.request.path).slice(1), body });
    return json(202, { id, probesCount: probes });
  }
  const read = /^\/v1\/measurements\/(\w+)$/.exec(url.pathname);
  if (read) {
    const measurement = gp.created.find((m) => m.id === read[1]);
    if (!measurement) return json(404, {});
    const claimed = gp.claimed[measurement.country] ?? gp.reach[measurement.country] ?? 0;
    return json(200, {
      status: 'finished',
      results: Array.from({ length: measurement.probes }, (_, i) => ({
        probe: { country: measurement.country.toUpperCase() },
        result: i < claimed ? { status: 'finished', statusCode: 200 } : { status: 'failed' },
      })),
    });
  }
  return json(404, {});
}

/** SSH-ответы ноды: к журналу заглушки добавляются обращения проб Globalping, которые «дошли» */
function responder(state: StubNodeState) {
  const base = stubNodeResponder(state);
  return (call: SshCall) => {
    const answer = base(call);
    if (!answer || !('stdout' in answer) || !call.command.includes('hits.log') || !call.command.includes('RUNNING')) return answer;
    const now = Math.floor(Date.now() / 1000);
    const lines: string[] = [];
    for (const measurement of gp.created) {
      for (let i = 0; i < (gp.reach[measurement.country] ?? 0); i++) lines.push(`${now} tcp ${gp.sameIp ? '192.0.2.10' : `192.0.2.${10 + lines.length}`} /${measurement.nonce}`);
    }
    return { ...answer, stdout: `${answer.stdout}${lines.join('\n')}\n` };
  };
}

const settings = (extra: Record<string, unknown> = {}) =>
  api('/api/probes', 'PUT', { settings: { enabled: true, countries: ['ru', 'kz'], globalping: true, ...extra } });
const resultOf = (country: string) => db.prepare('SELECT * FROM probe_results WHERE server_id = ? AND country = ?').get(serverId, country) as any;

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  ({ api } = createAdminApi(env, 'gpadmin', 'GpAdminPass-1'));
  ProbeService.pollDelayMs = 0;
  ProbeService.pollTotalMs = 150;
  db.exec("UPDATE servers SET status = 'uninstalled'");
  serverId = insertServer({ name: 'Frankfurt', host: '203.0.113.9' });
});

beforeEach(() => {
  resetProvider();
  installProviderStub(globalpingStub);
  ProbeService.resetCountriesCache();
  node = stubNodeState();
  stubSsh(responder(node));
  Object.assign(gp, {
    probes: [
      { country: 'ru', eyeball: true }, { country: 'ru', eyeball: true }, { country: 'ru', eyeball: false },
      { country: 'kz', eyeball: false },
      { country: 'cn', eyeball: true }, { country: 'cn', eyeball: true },
    ],
    reach: { ru: 2, kz: 1, cn: 2 },
    claimed: {},
    rateLimited: false,
    sameIp: false,
    down: false,
    created: [],
    calls: [],
  });
  db.exec('DELETE FROM probe_results');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  ProbeService.pollDelayMs = null;
  await env.close();
});

describe('Globalping — второй источник проверки из стран', () => {
  it('по умолчанию выключен: к сервису панель не обращается ни при обходе, ни за списком стран', async () => {
    await settings({ globalping: false });
    expect((await api('/api/probes')).body.settings.globalping).toBe(false);
    await ProbeService.runAll();
    const countries = (await api('/api/probes/countries')).body;
    expect(gp.calls).toEqual([]);
    expect(countries.map((c: any) => c.code)).toEqual(['de', 'kz', 'ru']);
    expect(resultOf('ru')).toMatchObject({ gp_ok: null, gp_total: null, gp_eyeball: null });
  });

  it('список стран дополняется странами, где есть только пробы Globalping, с числом проб', async () => {
    await settings();
    const countries = (await api('/api/probes/countries')).body;
    expect(countries.map((c: any) => c.code)).toEqual(['cn', 'de', 'kz', 'ru']);
    expect(countries.find((c: any) => c.code === 'cn')).toMatchObject({ nodes: [], gp_probes: 2, gp_eyeball: 2 });
    expect(countries.find((c: any) => c.code === 'ru')).toMatchObject({ gp_probes: 3, gp_eyeball: 2 });
    expect(countries.find((c: any) => c.code === 'de').gp_probes).toBeUndefined();
  });

  it('на каждую страну — своё измерение к заглушке ноды со своей меткой; пробы из сетей провайдеров, иначе любые', async () => {
    await settings();
    await ProbeService.runAll();

    expect(gp.created.map((m) => [m.country, m.eyeball, m.probes])).toEqual([['ru', true, 2], ['kz', false, 1]]);
    const ru = gp.created[0].body;
    expect(ru).toMatchObject({
      type: 'http',
      target: '203.0.113.9',
      locations: [{ country: 'RU', limit: 2, tags: ['eyeball-network'] }],
      measurementOptions: { protocol: 'HTTP', port: node.port, request: { method: 'GET' } },
    });
    expect(gp.created[0].nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set([gp.created[0].nonce, gp.created[1].nonce, provider.lastNonce]).size).toBe(3);
  });

  it('результат страны складывается из обоих источников и подтверждается журналом ноды', async () => {
    await settings();
    await ProbeService.runAll();

    // check-host.net: из двух узлов РФ до ноды дошёл один (второй — подмена); Globalping: дошли обе пробы
    expect(resultOf('ru')).toMatchObject({ ok_nodes: 3, total_nodes: 4, gp_ok: 2, gp_total: 2, gp_eyeball: 1, spoofed: 1, verified: 1 });
    // Казахстан: узел check-host.net не дошёл, проба Globalping (дата-центр) дошла
    expect(resultOf('kz')).toMatchObject({ ok_nodes: 1, total_nodes: 2, gp_ok: 1, gp_total: 1, gp_eyeball: 0 });
    const shown = (await api('/api/servers')).body.find((s: any) => s.id === serverId).probes;
    expect(shown.find((p: any) => p.country === 'ru')).toMatchObject({ status: 'partial', gp_ok: 2, gp_total: 2, gp_eyeball: true });
  });

  it('проба сообщила об ответе, а в журнале ноды её нет — подмена, доступность не засчитывается', async () => {
    gp.reach.ru = 0;
    gp.claimed.ru = 2;
    await settings();
    await ProbeService.runAll();
    expect(resultOf('ru')).toMatchObject({ ok_nodes: 1, total_nodes: 4, gp_ok: 0, gp_total: 2, spoofed: 3 });
  });

  it('пробы за одним адресом (CGNAT) не считаются подделкой: подтверждается число обращений, а не число адресов', async () => {
    gp.sameIp = true;
    await settings();
    await ProbeService.runAll();
    expect(resultOf('ru')).toMatchObject({ gp_ok: 2, gp_total: 2, spoofed: 1 });
    expect(resultOf('kz')).toMatchObject({ gp_ok: 1, gp_total: 1 });
  });

  it('обращения проб Globalping не приписываются узлам check-host.net', async () => {
    // ни один узел check-host.net до ноды не дошёл, хотя оба сообщили об успехе; пробы Globalping дошли с незнакомых адресов
    provider.reach = { tcp: new Set(), udp: new Set() };
    await settings();
    await ProbeService.runAll();
    expect(resultOf('ru')).toMatchObject({ ok_nodes: 2, total_nodes: 4, gp_ok: 2, spoofed: 2 });
  });

  it('страна только с пробами Globalping проверяется без check-host.net', async () => {
    await settings({ countries: ['cn'] });
    await ProbeService.runAll();
    expect(resultOf('cn')).toMatchObject({ method: 'stub', ok_nodes: 2, total_nodes: 2, gp_ok: 2, gp_total: 2, gp_eyeball: 1, udp_ok: null, verified: 1 });
    expect(provider.calls.filter((c) => c.path.startsWith('/check-'))).toEqual([]);
    expect(getSetting('probe_error')).toBeNull();
  });

  it('лимит Globalping исчерпан: обход продолжается на check-host.net, сообщение одно на весь обход', async () => {
    insertServer({ name: 'Second', host: '203.0.113.10' });
    gp.rateLimited = true;
    await settings();
    await ProbeService.runAll();
    expect(resultOf('ru')).toMatchObject({ ok_nodes: 1, total_nodes: 2, gp_total: null });
    // Ноды проверяются параллельно: до отметки о лимите запрос успевает уйти не больше чем от каждой из них, по одной стране
    expect(gp.calls.filter((c) => c === 'POST /v1/measurements').length).toBeLessThanOrEqual(2);
    expect(getSetting('probe_error')!.match(/исчерпан лимит/g)).toHaveLength(1);
    db.prepare("UPDATE servers SET status = 'uninstalled' WHERE host = '203.0.113.10'").run();
  });

  it('Globalping недоступен — проверка идёт через check-host.net, это отмечается', async () => {
    await settings();
    ProbeService.resetCountriesCache();
    gp.down = true;
    await ProbeService.runAll();
    expect(resultOf('ru')).toMatchObject({ ok_nodes: 1, total_nodes: 2, gp_total: null });
    expect(getSetting('probe_error')).toContain('Globalping недоступен');
  });

  it('check-host.net недоступен, Globalping работает — результаты есть', async () => {
    await settings();
    ProbeService.resetCountriesCache();
    await api('/api/probes/countries');
    provider.failNodesList = true;
    ProbeService['countriesCache' as keyof typeof ProbeService] = null as never;
    await ProbeService.runAll();
    expect(resultOf('ru')).toMatchObject({ ok_nodes: 2, total_nodes: 2, gp_ok: 2, gp_total: 2 });
  });

  it('журнал ноды не прочитан — засчитываются заявления проб без подтверждения', async () => {
    node.readFails = true;
    gp.claimed.ru = 1;
    await settings();
    await ProbeService.runAll();
    expect(resultOf('ru')).toMatchObject({ gp_ok: 1, gp_total: 2, verified: 0 });
  });

  describe('Оценка расхода лимита Globalping (globalping_budget)', () => {
    it('отдаёт нули при выключенной проверке или выключенном Globalping', async () => {
      await settings({ enabled: false, globalping: false, countries: ['ru', 'de'] });
      const res = await api('/api/probes');
      expect(res.body.globalping_budget).toEqual({ per_run: 0, per_hour: 0, limit: 250 });

      await settings({ enabled: true, globalping: false, countries: ['ru', 'de'] });
      const res2 = await api('/api/probes');
      expect(res2.body.globalping_budget).toEqual({ per_run: 0, per_hour: 0, limit: 250 });

      await settings({ enabled: true, globalping: true, countries: [] });
      const res3 = await api('/api/probes');
      expect(res3.body.globalping_budget).toEqual({ per_run: 0, per_hour: 0, limit: 250 });
    });

    it('считает 2 ноды × 3 страны = 12 за обход, при 15 мин = 48 в час; проверяет исключённые ноды и не обращается к Globalping', async () => {
      const callsBefore = gp.calls.length;
      // Первая нода (serverId) уже имеет stub_port: 33333
      // Вторая подходящая нода
      const s2 = insertServer({ name: 'SecondAWG', host: '198.51.100.2', protocol: 'awg' });
      db.prepare('UPDATE servers SET stub_port = 44444 WHERE id = ?').run(s2);

      // Исключённые ноды:
      // 1. uninstalled
      const sUninstalled = insertServer({ name: 'Uninstalled', host: '198.51.100.3', protocol: 'awg' });
      db.prepare("UPDATE servers SET stub_port = 44444, status = 'uninstalled' WHERE id = ?").run(sUninstalled);

      // 2. Без stub_port (только probe_port)
      const sNoStub = insertServer({ name: 'NoStub', host: '198.51.100.4', protocol: 'awg', probePort: 8080 });

      // 3. Партнёрская нода (remote_panel_id IS NOT NULL)
      const rp = db.prepare("INSERT INTO remote_panels (name, base_url, token, status) VALUES ('TestPanel', 'https://example.com', 'tok123', 'active')").run();
      const rpId = Number(rp.lastInsertRowid);
      const sPartner = insertServer({ name: 'Partner', host: '198.51.100.5', protocol: 'awg' });
      db.prepare('UPDATE servers SET stub_port = 44444, remote_panel_id = ? WHERE id = ?').run(rpId, sPartner);

      // 4. VLESS нода
      const sVless = insertServer({ name: 'Vless', host: '198.51.100.6' });
      db.prepare("UPDATE servers SET stub_port = 44444, protocol = 'vless' WHERE id = ?").run(sVless);

      // 5. IPv6 нода
      const sIpv6 = insertServer({ name: 'Ipv6AWG', host: '2001:db8::1', protocol: 'awg' });
      db.prepare('UPDATE servers SET stub_port = 44444 WHERE id = ?').run(sIpv6);

      // Проверка через PUT
      const putRes = await api('/api/probes', 'PUT', {
        settings: {
          enabled: true,
          globalping: true,
          countries: ['ru', 'de', 'nl'],
          interval_minutes: 15,
        },
      });
      // 2 подходящие ноды * 3 страны * 2 = 12 за обход
      // 12 * 60 / 15 = 48 в час
      expect(putRes.body.globalping_budget).toEqual({ per_run: 12, per_hour: 48, limit: 250 });

      // Проверка через GET
      const getRes = await api('/api/probes');
      expect(getRes.body.globalping_budget).toEqual({ per_run: 12, per_hour: 48, limit: 250 });

      // GET/PUT не должны обращаться к API Globalping
      expect(gp.calls.length).toBe(callsBefore);

      // Проверка округления ceil при дробном значении per_hour:
      // интервал 70 минут: 12 * 60 / 70 = 720 / 70 = 10.2857... -> Math.ceil = 11
      const roundRes = await api('/api/probes', 'PUT', {
        settings: {
          enabled: true,
          globalping: true,
          countries: ['ru', 'de', 'nl'],
          interval_minutes: 70,
        },
      });
      expect(roundRes.body.globalping_budget).toEqual({ per_run: 12, per_hour: 11, limit: 250 });

      // Очистка добавленных серверов
      db.prepare('DELETE FROM servers WHERE id IN (?, ?, ?, ?, ?, ?)').run(s2, sUninstalled, sNoStub, sPartner, sVless, sIpv6);
      db.prepare('DELETE FROM remote_panels WHERE id = ?').run(rpId);
    });
  });
});
