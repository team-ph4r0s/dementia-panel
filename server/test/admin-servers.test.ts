import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { AwgService } from '../src/services/awg.service.js';
import { ProvisionService } from '../src/services/provision.service.js';
import { SshService } from '../src/services/ssh.service.js';
import { encodeAmneziaKey } from '../src/utils/amnezia-key.js';
import { createAdminApi } from './helpers/api.js';
import { getServer, insertClient, insertServer } from './helpers/db.js';
import { stubSsh } from './helpers/ssh-stub.js';
import { startTestServer } from './test-app.js';

/**
 * Админ-API серверов и клиентов: проверка входных данных, отсутствие секретов в ответах, переключение способа входа по SSH,
 * удаление с остановкой контейнера, импорт ключей AmneziaVPN, конфиги и QR клиентов.
 */

let env: Awaited<ReturnType<typeof startTestServer>>;
let admin: ReturnType<typeof createAdminApi>;

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  admin = createAdminApi(env, 'admin_servers');
});

afterAll(async () => {
  await env.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

let counter = 0;
const uniqueHost = () => `node-${++counter}.example.com`;
const newServer = (extra: Record<string, unknown> = {}) => ({ name: 'S', host: uniqueHost(), ssh_password: 'super-secret-ssh-password', ...extra });

const SECRET_FIELDS = ['ssh_password', 'ssh_key', 'server_private_key', 'preshared_key'];

function expectNoSecrets(value: unknown, plaintexts: string[] = []) {
  const text = JSON.stringify(value);
  for (const field of SECRET_FIELDS) expect(text, `в ответе поле ${field}`).not.toContain(`"${field}"`);
  for (const secret of plaintexts) expect(text).not.toContain(secret);
}

describe('создание сервера: проверка входных данных', () => {
  it.each([
    ['без имени', { name: undefined }],
    ['пустое имя', { name: '  ' }],
    ['имя не строка', { name: 123 }],
    ['слишком длинное имя', { name: 'x'.repeat(65) }],
    ['без хоста', { host: undefined }],
    ['хост с пробелом', { host: 'a b.example.com' }],
    ['хост с командой', { host: 'example.com;id' }],
    ['хост с подстановкой', { host: '$(id).example.com' }],
    ['SSH-порт 0', { ssh_port: 0 }],
    ['SSH-порт больше 65535', { ssh_port: 70000 }],
    ['SSH-порт — строка с командой', { ssh_port: '22; rm -rf /' }],
    ['порт AmneziaWG дробный', { awg_port: 51820.5 }],
    ['подсеть без маски', { subnet: '10.8.0.1' }],
    ['слишком широкая подсеть', { subnet: '10.0.0.1/8' }],
    ['слишком узкая подсеть', { subnet: '10.8.0.1/31' }],
    ['адрес сети вместо адреса сервера', { subnet: '10.8.0.0/24' }],
    ['подсеть с подстановкой', { subnet: '10.8.0.1/24$(id)' }],
    ['пользователь SSH с пробелом', { ssh_user: 'root; id' }],
    ['пользователь SSH не строка', { ssh_user: ['root'] }],
    ['без пароля и ключа', { ssh_password: undefined }],
    ['ключ без PRIVATE KEY', { ssh_password: undefined, ssh_key: 'ssh-rsa AAAA user@host' }],
  ])('отклоняет: %s', async (_name, patch) => {
    const res = await admin.api('/api/servers', 'POST', { ...newServer(), ...patch });
    expect(res.status).toBe(400);
  });

  it('принимает домен, IPv4, IPv6 и ключ SSH; секреты не возвращаются', async () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
    const byKey = await admin.api('/api/servers', 'POST', { name: 'Key', host: '203.0.113.50', ssh_key: key, ssh_user: 'deploy' });
    const v6 = await admin.api('/api/servers', 'POST', newServer({ host: '2001:db8::10' }));
    expect([byKey.status, v6.status]).toEqual([201, 201]);
    expect(byKey.body).toMatchObject({ status: 'uninstalled', has_ssh_key: true, has_ssh_password: false, ssh_user: 'deploy', awg_version: 3, latest_awg_version: 3 });
    expectNoSecrets(byKey.body, ['AAAA']);
    expectNoSecrets(v6.body, ['super-secret-ssh-password']);
    expect(db.prepare('SELECT ssh_key FROM servers WHERE id = ?').get(byKey.body.id)).toEqual({ ssh_key: expect.stringMatching(/^enc:v1:/) });
  });

  it('новый сервер получает параметры актуальной версии, которые проходят проверку', async () => {
    const res = await admin.api('/api/servers', 'POST', newServer());
    expect(AwgService.validateParams(res.body)).toBeNull();
    expect(res.body).toMatchObject({ awg_version: 3, awg_port: 51820, subnet: '10.8.0.1/24', ssh_port: 22, ssh_user: 'root' });
  });
});

describe('секреты не покидают сервер', () => {
  it('ни один ответ API серверов их не содержит', async () => {
    stubSsh();
    const created = (await admin.api('/api/servers', 'POST', newServer({ ssh_password: 'plain-ssh-pw-1' }))).body;
    const id = created.id;
    const row = getServer(id);
    const secrets = ['plain-ssh-pw-1', row.server_private_key, row.preshared_key];

    expectNoSecrets((await admin.api('/api/servers')).body, secrets);
    expectNoSecrets((await admin.api(`/api/servers/${id}`)).body, secrets);
    expectNoSecrets((await admin.api(`/api/servers/${id}`, 'PUT', { name: 'Renamed' })).body, secrets);
    expectNoSecrets((await admin.api(`/api/servers/${id}/randomize-params`, 'POST')).body, secrets);
    expectNoSecrets((await admin.api(`/api/servers/${id}/upgrade-protocol`, 'POST')).body, secrets);
    expectNoSecrets((await admin.api(`/api/servers/${id}/scan`, 'POST')).body, secrets);
  });
});

describe('изменение сервера (PUT)', () => {
  it('переключает способ входа по SSH и очищает прежний секрет', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { auth_type: 'password' })).status).toBe(400);
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { auth_type: 'key', ssh_key: 'не ключ' })).status).toBe(400);

    const toKey = await admin.api(`/api/servers/${id}`, 'PUT', { auth_type: 'key', ssh_key: '-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----' });
    expect(toKey.body).toMatchObject({ has_ssh_key: true, has_ssh_password: false });
    expect(getServer(id).ssh_password).toBeNull();

    const toPassword = await admin.api(`/api/servers/${id}`, 'PUT', { auth_type: 'password', ssh_password: 'new-pw' });
    expect(toPassword.body).toMatchObject({ has_ssh_key: false, has_ssh_password: true });
    expect(getServer(id).ssh_key).toBeNull();
  });

  it('смена хоста и явный сброс забывают сохранённый отпечаток SSH-хоста', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    db.prepare("UPDATE servers SET host_key = 'SHA256:abc' WHERE id = ?").run(id);
    await admin.api(`/api/servers/${id}`, 'PUT', { name: 'Только имя' });
    expect(getServer(id).host_key).toBe('SHA256:abc');
    await admin.api(`/api/servers/${id}`, 'PUT', { reset_host_key: true });
    expect(getServer(id).host_key).toBeNull();

    db.prepare("UPDATE servers SET host_key = 'SHA256:abc' WHERE id = ?").run(id);
    await admin.api(`/api/servers/${id}`, 'PUT', { host: uniqueHost() });
    expect(getServer(id).host_key).toBeNull();
  });

  it('подсеть нельзя менять, пока на сервере есть клиенты', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { subnet: '10.50.0.1/24' })).body.subnet).toBe('10.50.0.1/24');
    insertClient(id, { ip: '10.50.0.2' });
    const res = await admin.api(`/api/servers/${id}`, 'PUT', { subnet: '10.60.0.1/24' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('есть клиенты');
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { subnet: '10.50.0.1/24' })).status).toBe(200);
  });

  it('параметры AWG проверяются; для установленного сервера изменение запускает применение, для неустановленного — нет', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    const current = getServer(id);

    expect((await admin.api(`/api/servers/${id}`, 'PUT', { s1: 20, s2: 76 })).body.error).toMatch(/S1 \+ 56/);
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { jmin: 100, jmax: 50 })).status).toBe(400);
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { h1: 'abc' })).status).toBe(400);
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { h2: current.h1 })).status).toBe(400);
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { i1: '<b 0x01>\nPostUp = id' })).status).toBe(400);
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { header_protection_key: 'короткий' })).status).toBe(400);
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { extra_params: { Unknown: '1' } })).status).toBe(200); // extra_params правится только импортом
    expect(getServer(id).needs_apply).toBe(0);

    const ssh = stubSsh();
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { jc: 9 })).body.jc).toBe(9);
    expect(ssh.calls).toHaveLength(0); // неустановленный сервер: перезапускать нечего

    db.prepare("UPDATE servers SET status = 'online', deployed_port = awg_port WHERE id = ?").run(id);
    expect((await admin.api(`/api/servers/${id}`, 'PUT', { jc: 8 })).status).toBe(200);
    await vi.waitFor(() => expect(ssh.calls.some((c) => c.command.includes('docker restart'))).toBe(true));
    expect(getServer(id).jc).toBe(8);
  });

  it('несуществующий и некорректный идентификатор', async () => {
    expect((await admin.api('/api/servers/999999', 'PUT', { name: 'x' })).status).toBe(404);
    expect((await admin.api('/api/servers/abc', 'PUT', { name: 'x' })).status).toBe(400);
    expect((await admin.api('/api/servers/999999')).status).toBe(404);
  });
});

