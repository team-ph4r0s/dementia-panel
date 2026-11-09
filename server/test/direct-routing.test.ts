import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, getSetting, initDatabase } from '../src/db/index.js';
import { complementCidrs, mergeRanges, parseCidr4, rangeToCidrs } from '../src/utils/cidr.js';
import { buildClashDirectRules, parseGeoList, updateDirectRouting, readDirectRouting } from '../src/services/direct-routing.service.js';
import { createAdminApi } from './helpers/api.js';
import { insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { startTestServer } from './test-app.js';

let env: Awaited<ReturnType<typeof startTestServer>>;
let admin: ReturnType<typeof createAdminApi>;
let token: string;

const RU_ZONE = '5.8.0.0/13\n77.88.0.0/18\n95.108.128.0/17\n';

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  admin = createAdminApi(env, 'direct-admin');
  const server = insertServer({ name: 'AWG', host: '203.0.113.10' });
  const subscriber = insertSubscriber({ name: 'Иван' });
  token = (db.prepare('SELECT token FROM subscribers WHERE id = ?').get(subscriber) as { token: string }).token;
  insertClient(server, { subscriberId: subscriber });
});

afterAll(async () => {
  await env.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Подменяет только скачивание списков (тестовый клиент сам ходит через fetch) */
function stubZone(body = RU_ZONE, status = 200) {
  const real = globalThis.fetch;
  const state = { body, status };
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: any, init?: any) =>
    String(input).startsWith('https://www.ipdeny.com/')
      ? Promise.resolve(new Response(state.body, { status: state.status }))
      : real(input, init));
  return state;
}

async function awgConf(): Promise<string> {
  const res = await env.request(`/sub/${token}?format=awg`);
  const links = Buffer.from(await res.text(), 'base64').toString().split('\n').filter(Boolean);
  const encoded = links[0].slice('awg://'.length).split('#')[0];
  return Buffer.from(encoded, 'base64url').toString();
}

describe('cidr: дополнение до всего IPv4', () => {
  it('разбирает сети, выравнивает по маске и отклоняет мусор', () => {
    expect(parseCidr4('10.0.0.0/8')).toEqual([167772160, 184549375]);
    expect(parseCidr4('10.1.2.3/8')).toEqual([167772160, 184549375]);
    expect(parseCidr4('8.8.8.8')).toEqual([134744072, 134744072]);
    for (const bad of ['256.1.1.1/8', '1.2.3/8', '1.2.3.4/33', '1.2.3.4/0', 'abc', '1.2.3.4/']) expect(parseCidr4(bad), bad).toBeNull();
  });

  it('рaзбивает диапазон на минимальный набор CIDR', () => {
    expect(rangeToCidrs([0, 0xffffffff])).toEqual(['0.0.0.0/0']);
    expect(rangeToCidrs([167772160, 184549375])).toEqual(['10.0.0.0/8']);
    expect(rangeToCidrs([1, 6])).toEqual(['0.0.0.1/32', '0.0.0.2/31', '0.0.0.4/31', '0.0.0.6/32']);
    // адреса выше 2^31 не становятся отрицательными
    expect(rangeToCidrs([0xc0000000, 0xffffffff])).toEqual(['192.0.0.0/2']);
  });

  it('дополнение не пересекает вычитаемые сети и покрывает всё остальное', () => {
    const excluded = ['5.8.0.0/13', '77.88.0.0/18', '95.108.128.0/17', '77.88.10.0/24'].map((c) => parseCidr4(c)!);
    const rest = complementCidrs(excluded);
    const merged = mergeRanges(excluded);
    const restRanges = rest.map((c) => parseCidr4(c)!);
    for (const r of restRanges) for (const e of merged) expect(r[1] < e[0] || r[0] > e[1], `${r} пересекает ${e}`).toBe(true);
    const total = restRanges.reduce((n, r) => n + (r[1] - r[0] + 1), 0) + merged.reduce((n, r) => n + (r[1] - r[0] + 1), 0);
    expect(total).toBe(2 ** 32);
    expect(complementCidrs([])).toEqual(['0.0.0.0/0']);
  });
});

describe('настройки «напрямую»', () => {
  it('нормализует домены и сети, отклоняет некорректные', () => {
    const { settings } = updateDirectRouting({
      enabled: true,
      countries: ['RU', 'ru', ' by '],
      domains: ' .Example.COM, *.sber.ru\nбанк.рф',
      cidrs: '10.20.30.0/24 1.1.1.1 2001:db8::/32',
    });
    expect(settings.countries).toEqual(['ru', 'by']);
    expect(settings.domains).toEqual(['example.com', 'sber.ru', 'xn--80ab2al.xn--p1ai']);
    expect(settings.cidrs).toEqual(['10.20.30.0/24', '1.1.1.1/32', '2001:db8::/32']);
    expect(readDirectRouting()).toEqual(settings);

    expect(() => updateDirectRouting({ countries: ['russia'] })).toThrow();
    expect(() => updateDirectRouting({ domains: 'bad domain!.com' })).toThrow();
    expect(() => updateDirectRouting({ domains: 'a_b.com' })).toThrow();
    expect(() => updateDirectRouting({ cidrs: '0.0.0.0/0' })).toThrow();
    expect(() => updateDirectRouting({ cidrs: '8.0.0.0/4' })).toThrow();
    expect(() => updateDirectRouting({ cidrs: 'не сеть' })).toThrow();
    expect(() => updateDirectRouting({ domains: Array.from({ length: 501 }, (_, i) => `d${i}.com`) })).toThrow();
    // отклонённый запрос ничего не меняет
    expect(readDirectRouting().countries).toEqual(['ru', 'by']);
    updateDirectRouting({ enabled: false, countries: [], domains: [], cidrs: [] });
  });

  it('список сетей страны разбирается строго', () => {
    expect(parseGeoList('1.0.0.0/24\n<html>\n999.1.1.1/8\n2.0.0.0/16\n')).toEqual(['1.0.0.0/24', '2.0.0.0/16']);
    expect(() => parseGeoList('<html>Not found</html>')).toThrow();
  });
});

