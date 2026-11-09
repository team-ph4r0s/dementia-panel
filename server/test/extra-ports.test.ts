import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { ExtraPortsService } from '../src/services/extra-ports.service.js';
import { ProvisionService } from '../src/services/provision.service.js';
import { buildPortRules, parseExtraPorts, parsePortsHealth } from '../src/utils/extra-ports.js';
import { createAdminApi } from './helpers/api.js';
import { getServer, insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { stubSsh } from './helpers/ssh-stub.js';
import { startTestServer } from './test-app.js';

/**
 * Запасные порты ноды AmneziaWG: правила для хоста ноды, API с откатом, выдача в подписке только применённых портов,
 * повторное применение после перезапуска контейнера и фоновая сверка.
 */

let env: Awaited<ReturnType<typeof startTestServer>>;
let admin: ReturnType<typeof createAdminApi>;

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  admin = createAdminApi(env, 'admin_extra_ports');
});
afterAll(async () => {
  await env.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  ExtraPortsService.resetHealthTimers();
});

/** Нода отвечает как настоящая: применение подтверждается строкой ---PORTS, проверка — числом правил */
const nodeResponder = (options: { rules?: number; pre?: number; fail?: boolean } = {}) => (call: { command: string }) => {
  if (!/DEMENTIA-PORTS|dementia-ports/.test(call.command)) return {};
  if (options.fail) return { code: 1, stderr: 'iptables: Permission denied' };
  if (call.command.includes('echo "RULES')) return { stdout: `RULES ${options.rules ?? 0}\nPRE ${options.pre ?? 1}\n` };
  // Скрипт установки вложен в sh -c '…': base64 правил идёт без кавычек или в экранированных кавычках
  const encoded = /echo [^A-Za-z0-9]*([A-Za-z0-9+/=]{40,})\S* \| base64 -d > \/etc\/dementia-ports\/rules\.sh\.new/.exec(call.command);
  const count = encoded ? (Buffer.from(encoded[1], 'base64').toString().match(/-j DNAT/g) ?? []).length : 0;
  return { stdout: `---PORTS ${count} 172.17.0.2\n` };
};

describe('правила запасных портов', () => {
  it('DNAT UDP с каждого запасного порта на контейнер, переход первым в PREROUTING, только для адресов сервера', () => {
    const rules = buildPortRules('amnezia-awg', 51820, [443, 5353]);
    expect(rules).toContain("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 'amnezia-awg'");
    expect(rules).toContain('iptables -t nat -I PREROUTING 1 -m addrtype --dst-type LOCAL -j DEMENTIA-PORTS');
    expect(rules).toContain('iptables -t nat -A DEMENTIA-PORTS -p udp --dport 443 -j DNAT --to-destination "$ip:51820"');
    expect(rules).toContain('iptables -t nat -A DEMENTIA-PORTS -p udp --dport 5353 -j DNAT --to-destination "$ip:51820"');
    expect(rules.trim().endsWith('echo "---PORTS 2 $ip"')).toBe(true);
    // Перед заполнением цепочка очищается, а прежний переход удаляется — повторное применение не плодит дубли
    expect(rules.indexOf('iptables -t nat -F DEMENTIA-PORTS')).toBeLessThan(rules.indexOf('-j DNAT'));
    expect(rules).toContain('while iptables -t nat -D PREROUTING -m addrtype --dst-type LOCAL -j DEMENTIA-PORTS 2>/dev/null; do :; done');
  });

  it('без портов цепочка убирается; имя контейнера и порт проверяются', () => {
    const empty = buildPortRules('amnezia-awg', 51820, []);
    expect(empty).not.toContain('DNAT');
    expect(empty).toContain('iptables -t nat -X DEMENTIA-PORTS');
    expect(() => buildPortRules('awg; rm -rf /', 51820, [443])).toThrow();
    expect(() => buildPortRules('amnezia-awg', 0, [443])).toThrow();
  });

  it('разбор колонки и ответа проверки', () => {
    expect(parseExtraPorts('[443, 53, 443, "x", 70000, 0]')).toEqual([443, 53]);
    expect(parseExtraPorts('не json')).toEqual([]);
    expect(parseExtraPorts(null)).toEqual([]);
    expect(parsePortsHealth('RULES 2\nPRE 1\n')).toEqual({ rules: 2, prerouting: true });
    expect(parsePortsHealth('')).toEqual({ rules: 0, prerouting: false });
  });
});

