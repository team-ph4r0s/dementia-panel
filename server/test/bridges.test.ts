import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, initDatabase, setSetting } from '../src/db/index.js';
import { BRIDGE_HOLD_MS, BridgeService, buildBridgeRules, expectedRuleCount, parseHealth } from '../src/services/bridge.service.js';
import { decryptSecret } from '../src/services/secrets.service.js';
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