describe('действия над сервером', () => {
  it('randomize-params меняет параметры в пределах версии и сохраняет I1–I5 и дополнительные параметры', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    db.prepare("UPDATE servers SET i1 = '<b 0x0102>', extra_params = ? WHERE id = ?").run(JSON.stringify({ RekeyTimeout: '10' }), id);
    const before = getServer(id);

    const res = await admin.api(`/api/servers/${id}/randomize-params`, 'POST');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ awg_version: 3, i1: '<b 0x0102>', extra_params: { RekeyTimeout: '10' } });
    expect(AwgService.validateParams(res.body)).toBeNull();
    expect([res.body.h1, res.body.h2, res.body.h3, res.body.h4]).not.toEqual([before.h1, before.h2, before.h3, before.h4]);
  });

  it('upgrade-protocol: уже актуальная версия — 400; неустановленный сервер переключается без переустановки', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    expect((await admin.api(`/api/servers/${id}/upgrade-protocol`, 'POST')).status).toBe(400);

    db.prepare("UPDATE servers SET awg_version = 1, s3 = NULL, s4 = NULL, header_protection_key = NULL, h1 = '1000', h2 = '2000', h3 = '3000', h4 = '4000' WHERE id = ?").run(id);
    const res = await admin.api(`/api/servers/${id}/upgrade-protocol`, 'POST');
    expect(res.status).toBe(200);
    expect(res.body.server).toMatchObject({ awg_version: 3 });
    expect(res.body.server.s3).not.toBeNull();
  });

  it('upgrade-protocol возвращает прежние параметры, если переустановка не удалась', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    db.prepare("UPDATE servers SET status = 'online', deployed_port = awg_port, awg_version = 1, s3 = NULL, s4 = NULL, header_protection_key = NULL, h1 = '1000', h2 = '2000', h3 = '3000', h4 = '4000' WHERE id = ?").run(id);
    stubSsh(() => ({ code: 1, stderr: 'docker pull failed' }));

    const res = await admin.api(`/api/servers/${id}/upgrade-protocol`, 'POST');

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('Параметры возвращены к прежним');
    expect(getServer(id)).toMatchObject({ awg_version: 1, s3: null, h1: 1000 });
  });

  describe('откат порта и параметров, если применить их на ноде не удалось', () => {
    // Контейнер amnezia-awg без маркера панели: установка отказывается его трогать
    const FOREIGN_SCAN = '---CONTAINER amnezia-awg|amneziavpn/amnezia-awg:latest|true\n---CONF /opt/amnezia/awg/wg0.conf\n[Interface]\nListenPort = 51820\n---ENDCONF\n---TOOL awg';

    async function installedServer() {
      const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
      db.prepare("UPDATE servers SET status = 'online', deployed_port = awg_port WHERE id = ?").run(id);
      return id;
    }

    it('смена порта: установка отказалась — порт в БД прежний, остальные правки сохранены', async () => {
      const id = await installedServer();
      const ssh = stubSsh((call) => (call.command.includes('docker ps -a') ? { stdout: FOREIGN_SCAN } : {}));

      const res = await admin.api(`/api/servers/${id}`, 'PUT', { name: 'Новое имя', awg_port: 40000 });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain('возвращены к прежним');
      expect(res.body.server).toMatchObject({ awg_port: 51820, name: 'Новое имя' });
      expect(getServer(id)).toMatchObject({ awg_port: 51820, deployed_port: 51820, name: 'Новое имя', needs_apply: 1 });
      expect(ssh.calls.some((c) => c.command.includes('deploy-awg'))).toBe(false);
    });

    it('параметры обфускации: нода недоступна — подписки продолжают получать прежние значения', async () => {
      const id = await installedServer();
      const before = getServer(id);
      stubSsh(() => ({ code: 255, stderr: 'Connection refused' }));

      const res = await admin.api(`/api/servers/${id}`, 'PUT', { jc: before.jc === 9 ? 8 : 9, h1: before.h1 });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain('Connection refused');
      expect(getServer(id)).toMatchObject({ jc: before.jc, h1: before.h1, needs_apply: 1 });
    });

    it('randomize-params при ошибке ноды оставляет прежние параметры', async () => {
      const id = await installedServer();
      const before = getServer(id);
      stubSsh(() => ({ code: 1, stderr: 'docker restart failed' }));

      const res = await admin.api(`/api/servers/${id}/randomize-params`, 'POST');

      expect(res.status).toBe(502);
      expect(res.body.error).toContain('возвращены к прежним');
      const after = getServer(id);
      for (const key of ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4', 'h1', 'h2', 'h3', 'h4', 'header_protection_key']) {
        expect(after[key], key).toEqual(before[key]);
      }
    });

    it('две правки до применения: при неудаче в БД возвращается значение с ноды, а не промежуточное (#58)', async () => {
      const id = await installedServer();
      const original = getServer(id).jc;
      const [first, second] = [3, 4, 5, 6].filter((v) => v !== original);
      // Очередь ноды занята синхронизацией, пока не откроем «ворота»; затем все команды падают
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      let held = false;
      stubSsh(async () => {
        if (!held) {
          held = true;
          await gate;
          return {};
        }
        return { code: 1, stderr: 'docker restart failed' };
      });
      const busy = ProvisionService.syncPeers(id);
      const waitJc = async (value: number) => {
        for (let i = 0; i < 200 && getServer(id).jc !== value; i++) await new Promise((r) => setTimeout(r, 10));
        expect(getServer(id).jc).toBe(value);
      };

      const p1 = admin.api(`/api/servers/${id}`, 'PUT', { jc: first });
      await waitJc(first);
      const p2 = admin.api(`/api/servers/${id}`, 'PUT', { jc: second });
      await waitJc(second);
      open();
      await busy;
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.status).toBe(502);
      expect(r2.status).toBe(502);
      // На ноде всё ещё исходное значение — в БД и подписках должно быть оно же
      expect(getServer(id)).toMatchObject({ jc: original, needs_apply: 1 });
    });

    it('не откатывает значения, изменённые ещё раз, пока шло применение', async () => {
      const id = await installedServer();
      // Jc генерируется случайно: новое значение должно отличаться от текущего, иначе применять нечего
      const jc = getServer(id).jc === 9 ? 8 : 9;
      stubSsh(() => {
        db.prepare('UPDATE servers SET jc = 7 WHERE id = ?').run(id);
        return { code: 1, stderr: 'ошибка' };
      });

      const res = await admin.api(`/api/servers/${id}`, 'PUT', { jc });

      expect(res.status).toBe(502);
      expect(res.body.error).not.toContain('возвращены к прежним');
      expect(getServer(id).jc).toBe(7);
    });

    it('при успешном применении изменения остаются', async () => {
      const id = await installedServer();
      const jc = getServer(id).jc === 9 ? 8 : 9;
      const ssh = stubSsh();

      const res = await admin.api(`/api/servers/${id}`, 'PUT', { jc });

      expect(res.status).toBe(200);
      expect(ssh.calls.some((c) => c.command.includes('docker restart'))).toBe(true);
      expect(getServer(id)).toMatchObject({ jc, needs_apply: 0 });
    });
  });

  it('sync и apply возвращают 502 при ошибке ноды и 200 при успехе', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    db.prepare("UPDATE servers SET status = 'online', deployed_port = awg_port WHERE id = ?").run(id);
    stubSsh(() => ({ code: 1, stderr: 'нет связи' }));
    expect((await admin.api(`/api/servers/${id}/sync`, 'POST')).status).toBe(502);
    expect((await admin.api(`/api/servers/${id}/apply`, 'POST')).status).toBe(502);

    vi.restoreAllMocks();
    stubSsh();
    expect((await admin.api(`/api/servers/${id}/sync`, 'POST')).body).toEqual({ success: true });
    expect((await admin.api(`/api/servers/${id}/apply`, 'POST')).body).toEqual({ success: true });
  });

  it('test-ssh и scan сообщают результат или ошибку', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    vi.spyOn(SshService, 'testConnection').mockResolvedValue({ success: true, message: 'ok' });
    expect((await admin.api(`/api/servers/${id}/test-ssh`, 'POST')).body).toEqual({ success: true, message: 'ok' });

    stubSsh(() => ({ stdout: '' }));
    const scan = await admin.api(`/api/servers/${id}/scan`, 'POST');
    expect(scan.body).toMatchObject({ found: false, server: { id } });

    vi.restoreAllMocks();
    stubSsh(() => ({ code: 1, stderr: 'Permission denied' }));
    const failed = await admin.api(`/api/servers/${id}/scan`, 'POST');
    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain('Permission denied');
  });
});