describe('API запасных портов', () => {
  it('проверка списка: не массив, лишние, основной порт, порт соседней ноды, VLESS и нода партнёра', async () => {
    const id = insertServer({ host: '198.51.100.10', awgPort: 51820 });
    insertServer({ host: '198.51.100.10', awgPort: 51821 });
    stubSsh(nodeResponder());
    const put = (ports: unknown) => admin.api(`/api/servers/${id}/extra-ports`, 'PUT', { ports });

    expect((await put('443')).status).toBe(400);
    expect((await put([443, 'abc'])).status).toBe(400);
    expect((await put([0])).status).toBe(400);
    expect((await put([1, 2, 3, 4, 5])).body.error).toContain('не больше 4');
    expect((await put([51820])).body.error).toContain('основной порт ноды');
    expect((await put([51821])).body.error).toContain('на этом же сервере');
    expect(getServer(id).extra_ports).toBeNull();

    const vless = (await admin.api('/api/servers', 'POST', { name: 'V', host: '198.51.100.11', ssh_password: 'x-secret-pass', protocol: 'vless' })).body.id;
    expect((await admin.api(`/api/servers/${vless}/extra-ports`, 'PUT', { ports: [8443] })).status).toBe(400);
  });

  it('неустановленная нода: список сохраняется без SSH и в подписку не попадает', async () => {
    const id = (await admin.api('/api/servers', 'POST', { name: 'New', host: 'ports-new.example.com', ssh_password: 'x-secret-pass' })).body.id;
    const ssh = stubSsh();
    const res = await admin.api(`/api/servers/${id}/extra-ports`, 'PUT', { ports: ['443', 53] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ extra_ports: [443, 53], extra_ports_active: [] });
    expect(ssh.calls).toHaveLength(0);
  });

  it('установленная нода: правила применяются сразу, порты становятся активными и попадают в подписку отдельными записями', async () => {
    const id = insertServer({ name: 'Берлин', host: '198.51.100.20', awgPort: 51820 });
    const subscriberId = insertSubscriber();
    const subscriber = db.prepare('SELECT token FROM subscribers WHERE id = ?').get(subscriberId) as { token: string };
    insertClient(id, { subscriberId });
    const ssh = stubSsh(nodeResponder());

    const res = await admin.api(`/api/servers/${id}/extra-ports`, 'PUT', { ports: [443, 5353] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ extra_ports: [443, 5353], extra_ports_active: [443, 5353] });
    expect(ssh.calls).toHaveLength(1);
    expect(ssh.calls[0].command).toContain('systemctl enable dementia-ports.service');

    const sub = await (await env.request(`/sub/${subscriber.token}?format=json`)).json();
    expect(sub.servers.map((s: any) => s.name)).toEqual(['Берлин', 'Берлин · порт 443', 'Берлин · порт 5353']);
    const configs = sub.servers.map((s: any) => Buffer.from(s.config, 'base64url').toString());
    expect(configs.map((c: string) => /Endpoint = (.+)/.exec(c)![1])).toEqual(['198.51.100.20:51820', '198.51.100.20:443', '198.51.100.20:5353']);
    // Меняется только Endpoint: ключи и параметры обфускации те же
    expect(configs[1].replace(':443', ':51820')).toBe(configs[0]);

    const clash = JSON.parse(await (await env.request(`/sub/${subscriber.token}?format=clash`)).text());
    expect(clash.proxies.map((p: any) => p.port)).toEqual([51820, 443, 5353]);
    expect(clash['proxy-groups'][1].proxies).toEqual(['Берлин', 'Берлин · порт 443', 'Берлин · порт 5353']);

    // Правила на ноде больше не подтверждены — подписка запасные порты не раздаёт
    db.prepare('UPDATE servers SET extra_ports_hash = NULL WHERE id = ?').run(id);
    const without = await (await env.request(`/sub/${subscriber.token}?format=json`)).json();
    expect(without.servers.map((s: any) => s.name)).toEqual(['Берлин']);
  });

  it('сбой применения: 502, список возвращается к прежнему', async () => {
    const id = insertServer({ host: '198.51.100.30' });
    stubSsh(nodeResponder());
    expect((await admin.api(`/api/servers/${id}/extra-ports`, 'PUT', { ports: [443] })).status).toBe(200);
    vi.restoreAllMocks();

    stubSsh(nodeResponder({ fail: true }));
    const res = await admin.api(`/api/servers/${id}/extra-ports`, 'PUT', { ports: [443, 8443] });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('Permission denied');
    expect(res.body.server).toMatchObject({ extra_ports: [443], extra_ports_active: [443] });
  });

  it('пустой список снимает правила и автозапуск с ноды', async () => {
    const id = insertServer({ host: '198.51.100.40' });
    stubSsh(nodeResponder());
    await admin.api(`/api/servers/${id}/extra-ports`, 'PUT', { ports: [443] });
    vi.restoreAllMocks();

    const ssh = stubSsh();
    const res = await admin.api(`/api/servers/${id}/extra-ports`, 'PUT', { ports: [] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ extra_ports: [], extra_ports_active: [] });
    expect(ssh.calls[0].command).toContain('iptables -t nat -X DEMENTIA-PORTS');
    expect(ssh.calls[0].command).toContain('rm -rf /etc/dementia-ports');
    expect(getServer(id)).toMatchObject({ extra_ports: null, extra_ports_hash: null });
  });

  it('основной порт нельзя сменить на запасной', async () => {
    const id = insertServer({ host: '198.51.100.50' });
    stubSsh(nodeResponder());
    await admin.api(`/api/servers/${id}/extra-ports`, 'PUT', { ports: [443] });
    const res = await admin.api(`/api/servers/${id}`, 'PUT', { awg_port: 443 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('запасной');
    expect(getServer(id).awg_port).toBe(51820);
  });
});

describe('жизненный цикл', () => {
  it('после применения параметров (перезапуск контейнера) правила применяются заново из той же очереди', async () => {
    const id = insertServer({ host: '198.51.100.60' });
    stubSsh(nodeResponder());
    await admin.api(`/api/servers/${id}/extra-ports`, 'PUT', { ports: [443] });
    vi.restoreAllMocks();

    const ssh = stubSsh(nodeResponder());
    expect((await ProvisionService.requestApply(id)).success).toBe(true);
    const restart = ssh.calls.findIndex((c) => c.command.includes('docker restart'));
    const ports = ssh.calls.findIndex((c) => c.command.includes('/etc/dementia-ports/rules.sh'));
    expect(restart).toBeGreaterThanOrEqual(0);
    expect(ports).toBeGreaterThan(restart);
    expect(ExtraPortsService.activePorts(getServer(id))).toEqual([443]);
  });

  it('нода без запасных портов: применение параметров лишних команд не выполняет', async () => {
    const id = insertServer({ host: '198.51.100.61' });
    const ssh = stubSsh();
    expect((await ProvisionService.requestApply(id)).success).toBe(true);
    expect(ssh.calls.some((c) => c.command.includes('DEMENTIA-PORTS'))).toBe(false);
  });

  it('удаление ноды с очисткой убирает цепочку и автозапуск', async () => {
    const id = insertServer({ host: '198.51.100.62' });
    const ssh = stubSsh();
    expect((await ProvisionService.teardown(id)).success).toBe(true);
    expect(ssh.calls[0].command).toContain('-j DEMENTIA-PORTS');
    expect(ssh.calls[0].command).toContain('rm -rf /etc/dementia-ports');
  });

  it('фоновая сверка: пропавшие правила сбрасывают отметку и применяются заново; сбой не повторяется каждые 30 секунд', async () => {
    const id = insertServer({ host: '198.51.100.70' });
    stubSsh(nodeResponder());
    await admin.api(`/api/servers/${id}/extra-ports`, 'PUT', { ports: [443, 53] });
    vi.restoreAllMocks();
    ExtraPortsService.resetHealthTimers();
    // Сверка обходит все ноды с запасными портами — оставляем только эту
    db.prepare('UPDATE servers SET extra_ports = NULL, extra_ports_hash = NULL WHERE id != ?').run(id);

    // Правила на месте — отметка остаётся
    let ssh = stubSsh(nodeResponder({ rules: 2 }));
    await ExtraPortsService.checkAll();
    expect(ssh.calls.filter((c) => c.command.includes('echo "RULES'))).toHaveLength(1);
    expect(ExtraPortsService.activePorts(getServer(id))).toEqual([443, 53]);
    // Повторная сверка раньше срока на ноду не ходит
    await ExtraPortsService.checkAll();
    expect(ssh.calls).toHaveLength(1);
    vi.restoreAllMocks();
    ExtraPortsService.resetHealthTimers();

    // Контейнер сменил адрес: правил на нынешний адрес нет
    ssh = stubSsh(nodeResponder({ rules: 0 }));
    await ExtraPortsService.checkAll();
    expect(getServer(id).extra_ports_hash).toBeNull();
    expect(ExtraPortsService.activePorts(getServer(id))).toEqual([]);
    await ExtraPortsService.checkAll();
    expect(ssh.calls.some((c) => c.command.includes('/etc/dementia-ports/rules.sh'))).toBe(true);
    expect(ExtraPortsService.activePorts(getServer(id))).toEqual([443, 53]);
    vi.restoreAllMocks();

    // Применение не удаётся: одна попытка, затем пауза
    db.prepare('UPDATE servers SET extra_ports_hash = NULL WHERE id = ?').run(id);
    ssh = stubSsh(nodeResponder({ fail: true }));
    await ExtraPortsService.checkAll();
    await ExtraPortsService.checkAll();
    expect(ssh.calls).toHaveLength(1);
    expect(getServer(id).extra_ports_error).toContain('Permission denied');
    db.prepare('UPDATE servers SET extra_ports = NULL, extra_ports_hash = NULL WHERE id = ?').run(id);
  });
});
