import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Запасные порты на настоящей ноде (dementia-node-1, SSH 2222): правила DNAT на хосте ноды доводят UDP-пакеты,
 * отправленные с другого узла (dementia-node-2) на запасной порт, до AmneziaWG в контейнере — это видно по счётчику
 * принятых датаграмм внутри контейнера. Проверяются также повторное применение после перезапуска контейнера,
 * отсутствие дублей и очистка. Без запущенных узлов (server/test/docker/nodes.sh up) тесты пропускаются.
 */

const NODE_SSH = 2222;
const PEER_SSH = 2223;

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(800, () => { socket.destroy(); resolve(false); });
  });
}

const available = (await isPortOpen(NODE_SSH)) && (await isPortOpen(PEER_SSH));

describe.skipIf(!available)('Запасные порты на реальной ноде', () => {
  let tmpDir: string;
  let m: { db: any; ProvisionService: any; ExtraPortsService: any; SshService: any };
  let serverId: number;
  let nodeIp: string;

  const creds = (port: number) => ({ host: '127.0.0.1', port, username: 'root', password: 'rootpass123' });
  const run = async (port: number, command: string) =>
    (await m.SshService.executeCommand(creds(port), command, { timeoutMs: 120000 })) as { code: number; stdout: string; stderr: string };
  /** Сколько UDP-датаграмм принял сетевой стек контейнера AmneziaWG */
  const received = async () => Number((await run(NODE_SSH, "docker exec amnezia-awg awk '/^Udp: [0-9]/ {print $2}' /proc/net/snmp")).stdout.trim());
  const send = (port: number, count = 5) =>
    // /dev/udp — возможность bash, а оболочка SSH-сеанса может быть другой
    run(PEER_SSH, `bash -c 'for i in $(seq 1 ${count}); do echo probe-$i > /dev/udp/${nodeIp}/${port}; done'; sleep 1`);
  const setPorts = (ports: number[]) =>
    m.db.prepare('UPDATE servers SET extra_ports = ? WHERE id = ?').run(ports.length ? JSON.stringify(ports) : null, serverId);
  const row = () => m.db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-docker-ports-'));
    process.env.DEMENTIA_DATA_DIR = tmpDir;
    const dbModule = await import('../src/db/index.js');
    dbModule.initDatabase();
    const helpers = await import('./helpers/db.js');
    m = {
      db: dbModule.db,
      ProvisionService: (await import('../src/services/provision.service.js')).ProvisionService,
      ExtraPortsService: (await import('../src/services/extra-ports.service.js')).ExtraPortsService,
      SshService: (await import('../src/services/ssh.service.js')).SshService,
    };
    serverId = helpers.insertServer({ name: 'Docker ports node', host: '127.0.0.1', sshPassword: 'rootpass123', awgPort: 51820, status: 'offline' });
    m.db.prepare('UPDATE servers SET ssh_port = ? WHERE id = ?').run(NODE_SSH, serverId);
    nodeIp = (await run(NODE_SSH, "ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1")).stdout.trim();
    expect((await m.ProvisionService.installServer(serverId)).success).toBe(true);
  }, 300000);

  afterAll(async () => {
    if (!m) return;
    await m.ProvisionService.teardown(serverId).catch(() => {});
    try {
      m.db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // временный каталог удалит система
    }
  });

  it('без правил пакеты на запасной порт до AmneziaWG не доходят, на основной — доходят', async () => {
    const start = await received();
    await send(4443);
    expect(await received()).toBe(start);
    await send(51820);
    expect(await received()).toBeGreaterThanOrEqual(start + 5);
  }, 60000);

  it('после применения пакеты на каждый запасной порт доходят до контейнера', async () => {
    setPorts([4443, 5353]);
    const result = await m.ExtraPortsService.apply(serverId);
    expect(result).toEqual({ success: true });
    expect(m.ExtraPortsService.activePorts(row())).toEqual([4443, 5353]);

    for (const port of [4443, 5353]) {
      const before = await received();
      await send(port);
      expect(await received()).toBeGreaterThanOrEqual(before + 5);
    }
    // Порт, которого нет в списке, по-прежнему закрыт
    const before = await received();
    await send(4444);
    expect(await received()).toBe(before);
  }, 60000);

  it('повторное применение не дублирует переход и правила', async () => {
    expect((await m.ExtraPortsService.apply(serverId)).success).toBe(true);
    const counts = await run(NODE_SSH, "iptables -t nat -S PREROUTING | grep -c -- '-j DEMENTIA-PORTS$'; iptables -t nat -S DEMENTIA-PORTS | grep -c -- '-j DNAT'");
    expect(counts.stdout.trim().split(/\s+/)).toEqual(['1', '2']);
    expect((await run(NODE_SSH, 'test -x /bin/sh && cat /etc/dementia-ports/rules.sh')).stdout).toContain('--dport 4443');
  }, 60000);

  it('применение параметров перезапускает контейнер — запасные порты продолжают работать, сверка подтверждает правила', async () => {
    m.db.prepare('UPDATE servers SET jc = 7 WHERE id = ?').run(serverId);
    expect((await m.ProvisionService.requestApply(serverId)).success).toBe(true);
    expect(m.ExtraPortsService.activePorts(row())).toEqual([4443, 5353]);
    const before = await received();
    await send(4443);
    expect(await received()).toBeGreaterThanOrEqual(before + 5);

    m.ExtraPortsService.resetHealthTimers();
    await m.ExtraPortsService.checkAll();
    expect(m.ExtraPortsService.activePorts(row())).toEqual([4443, 5353]);
  }, 120000);

  it('сверка замечает пропавшие правила и возвращает их', async () => {
    await run(NODE_SSH, 'iptables -t nat -F DEMENTIA-PORTS');
    m.ExtraPortsService.resetHealthTimers();
    await m.ExtraPortsService.checkAll();
    expect(m.ExtraPortsService.activePorts(row())).toEqual([]);
    await m.ExtraPortsService.checkAll();
    expect(m.ExtraPortsService.activePorts(row())).toEqual([4443, 5353]);
    const before = await received();
    await send(5353);
    expect(await received()).toBeGreaterThanOrEqual(before + 5);
  }, 60000);

  it('пустой список убирает цепочку и файлы; удаление ноды тоже ничего не оставляет', async () => {
    setPorts([]);
    expect((await m.ExtraPortsService.apply(serverId)).success).toBe(true);
    const left = await run(NODE_SSH, "iptables -t nat -S | grep -c DEMENTIA-PORTS; ls /etc/dementia-ports 2>/dev/null | wc -l");
    expect(left.stdout.trim().split(/\s+/)).toEqual(['0', '0']);
    const before = await received();
    await send(4443);
    expect(await received()).toBe(before);

    setPorts([4443]);
    expect((await m.ExtraPortsService.apply(serverId)).success).toBe(true);
    expect((await m.ProvisionService.teardown(serverId)).success).toBe(true);
    const after = await run(NODE_SSH, "iptables -t nat -S | grep -c DEMENTIA-PORTS; ls /etc/dementia-ports 2>/dev/null | wc -l");
    expect(after.stdout.trim().split(/\s+/)).toEqual(['0', '0']);
  }, 120000);
});
