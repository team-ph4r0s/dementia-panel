import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PANEL_PASSWORD, PANEL_USER, startPanel, type PanelProcess, type Reply, type RequestOptions } from './helpers/panel-process.js';

/**
 * Настоящий процесс панели (src/index.ts): HTTP и HTTPS на одном порту, редирект, WebSocket с авторизацией первым
 * сообщением, устойчивость к мусору в сокете. Проверяет то, что не видно в тестах отдельных роутеров.
 */

const USER = PANEL_USER;
const PASSWORD = PANEL_PASSWORD;

let panel: PanelProcess;
let child: ChildProcess;
let port: number;
let token = '';
let partnerToken = '';

const request = (options: RequestOptions) => panel.request(options);
const json = (reply: Reply) => JSON.parse(reply.body);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  panel = await startPanel();
  child = panel.child;
  port = panel.port;
  token = panel.token;
}, 60000);

afterAll(async () => {
  await panel?.stop();
});

const healthy = async () => (await request({ path: '/api/health' })).status === 200 || (await request({ path: '/api/health', tls: true }).catch(() => ({ status: 0 }))).status === 200;

describe('HTTP: заголовки и ошибки', () => {
  it('health, заголовки безопасности, JSON-ответы для неизвестных маршрутов и ошибок', async () => {
    const health = await request({ path: '/api/health' });
    expect(health.status).toBe(200);
    expect(json(health)).toMatchObject({ status: 'ok', https: false });
    expect(health.headers['content-security-policy']).toContain("script-src 'self'");
    expect(health.headers['x-frame-options']).toBe('DENY');
    expect(health.headers['x-powered-by']).toBeUndefined();
    expect(health.headers['strict-transport-security']).toBeUndefined();

    expect(json(await request({ path: '/api/nothing', authed: true }))).toEqual({ error: 'Метод API не найден' });
    expect((await request({ path: '/api/servers' })).status).toBe(401);
    expect((await request({ path: '/api/servers/%', authed: true })).status).toBe(400);
    const broken = await request({ path: '/api/subscribers', method: 'POST', authed: true, headers: { 'Content-Type': 'application/json' }, body: undefined });
    expect(broken.status).toBeLessThan(500);
  });

  it('некорректный JSON — 400, слишком большое тело — 413, а не падение', async () => {
    const raw = (body: string) =>
      new Promise<Reply>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
          (res) => {
            let text = '';
            res.on('data', (chunk) => (text += chunk));
            res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
          }
        );
        req.once('error', reject);
        req.end(body);
      });
    expect((await raw('{')).status).toBe(400);
    expect((await raw(JSON.stringify({ username: 'x'.repeat(2_000_000), password: 'y' }))).status).toBe(413);
    expect(await healthy()).toBe(true);
  });

  it('первый запуск с PANEL_PASSWORD не выводит пароль в журнал', () => {
    expect(panel.output()).not.toContain(PASSWORD);
    expect(panel.output()).toContain(`Создан администратор "${USER}"`);
  });
});

