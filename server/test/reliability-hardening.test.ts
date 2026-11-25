import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../src/db/index.js';
import { AuthService } from '../src/services/auth.service.js';
import { runExclusive, waitForActiveOperations } from '../src/services/provision.service.js';
import { LiveService } from '../src/services/live.service.js';

beforeAll(() => {
  initDatabase();
});

describe('graceful shutdown: waitForActiveOperations и LiveService.shutdown', () => {
  it('ждёт завершения активной операции в runExclusive', async () => {
    let finished = false;
    const task = runExclusive('shutdown-wait-test', async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      finished = true;
    });
    expect(finished).toBe(false);
    await waitForActiveOperations(2000);
    expect(finished).toBe(true);
    await task;
  });

  it('ограничивает ожидание таймаутом, если операция зависла', async () => {
    let release!: () => void;
    const hanging = runExclusive('shutdown-timeout-test', () => new Promise<void>((resolve) => { release = resolve; }));
    const started = Date.now();
    await waitForActiveOperations(50);
    expect(Date.now() - started).toBeLessThan(1000);
    release();
    await hanging;
  });

  it('LiveService.shutdown закрывает открытые сокеты с кодом 1001', () => {
    const close = vi.fn();
    const fakeWs = { readyState: 1, on: vi.fn(), close, terminate: vi.fn() } as any;
    LiveService.add(fakeWs, () => true);
    expect(LiveService.subscribers).toBe(1);
    LiveService.shutdown();
    expect(close).toHaveBeenCalledWith(1001, 'server shutting down');
    expect(LiveService.subscribers).toBe(0);
  });
});

describe('AuthService (async scrypt)', () => {
  it('hashPasswordAsync и verifyPasswordAsync совместимы с синхронной версией', async () => {
    const { hash, salt } = await AuthService.hashPasswordAsync('AsyncSecret123!');
    expect(await AuthService.verifyPasswordAsync('AsyncSecret123!', hash, salt)).toBe(true);
    expect(await AuthService.verifyPasswordAsync('WrongSecret123!', hash, salt)).toBe(false);
    expect(AuthService.verifyPassword('AsyncSecret123!', hash, salt)).toBe(true);
  });

  it('loginWithTotpAsync, changePasswordAsync, changeUsernameAsync и гость работают корректно', async () => {
    AuthService.resetAdmin('async_admin', 'InitialPass123!');
    expect(await AuthService.loginWithTotpAsync('async_admin', 'wrong')).toBeNull();

    const ok = await AuthService.loginWithTotpAsync('async_admin', 'InitialPass123!');
    expect(ok && typeof ok === 'object' ? ok.user.username : null).toBe('async_admin');

    const adminId = (ok as { user: { id: number } }).user.id;
    expect(await AuthService.confirmPasswordAsync(adminId, 'InitialPass123!')).toBe(true);
    expect(await AuthService.confirmPasswordAsync(adminId, 'wrong')).toBe(false);

    const newToken = await AuthService.changePasswordAsync(adminId, 'InitialPass123!', 'UpdatedPass123!');
    expect(newToken).toBeTruthy();

    const renamed = await AuthService.changeUsernameAsync(adminId, 'UpdatedPass123!', 'async_admin_2');
    expect(renamed).toMatchObject({ username: 'async_admin_2' });

    const guest = await AuthService.saveGuestSettingsAsync({ enabled: true, username: 'async_guest', password: 'GuestPass123!' });
    expect(guest).toEqual({ enabled: true, username: 'async_guest', has_password: true });

    const guestLogin = await AuthService.loginWithTotpAsync('async_guest', 'GuestPass123!');
    expect(guestLogin && typeof guestLogin === 'object' ? guestLogin.user.role : null).toBe('guest');

    await AuthService.saveGuestSettingsAsync({ enabled: false, username: 'async_guest' });
  });
});

describe('SecretsService: проверка длины data/secret.key', () => {
  const prevDir = process.env.DEMENTIA_DATA_DIR;
  const prevKey = process.env.DEMENTIA_SECRET_KEY;
  let tmpDir = '';

  afterAll(() => {
    if (prevDir === undefined) delete process.env.DEMENTIA_DATA_DIR;
    else process.env.DEMENTIA_DATA_DIR = prevDir;
    if (prevKey === undefined) delete process.env.DEMENTIA_SECRET_KEY;
    else process.env.DEMENTIA_SECRET_KEY = prevKey;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('отклоняет повреждённый data/secret.key неверной длины', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-secret-check-'));
    fs.writeFileSync(path.join(tmpDir, 'secret.key'), Buffer.from('too-short').toString('base64'));
    process.env.DEMENTIA_DATA_DIR = tmpDir;
    delete process.env.DEMENTIA_SECRET_KEY;
    vi.resetModules();

    const secrets = await import('../src/services/secrets.service.js');
    expect(() => secrets.encryptSecret('hello')).toThrow(/32 байта/);
  });
});
