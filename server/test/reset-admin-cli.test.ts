import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/services/auth.service.js';

/**
 * CLI сброса логина и пароля администратора (его вызывает и install.sh): запускается как отдельный процесс на пустой БД.
 */

const SERVER_DIR = path.resolve(__dirname, '..');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runCli(env: Record<string, string>, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-cli-'))) {
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/reset-admin.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DEMENTIA_DATA_DIR: dataDir, PANEL_USER: '', PANEL_PASSWORD: '', ...env },
    encoding: 'utf-8',
    timeout: 60000,
  });
  return { ...result, dataDir };
}

function readAdmins(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, 'dementia.db'));
  try {
    return {
      admins: db.prepare('SELECT username, password_hash, salt FROM admins').all() as { username: string; password_hash: string; salt: string }[],
      sessions: (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c,
      trusted: (db.prepare('SELECT COUNT(*) AS c FROM trusted_login_ips').get() as { c: number }).c,
    };
  } finally {
    db.close();
  }
}

describe('reset-admin CLI', () => {
  it('создаёт администратора с хэшем пароля (пароль в БД не хранится)', () => {
    const result = runCli({ PANEL_USER: 'root_admin', PANEL_PASSWORD: 'LongEnough-Pass1' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Учётные данные администратора "root_admin" обновлены');
    expect(result.stdout).toContain('systemctl restart dementia');
    expect(result.stdout + result.stderr).not.toContain('LongEnough-Pass1');
    const { admins } = readAdmins(result.dataDir);
    expect(admins).toHaveLength(1);
    expect(admins[0].username).toBe('root_admin');
    expect(JSON.stringify(admins)).not.toContain('LongEnough-Pass1');
    expect(AuthService.verifyPassword('LongEnough-Pass1', admins[0].password_hash, admins[0].salt)).toBe(true);
    expect(AuthService.verifyPassword('wrong', admins[0].password_hash, admins[0].salt)).toBe(false);
  }, 90000);

  it('без параметров создаёт администратора со случайными логином и паролем и показывает пароль один раз', () => {
    const result = runCli({});

    expect(result.status).toBe(0);
    const { admins } = readAdmins(result.dataDir);
    expect(admins).toHaveLength(1);
    expect(admins[0].username).toMatch(/^[a-z][a-z0-9]{9}$/);
    expect(admins[0].username).not.toBe('admin');
    expect(result.stdout).toContain(`Учётные данные администратора "${admins[0].username}" обновлены`);
    const printed = /Новый пароль: (\S+)/.exec(result.stdout)![1];
    expect(printed).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(AuthService.verifyPassword(printed, admins[0].password_hash, admins[0].salt)).toBe(true);
  }, 90000);

  it('повторный запуск сохраняет логин, выдаёт другой пароль и завершает сессии', () => {
    const first = runCli({});
    const initial = readAdmins(first.dataDir).admins[0];
    const firstPassword = /Новый пароль: (\S+)/.exec(first.stdout)![1];

    const db = new DatabaseSync(path.join(first.dataDir, 'dementia.db'));
    db.exec("INSERT INTO sessions (token, admin_id, expires_at) VALUES ('x', 1, '2999-01-01T00:00:00.000Z')");
    db.exec("INSERT INTO trusted_login_ips (ip, last_login_at) VALUES ('203.0.113.1', '2999-01-01T00:00:00.000Z')");
    db.close();

    const second = runCli({}, first.dataDir);

    expect(second.status).toBe(0);
    const state = readAdmins(first.dataDir);
    expect(state.admins).toHaveLength(1);
    expect(state.admins[0].username).toBe(initial.username);
    const secondPassword = /Новый пароль: (\S+)/.exec(second.stdout)![1];
    expect(secondPassword).not.toBe(firstPassword);
    expect(AuthService.verifyPassword(secondPassword, state.admins[0].password_hash, state.admins[0].salt)).toBe(true);
    expect(AuthService.verifyPassword(firstPassword, state.admins[0].password_hash, state.admins[0].salt)).toBe(false);
    expect(state.sessions).toBe(0);
    expect(state.trusted).toBe(0);
  }, 120000);

  it('заданные логин и пароль применяются, а пустой пароль означает «сгенерировать»', () => {
    const first = runCli({ PANEL_USER: 'chosen', PANEL_PASSWORD: 'ChosenPassword-1' });
    const second = runCli({ PANEL_USER: 'renamed', PANEL_PASSWORD: '' }, first.dataDir);

    expect(second.status).toBe(0);
    const state = readAdmins(first.dataDir);
    expect(state.admins).toHaveLength(1);
    expect(state.admins[0].username).toBe('renamed');
    expect(AuthService.verifyPassword('ChosenPassword-1', state.admins[0].password_hash, state.admins[0].salt)).toBe(false);
    expect(second.stdout).toContain('Новый пароль:');
  }, 120000);

  it('слишком короткий заданный пароль отклоняется с кодом 1, администратор не создаётся', () => {
    const password = 'short';
    const result = runCli({ PANEL_USER: 'admin', PANEL_PASSWORD: password });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('не менее 8 символов');
    // Подключение к файлу БД открывает пустой файл, но схема не создаётся и администратора нет
    expect(() => readAdmins(result.dataDir)).toThrow(/no such table/);
  }, 60000);

  it('2FA: без флага остаётся включённой с подсказкой, PANEL_RESET_2FA=1 отключает её (#68)', () => {
    const first = runCli({ PANEL_USER: 'totp_admin', PANEL_PASSWORD: 'LongEnough-Pass1' });
    expect(first.status).toBe(0);
    const enableTotp = () => {
      const db = new DatabaseSync(path.join(first.dataDir, 'dementia.db'));
      try {
        db.prepare("UPDATE admins SET totp_secret = 'enc:secret', totp_enabled = 1, recovery_codes = '[\"hash\"]'").run();
      } finally {
        db.close();
      }
    };
    const totpState = () => {
      const db = new DatabaseSync(path.join(first.dataDir, 'dementia.db'));
      try {
        return db.prepare('SELECT totp_secret, totp_enabled, recovery_codes FROM admins').get();
      } finally {
        db.close();
      }
    };

    enableTotp();
    const keep = runCli({ PANEL_PASSWORD: 'LongEnough-Pass2' }, first.dataDir);
    expect(keep.status).toBe(0);
    expect(keep.stdout).toContain('PANEL_RESET_2FA=1');
    expect(totpState()).toMatchObject({ totp_enabled: 1 });

    const reset = runCli({ PANEL_PASSWORD: 'LongEnough-Pass3', PANEL_RESET_2FA: '1' }, first.dataDir);
    expect(reset.status).toBe(0);
    expect(reset.stdout).toContain('Двухфакторная аутентификация отключена');
    expect(totpState()).toEqual({ totp_secret: null, totp_enabled: 0, recovery_codes: null });
  }, 120000);
});
