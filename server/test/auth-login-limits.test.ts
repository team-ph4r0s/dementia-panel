import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../src/db/index.js';
import { FailureLimiter, loginIpLimiter, loginUserLimiter } from '../src/middleware/rate-limit.js';
import { AuthService } from '../src/services/auth.service.js';
import { createAdminApi } from './helpers/api.js';
import { startTestServer } from './test-app.js';

/**
 * Ограничения перебора при входе: гостевой вход не обнуляет счётчик адреса, длинные логины не копятся в памяти,
 * размер ограничителя ограничен.
 */

let env: Awaited<ReturnType<typeof startTestServer>>;

const USER = 'admin_limits';
const PASSWORD = 'LimitsPassword123!';
const GUEST = 'guest_limits';
const GUEST_PASSWORD = 'GuestPassword123!';

const login = async (username: unknown, password: unknown) => {
  const res = await env.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, body: await res.json() };
};

const resetLimiters = () => {
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) loginIpLimiter.reset(ip);
  for (const name of [USER, GUEST]) loginUserLimiter.reset(name);
};

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  createAdminApi(env, USER, PASSWORD);
});

afterAll(async () => {
  AuthService.saveGuestSettings({ enabled: false, username: GUEST });
  await env.close();
});

beforeEach(resetLimiters);

describe('перебор пароля администратора', () => {
  it('успешный гостевой вход с того же адреса не сбрасывает счётчик неудач (обход ограничения)', async () => {
    // Адрес становится «известным»: для него лимит по логину не действует, остаётся только лимит по IP
    expect((await login(USER, PASSWORD)).status).toBe(200);
    AuthService.saveGuestSettings({ enabled: true, username: GUEST, password: GUEST_PASSWORD });

    for (let i = 0; i < 4; i++) expect((await login(USER, 'wrong-password')).status).toBe(401);
    expect((await login(GUEST, GUEST_PASSWORD)).status).toBe(200);
    expect((await login(USER, 'wrong-password')).status).toBe(401);
    // Пятая неудача — адрес заблокирован, несмотря на вход гостя между попытками
    expect((await login(USER, 'wrong-password')).status).toBe(429);
  });

  it('вход администратора по-прежнему сбрасывает счётчик адреса', async () => {
    for (let i = 0; i < 4; i++) expect((await login(USER, 'wrong-password')).status).toBe(401);
    expect((await login(USER, PASSWORD)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(USER, 'wrong-password')).status).toBe(401);
  });
});

describe('длинные логин и пароль', () => {
  it('отклоняются до ограничителей и хэширования: ключи не копятся в памяти', async () => {
    const before = loginUserLimiter.size;
    const longName = await login('x'.repeat(200_000), 'wrong-password');
    expect(longName.status).toBe(400);
    expect(longName.body.error).toBe('Слишком длинный логин или пароль');
    expect((await login(USER, 'p'.repeat(5000))).status).toBe(400);
    expect(loginUserLimiter.size).toBe(before);
  });

  it('логин обычной длины по-прежнему учитывается', async () => {
    const name = `user_${'a'.repeat(50)}`;
    expect((await login(name, 'wrong-password')).status).toBe(401);
    expect(loginUserLimiter.blockedFor(name)).toBe(0);
    loginUserLimiter.reset(name);
  });
});

describe('FailureLimiter', () => {
  it('не хранит больше maxKeys записей: вытесняются самые старые', () => {
    const limiter = new FailureLimiter(3, 60_000, 100);
    for (let i = 0; i < 1000; i++) limiter.registerFailure(`key-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(100);
    // Свежие записи на месте и продолжают считаться
    limiter.registerFailure('key-999');
    limiter.registerFailure('key-999');
    expect(limiter.blockedFor('key-999')).toBeGreaterThan(0);
    expect(limiter.blockedFor('key-0')).toBe(0);
  });
});