describe('удаление сервера', () => {
  it('без teardown удаляет сервер и клиентов из панели, не обращаясь к ноде', async () => {
    const ssh = stubSsh();
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    const client = insertClient(id);
    expect((await admin.api(`/api/servers/${id}`, 'DELETE')).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS c FROM clients WHERE id = ?').get(client.id)).toEqual({ c: 0 });
    expect((await admin.api(`/api/servers/${id}`)).status).toBe(404);
    expect(ssh.calls).toHaveLength(0);
  });

  it('teardown=1 останавливает контейнер; при ошибке — 502 и сервер остаётся, force=1 удаляет принудительно', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    db.prepare("UPDATE servers SET status = 'online' WHERE id = ?").run(id);
    stubSsh(() => ({ code: 1, stderr: 'ssh: connect timed out' }));

    const failed = await admin.api(`/api/servers/${id}?teardown=1`, 'DELETE');
    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain('VPN на сервере продолжит работать');
    expect((await admin.api(`/api/servers/${id}`)).status).toBe(200);

    expect((await admin.api(`/api/servers/${id}?teardown=1&force=1`, 'DELETE')).status).toBe(200);
    expect((await admin.api(`/api/servers/${id}`)).status).toBe(404);

    vi.restoreAllMocks();
    const ok = stubSsh();
    const second = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    db.prepare("UPDATE servers SET status = 'online' WHERE id = ?").run(second);
    expect((await admin.api(`/api/servers/${second}?teardown=1`, 'DELETE')).status).toBe(200);
    expect(ok.calls[0].command).toContain('docker rm -f amnezia-awg');
  });

  it('у неустановленного сервера teardown пропускается', async () => {
    const ssh = stubSsh();
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    expect((await admin.api(`/api/servers/${id}?teardown=1`, 'DELETE')).status).toBe(200);
    expect(ssh.calls).toHaveLength(0);
  });
});

