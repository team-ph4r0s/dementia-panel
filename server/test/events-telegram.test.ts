import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, getSetting, initDatabase, setSetting } from '../src/db/index.js';
import { EventService } from '../src/services/event.service.js';
import { TelegramService } from '../src/services/telegram.service.js';
import { isEncrypted } from '../src/services/secrets.service.js';
import { createAdminApi } from './helpers/api.js';
import { startTestServer, TestEnv } from './test-app.js';

let env: TestEnv;
let admin: ReturnType<typeof createAdminApi>;

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  admin = createAdminApi(env, 'eventsadmin');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.exec('DELETE FROM events');
  for (const key of ['telegram_bot_token', 'telegram_chat_id', 'telegram_enabled', 'telegram_notify_info', 'migration_state', 'migration_expires_at']) {
    setSetting(key, null);
  }
});

describe('журнал событий', () => {
  it('фильтрует события по уровню и возвращает общее число', async () => {
    EventService.log('info', 'test.info', 'Информация');
    EventService.log('error', 'test.error', 'Ошибка', { kind: 'server', id: 7 });

    const result = EventService.list({ level: 'error', limit: 20, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ level: 'error', type: 'test.error', message: 'Ошибка', entity_kind: 'server', entity_id: '7' });

    const response = await admin.api('/api/events?level=error&limit=20&offset=0');
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items[0].message).toBe('Ошибка');
  });

  it('ограничивает журнал последними 5000 записями через prune и автоматически при частых вставках', () => {
    const insert = db.prepare("INSERT INTO events(level, type, message) VALUES ('info', 'test.bulk', 'bulk')");
    db.exec('BEGIN');
    for (let i = 0; i < 5005; i++) insert.run();
    db.exec('COMMIT');

    EventService.log('info', 'test.last', 'Последнее событие');
    EventService.prune();
    const count = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
    expect(count).toBe(5000);
    expect(EventService.list({ limit: 1, offset: 0 }).items[0].type).toBe('test.last');

    for (let i = 0; i < EventService.PRUNE_EVERY; i++) {
      EventService.log('info', 'test.auto', `Auto ${i}`);
    }
    const countAfterBatch = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
    expect(countAfterBatch).toBe(5000);
  });

  it('записывает входы и основные действия администратора', async () => {
    const failed = await env.request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'eventsadmin', password: 'wrong' }),
    });
    expect(failed.status).toBe(401);
    const loggedIn = await env.request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'eventsadmin', password: 'TestPassword123!' }),
    });
    expect(loggedIn.status).toBe(200);

    const server = await admin.api('/api/servers', 'POST', { name: 'События', host: '192.0.2.10', ssh_password: 'secret' });
    expect(server.status).toBe(201);
    const subscriber = await admin.api('/api/subscribers', 'POST', { name: 'Пользователь', server_ids: [] });
    expect(subscriber.status).toBe(201);
    await admin.api(`/api/subscribers/${subscriber.body.id}/reset-traffic`, 'POST');
    await admin.api(`/api/subscribers/${subscriber.body.id}`, 'DELETE');
    await admin.api(`/api/servers/${server.body.id}`, 'DELETE');

    const types = EventService.list({ limit: 100, offset: 0 }).items.map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining([
      'auth.login_failed', 'auth.login', 'server.created', 'server.deleted',
      'subscriber.created', 'subscriber.traffic_reset', 'subscriber.deleted',
    ]));
  });
});

describe('Telegram', () => {
  it('хранит токен зашифрованным и не отдаёт его через API', async () => {
    const saved = await admin.api('/api/telegram', 'PUT', {
      enabled: true,
      chat_id: '-1001234567890',
      bot_token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345',
      notify_info: true,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({ enabled: true, chat_id: '-1001234567890', bot_token_saved: true, notify_info: true });
    expect(JSON.stringify(saved.body)).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(isEncrypted(getSetting('telegram_bot_token'))).toBe(true);

    const fetched = await admin.api('/api/telegram');
    expect(fetched.body.settings.bot_token_saved).toBe(true);
    expect(fetched.body.settings).not.toHaveProperty('bot_token');
  });

  it('отправляет текст события в Telegram без HTML-разметки', async () => {
    setSetting('telegram_bot_token', '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345');
    setSetting('telegram_chat_id', '12345');
    setSetting('telegram_enabled', '1');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await TelegramService.deliverEvent({ level: 'error', type: 'server.offline', message: 'Нода <недоступна>' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345/sendMessage');
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({ chat_id: '12345', disable_web_page_preview: true });
    expect(body.text).toContain('Нода <недоступна>');
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('не падает при ошибке сети и не отправляет события во время переноса', async () => {
    setSetting('telegram_bot_token', '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345');
    setSetting('telegram_chat_id', '12345');
    setSetting('telegram_enabled', '1');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(TelegramService.deliverEvent({ level: 'error', type: 'test', message: 'Ошибка' })).resolves.toBeUndefined();

    setSetting('migration_state', 'exporting');
    setSetting('migration_expires_at', new Date(Date.now() + 60000).toISOString());
    await TelegramService.deliverEvent({ level: 'error', type: 'test', message: 'Не отправлять' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('нормализует токен с префиксом bot и ссылку, а также ID чата с пробелами', async () => {
    const saved = await admin.api('/api/telegram', 'PUT', {
      enabled: true,
      chat_id: '  id: 123 456 789  ',
      bot_token: 'bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345',
      notify_info: false,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.chat_id).toBe('123456789');

    const savedChannel = await admin.api('/api/telegram', 'PUT', {
      enabled: true,
      chat_id: '@my_super_channel',
      bot_token: 'https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345/sendMessage',
      notify_info: false,
    });
    expect(savedChannel.status).toBe(200);
    expect(savedChannel.body.settings.chat_id).toBe('@my_super_channel');
  });

  it('позволяет протестировать ещё не сохранённые параметры через POST /api/telegram/test', async () => {
    const realFetch = globalThis.fetch;
    const telegramMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', vi.fn((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('api.telegram.org')) return telegramMock(input, init);
      return realFetch(input, init);
    }));

    const res = await admin.api('/api/telegram/test', 'POST', {
      bot_token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345',
      chat_id: '999888777',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Тестовое сообщение отправлено' });
    expect(telegramMock).toHaveBeenCalledOnce();
    const [url, options] = telegramMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345/sendMessage');
    expect(JSON.parse(options.body).chat_id).toBe('999888777');
  });

  it('возвращает понятную подсказку о команде /start при ошибке chat not found', async () => {
    const realFetch = globalThis.fetch;
    const telegramMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found',
    }), { status: 400 }));
    vi.stubGlobal('fetch', vi.fn((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('api.telegram.org')) return telegramMock(input, init);
      return realFetch(input, init);
    }));

    const res = await admin.api('/api/telegram/test', 'POST', {
      bot_token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345',
      chat_id: '999888777',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('/start');
  });

  it('определяет ID чата через getUpdates в detect-chat', async () => {
    const realFetch = globalThis.fetch;
    const telegramMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: [
        {
          update_id: 100,
          message: {
            message_id: 1,
            from: { id: 777123, username: 'admin' },
            chat: { id: 777123, username: 'admin', first_name: 'Admin' },
            text: '/start',
          },
        },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', vi.fn((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (url.includes('api.telegram.org')) return telegramMock(input, init);
      return realFetch(input, init);
    }));

    const res = await admin.api('/api/telegram/detect-chat', 'POST', {
      bot_token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      chat_id: '777123',
    });
  });
});
