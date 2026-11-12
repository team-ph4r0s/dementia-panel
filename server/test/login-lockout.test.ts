import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../src/db/index.js';
import { authRouter } from '../src/routes/auth.js';
import { AuthService } from '../src/services/auth.service.js';
import { loginIpLimiter, loginUserLimiter } from '../src/middleware/rate-limit.js';
import { jsonBody } from '../src/middleware/json-body.js';

/**
 * GHSA-2mp9: блокировка по логину не должна закрывать вход самому администратору.
 * Адреса клиентов задаются через X-Forwarded-For (trust proxy включён только в этом тестовом приложении).
 */

let server: http.Server;
let baseUrl: string;

const ADMIN = { username: 'admin', password: 'CorrectHorse-123' };
const ATTACKER_IPS = ['203.0.113.1', '203.0.113.2', '203.0.113.3'];
const ADMIN_IP = '198.51.100.7';

async function login(ip: string, password: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ username: ADMIN.username, password }),
  });
  return res.status;
}

beforeAll(async () => {
  initDatabase();
  AuthService.resetAdmin(ADMIN.username, ADMIN.password);
  const app = express();
  app.set('trust proxy', true);
  app.use(jsonBody);
  app.use('/api/auth', authRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  for (const ip of [...ATTACKER_IPS, ADMIN_IP]) loginIpLimiter.reset(ip);
  loginUserLimiter.reset(ADMIN.username);
});

/** 10 неверных паролей с нескольких адресов (по 5 на адрес — лимит одного IP) */
async function floodWrongPasswords() {
  for (let i = 0; i < 10; i++) expect(await login(ATTACKER_IPS[i % 2], 'wrong-password')).toBe(401);
}

describe('блокировка входа по логину', () => {
  it('закрывает вход с неизвестных адресов после 10 неудач (защита от распределённого перебора)', async () => {
    await floodWrongPasswords();
    expect(await login(ATTACKER_IPS[2], ADMIN.password)).toBe(429);
  });

  it('не мешает администратору входить с адреса, откуда он уже входил', async () => {
    expect(await login(ADMIN_IP, ADMIN.password)).toBe(200);
    expect(AuthService.isKnownLoginIp(ADMIN_IP)).toBe(true);

    await floodWrongPasswords();
    expect(await login(ADMIN_IP, ADMIN.password)).toBe(200);
  });

  it('на известный адрес по-прежнему действует лимит неудачных попыток с одного IP', async () => {
    expect(await login(ADMIN_IP, ADMIN.password)).toBe(200);
    for (let i = 0; i < 5; i++) expect(await login(ADMIN_IP, 'wrong-password')).toBe(401);
    expect(await login(ADMIN_IP, ADMIN.password)).toBe(429);
  });

  it('сброс учётных данных через CLI забывает известные адреса', async () => {
    expect(await login(ADMIN_IP, ADMIN.password)).toBe(200);
    AuthService.resetAdmin(ADMIN.username, ADMIN.password);
    expect(AuthService.isKnownLoginIp(ADMIN_IP)).toBe(false);
  });
});
