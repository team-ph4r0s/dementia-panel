import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { AuthService } from '../src/services/auth.service.js';
import { EventService } from '../src/services/event.service.js';
import { PANEL_VERSION, VersionService } from '../src/services/version.service.js';
import { isGuestAllowed } from '../src/middleware/auth.middleware.js';
import { createAdminApi, type TestEnv } from './helpers/api.js';
import { startTestServer } from './test-app.js';

const ADMIN_PASSWORD = 'TestPassword123!';
const GUEST_PASSWORD = 'GuestPassword456';

describe('Гостевой доступ (только просмотр)', () => {
  let env: TestEnv;
  let admin: ReturnType<typeof createAdminApi>;
  let guestToken: string;
  let serverId: number;
  let clientId: number;
  let subscriberToken: string;

  async function login(username: string, password: string) {
    const res = await env.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function asGuest(path: string, method = 'GET', body?: unknown) {
    const res = await env.request(path, {
      method,
      headers: { Authorization: `Bearer ${guestToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  beforeAll(async () => {
    initDatabase();
    // This suite checks guest permissions, not the live GitHub release service.
    vi.spyOn(VersionService, 'getInfo').mockResolvedValue({
      current: PANEL_VERSION, latest: null, latest_url: null, published_at: null, update_available: false,
      releases_url: 'https://github.com/team-ph4r0s/dementia-panel/releases', checked_at: null, check_enabled: false, error: null,
    });
    env = await startTestServer();
    admin = createAdminApi(env, 'guest_test_admin', ADMIN_PASSWORD);

    const server = await admin.api('/api/servers', 'POST', {
      name: 'Гостевая нода', host: '203.0.113.77', ssh_port: 22, ssh_password: 'ssh-secret', awg_port: 51820, subnet: '10.8.7.1/24',
    });
    serverId = server.body.id;
    db.prepare("UPDATE servers SET status = 'online' WHERE id = ?").run(serverId);

    const sub = await admin.api('/api/subscribers', 'POST', { name: 'Тестовый пользователь', server_ids: [serverId] });
    subscriberToken = sub.body.token;
    clientId = (db.prepare('SELECT id FROM clients WHERE server_id = ?').get(serverId) as { id: number }).id;
  });

  afterAll(async () => {
    await env.close();
    vi.restoreAllMocks();
  });

  it('пока гостевой доступ не настроен, войти нельзя', async () => {
    const res = await login('guest', GUEST_PASSWORD);
    expect(res.status).toBe(401);
    expect(AuthService.getGuestSettings()).toEqual({ enabled: false, username: '', has_password: false });
  });

  describe('настройка администратором', () => {
    const put = (body: Record<string, unknown>) => admin.api('/api/auth/guest', 'PUT', body);

    it('требует пароль администратора и не принимает чужой', async () => {
      expect((await put({ enabled: true, username: 'guest', password: GUEST_PASSWORD })).status).toBe(400);
      const wrong = await put({ enabled: true, username: 'guest', password: GUEST_PASSWORD, current_password: 'wrong-password' });
      expect(wrong.status).toBe(400);
      expect(AuthService.getGuestSettings().enabled).toBe(false);
    });

    it('не принимает логин администратора, слабый пароль, пароль администратора и включение без пароля', async () => {
      const taken = await put({ enabled: true, username: 'guest_test_admin', password: GUEST_PASSWORD, current_password: ADMIN_PASSWORD });
      expect(taken.status).toBe(409);
      const short = await put({ enabled: true, username: 'guest', password: '123', current_password: ADMIN_PASSWORD });
      expect(short.status).toBe(400);
      const same = await put({ enabled: true, username: 'guest', password: ADMIN_PASSWORD, current_password: ADMIN_PASSWORD });
      expect(same.status).toBe(400);
      const noPassword = await put({ enabled: true, username: 'guest', current_password: ADMIN_PASSWORD });
      expect(noPassword.status).toBe(400);
      const badName = await put({ enabled: true, username: 'bad name!', password: GUEST_PASSWORD, current_password: ADMIN_PASSWORD });
      expect(badName.status).toBe(400);
    });

    it('сохраняет настройки; пароль в ответе и в БД не открытым текстом', async () => {
      const res = await put({ enabled: true, username: 'guest', password: GUEST_PASSWORD, current_password: ADMIN_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ enabled: true, username: 'guest', has_password: true });
      const stored = db.prepare("SELECT value FROM settings WHERE key LIKE 'guest_%'").all() as { value: string }[];
      expect(JSON.stringify(stored)).not.toContain(GUEST_PASSWORD);
      expect((await admin.api('/api/auth/guest')).body).toEqual({ enabled: true, username: 'guest', has_password: true });
    });

    it('администратор не может взять логин гостя', async () => {
      const res = await admin.api('/api/auth/change-username', 'POST', { password: ADMIN_PASSWORD, newUsername: 'guest' });
      expect(res.status).toBe(409);
    });
  });

  describe('вход гостя', () => {
    it('неверный пароль и пароль администратора не подходят', async () => {
      expect((await login('guest', 'WrongPassword1')).status).toBe(401);
      expect((await login('guest', ADMIN_PASSWORD)).status).toBe(401);
    });

    it('верная пара открывает сессию с ролью guest', async () => {
      const res = await login('guest', GUEST_PASSWORD);
      expect(res.status).toBe(200);
      expect(res.body.user).toEqual({ id: 0, username: 'guest', role: 'guest' });
      guestToken = res.body.token;

      const me = await asGuest('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.user.role).toBe('guest');
    });

    it('сессия гостя короче и помечена в списке сессий администратора', async () => {
      const row = db.prepare("SELECT role, expires_at, created_at FROM sessions WHERE role = 'guest'").get() as any;
      expect(row.role).toBe('guest');
      expect(new Date(row.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      const sessions = (await admin.api('/api/auth/sessions')).body.sessions as any[];
      expect(sessions.some((s) => s.role === 'guest')).toBe(true);
      expect(sessions.some((s) => s.role === 'admin' && s.current)).toBe(true);
    });

    it('администратор по-прежнему входит со своим логином и получает роль admin', async () => {
      const res = await login('guest_test_admin', ADMIN_PASSWORD);
      expect(res.body.user.role).toBe('admin');
    });
  });

  describe('что видит гость', () => {
    it('читает ноды, клиентов, пользователей, события и настройки', async () => {
      for (const path of [
        '/api/servers', `/api/servers/${serverId}`, `/api/servers/${serverId}/clients`, '/api/subscribers', '/api/settings',
        '/api/bridges', '/api/events', '/api/partners', '/api/remote-panels', '/api/probes', '/api/version',
      ]) {
        const res = await asGuest(path);
        expect(res.status, path).toBe(200);
      }
    });

    it('не получает секреты: токены подписок, ключи и SSH-доступы', async () => {
      const subscribers = await asGuest('/api/subscribers');
      expect(subscribers.body).toHaveLength(1);
      expect(subscribers.body[0].name).toBe('Тестовый пользователь');
      expect(subscribers.body[0]).not.toHaveProperty('token');

      const clients = await asGuest(`/api/servers/${serverId}/clients`);
      expect(clients.body.length).toBeGreaterThan(0);
      expect(clients.body[0]).not.toHaveProperty('preshared_key');
      expect(clients.body[0]).not.toHaveProperty('client_private_key');

      const servers = await asGuest('/api/servers');
      const text = JSON.stringify([servers.body, subscribers.body, clients.body]);
      expect(text).not.toContain(subscriberToken);
      expect(text).not.toContain('ssh-secret');
      expect(servers.body[0]).not.toHaveProperty('ssh_password');
    });

    it('администратор те же данные видит целиком (маскирование только для гостя)', async () => {
      const subscribers = await admin.api('/api/subscribers');
      expect(subscribers.body[0].token).toBe(subscriberToken);
      const clients = await admin.api(`/api/servers/${serverId}/clients`);
      expect(clients.body[0].preshared_key).toBeTruthy();
    });

    it('события входа и учётной записи гостю не показываются, остальные — да', async () => {
      EventService.log('info', 'server.created', 'Добавлена нода «Видимая»');
      const admin_events = await admin.api('/api/events?limit=200');
      expect(admin_events.body.items.some((e: any) => e.type.startsWith('auth.'))).toBe(true);

      const events = await asGuest('/api/events?limit=200');
      expect(events.status).toBe(200);
      expect(events.body.items.length).toBeGreaterThan(0);
      expect(events.body.items.some((e: any) => e.type.startsWith('auth.') || e.type.startsWith('admin_'))).toBe(false);
      expect(events.body.items.some((e: any) => e.type === 'server.created')).toBe(true);
      expect(events.body.total).toBeLessThan(admin_events.body.total);
    });
  });

  describe('чего гость не может', () => {
    it('изменять ноды, клиентов, пользователей и настройки', async () => {
      const attempts: [string, string, unknown?][] = [
        ['POST', '/api/servers', { name: 'x', host: '203.0.113.1', ssh_password: 'p', awg_port: 51820, subnet: '10.1.1.1/24' }],
        ['PUT', `/api/servers/${serverId}`, { name: 'Взлом' }],
        ['DELETE', `/api/servers/${serverId}`],
        ['POST', `/api/servers/${serverId}/sync`],
        ['POST', `/api/servers/${serverId}/test-ssh`],
        ['POST', `/api/servers/${serverId}/clients`, { name: 'гость' }],
        ['PUT', `/api/clients/${clientId}`, { enabled: 0 }],
        ['DELETE', `/api/clients/${clientId}`],
        ['POST', '/api/subscribers', { name: 'Гость', server_ids: [] }],
        ['PUT', '/api/subscribers/1', { name: 'Гость' }],
        ['DELETE', '/api/subscribers/1'],
        ['POST', '/api/subscribers/1/reset-token'],
        ['PUT', '/api/settings', { client_dns: '8.8.8.8' }],
        ['PUT', '/api/subscription-settings', { title: 'x' }],
        ['POST', '/api/bridges', { name: 'x' }],
        ['PUT', '/api/probes', { settings: {} }],
        ['POST', '/api/partners', { name: 'x', node_ids: [] }],
        ['POST', '/api/security/ssl/toggle', { enabled: true }],
        ['POST', '/api/security/fail2ban/ban', { ip: '203.0.113.9' }],
        ['POST', '/api/version/update', { version: 'v9.9.9' }],
        ['POST', '/api/node-updates/check'],
        ['POST', '/api/node-updates/update'],
        ['PUT', '/api/node-updates', { auto_update: true, hour_utc: 3 }],
        ['PUT', '/api/auth/guest', { enabled: false, current_password: GUEST_PASSWORD }],
        ['POST', '/api/auth/change-password', { oldPassword: GUEST_PASSWORD, newPassword: 'NewPassword789' }],
        ['POST', '/api/auth/totp/setup'],
      ];
      for (const [method, path, body] of attempts) {
        const res = await asGuest(path, method, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.guest).toBe(true);
      }
      const server = db.prepare('SELECT name FROM servers WHERE id = ?').get(serverId) as { name: string };
      expect(server.name).toBe('Гостевая нода');
    });

    it('читать то, что выдаёт секреты или настройки панели', async () => {
      for (const path of [
        `/api/clients/${clientId}/config`, `/api/clients/${clientId}/qrcode`, '/api/backups', '/api/backups/settings',
        '/api/telegram', '/api/security/ssl', '/api/security/fail2ban', '/api/migration/status', '/api/auth/sessions',
        '/api/auth/guest', '/api/version/update', '/api/subscription-settings', '/api/node-updates', '/api/security/cloudflare',
      ]) {
        const res = await asGuest(path);
        expect(res.status, path).toBe(403);
      }
    });

  });

  describe('границы белого списка', () => {
    it('сравнивает путь дословно: регистр, кодирование и лишние сегменты не проходят', () => {
      expect(isGuestAllowed('GET', '/api/servers')).toBe(true);
      expect(isGuestAllowed('HEAD', '/api/servers/5/clients')).toBe(true);
      expect(isGuestAllowed('POST', '/api/auth/logout')).toBe(true);
      expect(isGuestAllowed('GET', '/API/servers')).toBe(false);
      expect(isGuestAllowed('GET', '/api/servers/%31')).toBe(false);
      expect(isGuestAllowed('GET', '/api/servers/1/config')).toBe(false);
      expect(isGuestAllowed('GET', '/api/servers/1/clients/extra')).toBe(false);
      expect(isGuestAllowed('GET', '//api/servers')).toBe(false);
      expect(isGuestAllowed('POST', '/api/servers')).toBe(false);
      expect(isGuestAllowed('OPTIONS', '/api/servers')).toBe(false);
      expect(isGuestAllowed('GET', '/api/clients/1/config')).toBe(false);
    });

    it('адрес с хвостовым слэшем и строкой запроса обрабатывается как обычный', async () => {
      expect((await asGuest('/api/servers/?x=1')).status).toBe(200);
      expect((await asGuest('/api/clients/1/config/')).status).toBe(403);
    });
  });

  describe('жизненный цикл', () => {
    it('выход завершает сессию гостя', async () => {
      const second = await login('guest', GUEST_PASSWORD);
      const res = await env.request('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${second.body.token}` } });
      expect(res.status).toBe(200);
      const me = await env.request('/api/auth/me', { headers: { Authorization: `Bearer ${second.body.token}` } });
      expect(me.status).toBe(401);
    });

    it('смена пароля гостя завершает действующие гостевые сессии и не трогает администратора', async () => {
      const res = await admin.api('/api/auth/guest', 'PUT', { enabled: true, username: 'guest', password: 'AnotherGuest789', current_password: ADMIN_PASSWORD });
      expect(res.status).toBe(200);
      expect((await asGuest('/api/auth/me')).status).toBe(401);
      expect((await login('guest', GUEST_PASSWORD)).status).toBe(401);
      const relogin = await login('guest', 'AnotherGuest789');
      expect(relogin.status).toBe(200);
      guestToken = relogin.body.token;
      expect((await admin.api('/api/auth/me')).status).toBe(200);
    });

    it('смена пароля администратора завершает и гостевые сессии', async () => {
      expect(AuthService.validateSession(guestToken)?.role).toBe('guest');
      expect(AuthService.changePassword(admin_id(), ADMIN_PASSWORD, ADMIN_PASSWORD)).toBeTruthy();
      expect(AuthService.validateSession(guestToken)).toBeNull();
      // changePassword сбросил и сессию, под которой работает хелпер
      admin = createAdminApi(env, 'guest_test_admin', ADMIN_PASSWORD);
    });

    it('отключение мгновенно закрывает вход и действующие сессии, настройки сохраняются', async () => {
      const relogin = await login('guest', 'AnotherGuest789');
      guestToken = relogin.body.token;
      expect((await asGuest('/api/servers')).status).toBe(200);

      const res = await admin.api('/api/auth/guest', 'PUT', { enabled: false, current_password: ADMIN_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ enabled: false, username: 'guest', has_password: true });
      expect((await asGuest('/api/servers')).status).toBe(401);
      expect((await login('guest', 'AnotherGuest789')).status).toBe(401);
    });

    it('сессия отключённого гостя недействительна, даже если запись о ней осталась в БД', async () => {
      const session = AuthService.login('guest_test_admin', ADMIN_PASSWORD)!;
      expect(session.user.role).toBe('admin');
      db.prepare("UPDATE sessions SET role = 'guest' WHERE id = (SELECT MAX(id) FROM sessions)").run();
      expect(AuthService.validateSession(session.token)).toBeNull();
    });
  });

  function admin_id(): number {
    return (db.prepare("SELECT id FROM admins WHERE username = 'guest_test_admin'").get() as { id: number }).id;
  }
});
