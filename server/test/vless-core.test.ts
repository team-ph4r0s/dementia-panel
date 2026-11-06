import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { ProvisionService } from '../src/services/provision.service.js';
import { XrayService } from '../src/services/xray.service.js';
import { isValidUuid, toXrayKey, XRAY_API_PORT, XRAY_CONF_PATH, XRAY_CONTAINER, XRAY_INBOUND_TAG } from '../src/utils/vless-params.js';
import { createAdminApi, type TestEnv } from './helpers/api.js';
import { stubSsh } from './helpers/ssh-stub.js';
import { startTestServer } from './test-app.js';

const PASSWORD = 'TestPassword123!';

describe('CORE VLESS', () => {
  let env: TestEnv;
  let admin: ReturnType<typeof createAdminApi>;
  let hostIndex = 0;

  beforeAll(async () => {
    initDatabase();
    env = await startTestServer();
    admin = createAdminApi(env, 'vless_admin', PASSWORD);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await env?.close();
  });

  async function createNode() {
    const response = await admin.api('/api/servers', 'POST', {
      protocol: 'vless', name: 'Reality', host: `198.51.100.${++hostIndex}`, ssh_password: 'test-ssh-password',
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  function readClient(id: number) {
    return db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as any;
  }

  it('собирает config.json из БД только с активными клиентами VLESS', async () => {
    const node = await createNode();
    expect(node).toMatchObject({
      protocol: 'vless', awg_port: 443, subnet: '', container_name: XRAY_CONTAINER, conf_path: XRAY_CONF_PATH,
    });
    expect(node).not.toHaveProperty('server_private_key');
    const path = `/api/servers/${node.id}/clients`;
    const active = (await admin.api(path, 'POST', { name: 'Активный' })).body;
    const disabled = (await admin.api(path, 'POST', { name: 'Отключённый' })).body;
    await admin.api(`/api/clients/${disabled.id}`, 'PUT', { enabled: false });
    const sub = await admin.api('/api/subscribers', 'POST', { name: 'Подписчик', server_ids: [node.id] });
    expect(sub.status).toBe(201);
    db.prepare('UPDATE subscribers SET suspended = 1 WHERE id = ?').run(sub.body.id);

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(node.id) as any;
    const client = readClient(active.id);
    expect(isValidUuid(client.client_uuid)).toBe(true);
    expect(client).toMatchObject({ client_ip: '', client_public_key: '', client_private_key: '', preshared_key: null });
    expect(disabled.id).not.toBe(active.id);
    expect(readClient(disabled.id).client_uuid).not.toBe(client.client_uuid);

    const config = JSON.parse(XrayService.generateServerConfig(server, ProvisionService.getServerClients(node.id)));
    expect(config).toMatchObject({
      log: { loglevel: 'warning' },
      api: { tag: 'api', services: ['HandlerService', 'StatsService'] },
      policy: { levels: { 0: { statsUserUplink: true, statsUserDownlink: true } } },
      routing: { rules: [
        { inboundTag: ['api'], outboundTag: 'api' },
        { ip: ['geoip:private'], outboundTag: 'block' },
      ] },
    });
    expect(config.inbounds.find((inbound: any) => inbound.tag === 'api')).toMatchObject({
      listen: '127.0.0.1', port: XRAY_API_PORT, protocol: 'dokodemo-door',
    });
    expect(config.inbounds.find((inbound: any) => inbound.tag === XRAY_INBOUND_TAG)).toMatchObject({
      port: 443, protocol: 'vless',
      settings: {
        decryption: 'none',
        clients: [{ id: client.client_uuid, flow: node.xray_flow, email: `c${client.id}`, level: 0 }],
      },
      streamSettings: {
        network: 'tcp', security: 'reality',
        realitySettings: {
          dest: node.reality_dest, serverNames: [node.reality_sni], shortIds: node.reality_short_ids,
          privateKey: toXrayKey(server.server_private_key),
        },
      },
    });
  });

  it('отдаёт ссылку и QR администратору, скрывает UUID в списках', async () => {
    const node = await createNode();
    const listPath = `/api/servers/${node.id}/clients`;
    const created = await admin.api(listPath, 'POST', { name: 'Клиент VLESS' });
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('client_uuid');
    const uuid = readClient(created.body.id).client_uuid;
    expect(isValidUuid(uuid)).toBe(true);
    const link = `vless://${uuid}@${node.host}:443`;
    const buildLink = vi.spyOn(XrayService, 'buildVlessLink').mockReturnValue(link);

    const path = `/api/clients/${created.body.id}`;
    const config = await admin.api(`${path}/config`);
    expect(config.status).toBe(200);
    expect(config.body).toBe(link);
    expect(config.headers.get('content-disposition')).toContain('.txt');
    expect(config.headers.get('cache-control')).toBe('no-store');
    const qr = await admin.api(`${path}/qrcode`);
    expect(qr.status).toBe(200);
    expect(qr.body).toMatchObject({ config: link, qrcode: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(buildLink).toHaveBeenCalledTimes(2);
    expect(buildLink).toHaveBeenCalledWith(expect.objectContaining({ id: node.id }), expect.objectContaining({ client_uuid: uuid }), 'Клиент VLESS');

    expect((await admin.api(listPath)).body[0]).not.toHaveProperty('client_uuid');
    const guest = await admin.api('/api/auth/guest', 'PUT', {
      enabled: true, username: 'vless_guest', password: 'GuestPassword123!', current_password: PASSWORD,
    });
    expect(guest.status).toBe(200);
    const login = await env.request('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'vless_guest', password: 'GuestPassword123!' }),
    });
    expect(login.status).toBe(200);
    const headers = { Authorization: `Bearer ${(await login.json()).token}` };
    const listed = await env.request(listPath, { headers });
    expect(listed.status).toBe(200);
    const clients = await listed.json();
    expect(clients[0]).toMatchObject({ id: created.body.id });
    expect(clients[0]).not.toHaveProperty('client_uuid');
    expect((await env.request(`${path}/config`, { headers })).status).toBe(403);
    expect((await env.request(`${path}/qrcode`, { headers })).status).toBe(403);
  });

  it('создаёт подписочный пир без IP и перевыпускает UUID при сбросе ссылки', async () => {
    const node = await createNode();
    const created = await admin.api('/api/subscribers', 'POST', { name: 'Подписчик', server_ids: [node.id] });
    expect(created.status).toBe(201);
    const peer = db.prepare('SELECT * FROM clients WHERE subscriber_id = ?').get(created.body.id) as any;
    expect(peer).toMatchObject({ client_ip: '', client_public_key: '', client_private_key: '', preshared_key: null });
    expect(isValidUuid(peer.client_uuid)).toBe(true);
    expect(created.body.servers[0]).not.toHaveProperty('client_uuid');

    const reset = await admin.api(`/api/subscribers/${created.body.id}/reset-token`, 'POST');
    expect(reset.status).toBe(200);
    const rotated = readClient(peer.id);
    expect(isValidUuid(rotated.client_uuid)).toBe(true);
    expect(rotated.client_uuid).not.toBe(peer.client_uuid);
    expect(rotated.client_public_key).toBe('');
  });

  it('валидирует, сохраняет и рандомизирует параметры Reality', async () => {
    const node = await createNode();
    const path = `/api/servers/${node.id}`;
    for (const params of [
      { reality_sni: 'localhost' }, { reality_dest: 'www.example.org:99999' }, { reality_short_ids: ['abc'] },
      { xray_flow: 'invalid' }, { xray_fingerprint: 'invalid' }, { jc: 5 }, { subnet: '10.8.0.1/24' },
      { awg_port: XRAY_API_PORT }, { protocol: 'awg' },
    ]) {
      const invalid = await admin.api(path, 'PUT', params);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toEqual(expect.any(String));
    }
    const params = {
      reality_sni: 'www.example.org', reality_dest: 'www.example.org:8443', reality_short_ids: ['', 'aabb'], xray_flow: '',
    };
    const updated = await admin.api(path, 'PUT', params);
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject(params);
    const randomized = await admin.api(`${path}/randomize-params`, 'POST');
    expect(randomized.status).toBe(200);
    expect(randomized.body).toMatchObject({ server_public_key: node.server_public_key, xray_flow: 'xtls-rprx-vision' });
    expect(randomized.body.reality_short_ids).toEqual([expect.stringMatching(/^[0-9a-f]{16}$/)]);
  });

  it('запрашивает применение параметров и откатывает их при ошибке', async () => {
    const node = await createNode();
    db.prepare("UPDATE servers SET status = 'online', deployed_port = awg_port WHERE id = ?").run(node.id);
    const newSni = 'www.example.org';
    // SSH-путь Xray реализуется в задаче NODES. Здесь проверяем границу маршрута и откат.
    const apply = vi.spyOn(ProvisionService, 'requestApply').mockImplementation(async (id) => {
      const row = db.prepare('SELECT reality_sni FROM servers WHERE id = ?').get(id);
      expect(row).toMatchObject({ reality_sni: newSni });
      return { success: false, error: 'ошибка Xray' };
    });
    const result = await admin.api(`/api/servers/${node.id}`, 'PUT', { reality_sni: newSni });
    expect(apply).toHaveBeenCalledWith(node.id);
    expect(result.status).toBe(502);
    expect(result.body.server).toMatchObject({ reality_sni: node.reality_sni, needs_apply: true });
  });

  it('отклоняет операции AmneziaWG для VLESS до обращения по SSH', async () => {
    const node = await createNode();
    const ssh = stubSsh();
    for (const path of [`/api/servers/${node.id}/scan`, `/api/servers/${node.id}/upgrade-protocol`, '/api/servers/import-amnezia']) {
      const result = await admin.api(path, 'POST', { protocol: 'vless' });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('Недоступно для VLESS');
    }
    expect(ssh.calls).toEqual([]);
  });

  it('отклоняет выдачу VLESS партнёру и фильтрует ноду в федерации', async () => {
    const node = await createNode();
    const denied = await admin.api('/api/partners', 'POST', { name: 'Партнёр', node_ids: [node.id] });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toContain('VLESS');

    const created = await admin.api('/api/partners', 'POST', { name: 'Партнёр', node_ids: [] });
    expect(created.status).toBe(201);
    const changed = await admin.api(`/api/partners/${created.body.partner.id}`, 'PUT', { node_ids: [node.id] });
    expect(changed.status).toBe(400);
    // Даже прямая привязка в БД не даёт доступа через федерацию.
    db.prepare('INSERT INTO partner_nodes (partner_id, server_id) VALUES (?, ?)').run(created.body.partner.id, node.id);
    vi.stubEnv('ALLOW_INSECURE_FEDERATION', '1');
    const headers = { Authorization: `Bearer ${created.body.token}` };
    const nodes = await admin.api('/api/federation/v1/nodes', 'GET', undefined, headers);
    expect(nodes.status).toBe(200);
    expect(nodes.body.nodes).toEqual([]);
    const peer = await admin.api('/api/federation/v1/peers', 'POST', { node_id: node.id }, headers);
    expect(peer.status).toBe(400);
    expect(peer.body.error).toContain('VLESS');
  });
});
