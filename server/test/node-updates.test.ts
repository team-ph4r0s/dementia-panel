import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase, setSetting } from '../src/db/index.js';
import { NodeUpdateService } from '../src/services/node-update.service.js';
import { ProvisionService } from '../src/services/provision.service.js';
import { AuthService } from '../src/services/auth.service.js';
import { createAdminApi } from './helpers/api.js';
import { insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { stubSsh } from './helpers/ssh-stub.js';
import { startTestServer } from './test-app.js';

const oldImage = `sha256:${'a'.repeat(64)}`;
const newImage = `sha256:${'b'.repeat(64)}`;
const images = `---DEMENTIA_IMAGE--- ${oldImage} ${newImage}\n`;
let env: Awaited<ReturnType<typeof startTestServer>>;
let admin: ReturnType<typeof createAdminApi>;
beforeAll(async () => {
  initDatabase(); env = await startTestServer(); admin = createAdminApi(env, 'nodeupdateadmin');
});
afterAll(async () => { await env.close(); });
afterEach(async () => {
  await vi.waitFor(() => expect(NodeUpdateService.overview().running).toBe(false));
  vi.restoreAllMocks();
  db.exec('DELETE FROM servers; DELETE FROM subscribers; DELETE FROM events');
  for (const k of ['node_auto_update', 'node_update_hour', 'migration_state', 'migration_expires_at']) setSetting(k, null);
});

describe('обновление образов нод', () => {
  it('не меняет ни одну запись клиента, подписку, ключ или параметр сервера при успешном обновлении', async () => {
    const id = insertServer({ sshUser: 'deploy' });
    const sub = insertSubscriber();
    insertClient(id, { subscriberId: sub });
    insertClient(id, { external: 1 });
    insertClient(id, { enabled: 0 });
    const partner = Number(db.prepare("INSERT INTO partners(name, token_hash, token_hint) VALUES ('p', 'hash', 'hint')").run().lastInsertRowid);
    db.prepare('INSERT INTO partner_nodes(partner_id, server_id) VALUES (?, ?)').run(partner, id);
    const pc = insertClient(id);
    db.prepare('UPDATE clients SET partner_id = ? WHERE id = ?').run(partner, pc.id);
    const clients = db.prepare('SELECT * FROM clients ORDER BY id').all();
    const subscriber = db.prepare('SELECT * FROM subscribers').all();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    const ssh = stubSsh(() => ({ stdout: images + '---DEMENTIA_UPDATED---\n' }));
    await NodeUpdateService.operate(id, 'update');
    expect(db.prepare('SELECT * FROM clients ORDER BY id').all()).toEqual(clients);
    expect(db.prepare('SELECT * FROM subscribers').all()).toEqual(subscriber);
    expect(db.prepare('SELECT * FROM servers WHERE id = ?').get(id)).toEqual(server);
    expect(ssh.calls[0].command).toContain('sudo -n timeout --signal=TERM --kill-after=30s 18m bash');
    expect(ssh.calls[0].input).not.toContain('AWG_CONF_B64');
    expect(NodeUpdateService.state(id)).toMatchObject({ available: 0, current_image: newImage, result: 'updated', error: null });
    expect(db.prepare("SELECT type FROM events WHERE type = 'node.updated'").get()).toBeTruthy();
  });

  it('проверяет immutable ID, сохраняет доступность и не дублирует уведомления', async () => {
    const id = insertServer();
    stubSsh(() => ({ stdout: images }));
    await NodeUpdateService.operate(id, 'check');
    await NodeUpdateService.operate(id, 'check');
    expect(NodeUpdateService.state(id)).toMatchObject({ available: 1, current_image: oldImage, latest_image: newImage });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'node.update_available'").get()).toEqual({ n: 1 });
  });

  it('не считает один docker pull успешным обновлением и не раскрывает удалённый вывод', async () => {
    const id = insertServer();
    insertClient(id);
    const before = db.prepare('SELECT * FROM clients').all();
    stubSsh(() => ({ stdout: images, stderr: 'PRIVATE_SECRET' }));
    await expect(NodeUpdateService.operate(id, 'update')).rejects.toThrow('Не удалось обновить');
    expect(NodeUpdateService.state(id)?.result).toBe('error');
    expect(JSON.stringify(NodeUpdateService.overview())).not.toContain('PRIVATE_SECRET');
    expect(db.prepare('SELECT * FROM clients').all()).toEqual(before);
  });

  it('отмечает подтверждённый откат, оставляя клиентов и ключи неизменными', async () => {
    const id = insertServer(); insertClient(id, { external: 1 });
    const before = db.prepare('SELECT * FROM clients').all();
    stubSsh(() => ({ code: 1, stdout: images + '---DEMENTIA_ROLLED_BACK---\n' }));
    await expect(NodeUpdateService.operate(id, 'update')).rejects.toThrow('прежний контейнер восстановлен');
    expect(NodeUpdateService.state(id)).toMatchObject({ result: 'rolled_back' });
    expect(db.prepare('SELECT * FROM clients').all()).toEqual(before);
  });

  it('не трогает импортированные, партнёрские, недоступные ноды и ноды с неприменёнными изменениями', async () => {
    const foreign = insertServer({ managedBy: 'amnezia' });
    const offline = insertServer({ status: 'offline' });
    const pending = insertServer(); db.prepare('UPDATE servers SET needs_sync = 1 WHERE id = ?').run(pending);
    const remote = insertServer();
    const panel = Number(db.prepare("INSERT INTO remote_panels(name, base_url, token) VALUES ('p', 'https://p.example', 'x')").run().lastInsertRowid);
    db.prepare('UPDATE servers SET remote_panel_id = ? WHERE id = ?').run(panel, remote);
    const ssh = stubSsh();
    for (const id of [foreign, offline, pending, remote, 999999]) await expect(NodeUpdateService.operate(id, 'update')).rejects.toThrow('Обновление доступно');
    expect(ssh.calls).toHaveLength(0);
  });

  it('делит очередь с синхронизацией: контейнер не заменяется во время syncconf', async () => {
    const id = insertServer();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ssh = stubSsh(async ({ input }) => {
      if (!input?.includes('AWG_MODE')) { await gate; return {}; }
      return { stdout: images + '---DEMENTIA_UPDATED---\n' };
    });
    const sync = ProvisionService.requestSync(id);
    const update = NodeUpdateService.operate(id, 'update');
    await vi.waitFor(() => expect(ssh.calls).toHaveLength(1));
    release(); await sync; await update;
    expect(ssh.calls).toHaveLength(2);
  });

  it('по умолчанию раз в сутки только проверяет, автообновление требует включения и окна UTC', async () => {
    const id = insertServer();
    const ssh = stubSsh(({ input }) => ({ stdout: images + (input?.includes("AWG_MODE='update'") ? '---DEMENTIA_UPDATED---\n' : '') }));
    const now = new Date(); now.setUTCHours(3, 0, 0, 0);
    await NodeUpdateService.tick(now);
    expect(ssh.calls).toHaveLength(1);
    await NodeUpdateService.tick(now);
    expect(ssh.calls).toHaveLength(1);
    NodeUpdateService.saveSettings({ auto_update: true, hour_utc: 4 });
    await NodeUpdateService.tick(now);
    expect(ssh.calls).toHaveLength(1);
    NodeUpdateService.saveSettings({ auto_update: true, hour_utc: 3 });
    await NodeUpdateService.tick(now);
    expect(ssh.calls).toHaveLength(2);
    expect(NodeUpdateService.state(id)?.result).toBe('updated');
  });

  it('после неудачного автообновления не перезапускает ноду каждую минуту', async () => {
    const id = insertServer();
    const ssh = stubSsh(({ input }) => input?.includes("AWG_MODE='update'") ? { code: 1, stdout: images + '---DEMENTIA_ROLLED_BACK---\n' } : { stdout: images });
    NodeUpdateService.saveSettings({ auto_update: true, hour_utc: 3 });
    const now = new Date(); now.setUTCHours(3, 0, 0, 0);
    await NodeUpdateService.tick(now); await NodeUpdateService.tick(now);
    expect(ssh.calls).toHaveLength(2);
    expect(NodeUpdateService.state(id)?.result).toBe('rolled_back');
  });

  it('во время переноса не запускает даже проверку', async () => {
    insertServer(); const ssh = stubSsh();
    setSetting('migration_state', 'exporting'); setSetting('migration_expires_at', new Date(Date.now() + 60000).toISOString());
    await NodeUpdateService.tick();
    expect(() => NodeUpdateService.start('check')).toThrow('Идёт перенос');
    expect(ssh.calls).toHaveLength(0);
  });

  it('API требует администратора, проверяет расписание и список нод, запускает пакет по одной ноде', async () => {
    expect((await env.request('/api/node-updates')).status).toBe(401);
    AuthService.saveGuestSettings({ enabled: true, username: 'nodeguest', password: 'GuestPassword123!' });
    const guest = AuthService.loginWithTotp('nodeguest', 'GuestPassword123!') as { token: string };
    expect((await env.request('/api/node-updates', { headers: { Authorization: `Bearer ${guest.token}` } })).status).toBe(403);
    expect((await admin.api('/api/node-updates', 'PUT', { auto_update: true, hour_utc: 24 })).status).toBe(400);
    expect((await admin.api('/api/node-updates/check', 'POST', { server_ids: 'bad' })).status).toBe(400);
    const a = insertServer(); const b = insertServer();
    let concurrent = 0; let max = 0;
    const ssh = stubSsh(async () => {
      concurrent++; max = Math.max(max, concurrent);
      await new Promise((r) => setTimeout(r, 10)); concurrent--;
      return { stdout: images };
    });
    expect((await admin.api('/api/node-updates/check', 'POST')).status).toBe(202);
    await vi.waitFor(() => expect(NodeUpdateService.overview().running).toBe(false));
    expect(max).toBe(1); expect(ssh.calls).toHaveLength(2);
    expect(NodeUpdateService.state(a)?.available).toBe(1); expect(NodeUpdateService.state(b)?.available).toBe(1);
    expect((await admin.api('/api/node-updates')).body.nodes).toHaveLength(2);
    db.prepare('DELETE FROM servers WHERE id = ?').run(a);
    expect(NodeUpdateService.state(a)).toBeNull();
  });
});
