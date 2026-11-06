import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generate } from 'selfsigned';

/**
 * Нода VLESS на настоящем Docker-узле (тестовый контейнер с SSH на 2222, docs/testing.md): установка Xray, подключение
 * настоящим клиентом Xray по выданным параметрам (TCP и XHTTP), блокировка частных сетей по IP и по имени, учёт трафика,
 * проверка конфига перед заменой, вход через CDN (TLS с сертификатом из БД) и удаление без чужих контейнеров.
 * Клиент запускается на самом узле (тот же образ Xray, --network host). Нужен выход в интернет с узла.
 * Без запущенного узла тесты пропускаются.
 */

const SSH_PORT = 2222;
const SOCKS = '127.0.0.1:10808';
const CLIENT = 'dementia-test-xray-client';
const CLIENT_DIR = '/tmp/dementia-test-xray-client';

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(800, () => { socket.destroy(); resolve(false); });
  });
}

const dockerNodeAvailable = await isPortOpen(SSH_PORT);

describe.skipIf(!dockerNodeAvailable)('Нода VLESS на реальном Docker-узле', () => {
  let tmpDir: string;
  let m: any;
  let serverId: number;
  let clientId: number;
  let uuid: string;

  const server = () => m.db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
  const ssh = (command: string, input?: string) =>
    m.SshService.executeCommand(m.ProvisionService.getCredentials(server()), command, { timeoutMs: 120000, input });
  const nodeConfig = async () => JSON.parse((await ssh('cat /opt/dementia-xray/config.json')).stdout);

  /** Конфиг клиента Xray из параметров ноды — как их получает приложение из ссылки vless:// */
  function clientConfig(): string {
    const s = server();
    const p = m.vlessParamsFromRow(s);
    const stream: any = p.xray_transport === 'xhttp'
      ? { network: 'xhttp', xhttpSettings: { path: p.xhttp_path, host: p.reality_sni, mode: p.xhttp_mode } }
      : { network: 'tcp' };
    return JSON.stringify({
      log: { loglevel: 'warning' },
      inbounds: [{ listen: '127.0.0.1', port: 10808, protocol: 'socks', settings: { udp: false } }],
      outbounds: [{
        protocol: 'vless',
        settings: { vnext: [{ address: '127.0.0.1', port: s.awg_port, users: [{ id: uuid, encryption: 'none', flow: p.xray_flow }] }] },
        streamSettings: {
          ...stream,
          security: 'reality',
          realitySettings: {
            serverName: p.reality_sni, fingerprint: p.xray_fingerprint, publicKey: m.toXrayKey(s.server_public_key),
            shortId: p.reality_short_ids[0],
          },
        },
      }],
    });
  }

  async function startClient(): Promise<void> {
    await ssh(`docker rm -f ${CLIENT} >/dev/null 2>&1; mkdir -p ${CLIENT_DIR} && cat > ${CLIENT_DIR}/client.json`, clientConfig());
    const run = await ssh(`docker run -d --name ${CLIENT} --network host -v ${CLIENT_DIR}:/etc/xray:ro ghcr.io/xtls/xray-core:latest run -c /etc/xray/client.json`);
    expect(run.code, run.stderr).toBe(0);
    for (let i = 0; i < 20; i++) {
      // Оболочка root на узле — ash: /dev/tcp есть только в bash
      if ((await ssh(`bash -c '(echo > /dev/tcp/127.0.0.1/10808) 2>/dev/null && echo up'`)).stdout.includes('up')) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Клиент Xray не запустился: ${(await ssh(`docker logs ${CLIENT} 2>&1 | tail -20`)).stdout}`);
  }

  /** HTTP-код через туннель (000 — соединение не установлено/сброшено) */
  const viaTunnel = async (url: string) =>
    (await ssh(`curl -s -o /dev/null -w '%{http_code}' --max-time 20 --socks5-hostname ${SOCKS} '${url}' || true`)).stdout.trim();

  /** Что пришло через туннель от SSH-сервера узла: баннер SSH значит, что запрос к частному адресу прошёл */
  const reachLocalSsh = async (host: string) =>
    (await ssh(`curl -s --http0.9 --max-time 5 --socks5-hostname ${SOCKS} 'http://${host}:22/' 2>/dev/null | head -c 64 || true`)).stdout;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-docker-vless-'));
    process.env.DEMENTIA_DATA_DIR = tmpDir;
    const dbModule = await import('../src/db/index.js');
    dbModule.initDatabase();
    const helpers = await import('./helpers/db.js');
    const vless = await import('../src/utils/vless-params.js');
    m = {
      db: dbModule.db,
      ProvisionService: (await import('../src/services/provision.service.js')).ProvisionService,
      SshService: (await import('../src/services/ssh.service.js')).SshService,
      encryptSecret: (await import('../src/services/secrets.service.js')).encryptSecret,
      vlessParamsFromRow: vless.vlessParamsFromRow,
      vlessParamsToColumns: vless.vlessParamsToColumns,
      generateVlessParams: vless.generateVlessParams,
      toXrayKey: vless.toXrayKey,
    };
    serverId = helpers.insertServer({
      name: 'Docker VLESS', host: '127.0.0.1', status: 'uninstalled', deployedPort: null, sshPassword: 'rootpass123', awgPort: 443,
    });
    const columns = { ...m.vlessParamsToColumns(m.generateVlessParams()), protocol: 'vless', container_name: 'dementia-xray', conf_path: '/opt/dementia-xray/config.json' };
    m.db.prepare(`UPDATE servers SET ssh_port = ?, preshared_key = NULL, ${Object.keys(columns).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(SSH_PORT, ...Object.values(columns), serverId);
    const client = helpers.insertClient(serverId, { name: 'vless-real' });
    clientId = client.id;
    uuid = crypto.randomUUID();
    m.db.prepare("UPDATE clients SET client_uuid = ?, client_ip = '', client_public_key = '', client_private_key = '' WHERE id = ?").run(uuid, clientId);
  });

  afterAll(async () => {
    if (m && serverId) {
      try {
        await ssh(`docker rm -f ${CLIENT} dementia-xray >/dev/null 2>&1; rm -rf ${CLIENT_DIR} /opt/dementia-xray`);
      } catch {
        // узел мог быть недоступен
      }
    }
    try {
      m?.db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // временный каталог удалит система
    }
  });

  it('устанавливает Xray: контейнер работает, клиент в config.json, маршрутизация IPIfNonMatch', async () => {
    const result = await m.ProvisionService.installServer(serverId);
    expect(result).toEqual({ success: true });
    expect((await ssh("docker inspect -f '{{.State.Running}}' dementia-xray")).stdout.trim()).toBe('true');
    const config = await nodeConfig();
    expect(config.routing.domainStrategy).toBe('IPIfNonMatch');
    expect(config.inbounds.find((i: any) => i.tag === 'vless-in').settings.clients.map((c: any) => c.id)).toEqual([uuid]);
    expect((await ssh('stat -c %a /opt/dementia-xray/config.json')).stdout.trim()).toBe('600');
  }, 300000);

  it('клиент Xray подключается по выданным параметрам (TCP + Reality + Vision), трафик учитывается', async () => {
    await startClient();
    expect(await viaTunnel('https://www.google.com/generate_204')).toBe('204');
    await m.ProvisionService.fetchServerStats(serverId);
    const client = m.db.prepare('SELECT total_rx, total_tx FROM clients WHERE id = ?').get(clientId) as any;
    expect(client.total_tx).toBeGreaterThan(0);
    expect(client.total_rx).toBeGreaterThan(0);
  }, 120000);

  it('частные сети недоступны через VPN — и по IP, и по имени, которое в них резолвится', async () => {
    // Контроль: сам SSH-сервер узла отвечает баннером напрямую
    expect((await ssh(`curl -s --http0.9 --max-time 5 'http://127.0.0.1:22/' 2>/dev/null | head -c 64 || true`)).stdout).toContain('SSH-');
    expect(await reachLocalSsh('127.0.0.1')).not.toContain('SSH-');
    // С AsIs имя localhost проходило мимо правила частных сетей
    expect(await reachLocalSsh('localhost')).not.toContain('SSH-');
  }, 60000);

  it('переход на XHTTP: применение перезапускает Xray, клиент подключается по XHTTP', async () => {
    m.ProvisionService.noteAppliedBaseline(server());
    m.db.prepare("UPDATE servers SET xray_transport = 'xhttp', xhttp_mode = 'auto' WHERE id = ?").run(serverId);
    const result = await m.ProvisionService.requestApply(serverId);
    expect(result).toEqual({ success: true });
    const inbound = (await nodeConfig()).inbounds.find((i: any) => i.tag === 'vless-in');
    expect(inbound.streamSettings.network).toBe('xhttp');
    await startClient();
    expect(await viaTunnel('https://www.google.com/generate_204')).toBe('204');
  }, 120000);

  it('конфиг, который Xray не принимает, не заменяет работающий: нода продолжает обслуживать клиентов', async () => {
    const before = (await ssh('sha256sum /opt/dementia-xray/config.json')).stdout;
    // Порт строкой: Xray отвергнет такой конфиг при проверке `run -test`
    const command = (m.ProvisionService as any).writeConfigCommand(m.ProvisionService.getCredentials(server()), server());
    const result = await ssh(command, '{"inbounds": [{"port": "not-a-port", "protocol": "vless"}]}');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Xray отклонил конфигурацию');
    expect((await ssh('sha256sum /opt/dementia-xray/config.json')).stdout).toBe(before);
    expect((await ssh('ls /opt/dementia-xray')).stdout).not.toContain('config.new.json');
    expect(await viaTunnel('https://www.google.com/generate_204')).toBe('204');
  }, 120000);

  it('вход через CDN: второй порт с TLS и сертификатом домена из БД', async () => {
    const cert = await generate([{ name: 'commonName', value: 'vpn.example.com' }], {
      keySize: 2048, days: 90, extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'vpn.example.com' }] }],
    } as any);
    m.db.prepare(`UPDATE servers SET cdn_enabled = 1, cdn_domain = 'vpn.example.com', cdn_port = 8443, cdn_cert = ?, cdn_key = ?
      WHERE id = ?`).run(cert.cert, m.encryptSecret(cert.private), serverId);
    // Включение входа — переустановка: открывает второй порт в фаерволе
    const result = await m.ProvisionService.requestReinstall(serverId);
    expect(result).toEqual({ success: true });
    const cdn = (await nodeConfig()).inbounds.find((i: any) => i.tag === 'vless-cdn');
    expect(cdn).toMatchObject({ port: 8443, streamSettings: { network: 'xhttp', security: 'tls' } });
    const path = server().xhttp_path;
    const tls = await ssh(`curl -skv --max-time 10 --resolve vpn.example.com:8443:127.0.0.1 'https://vpn.example.com:8443${path}' -o /dev/null 2>&1 || true`);
    expect(tls.stdout).toMatch(/subject: CN\s*=\s*vpn\.example\.com/);
    // Reality-вход продолжает работать
    expect(await viaTunnel('https://www.google.com/generate_204')).toBe('204');
  }, 300000);

  it('удаление ноды не трогает чужой контейнер с тем же именем', async () => {
    const removed = await m.ProvisionService.teardown(serverId);
    expect(removed.success).toBe(true);
    expect((await ssh("docker ps -a --format '{{.Names}}'")).stdout).not.toMatch(/^dementia-xray$/m);
    // Контейнер с именем панели, но без метки — чужой
    await ssh('docker create --name dementia-xray ghcr.io/xtls/xray-core:latest version >/dev/null');
    expect((await m.ProvisionService.teardown(serverId)).success).toBe(true);
    expect((await ssh("docker ps -a --format '{{.Names}}'")).stdout).toMatch(/^dementia-xray$/m);
    await ssh('docker rm -f dementia-xray >/dev/null 2>&1');
  }, 120000);
});
