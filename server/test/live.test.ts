import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PANEL_PASSWORD, PANEL_USER, startPanel, type PanelProcess } from './helpers/panel-process.js';

/**
 * Живое обновление интерфейса (services/live.service.ts): WebSocket администратора получает {type: 'changed'} после успешной
 * записи через API, но не после чтения и не после ошибки; сокет закрывается вместе с сессией.
 */

let panel: PanelProcess;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  panel = await startPanel();
}, 60000);

afterAll(async () => {
  await panel?.stop();
});

interface Socket {
  ws: WebSocket;
  messages: any[];
  closed: Promise<number>;
}

async function connect(token: string): Promise<Socket> {
  const ws = new WebSocket(`ws://127.0.0.1:${panel.port}/ws`);
  const messages: any[] = [];
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token }));
  for (let i = 0; i < 50 && !messages.some((m) => m.type === 'auth_ok'); i++) await sleep(20);
  expect(messages).toContainEqual({ type: 'auth_ok' });
  messages.length = 0;
  return { ws, messages, closed };
}

const changes = (s: Socket) => s.messages.filter((m) => m.type === 'changed').length;
const createSubscriber = (name: string) => panel.api('/api/subscribers', 'POST', { name, server_ids: [] });

describe('WebSocket: сигнал «данные изменились»', () => {
  it('после успешной записи через API приходит changed, без данных внутри', async () => {
    const socket = await connect(panel.token);
    const created = await createSubscriber('live-1');
    expect(created.status).toBe(201);
    await sleep(600);
    expect(socket.messages).toHaveLength(1);
    expect(socket.messages[0]).toEqual({ type: 'changed', scopes: expect.arrayContaining(['subscribers', 'servers']) });
    expect(Object.keys(socket.messages[0]).sort()).toEqual(['scopes', 'type']);
    socket.ws.close();
  });

  it('чтение и неудачная запись не рассылают сигнал', async () => {
    const socket = await connect(panel.token);
    expect((await panel.api('/api/servers')).status).toBe(200);
    expect((await panel.api('/api/subscribers', 'POST', { name: '' })).status).toBeGreaterThanOrEqual(400);
    await sleep(700);
    expect(changes(socket)).toBe(0);
    socket.ws.close();
  });

  it('частые записи сливаются в несколько сообщений, а не по одному на запрос', async () => {
    const socket = await connect(panel.token);
    await Promise.all(Array.from({ length: 6 }, (_, i) => createSubscriber(`burst-${i}`)));
    await sleep(900);
    expect(changes(socket)).toBeGreaterThanOrEqual(1);
    expect(changes(socket)).toBeLessThan(6);
    socket.ws.close();
  });

  it('сокет закрывается с кодом 4401, когда сессия администратора завершена', async () => {
    const login = await panel.request({ path: '/api/auth/login', method: 'POST', body: { username: PANEL_USER, password: PANEL_PASSWORD } });
    const second = JSON.parse(login.body).token as string;
    const socket = await connect(second);
    const out = await panel.request({ path: '/api/auth/logout', method: 'POST', headers: { Authorization: `Bearer ${second}` } });
    expect(out.status).toBeLessThan(300);
    expect(await Promise.race([socket.closed, sleep(3000).then(() => -1)])).toBe(4401);
  });

  it('другие сессии остаются подписанными, когда одна из них завершена', async () => {
    const socket = await connect(panel.token);
    const login = await panel.request({ path: '/api/auth/login', method: 'POST', body: { username: PANEL_USER, password: PANEL_PASSWORD } });
    const other = JSON.parse(login.body).token as string;
    await panel.request({ path: '/api/auth/logout', method: 'POST', headers: { Authorization: `Bearer ${other}` } });
    await sleep(600);
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    expect(changes(socket)).toBeGreaterThanOrEqual(1);
    socket.ws.close();
  });
});
