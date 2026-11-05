import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { loginIpLimiter, loginUserLimiter, reauthLimiter } from '../src/middleware/rate-limit.js';
import { AuthService } from '../src/services/auth.service.js';
import { createAdminApi } from './helpers/api.js';
import { insertClient, insertServer } from './helpers/db.js';
import { startTestServer } from './test-app.js';

/**
 * Вход, сессии, смена пароля и настройки панели (DNS, MTU, публичный адрес) через HTTP API.
 */

let env: Awaited<ReturnType<typeof startTestServer>>;
let admin: ReturnType<typeof createAdminApi>;

const USER = 'admin_auth';
const PASSWORD = 'TestPassword123!';

const login = async (username: unknown, password: unknown) => {
  const res = await env.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  admin = createAdminApi(env, USER, PASSWORD);
});

afterAll(async () => {
  await env.close();
});

beforeEach(() => {
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) loginIpLimiter.reset(ip);
  loginUserLimiter.reset(USER);
});

describe('вход', () => {
  it('успешный вход выдаёт токен и данные пользователя, пароль в ответе не возвращается', async () => {
    const res = await login(USER, PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: expect.any(Number), username: USER, role: 'admin' });
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|salt/i);
  });

  it('неверные данные — 401 с одинаковым сообщением для неверного пароля и несуществующего логина', async () => {
    const wrongPassword = await login(USER, 'wrong-password');
    const unknownUser = await login('no_such_user', 'wrong-password');
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error).toBe(unknownUser.body.error);
  });

  it.each([
    ['пустое тело', undefined, undefined],
    ['логин не строка', 123, PASSWORD],
    ['пароль не строка', USER, { a: 1 }],
    ['пустой логин', '', PASSWORD],
    ['пустой пароль', USER, ''],
  ])('некорректные данные (%s) — 400', async (_name, username, password) => {
    expect((await login(username, password)).status).toBe(400);
  });

  it('неудачные попытки блокируют вход (429 с Retry-After), успешный вход сбрасывает счётчик', async () => {
    for (let i = 0; i < 4; i++) expect((await login(USER, 'bad')).status).toBe(401);
    expect((await login(USER, PASSWORD)).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await login(USER, 'bad')).status).toBe(401);
    const blocked = await env.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASSWORD }),
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('сессии', () => {
  it('/me возвращает текущего пользователя; без токена, с чужим токеном и токеном в URL — 401', async () => {
    expect((await admin.api('/api/auth/me')).body.user.username).toBe(USER);
    expect((await env.request('/api/auth/me')).status).toBe(401);
    expect((await env.request('/api/auth/me', { headers: { Authorization: 'Bearer ' + 'a'.repeat(64) } })).status).toBe(401);
    expect((await env.request('/api/auth/me', { headers: { Authorization: admin.token } })).status).toBe(401);
    // Инвариант 4: токен принимается только из заголовка
    expect((await env.request(`/api/servers?token=${admin.token}`)).status).toBe(401);
  });

  it('все защищённые маршруты требуют авторизацию', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/servers'], ['POST', '/api/servers'], ['GET', '/api/servers/1'], ['POST', '/api/servers/1/sync'],
      ['GET', '/api/servers/1/clients'], ['POST', '/api/servers/1/clients'], ['PUT', '/api/clients/1'], ['DELETE', '/api/clients/1'],
      ['GET', '/api/clients/1/config'], ['GET', '/api/clients/1/qrcode'], ['GET', '/api/subscribers'], ['POST', '/api/subscribers'],
      ['GET', '/api/security/ssl'], ['POST', '/api/security/fail2ban/ban'], ['GET', '/api/settings'], ['PUT', '/api/settings'],
      ['GET', '/api/subscription-settings'], ['GET', '/api/partners'], ['POST', '/api/partners'], ['GET', '/api/remote-panels'],
      ['POST', '/api/remote-panels'], ['POST', '/api/auth/logout'], ['POST', '/api/auth/change-password'],
      ['POST', '/api/auth/change-username'], ['GET', '/api/probes'], ['PUT', '/api/probes'], ['POST', '/api/probes/run'],
      ['GET', '/api/probes/countries'], ['GET', '/api/migration/status'], ['POST', '/api/migration/prepare'],
      ['GET', '/api/migration/download'], ['POST', '/api/migration/cancel'],
    ];
    for (const [method, path] of routes) {
      const res = await env.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('просроченная сессия не действует и удаляется очисткой', async () => {
    const { token } = AuthService.login(USER, PASSWORD)!;
    expect(AuthService.validateSession(token)).not.toBeNull();
    db.prepare("UPDATE sessions SET expires_at = '2020-01-01T00:00:00.000Z'").run();
    expect(AuthService.validateSession(token)).toBeNull();
    expect((await env.request('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);

    AuthService.cleanupExpiredSessions();
    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 0 });
    admin = createAdminApi(env, USER, PASSWORD);
  });

  it('в БД хранится только хэш токена', () => {
    const { token } = AuthService.login(USER, PASSWORD)!;
    const rows = db.prepare('SELECT token FROM sessions').all() as { token: string }[];
    expect(rows.some((row) => row.token === token)).toBe(false);
    expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.token))).toBe(true);
  });

  it('выход завершает только текущую сессию', async () => {
    const other = AuthService.login(USER, PASSWORD)!.token;
    expect((await admin.api('/api/auth/logout', 'POST')).status).toBe(200);
    expect((await admin.api('/api/auth/me')).status).toBe(401);
    expect(AuthService.validateSession(other)).not.toBeNull();
    admin = createAdminApi(env, USER, PASSWORD);
  });
});

