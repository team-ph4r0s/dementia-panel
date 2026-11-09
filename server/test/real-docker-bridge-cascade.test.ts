import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { shellQuote } from '../src/utils/net.js';

const NODE_SSH = 2222;
const BRIDGE_SSH = 2223;
const VPN_PORT = 36440;
const STUB_PORT = 36441;
const CASCADE_PORT = 36442;

const echoProgram = `
from socketserver import BaseRequestHandler, ThreadingTCPServer, UDPServer
from threading import Thread

class Datagram(BaseRequestHandler):
    def handle(self):
        packet, sock = self.request
        sock.sendto(packet, self.client_address)

class Stream(BaseRequestHandler):
    def handle(self):
        while packet := self.request.recv(4096):
            self.request.sendall(packet)

ThreadingTCPServer.allow_reuse_address = True
with ThreadingTCPServer(('127.0.0.1', ${STUB_PORT}), Stream) as tcp:
    Thread(target=tcp.serve_forever, daemon=True).start()
    with UDPServer(('127.0.0.1', ${VPN_PORT}), Datagram) as udp:
        print('ready', flush=True)
        udp.serve_forever()
`;

const probeProgram = `
import socket
import sys

kind = socket.SOCK_DGRAM if sys.argv[1] == 'udp' else socket.SOCK_STREAM
payload = bytes(range(256)) * 5
with socket.socket(socket.AF_INET, kind) as sock:
    sock.settimeout(8)
    sock.connect((sys.argv[2], int(sys.argv[3])))
    sock.sendall(payload)
    received = sock.recv(4096)
    while kind == socket.SOCK_STREAM and received and len(received) < len(payload):
        part = sock.recv(4096)
        if not part:
            break
        received += part
    assert received == payload, (len(received), len(payload))
print('echo ok')
`;

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(800, () => finish(false));
  });
}

const available = (await isPortOpen(NODE_SSH)) && (await isPortOpen(BRIDGE_SSH));