describe('подписки с правилами «напрямую»', () => {
  it('выключено: mihomo остаётся с одним MATCH, AWG — с полным AllowedIPs', async () => {
    const clash = JSON.parse(await (await env.request(`/sub/${token}?format=clash`)).text());
    expect(clash.rules).toEqual(['MATCH,Dementia']);
    expect(await awgConf()).toContain('AllowedIPs = 0.0.0.0/0, ::/0\n');
  });

  it('mihomo: домены страны, свои домены и сети, GEOIP — до MATCH', async () => {
    updateDirectRouting({ enabled: true, countries: ['ru'], domains: ['sber.ru', 'ru'], cidrs: ['10.20.30.0/24', '2001:db8::/32'], awg: false });
    expect(buildClashDirectRules()).toEqual([
      'DOMAIN-SUFFIX,ru,DIRECT', 'DOMAIN-SUFFIX,su,DIRECT', 'DOMAIN-SUFFIX,xn--p1ai,DIRECT', 'DOMAIN-SUFFIX,sber.ru,DIRECT',
      'IP-CIDR,10.20.30.0/24,DIRECT,no-resolve', 'IP-CIDR6,2001:db8::/32,DIRECT,no-resolve', 'GEOIP,RU,DIRECT,no-resolve',
    ]);
    const clash = JSON.parse(await (await env.request(`/sub/${token}?format=clash`)).text());
    expect(clash.rules.at(-1)).toBe('MATCH,Dementia');
    expect(clash.rules).toContain('GEOIP,RU,DIRECT,no-resolve');
    // для AWG без галочки конфиг прежний
    expect(await awgConf()).toContain('AllowedIPs = 0.0.0.0/0, ::/0\n');
  });

  it('AWG: AllowedIPs без сетей страны и своих сетей, IPv6 остаётся в туннеле', async () => {
    stubZone();
    const res = await admin.api('/api/subscription-settings', 'PUT', { direct: { enabled: true, countries: ['ru'], cidrs: ['10.20.30.0/24'], awg: true } });
    expect(res.status).toBe(200);
    expect(res.body.direct.countries_status).toEqual([expect.objectContaining({ country: 'ru', networks: 3 })]);

    const conf = await awgConf();
    const allowed = /AllowedIPs = (.*)\n/.exec(conf)![1].split(', ');
    expect(allowed.at(-1)).toBe('::/0');
    const v4 = allowed.slice(0, -1).map((c) => parseCidr4(c)!);
    const covered = (ip: string) => v4.some((r) => parseCidr4(ip)![0] >= r[0] && parseCidr4(ip)![0] <= r[1]);
    expect(covered('77.88.8.8')).toBe(false);
    expect(covered('5.10.0.1')).toBe(false);
    expect(covered('10.20.30.40')).toBe(false);
    expect(covered('8.8.8.8')).toBe(true);
    expect(covered('77.88.64.1')).toBe(true);
  });

  it('AWG: страна без загруженного списка не ломает конфиг — остаётся полный AllowedIPs', async () => {
    stubZone('', 404);
    const res = await admin.api('/api/subscription-settings', 'PUT', { direct: { enabled: true, countries: ['xx'], cidrs: [], awg: true } });
    expect(res.status).toBe(200);
    expect(res.body.refresh).toEqual([{ country: 'xx', error: expect.stringContaining('XX') }]);
    expect(res.body.direct.countries_status[0].networks).toBe(0);
    expect(await awgConf()).toContain('AllowedIPs = 0.0.0.0/0, ::/0\n');
  });
});

describe('API', () => {
  it('отдаёт состояние и принимает только объект direct', async () => {
    const get = await admin.api('/api/subscription-settings');
    expect(get.body.direct).toMatchObject({ enabled: true, awg: true });
    expect((await admin.api('/api/subscription-settings', 'PUT', { direct: [] })).status).toBe(400);
    expect((await admin.api('/api/subscription-settings', 'PUT', { direct: { countries: ['ru1'] } })).status).toBe(400);
  });

  it('обновление сетей по кнопке: ошибка источника не сохраняет мусор', async () => {
    const zone = stubZone('<html>oops</html>');
    updateDirectRouting({ enabled: true, countries: ['ru'], domains: [], cidrs: [], awg: true });
    const bad = await admin.api('/api/subscription-settings/direct/refresh', 'POST', { countries: ['ru'] });
    expect(bad.status).toBe(200);
    expect(bad.body.results[0].error).toContain('некорректен');
    expect(getSetting('geo_v4_ru')).toContain('77.88.0.0/18'); // прежний список сохранён
    zone.body = '77.88.0.0/18\n';
    const ok = await admin.api('/api/subscription-settings/direct/refresh', 'POST', { countries: ['ru'] });
    expect(ok.body.results).toEqual([{ country: 'ru', error: null }]);
    expect(ok.body.direct.countries_status[0].networks).toBe(1);
  });

  it('требует авторизации', async () => {
    const res = await env.request('/api/subscription-settings/direct/refresh', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