describe('смена пароля', () => {
  it('проверяет входные данные и старый пароль', async () => {
    expect((await admin.api('/api/auth/change-password', 'POST', {})).status).toBe(400);
    expect((await admin.api('/api/auth/change-password', 'POST', { oldPassword: PASSWORD, newPassword: 123 })).status).toBe(400);
    const short = await admin.api('/api/auth/change-password', 'POST', { oldPassword: PASSWORD, newPassword: 'short' });
    expect(short.status).toBe(400);
    expect(short.body.error).toContain('не менее 8');
    const wrong = await admin.api('/api/auth/change-password', 'POST', { oldPassword: 'not-the-password', newPassword: 'NewPassword456!' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain('старый пароль');
    expect(AuthService.login(USER, PASSWORD)).not.toBeNull();
  });

  it('завершает все прежние сессии, выдаёт новый токен и меняет пароль', async () => {
    const otherSession = AuthService.login(USER, PASSWORD)!.token;
    const res = await admin.api('/api/auth/change-password', 'POST', { oldPassword: PASSWORD, newPassword: 'NewPassword456!' });
    expect(res.status).toBe(200);

    expect((await admin.api('/api/auth/me')).status).toBe(401);
    expect(AuthService.validateSession(otherSession)).toBeNull();
    expect(AuthService.validateSession(res.body.token)).not.toBeNull();
    expect(AuthService.login(USER, PASSWORD)).toBeNull();
    expect(AuthService.login(USER, 'NewPassword456!')).not.toBeNull();

    AuthService.resetAdmin(USER, PASSWORD);
    admin = createAdminApi(env, USER, PASSWORD);
  });
});

describe('смена логина', () => {
  const changeUsername = (password: unknown, newUsername: unknown) => admin.api('/api/auth/change-username', 'POST', { password, newUsername });
  const adminId = () => (db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get() as { id: number }).id;

  const resetReauth = () => reauthLimiter.reset(`admin:${adminId()}`);

  beforeEach(resetReauth);

  it('проверяет входные данные: обязательные поля, допустимые символы и длину, совпадение с текущим', async () => {
    expect((await changeUsername(PASSWORD, undefined)).status).toBe(400);
    expect((await changeUsername(undefined, 'new_login')).status).toBe(400);
    expect((await changeUsername(PASSWORD, '   ')).status).toBe(400);
    for (const bad of ['two words', 'логин', 'a'.repeat(65), '<script>', 'x/y', 'a\nb', "quote'"]) {
      const res = await changeUsername(PASSWORD, bad);
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toContain('Логин');
    }
    const same = await changeUsername(PASSWORD, USER);
    expect(same.status).toBe(400);
    expect(same.body.error).toContain('совпадает');
    expect((await admin.api('/api/auth/me')).body.user.username).toBe(USER);
  });

  it('неверный пароль — 400, логин не меняется', async () => {
    const wrong = await changeUsername('not-the-password', 'new_login');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('Неверный пароль');
    expect(AuthService.login(USER, PASSWORD)).not.toBeNull();
    expect(AuthService.login('new_login', PASSWORD)).toBeNull();
  });

  it('логин меняется: вход под новым логином с прежним паролем, старый логин не действует, остальные сессии завершены', async () => {
    const otherSession = AuthService.login(USER, PASSWORD)!.token;
    const res = await changeUsername(PASSWORD, ' New.Login-1@x ');
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: adminId(), username: 'New.Login-1@x', role: 'admin' });

    expect(AuthService.validateSession(otherSession)).toBeNull();
    expect((await admin.api('/api/auth/me')).status).toBe(401);
    const me = await env.request('/api/auth/me', { headers: { Authorization: `Bearer ${res.body.token}` } });
    expect(((await me.json()) as any).user.username).toBe('New.Login-1@x');

    expect((await login(USER, PASSWORD)).status).toBe(401);
    const relogin = await login('New.Login-1@x', PASSWORD);
    expect(relogin.status).toBe(200);
    expect(relogin.body.user.username).toBe('New.Login-1@x');
    expect(JSON.stringify(res.body)).not.toMatch(/hash|salt|"password"/i);

    AuthService.resetAdmin(USER, PASSWORD);
    admin = createAdminApi(env, USER, PASSWORD);
  });

  it('занятый логин другого администратора — 409', async () => {
    const { hash, salt } = AuthService.hashPassword('OtherAdminPass-1');
    db.prepare('INSERT INTO admins (username, password_hash, salt) VALUES (?, ?, ?)').run('second_admin', hash, salt);
    try {
      const res = await changeUsername(PASSWORD, 'second_admin');
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('занят');
      expect(AuthService.login(USER, PASSWORD)).not.toBeNull();
    } finally {
      db.prepare('DELETE FROM admins WHERE username = ?').run('second_admin');
    }
  });

  it('подбор пароля через смену логина и пароля ограничен: 5 неверных за 15 минут — затем 429 даже с верным паролем', async () => {
    for (let i = 0; i < 3; i++) expect((await changeUsername('bad-password-' + i, 'new_login')).status).toBe(400);
    for (let i = 0; i < 2; i++) {
      expect((await admin.api('/api/auth/change-password', 'POST', { oldPassword: 'bad-' + i, newPassword: 'NewPassword456!' })).status).toBe(400);
    }
    const blocked = await changeUsername(PASSWORD, 'new_login');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain('Повторите');
    expect((await admin.api('/api/auth/change-password', 'POST', { oldPassword: PASSWORD, newPassword: 'NewPassword456!' })).status).toBe(429);
    expect(AuthService.login(USER, PASSWORD)).not.toBeNull();

    resetReauth();
    // верный пароль сбрасывает счётчик
    expect((await changeUsername('bad', 'new_login')).status).toBe(400);
    expect((await changeUsername(PASSWORD, 'new_login')).status).toBe(200);
    AuthService.resetAdmin(USER, PASSWORD);
    admin = createAdminApi(env, USER, PASSWORD);
  });
});