describe('WebSocket /ws: авторизация первым сообщением', () => {
  const open = (url = `ws://127.0.0.1:${port}/ws`) =>
    new Promise<{ ws: WebSocket; messages: any[] }>((resolve, reject) => {
      const ws = new WebSocket(url);
      const messages: any[] = [];
      ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
      ws.once('open', () => resolve({ ws, messages }));
      ws.once('error', reject);
    });
  const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  const waitFor = async (messages: any[], predicate: (m: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const found = messages.find(predicate);
      if (found) return found;
      await sleep(30);
    }
    throw new Error(`Сообщение не получено: ${JSON.stringify(messages)}`);
  };

  it('команда без авторизации отклоняется, соединение закрывается (4401)', async () => {
    const { ws, messages } = await open();
    const close = closed(ws);
    ws.send(JSON.stringify({ type: 'start_install', serverId: 1 }));
    expect(await close).toBe(4401);
    expect(messages[0]).toEqual({ type: 'error', message: 'Необходима авторизация' });
  });

  it('неверный токен закрывает соединение, мусор вместо JSON — сообщение об ошибке', async () => {
    const { ws, messages } = await open();
    ws.send('это не JSON');
    expect(await waitFor(messages, (m) => m.type === 'error')).toEqual({ type: 'error', message: 'Некорректное сообщение' });
    const close = closed(ws);
    ws.send(JSON.stringify({ type: 'auth', token: 'f'.repeat(64) }));
    expect(await close).toBe(4401);
  });

  it('после авторизации выполняет команды; для несуществующего сервера возвращает ошибку, нечисловой id игнорируется', async () => {
    const { ws, messages } = await open();
    ws.send(JSON.stringify({ type: 'auth', token }));
    await waitFor(messages, (m) => m.type === 'auth_ok');

    ws.send(JSON.stringify({ type: 'start_install', serverId: '1' }));
    ws.send(JSON.stringify({ type: 'start_install', serverId: 999999 }));
    const error = await waitFor(messages, (m) => m.type === 'error');
    expect(error.message).toContain('Сервер #999999 не найден');
    expect(messages.filter((m) => m.type === 'log' && m.data.includes("'1'"))).toHaveLength(0);
    ws.close();
  });

  it('после выхода сокет этой сессии закрывается и не может запустить установку', async () => {
    const loginReply = await request({ path: '/api/auth/login', method: 'POST', body: { username: USER, password: PASSWORD } });
    const sessionToken = json(loginReply).token as string;
    const { ws, messages } = await open();
    ws.send(JSON.stringify({ type: 'auth', token: sessionToken }));
    await waitFor(messages, (m) => m.type === 'auth_ok');

    const close = closed(ws);
    const logout = await request({ path: '/api/auth/logout', method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` } });
    expect(logout.status).toBe(200);
    // Команда сразу после выхода — раньше она ещё проходила по сохранённой при входе сессии
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'start_install', serverId: 999999 }));
    expect(await close).toBe(4401);
    expect(messages.some((m) => m.type === 'log' || (m.type === 'error' && String(m.message).includes('не найден')))).toBe(false);
  });

  it('другой путь, слишком большое сообщение и битый фрейм не роняют процесс', async () => {
    await expect(open(`ws://127.0.0.1:${port}/socket`)).rejects.toThrow();

    const { ws } = await open();
    const close = closed(ws);
    ws.send('x'.repeat(70 * 1024)); // больше maxPayload (64 КБ)
    expect(await close).toBe(1009);

    // Немаскированный фрейм клиента — ошибка протокола, раньше она роняла процесс
    await new Promise<void>((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.write(
          `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      socket.once('data', () => {
        socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 200);
      });
      socket.on('error', () => resolve());
    });
    expect(await healthy()).toBe(true);
    expect(child.exitCode).toBeNull();
  });

  it('мусор в сыром сокете и оборванные запросы не влияют на работу', async () => {
    for (const junk of [Buffer.from('GARBAGE\r\n\r\n'), Buffer.from([0x16, 0x03, 0x01, 0x00]), Buffer.alloc(2048, 0xff), Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n')]) {
      await new Promise<void>((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
          socket.write(junk);
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 100);
        });
        socket.on('error', () => resolve());
      });
    }
    expect(await healthy()).toBe(true);
    expect(child.exitCode).toBeNull();
  });
});

describe('партнёрский API только по HTTPS (инвариант 8)', () => {
  it('по HTTP токен партнёра не принимается даже верный', async () => {
    const created = await request({ path: '/api/partners', method: 'POST', authed: true, body: { name: 'process-partner' } });
    expect(created.status).toBe(201);
    partnerToken = json(created).token as string;
    const reply = await request({ path: '/api/federation/v1/info', headers: { Authorization: `Bearer ${partnerToken}` } });
    expect(reply.status).toBe(403);
    expect(json(reply).error).toContain('HTTPS');
  });
});

describe('HTTP и HTTPS на одном порту', () => {
  let firstFingerprint: string;

  it('самоподписанный сертификат включает HTTPS без перезапуска; тот же порт отвечает по TLS', async () => {
    const issued = await request({ path: '/api/security/ssl/issue-ip', method: 'POST', authed: true, body: { ip: '127.0.0.1' } });
    expect(json(issued)).toEqual({ success: true });
    await sleep(200);

    const secure = await request({ path: '/api/health', tls: true });
    expect(secure.status).toBe(200);
    expect(json(secure).https).toBe(true);
    expect(secure.headers['strict-transport-security']).toContain('max-age=');
    firstFingerprint = secure.certFingerprint!;
    expect(firstFingerprint).toBeTruthy();
  }, 30000);

  it('обычный HTTP: страницы перенаправляются на домен сертификата, API закрыт, подписки и ACME доступны', async () => {
    const redirect = await request({ path: '/some/page?x=1' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe(`https://127.0.0.1:${port}/some/page?x=1`);

    // Заголовок Host подделать можно — на редирект он не влияет
    const spoofed = await request({ path: '/', headers: { Host: 'attacker.example' } });
    expect(spoofed.headers.location).toBe('https://127.0.0.1/');

    const api = await request({ path: '/api/servers', authed: true });
    expect(api.status).toBe(403);
    expect(json(api)).toMatchObject({ https: true });

    // Проверка запуска по HTTP работает и при включённом HTTPS: иначе install.sh принимал бы обновление такой панели за сбой
    const health = await request({ path: '/api/health' });
    expect(health.status).toBe(200);
    expect(json(health)).toMatchObject({ status: 'ok', https: true });

    // Ссылки подписки, выданные по HTTP, продолжают работать (инвариант 20)
    const sub = await request({ path: '/sub/sub_unknown' });
    expect(sub.status).toBe(404);
    expect(sub.body).toBe('Subscription not found');
    const acme = await request({ path: '/.well-known/acme-challenge/unknown-token' });
    expect(acme.status).toBe(404);
    expect(acme.body).toBe('Challenge not found');
  });

  it('партнёрский API по HTTPS принимает токен без ALLOW_INSECURE_FEDERATION', async () => {
    const reply = await request({ path: '/api/federation/v1/info', tls: true, headers: { Authorization: `Bearer ${partnerToken}` } });
    expect(reply.status).toBe(200);
    expect(json(reply)).toMatchObject({ api_version: 1, partner_name: 'process-partner' });
  });

  it('WebSocket: по HTTP отклоняется, по wss работает', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.once('open', () => resolve('open'));
        ws.once('error', reject);
      })
    ).rejects.toThrow();

    const messages: any[] = [];
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false });
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'auth', token }));
    for (let i = 0; i < 50 && messages.length === 0; i++) await sleep(30);
    expect(messages[0]).toEqual({ type: 'auth_ok' });
    ws.close();
  });

  it('новый сертификат подхватывается без перезапуска', async () => {
    const issued = await request({ path: '/api/security/ssl/issue-ip', method: 'POST', tls: true, authed: true, body: { ip: '127.0.0.1' } });
    expect(issued.status).toBe(200);
    await sleep(200);
    const secure = await request({ path: '/api/health', tls: true });
    expect(secure.certFingerprint).not.toBe(firstFingerprint);
  }, 30000);

  it('отключение HTTPS возвращает обычный HTTP без перезапуска', async () => {
    const toggled = await request({ path: '/api/security/ssl/toggle', method: 'POST', tls: true, authed: true, body: { enabled: false } });
    expect(json(toggled)).toEqual({ success: true, enabled: false });
    const plain = await request({ path: '/api/health' });
    expect(plain.status).toBe(200);
    expect(json(plain).https).toBe(false);
    expect(child.exitCode).toBeNull();
  });
});