describe('клиенты сервера', () => {
  it('создание: имя по умолчанию, проверка имени, уникальные IP и ключи, секреты не в ответе', async () => {
    stubSsh();
    const id = (await admin.api('/api/servers', 'POST', newServer({ subnet: '10.70.0.1/24' }))).body.id;
    db.prepare("UPDATE servers SET status = 'online' WHERE id = ?").run(id);

    const first = await admin.api(`/api/servers/${id}/clients`, 'POST', {});
    const second = await admin.api(`/api/servers/${id}/clients`, 'POST', { name: '  Телефон  ' });
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body.name).toMatch(/^client-\d{4}$/);
    expect(second.body.name).toBe('Телефон');
    expect([first.body.client_ip, second.body.client_ip]).toEqual(['10.70.0.2', '10.70.0.3']);
    expect(JSON.stringify(first.body)).not.toContain('client_private_key');
    expect(first.body).not.toHaveProperty('rx_counter');

    for (const name of [' ', 'x'.repeat(65), 123, { a: 1 }]) {
      expect((await admin.api(`/api/servers/${id}/clients`, 'POST', { name })).status).toBe(400);
    }
    expect((await admin.api('/api/servers/999999/clients', 'POST', { name: 'x' })).status).toBe(404);
  });

  it('создание клиента при переполненной подсети — 409', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer({ subnet: '10.71.0.1/30' }))).body.id;
    expect((await admin.api(`/api/servers/${id}/clients`, 'POST', { name: 'a' })).status).toBe(201);
    const full = await admin.api(`/api/servers/${id}/clients`, 'POST', { name: 'b' });
    expect(full.status).toBe(409);
    expect(full.body.error).toContain('переполнена');
  });

  it('PUT меняет имя и состояние, DELETE удаляет клиента и снимает его с ноды', async () => {
    const ssh = stubSsh();
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    db.prepare("UPDATE servers SET status = 'online' WHERE id = ?").run(id);
    const client = (await admin.api(`/api/servers/${id}/clients`, 'POST', { name: 'old' })).body;

    expect((await admin.api(`/api/clients/${client.id}`, 'PUT', { name: 'new', enabled: false })).body).toMatchObject({ name: 'new', enabled: 0 });
    expect((await admin.api(`/api/clients/${client.id}`, 'PUT', { name: '' })).status).toBe(400);
    await vi.waitFor(() => expect(ssh.calls.length).toBeGreaterThanOrEqual(2));
    expect((await admin.api(`/api/clients/${client.id}`, 'DELETE')).status).toBe(200);
    expect((await admin.api(`/api/clients/${client.id}`, 'DELETE')).status).toBe(404);
    expect((await admin.api('/api/clients/abc', 'PUT', {})).status).toBe(400);
  });

  it('конфигурация и QR: имя файла безопасно для заголовка, QR — data URL с тем же конфигом', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    const client = insertClient(id, { name: 'Телефон «Мой» "кавычки"/слэш' });

    const conf = await env.request(`/api/clients/${client.id}/config`, { headers: { Authorization: `Bearer ${admin.token}` } });
    expect(conf.status).toBe(200);
    const disposition = conf.headers.get('content-disposition')!;
    expect(disposition).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
    expect(disposition).not.toMatch(/["\\/]{2}/);
    const text = await conf.text();
    expect(text).toContain(`PrivateKey = ${client.privateKey}`);
    expect(text).toContain(`Address = ${client.ip}/32`);
    expect(text).toMatch(/Endpoint = .+:51820/);

    const qr = await admin.api(`/api/clients/${client.id}/qrcode`);
    expect(qr.status).toBe(200);
    expect(qr.body.qrcode).toMatch(/^data:image\/png;base64,/);
    expect(qr.body.config).toBe(text);
  });

  it('импортированные клиенты и клиенты без IP не отдают конфигурацию (409)', async () => {
    const id = (await admin.api('/api/servers', 'POST', newServer())).body.id;
    const external = insertClient(id, { external: 1 });
    const pending = insertClient(id, { ip: 'pending:abc' });
    for (const client of [external, pending]) {
      expect((await admin.api(`/api/clients/${client.id}/config`)).status).toBe(409);
      expect((await admin.api(`/api/clients/${client.id}/qrcode`)).status).toBe(409);
    }
    expect((await admin.api('/api/clients/999999/config')).status).toBe(404);
    const list = (await admin.api(`/api/servers/${id}/clients`)).body;
    expect(list.find((c: any) => c.id === pending.id)).toMatchObject({ pending: true, client_ip: '' });
    expect(list.find((c: any) => c.id === external.id)).toMatchObject({ external: true });
  });
});