describe('настройки панели', () => {
  it('значения по умолчанию', async () => {
    expect((await admin.api('/api/settings')).body).toEqual({ public_url: '', client_dns: '1.1.1.1, 8.8.8.8', client_mtu: 1280 });
  });

  it('публичный адрес: только http(s), слэш на конце убирается, пустое значение сбрасывает настройку', async () => {
    expect((await admin.api('/api/settings', 'PUT', { public_url: 'https://panel.example.com///' })).body.public_url).toBe('https://panel.example.com');
    for (const bad of ['javascript:alert(1)', 'ftp://panel.example.com', 'не ссылка', 'file:///etc/passwd']) {
      expect((await admin.api('/api/settings', 'PUT', { public_url: bad })).status, bad).toBe(400);
    }
    expect((await admin.api('/api/settings')).body.public_url).toBe('https://panel.example.com');
    expect((await admin.api('/api/settings', 'PUT', { public_url: '' })).body.public_url).toBe('');
  });

  it('DNS клиентов: от 1 до 4 IP-адресов, без имён и директив', async () => {
    expect((await admin.api('/api/settings', 'PUT', { client_dns: ' 9.9.9.9 ,149.112.112.112, 2620:fe::fe ' })).body.client_dns).toBe('9.9.9.9, 149.112.112.112, 2620:fe::fe');
    for (const bad of ['', ',', 'dns.example.com', '1.1.1.1\nPostUp = id', '1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4, 5.5.5.5', 123, { a: 1 }]) {
      expect((await admin.api('/api/settings', 'PUT', { client_dns: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await admin.api('/api/settings')).body.client_dns).toBe('9.9.9.9, 149.112.112.112, 2620:fe::fe');
  });

  it('MTU: целое от 576 до 1500', async () => {
    expect((await admin.api('/api/settings', 'PUT', { client_mtu: 1420 })).body.client_mtu).toBe(1420);
    for (const bad of [575, 1501, 1280.5, 'abc', null, {}]) {
      expect((await admin.api('/api/settings', 'PUT', { client_mtu: bad })).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('отклонённый запрос не сохраняет ни одного поля (#61)', async () => {
    const before = (await admin.api('/api/settings')).body;
    const res = await admin.api('/api/settings', 'PUT', { public_url: 'https://other.example.com', client_dns: '4.4.4.4', client_mtu: 100 });
    expect(res.status).toBe(400);
    expect((await admin.api('/api/settings')).body).toEqual(before);
  });

  it('DNS и MTU попадают в конфигурацию клиента', async () => {
    await admin.api('/api/settings', 'PUT', { client_dns: '9.9.9.9', client_mtu: 1380 });
    const serverId = insertServer();
    const client = insertClient(serverId);
    const res = await env.request(`/api/clients/${client.id}/config`, { headers: { Authorization: `Bearer ${admin.token}` } });
    expect(res.status).toBe(200);
    const conf = await res.text();
    expect(conf).toContain('DNS = 9.9.9.9');
    expect(conf).toContain('MTU = 1380');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toContain('filename="client-');
  });
});

describe('настройки подписки', () => {
  it('проверяет ссылки, email, длину и порядок, сохраняет отображаемые имена серверов', async () => {
    const serverId = insertServer({ name: 'Основной' });
    const bad: Record<string, unknown>[] = [
      { announce_url: 'javascript:alert(1)' }, { support_url: 'не ссылка' }, { web_page_url: 'data:text/html,x' },
      { support_email: 'не email' }, { support_email: 'почта@пример.рф' }, { sort_order: 'random' },
      { update_interval: 0 }, { update_interval: 169 }, { update_interval: 1.5 },
      { announce: 'я'.repeat(201) }, { description: 'я'.repeat(501) }, { title: 'x'.repeat(26) },
    ];
    for (const settings of bad) {
      expect((await admin.api('/api/subscription-settings', 'PUT', { settings })).status, JSON.stringify(settings)).toBe(400);
    }

    const ok = await admin.api('/api/subscription-settings', 'PUT', {
      settings: { title: 'VPN {user}', update_interval: 6, announce_url: 'https://example.com/новости', support_email: 'help@example.com', sort_order: 'name', hide_url: true },
      servers: [{ id: serverId, sub_name: ' 🇩🇪 Германия # 1\n', sub_order: 3 }],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toMatchObject({ title: 'VPN {user}', update_interval: 6, sort_order: 'name', hide_url: true });
    expect(ok.body.settings.announce_url).toBe('https://example.com/%D0%BD%D0%BE%D0%B2%D0%BE%D1%81%D1%82%D0%B8');
    expect(ok.body.servers.find((s: any) => s.id === serverId)).toMatchObject({ sub_name: '🇩🇪 Германия   1', sub_order: 3 });

    for (const servers of ['x', [{ id: 'a' }], [{ id: serverId, sub_order: -1 }], [{ id: serverId, sub_name: 'я'.repeat(65) }]]) {
      expect((await admin.api('/api/subscription-settings', 'PUT', { servers })).status).toBe(400);
    }
  });
});