describe.skipIf(!available)('XHTTP Reality на двух реальных SSH-хостах Docker', () => {
  let tmpDir: string;
  let nodeId: number;
  let bridgeId: number;
  let bridgeIp: string;
  let echoPid = 0;
  let m: {
    db: typeof import('../src/db/index.js').db;
    SshService: typeof import('../src/services/ssh.service.js').SshService;
    BridgeService: typeof import('../src/services/bridge.service.js').BridgeService;
  };

  const run = (port: number, command: string) => m.SshService.executeCommand(
    { host: '127.0.0.1', port, username: 'root', password: 'rootpass123' },
    command, { timeoutMs: 20000 },
  );

  const ipOf = async (port: number) => (await run(port, "ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1")).stdout.trim();

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-docker-cascade-'));
    process.env.DEMENTIA_DATA_DIR = tmpDir;
    const { db, initDatabase } = await import('../src/db/index.js');
    initDatabase();
    const { SshService } = await import('../src/services/ssh.service.js');
    const { ProvisionService } = await import('../src/services/provision.service.js');
    const { BridgeService } = await import('../src/services/bridge.service.js');
    const { insertServer } = await import('./helpers/db.js');
    m = { db, SshService, BridgeService };
    const nodeIp = await ipOf(NODE_SSH);
    bridgeIp = await ipOf(BRIDGE_SSH);
    expect(net.isIPv4(nodeIp) && net.isIPv4(bridgeIp)).toBe(true);
    // VPN идёт напрямую между контейнерами, SSH — через опубликованные порты Docker.
    const original = ProvisionService.getCredentials.bind(ProvisionService);
    vi.spyOn(ProvisionService, 'getCredentials').mockImplementation((server) => ({ ...original(server), host: '127.0.0.1' }));
    nodeId = insertServer({ name: 'Cascade exit', host: nodeIp, sshPassword: 'rootpass123', awgPort: VPN_PORT });
    db.prepare('UPDATE servers SET ssh_port = ?, stub_port = ? WHERE id = ?').run(NODE_SSH, STUB_PORT, nodeId);
    bridgeId = BridgeService.create({ name: 'Cascade entrance', host: '127.0.0.1', ssh_port: BRIDGE_SSH, ssh_password: 'rootpass123', country: 'ru' });
    expect(await BridgeService.setLinks(bridgeId, [{ server_id: nodeId }])).toEqual({ success: true });
    const bridge = await BridgeService.install(bridgeId);
    expect(bridge.success, bridge.error).toBe(true);
    // Слушатели только на loopback ноды. Старый DNAT на eth0 до них не доводит.
    const echo = await run(NODE_SSH, `log=$(mktemp)
      nohup python3 -c ${shellQuote(echoProgram)} </dev/null >"$log" 2>&1 & pid=$!
      for attempt in $(seq 1 50); do
        if grep -qx ready "$log"; then rm -f "$log"; echo "$pid"; exit 0; fi
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      kill "$pid" 2>/dev/null || true
      cat "$log" >&2
      rm -f "$log"
      exit 1`);
    echoPid = Number(echo.stdout.trim());
    expect(echoPid, echo.stderr).toBeGreaterThan(1);
    for (const [protocol, port] of [['udp', VPN_PORT], ['tcp', STUB_PORT]]) {
      const response = await run(NODE_SSH, `python3 -c ${shellQuote(probeProgram)} ${protocol} 127.0.0.1 ${port}`);
      expect(response.stdout.trim(), response.stderr).toBe('echo ok');
    }
  }, 60000);

  afterAll(async () => {
    if (!m) return;
    try {
      if (bridgeId && nodeId) await m.BridgeService.setCascade(bridgeId, nodeId, null);
      if (bridgeId) await m.BridgeService.teardown(bridgeId);
      if (echoPid > 1) await run(NODE_SSH, `kill ${echoPid} 2>/dev/null || true`);
    } finally {
      vi.restoreAllMocks();
      m.db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120000);

  it('передаёт UDP в обе стороны и TCP проверки через тот же порт моста', async () => {
    // Сначала оставляем старую запись DNAT, которая иначе могла бы пережить смену правил.
    await run(NODE_SSH, `bash -c 'echo before > /dev/udp/${bridgeIp}/${VPN_PORT}'`);
    const oldFlows = await run(BRIDGE_SSH, `conntrack -L -p udp --orig-port-dst ${VPN_PORT} --dst-nat`);
    expect(oldFlows.stdout).toContain(`dport=${VPN_PORT}`);
    const enabled = await m.BridgeService.setCascade(bridgeId, nodeId, CASCADE_PORT);
    expect(enabled.success, enabled.error).toBe(true);
    const bridge = m.BridgeService.get(bridgeId);
    expect(bridge.links[0]).toMatchObject({ listen_port: VPN_PORT, cascade_port: CASCADE_PORT });
    const flows = await run(BRIDGE_SSH, `conntrack -L -p udp --orig-port-dst ${VPN_PORT} --dst-nat`);
    expect(flows.stdout.trim()).toBe('');

    for (const protocol of ['udp', 'tcp']) {
      const response = await run(NODE_SSH, `python3 -c ${shellQuote(probeProgram)} ${protocol} ${bridgeIp} ${VPN_PORT}`);
      expect(response.stdout.trim(), response.stderr).toBe('echo ok');
    }
    const disabled = await m.BridgeService.setCascade(bridgeId, nodeId, null);
    expect(disabled.success, disabled.error).toBe(true);
    expect((await run(NODE_SSH, 'docker ps -a --filter name=dementia-cascade --format "{{.Names}}"')).stdout.trim()).toBe('');
    expect((await run(BRIDGE_SSH, 'docker ps -a --filter name=dementia-cascade --format "{{.Names}}"')).stdout.trim()).toBe('');
    expect((await run(BRIDGE_SSH, 'iptables -t nat -S DEMENTIA-BRIDGE')).stdout).toContain(`--dport ${VPN_PORT}`);
  }, 420000);

  it('для VLESS пересылает TCP на VPN-порт ноды', async () => {
    m.db.prepare("UPDATE servers SET protocol = 'vless', awg_port = ?, deployed_port = ?, stub_port = NULL WHERE id = ?")
      .run(STUB_PORT, STUB_PORT, nodeId);
    const enabled = await m.BridgeService.setCascade(bridgeId, nodeId, CASCADE_PORT);
    expect(enabled.success, enabled.error).toBe(true);
    const response = await run(NODE_SSH, `python3 -c ${shellQuote(probeProgram)} tcp ${bridgeIp} ${VPN_PORT}`);
    expect(response.stdout.trim(), response.stderr).toBe('echo ok');
  }, 120000);
});