describe('импорт серверов из AmneziaVPN', () => {
  const fullAccess = (host: string, extra: Record<string, unknown> = {}) =>
    encodeAmneziaKey({ hostName: host, userName: 'root', password: 'ssh-secret', port: 22, description: 'Из Amnezia', containers: [{ container: 'amnezia-awg' }], ...extra });

  it('отклоняет пустой ввод и слишком много ключей', async () => {
    expect((await admin.api('/api/servers/import-amnezia', 'POST', { keys: '   ' })).status).toBe(400);
    expect((await admin.api('/api/servers/import-amnezia', 'POST', {})).status).toBe(400);
    const many = Array.from({ length: 51 }, () => 'vpn://x').join('\n');
    const res = await admin.api('/api/servers/import-amnezia', 'POST', { keys: many });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('50');
  });

  it('разбирает каждый ключ отдельно: некорректный, дубль, без AmneziaWG, ошибка SSH и подключённый без переустановки', async () => {
    const existing = (await admin.api('/api/servers', 'POST', newServer({ host: 'dup-import.example.com' }))).body.id;
    const serverKeys = AwgService.generateKeyPair();
    const scanWithAwg = [
      '---CONTAINER amnezia-awg|amneziavpn/amnezia-awg:latest|true',
      '---CONF /opt/amnezia/awg/awg0.conf',
      '[Interface]', `PrivateKey = ${serverKeys.privateKey}`, 'Address = 10.8.1.0/24', 'ListenPort = 40000',
      'Jc = 5', 'Jmin = 10', 'Jmax = 50', 'S1 = 30', 'S2 = 40', 'H1 = 1111', 'H2 = 2222', 'H3 = 3333', 'H4 = 4444',
      '[Peer]', 'PublicKey = IMPORTED1=', 'AllowedIPs = 10.8.1.2',
      '---ENDCONF', '---TOOL awg',
    ].join('\n');
    // Ответ сканирования зависит от хоста, поэтому выбирается по учётным данным вызова
    vi.spyOn(SshService, 'executeCommand').mockImplementation(async (credentials) => {
      const host = credentials.host;
      if (host === 'fail.example.com') throw new Error('ECONNREFUSED');
      if (host === 'awg.example.com') return { code: 0, stdout: scanWithAwg, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });

    const keys = [
      'vpn://не-ключ',
      encodeAmneziaKey({ hostName: 'connect-only.example.com', containers: [] }), // ключ подключения без полного доступа
      fullAccess('dup-import.example.com'),
      fullAccess('empty.example.com', { description: '' }),
      fullAccess('fail.example.com'),
      fullAccess('awg.example.com'),
      fullAccess('bad host name!'),
      fullAccess(`${'a'.repeat(60)}.${'b'.repeat(60)}.example.com`, { description: '' }),
    ].join('\n');
    const res = await admin.api('/api/servers/import-amnezia', 'POST', { keys });

    expect(res.status).toBe(200);
    const byKey = res.body.results as any[];
    expect(byKey.map((r) => r.status)).toEqual(['invalid', 'invalid', 'exists', 'needs_install', 'ssh_error', 'adopted', 'invalid', 'needs_install']);
    expect(byKey[2].serverId).toBe(existing);

    const empty = db.prepare("SELECT * FROM servers WHERE host = 'empty.example.com'").get() as any;
    expect(empty).toMatchObject({ name: 'empty.example.com', status: 'uninstalled', ssh_user: 'root' });
    expect(empty.ssh_password).toMatch(/^enc:v1:/);
    expect(JSON.stringify(res.body)).not.toContain('ssh-secret');

    const failed = db.prepare("SELECT * FROM servers WHERE host = 'fail.example.com'").get() as any;
    expect(failed.last_error).toBe('ECONNREFUSED');
    expect(byKey[4].message).toContain('подключиться по SSH не удалось');

    const adopted = db.prepare("SELECT * FROM servers WHERE host = 'awg.example.com'").get() as any;
    expect(adopted).toMatchObject({ status: 'online', awg_port: 40000, managed_by: 'amnezia', name: 'Из Amnezia' });
    expect(byKey[5].importedPeers).toBe(1);

    // Очень длинное доменное имя не ломает импорт: имя сервера обрезается до 64 символов
    const long = db.prepare("SELECT name FROM servers WHERE host LIKE 'aaaa%'").get() as { name: string };
    expect(long.name).toHaveLength(64);
  });
});
