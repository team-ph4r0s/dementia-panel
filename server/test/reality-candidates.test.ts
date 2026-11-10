import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { buildCandidatesScript, isPublicIp, isValidDnsDomain, parseCandidatesStdout } from '../src/services/reality-targets.service.js';
import { DEFAULT_REALITY_TARGETS } from '../src/utils/vless-params.js';
import { createAdminApi, type TestEnv } from './helpers/api.js';
import { stubSsh, type SshCall } from './helpers/ssh-stub.js';
import { startTestServer } from './test-app.js';

const PASSWORD = 'TestPassword123!';

describe('Подбор сайта Reality с ноды (B2)', () => {
  let env: TestEnv;
  let admin: ReturnType<typeof createAdminApi>;
  let vlessServerId: number;
  let awgServerId: number;
  let remoteServerId: number;

  beforeAll(async () => {
    initDatabase();
    env = await startTestServer();
    admin = createAdminApi(env, 'reality_cand_admin', PASSWORD);

    // 1. VLESS-сервер
    const vlessRes = await admin.api('/api/servers', 'POST', {
      protocol: 'vless',
      name: 'VlessNode',
      host: '198.51.100.10',
      ssh_password: 'test-password',
    });
    expect(vlessRes.status).toBe(201);
    vlessServerId = vlessRes.body.id;

    // 2. AWG-сервер
    const awgRes = await admin.api('/api/servers', 'POST', {
      protocol: 'awg',
      name: 'AwgNode',
      host: '198.51.100.11',
      ssh_password: 'test-password',
    });
    expect(awgRes.status).toBe(201);
    awgServerId = awgRes.body.id;

    // 3. Партнёрская нода (remote_panel_id)
    const rp = db.prepare("INSERT INTO remote_panels (name, base_url, token, status) VALUES ('TestRP', 'https://example.com', 'tok', 'active')").run();
    const rpId = Number(rp.lastInsertRowid);
    const remoteRes = await admin.api('/api/servers', 'POST', {
      protocol: 'vless',
      name: 'RemoteNode',
      host: '198.51.100.12',
      ssh_password: 'test-password',
    });
    remoteServerId = remoteRes.body.id;
    db.prepare('UPDATE servers SET remote_panel_id = ? WHERE id = ?').run(rpId, remoteServerId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await env?.close();
  });

  describe('Чистые функции валидации и разбора', () => {
    it('isValidDnsDomain: проверяет строгие доменные имена', () => {
      expect(isValidDnsDomain('dl.google.com')).toBe(true);
      expect(isValidDnsDomain('example.org')).toBe(true);
      expect(isValidDnsDomain('sub.domain.co.uk')).toBe(true);

      // Недопустимые:
      expect(isValidDnsDomain('')).toBe(false);
      expect(isValidDnsDomain('127.0.0.1')).toBe(false);
      expect(isValidDnsDomain('::1')).toBe(false);
      expect(isValidDnsDomain('http://google.com')).toBe(false);
      expect(isValidDnsDomain('https://google.com')).toBe(false);
      expect(isValidDnsDomain('google.com:443')).toBe(false);
      expect(isValidDnsDomain('google.com/path')).toBe(false);
      expect(isValidDnsDomain('user@google.com')).toBe(false);
      expect(isValidDnsDomain('bad_char.com')).toBe(false);
      expect(isValidDnsDomain('-invalid.com')).toBe(false);
      expect(isValidDnsDomain(null)).toBe(false);
      expect(isValidDnsDomain(undefined)).toBe(false);
    });

    it('isPublicIp: исключает частные и локальные адреса IPv4 и IPv6', () => {
      // Публичные IPv4
      expect(isPublicIp('8.8.8.8')).toBe(true);
      expect(isPublicIp('1.1.1.1')).toBe(true);
      expect(isPublicIp('172.32.0.1')).toBe(true);
      expect(isPublicIp('100.128.0.1')).toBe(true);

      // Частные / спецсести IPv4
      expect(isPublicIp('127.0.0.1')).toBe(false);
      expect(isPublicIp('127.1.2.3')).toBe(false);
      expect(isPublicIp('10.0.0.1')).toBe(false);
      expect(isPublicIp('10.255.255.255')).toBe(false);
      expect(isPublicIp('172.16.0.1')).toBe(false);
      expect(isPublicIp('172.31.255.255')).toBe(false);
      expect(isPublicIp('192.168.1.1')).toBe(false);
      expect(isPublicIp('169.254.1.1')).toBe(false);
      expect(isPublicIp('100.64.0.1')).toBe(false);
      expect(isPublicIp('100.127.255.255')).toBe(false);
      expect(isPublicIp('0.0.0.0')).toBe(false);
      expect(isPublicIp('224.0.0.1')).toBe(false);
      expect(isPublicIp('')).toBe(false);
      expect(isPublicIp(undefined)).toBe(false);

      // Публичные IPv6
      expect(isPublicIp('2606:4700::6810:84e5')).toBe(true);
      expect(isPublicIp('2001:4860:4860::8888')).toBe(true);

      // Частные / спецсести IPv6
      expect(isPublicIp('::1')).toBe(false);
      expect(isPublicIp('::')).toBe(false);
      expect(isPublicIp('fe80::1')).toBe(false);
      expect(isPublicIp('febf::ffff')).toBe(false);
      expect(isPublicIp('fc00::1')).toBe(false);
      expect(isPublicIp('fd12:3456::1')).toBe(false);
    });

    it('скрипт ноды печатает поля в том порядке, в каком их читает разбор (вывод снят с реальной ноды)', () => {
      const script = buildCandidatesScript(['dl.google.com', 'a.example.org']);
      // Успех: curl сам печатает «версия, время, код 0, адрес»; отказ: «0, 0, код curl, -»
      expect(script).toContain('--write-out "%{http_version}\t%{time_total}\t0\t%{remote_ip}"');
      expect(script).toContain('printf "%s\t%s\n" "$d" "$res"');
      expect(script).toContain('printf "%s\t0\t0\t%s\t-\n" "$d" "$ec"');
      expect(script).toMatch(/for d in '?dl\.google\.com'? '?a\.example\.org'?; do/);
      expect(script).not.toMatch(/--insecure|-k |--location|-L /);

      const real = 'dl.google.com\t2\t0.189724\t0\t142.250.74.46\nno-such-host.invalid\t0\t0\t35\t-\nexample.com\t2\t0.174388\t0\t::ffff:10.0.0.5\n';
      expect(parseCandidatesStdout(real, ['dl.google.com', 'no-such-host.invalid', 'example.com'])).toEqual([
        { domain: 'dl.google.com', latency_ms: 190, suitable: true },
        { domain: 'no-such-host.invalid', latency_ms: null, suitable: false },
        // IPv4 частной сети в записи IPv6 — тоже не публичный адрес
        { domain: 'example.com', latency_ms: null, suitable: false },
      ]);
    });

    it('parseCandidatesStdout: строгий разбор недоверенного вывода stdout', () => {
      const expected = ['dl.google.com', 'www.samsung.com', 'custom.example.com'];
      const stdout = [
        // 1. Корректный подходящий
        'dl.google.com\t2\t0.045\t0\t142.250.186.206',
        // 2. Чужой домен (инъекция из stdout) - должен быть проигнорирован
        'evil.com\t2\t0.010\t0\t8.8.8.8',
        // 3. Дубликат dl.google.com - должен быть проигнорирован
        'dl.google.com\t2\t0.010\t0\t8.8.8.8',
        // 4. Подходящий кандидат, но с частным IP
        'www.samsung.com\t2\t0.082\t0\t10.0.0.1',
        // 5. Не-HTTP/2 (например HTTP/1.1)
        'custom.example.com\t1.1\t0.050\t0\t93.184.216.34',
        // 6. Мусорные строки / NaN
        'random garbage',
        'another\tNaN\tNaN\tNaN\t8.8.8.8',
      ].join('\n');

      const res = parseCandidatesStdout(stdout, expected);
      expect(res).toEqual([
        { domain: 'dl.google.com', latency_ms: 45, suitable: true },
        { domain: 'www.samsung.com', latency_ms: null, suitable: false },
        { domain: 'custom.example.com', latency_ms: null, suitable: false },
      ]);
    });
  });

  describe('HTTP API POST /api/servers/:id/reality-candidates', () => {
    it('отклоняет запрос для несуществующего сервера (404)', async () => {
      const res = await admin.api('/api/servers/999999/reality-candidates', 'POST', {});
      expect(res.status).toBe(404);
    });

    it('отклоняет запрос для удалённой/партнёрской ноды (400)', async () => {
      const res = await admin.api(`/api/servers/${remoteServerId}/reality-candidates`, 'POST', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('нода партнёра');
    });

    it('отклоняет запрос для AWG-ноды (400)', async () => {
      const res = await admin.api(`/api/servers/${awgServerId}/reality-candidates`, 'POST', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('только для VLESS');
    });

    it('отклоняет некорректный введённый домен без обращения к SSH (400)', async () => {
      let sshCalled = false;
      stubSsh(() => {
        sshCalled = true;
        return { code: 0, stdout: '' };
      });

      const badInputs = ['http://example.com', '127.0.0.1', 'example.com:443', 'bad domain', 'sub..com'];
      for (const bad of badInputs) {
        const res = await admin.api(`/api/servers/${vlessServerId}/reality-candidates`, 'POST', { domain: bad });
        expect(res.status).toBe(400);
      }
      expect(sshCalled).toBe(false);
    });

    it('возвращает понятную ошибку, если curl не установлен', async () => {
      stubSsh(() => ({ code: 0, stdout: 'ERR_NO_CURL\n' }));
      const res = await admin.api(`/api/servers/${vlessServerId}/reality-candidates`, 'POST', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('не установлен curl');
    });

    it('возвращает понятную ошибку, если curl без HTTP/2', async () => {
      stubSsh(() => ({ code: 0, stdout: 'ERR_NO_HTTP2\n' }));
      const res = await admin.api(`/api/servers/${vlessServerId}/reality-candidates`, 'POST', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('не поддерживает HTTP/2');
    });

    it('успешно проверяет кандидатов по умолчанию и переданный домен, ничего не меняя в БД', async () => {
      const dbServerBefore = db.prepare('SELECT * FROM servers WHERE id = ?').get(vlessServerId);

      const sshCalls: SshCall[] = [];
      stubSsh((call) => {
        sshCalls.push(call);
        const stdout = [
          'dl.google.com\t2\t0.035\t0\t142.250.186.206',
          'www.samsung.com\t2\t0.080\t0\t211.233.77.10',
          'www.nvidia.com\t0\t0.000\t28\t', // timeout
          'my-custom.org\t2\t0.052\t0\t198.51.100.55',
        ].join('\n');
        return { code: 0, stdout };
      });

      const res = await admin.api(`/api/servers/${vlessServerId}/reality-candidates`, 'POST', {
        domain: 'MY-CUSTOM.ORG ',
      });

      expect(res.status).toBe(200);
      expect(res.body.candidates).toEqual([
        { domain: 'dl.google.com', latency_ms: 35, suitable: true },
        { domain: 'www.samsung.com', latency_ms: 80, suitable: true },
        { domain: 'www.nvidia.com', latency_ms: null, suitable: false },
        { domain: 'my-custom.org', latency_ms: 52, suitable: true },
      ]);

      // Проверяем, что SSH вызывался один раз
      expect(sshCalls.length).toBe(1);
      expect(sshCalls[0].command).toContain('dl.google.com');
      expect(sshCalls[0].command).toContain('my-custom.org');

      // Проверяем, что БД не изменилась
      const dbServerAfter = db.prepare('SELECT * FROM servers WHERE id = ?').get(vlessServerId);
      expect(dbServerAfter).toEqual(dbServerBefore);
    });

    it('обрабатывает сбой SSH с понятной ошибкой', async () => {
      stubSsh(() => ({ code: 255, stderr: 'Connection refused' }));
      const res = await admin.api(`/api/servers/${vlessServerId}/reality-candidates`, 'POST', {});
      expect(res.status).toBe(500);
    });
  });
});
