import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { shellQuote } from '../src/utils/net.js';

const available = await new Promise<boolean>((resolve) => {
  const socket = net.createConnection({ host: '127.0.0.1', port: 2223 });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => { socket.destroy(); resolve(false); });
  socket.setTimeout(800, () => { socket.destroy(); resolve(false); });
});

describe.skipIf(!available)('обновление образа на настоящей Docker-ноде', () => {
  let m: any;
  let id: number;
  let keys: string[];
  const credentials = () => m.ProvisionService.getCredentials(m.db.prepare('SELECT * FROM servers WHERE id = ?').get(id));
  const ssh = (command: string, input?: string) => m.SshService.executeCommand(credentials(), command, { input, timeoutMs: 120000 });
  const peers = async () => (await ssh('docker exec amnezia-awg awg show awg0 peers')).stdout.trim().split(/\s+/).sort();
  const clients = () => m.db.prepare('SELECT * FROM clients WHERE server_id = ? ORDER BY id').all(id);

  beforeAll(async () => {
    const database = await import('../src/db/index.js'); database.initDatabase();
    const h = await import('./helpers/db.js');
    m = { db: database.db,
      ProvisionService: (await import('../src/services/provision.service.js')).ProvisionService,
      NodeUpdateService: (await import('../src/services/node-update.service.js')).NodeUpdateService,
      SshService: (await import('../src/services/ssh.service.js')).SshService };
    id = h.insertServer({ host: '127.0.0.1', sshPassword: 'rootpass123', status: 'uninstalled', deployedPort: null });
    m.db.prepare('UPDATE servers SET ssh_port = 2223 WHERE id = ?').run(id);
    const normal = h.insertClient(id, { ip: '10.8.0.2' });
    const imported = h.insertClient(id, { ip: '10.8.0.3', external: 1 });
    h.insertClient(id, { ip: '10.8.0.4', enabled: 0 });
    keys = [normal.publicKey, imported.publicKey].sort();
    expect(await m.ProvisionService.installServer(id)).toEqual({ success: true });
  }, 180000);
  afterAll(async () => { if (m && id) await m.ProvisionService.teardown(id); });

  // Distinguishable previous image, derived from the actual AWG image, while latest remains official.
  async function previousImage() {
    const r = await ssh(`set -e
image=$(docker commit amnezia-awg)
docker rm -f amnezia-awg >/dev/null
docker run -d --name amnezia-awg --restart always --cap-add NET_ADMIN --cap-add SYS_MODULE \
  --device /dev/net/tun:/dev/net/tun -p 51820:51820/udp -v /lib/modules:/lib/modules:ro \
  -v /opt/amnezia/awg:/opt/amnezia/awg --sysctl net.ipv4.conf.all.src_valid_mark=1 \
  --sysctl net.ipv4.ip_forward=1 --entrypoint /opt/amnezia/awg/start.sh "$image" >/dev/null
docker inspect -f '{{.Image}}' amnezia-awg`);
    expect(r.code, r.stderr).toBe(0);
    await vi.waitFor(async () => expect(await peers()).toEqual(keys), { timeout: 30000, interval: 500 });
    return r.stdout.trim();
  }

  it('заменяет контейнер свежим образом, сохраняя записи БД, ключи и импортированных пиров', async () => {
    const old = await previousImage();
    const before = clients();
    const conf = await ssh('sha256sum /opt/amnezia/awg/awg0.conf');
    await m.NodeUpdateService.operate(id, 'check');
    expect(m.NodeUpdateService.state(id).available).toBe(1);
    await m.NodeUpdateService.operate(id, 'update');
    expect(m.NodeUpdateService.state(id)).toMatchObject({ result: 'updated', available: 0, error: null });
    expect((await ssh("docker inspect -f '{{.Image}}' amnezia-awg")).stdout.trim()).not.toBe(old);
    expect(await peers()).toEqual(keys);
    expect(clients()).toEqual(before);
    expect((await ssh('sha256sum /opt/amnezia/awg/awg0.conf')).stdout).toBe(conf.stdout);
  }, 180000);

  it('если новый контейнер потерял пира, возвращает прежний с прежними ключами и IP', async () => {
    const old = await previousImage();
    const before = clients();
    const hostname = (await ssh("docker inspect -f '{{.Config.Hostname}}' amnezia-awg")).stdout.trim();
    const start = (await ssh('cat /opt/amnezia/awg/start.sh')).stdout;
    const broken = start.replace('awg-quick up /opt/amnezia/awg/awg0.conf',
      `awg-quick up /opt/amnezia/awg/awg0.conf\nif [ "$(hostname)" != ${shellQuote(hostname)} ]; then awg set awg0 peer ${shellQuote(keys[0])} remove; fi`);
    try {
      expect((await ssh('cat > /opt/amnezia/awg/start.sh', broken)).code).toBe(0);
      await expect(m.NodeUpdateService.operate(id, 'update')).rejects.toThrow('прежний контейнер восстановлен');
      expect(m.NodeUpdateService.state(id).result).toBe('rolled_back');
      expect((await ssh("docker inspect -f '{{.Image}}' amnezia-awg")).stdout.trim()).toBe(old);
      expect(await peers()).toEqual(keys);
      expect(clients()).toEqual(before);
    } finally { await ssh('cat > /opt/amnezia/awg/start.sh', start); }
  }, 180000);
});
