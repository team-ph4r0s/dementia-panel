import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase, setSetting } from '../src/db/index.js';
import { isEncrypted } from '../src/services/secrets.service.js';
import { ProviderService } from '../src/services/provider.service.js';
import { daysBetween, isoDate, nextDueDate, reminderText } from '../src/utils/providers.js';
import { createAdminApi } from './helpers/api.js';
import { startTestServer, TestEnv } from './test-app.js';

let env: TestEnv;
let admin: ReturnType<typeof createAdminApi>;
let nodeId: number;

const utc = (s: string) => new Date(`${s}Z`);

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  admin = createAdminApi(env, 'providersadmin');
  const server = await admin.api('/api/servers', 'POST', { name: 'Нода Хельсинки', host: '192.0.2.50', ssh_password: 'secret' });
  expect(server.status).toBe(201);
  nodeId = server.body.id ?? server.body.server?.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.exec('DELETE FROM provider_accounts; DELETE FROM provider_reminders');
  for (const key of ['telegram_bot_token', 'telegram_chat_id', 'telegram_enabled', 'providers_remind_days', 'providers_remind_hour', 'providers_remind_enabled', 'migration_state', 'migration_expires_at']) {
    setSetting(key, null);
  }
});

/** Подменяет только запросы к Telegram: тестовое приложение запрашивается тем же fetch */
function stubTelegram(handler: (url: string, init: any) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch;
  const mock = vi.fn(handler as any);
  vi.stubGlobal('fetch', (input: any, init: any) => (String(input).startsWith('https://api.telegram.org/') ? mock(String(input), init) : realFetch(input, init)));
  return mock;
}

function enableTelegram() {
  setSetting('telegram_enabled', '1');
  setSetting('telegram_chat_id', '123456');
  // токен хранится зашифрованным, поэтому сохраняем его тем же сервисом
  return import('../src/services/telegram.service.js').then(({ TelegramService }) => {
    TelegramService.saveSettings({ enabled: true, chat_id: '123456', bot_token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh', notify_info: false });
  });
}

describe('дата ближайшего платежа', () => {
  it('ежемесячный платёж: сегодня, позже в месяце и уже прошедший', () => {
    expect(isoDate(nextDueDate(utc('2026-11-10T10:00:00'), 10, null))).toBe('2026-11-10');
    expect(isoDate(nextDueDate(utc('2026-11-10T10:00:00'), 15, null))).toBe('2026-11-15');
    expect(isoDate(nextDueDate(utc('2026-11-10T10:00:00'), 5, null))).toBe('2026-12-05');
    expect(isoDate(nextDueDate(utc('2026-12-20T10:00:00'), 5, null))).toBe('2027-01-05');
  });

  it('31-е число в коротком месяце переносится на последний день месяца', () => {
    expect(isoDate(nextDueDate(utc('2027-02-01T00:00:00'), 31, null))).toBe('2027-02-28');
    expect(isoDate(nextDueDate(utc('2028-02-01T00:00:00'), 31, null))).toBe('2028-02-29');
  });

  it('с месяцем платёж ежегодный (день/месяц)', () => {
    expect(isoDate(nextDueDate(utc('2026-11-10T00:00:00'), 15, 3))).toBe('2027-03-15');
    expect(isoDate(nextDueDate(utc('2026-01-10T00:00:00'), 15, 3))).toBe('2026-03-15');
    expect(daysBetween(utc('2026-11-14T22:00:00'), utc('2026-11-15T00:00:00'))).toBe(1);
  });

  it('текст напоминания не содержит логина и пароля', () => {
    const text = reminderText({ name: 'Хельсинки', host: '192.0.2.50', daysLeft: 1, due: utc('2026-11-15T00:00:00'), amount: 500, currency: 'RUB', url: 'https://cabinet.example/' });
    expect(text).toContain('Завтра (15.11)');
    expect(text).toContain('500 ₽');
    expect(text).toContain('https://cabinet.example/');
  });
});

describe('API провайдеров', () => {
  it('список содержит панель и ноду; пароль хранится зашифрованным и не отдаётся в списке', async () => {
    const before = await admin.api('/api/providers');
    expect(before.status).toBe(200);
    expect(before.body.items.map((i: any) => `${i.target_type}:${i.target_id}`)).toEqual(['panel:0', `node:${nodeId}`]);

    const saved = await admin.api(`/api/providers/node/${nodeId}`, 'PUT', {
      url: 'https://cabinet.example/login', login: 'user@example.com', password: 'S3cret-пароль', amount: '499,5', currency: 'EUR', pay_day: 15, pay_month: 3,
    });
    expect(saved.status).toBe(200);
    const item = saved.body.items.find((i: any) => i.target_type === 'node');
    expect(item).toMatchObject({ login: 'user@example.com', password_saved: true, amount: 499.5, currency: 'EUR', pay_day: 15, pay_month: 3 });
    expect(JSON.stringify(saved.body)).not.toContain('S3cret');

    const raw = db.prepare("SELECT password FROM provider_accounts WHERE target_type = 'node'").get() as { password: string };
    expect(isEncrypted(raw.password)).toBe(true);
    expect(raw.password).not.toContain('S3cret');

    const revealed = await admin.api(`/api/providers/node/${nodeId}/password`);
    expect(revealed.body.password).toBe('S3cret-пароль');
  });

  it('пароль без поля password не меняется, пустая строка его стирает', async () => {
    await admin.api(`/api/providers/panel/0`, 'PUT', { login: 'a', password: 'p1' });
    await admin.api(`/api/providers/panel/0`, 'PUT', { login: 'b' });
    expect((await admin.api('/api/providers/panel/0/password')).body.password).toBe('p1');
    await admin.api(`/api/providers/panel/0`, 'PUT', { login: 'b', password: '' });
    expect((await admin.api('/api/providers/panel/0/password')).status).toBe(404);
  });

  it('проверяет данные: ссылка только http(s), день 1–31, месяц без дня запрещён, чужой сервер — 404', async () => {
    expect((await admin.api('/api/providers/panel/0', 'PUT', { url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await admin.api('/api/providers/panel/0', 'PUT', { pay_day: 32 })).status).toBe(400);
    expect((await admin.api('/api/providers/panel/0', 'PUT', { pay_month: 3 })).status).toBe(400);
    expect((await admin.api('/api/providers/panel/0', 'PUT', { amount: -1 })).status).toBe(400);
    expect((await admin.api('/api/providers/node/99999', 'PUT', { login: 'x' })).status).toBe(404);
    expect((await admin.api('/api/providers/other/1', 'PUT', { login: 'x' })).status).toBe(404);
  });

  it('пустая форма удаляет запись, гость и неавторизованный доступа не имеют', async () => {
    await admin.api('/api/providers/panel/0', 'PUT', { login: 'a' });
    await admin.api('/api/providers/panel/0', 'PUT', {});
    expect((db.prepare('SELECT COUNT(*) AS c FROM provider_accounts').get() as { c: number }).c).toBe(0);
    expect((await env.request('/api/providers')).status).toBe(401);
  });

  it('настройки напоминаний проверяются и сохраняются', async () => {
    expect((await admin.api('/api/providers/settings', 'PUT', { remind_enabled: true, remind_days: [], remind_hour: 6 })).status).toBe(400);
    expect((await admin.api('/api/providers/settings', 'PUT', { remind_enabled: true, remind_days: [99], remind_hour: 6 })).status).toBe(400);
    expect((await admin.api('/api/providers/settings', 'PUT', { remind_enabled: true, remind_days: [1, 0], remind_hour: 25 })).status).toBe(400);
    const ok = await admin.api('/api/providers/settings', 'PUT', { remind_enabled: true, remind_days: [0, 3, 1], remind_hour: 8 });
    expect(ok.body.settings).toEqual({ remind_enabled: true, remind_days: [3, 1, 0], remind_hour: 8 });
  });
});

describe('напоминания в Telegram', () => {
  it('шлёт накануне и в день платежа один раз, после часа напоминания', async () => {
    await enableTelegram();
    const fetchMock = stubTelegram(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await admin.api(`/api/providers/node/${nodeId}`, 'PUT', { url: 'https://cabinet.example/', login: 'u', password: 'topsecret', amount: 500, pay_day: 15 });

    // до настроенного часа (06:00 UTC) — тишина
    expect(await ProviderService.tick(utc('2026-11-14T05:00:00'))).toBe(0);
    // за 2 дня — не напоминаем
    expect(await ProviderService.tick(utc('2026-11-13T07:00:00'))).toBe(0);
    // накануне
    expect(await ProviderService.tick(utc('2026-11-14T07:00:00'))).toBe(1);
    // повторный запуск в тот же день не дублирует
    expect(await ProviderService.tick(utc('2026-11-14T12:00:00'))).toBe(0);
    // в день платежа
    expect(await ProviderService.tick(utc('2026-11-15T06:30:00'))).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const bodies = fetchMock.mock.calls.map((c: any) => JSON.parse(c[1].body).text as string);
    expect(bodies[0]).toContain('Завтра (15.11)');
    expect(bodies[1]).toContain('Сегодня (15.11)');
    expect(bodies[0]).toContain('Нода Хельсинки');
    expect(bodies.join('\n')).not.toContain('topsecret');
    expect(bodies.join('\n')).not.toContain('login');

    // платёж ежемесячный: следующее напоминание — в декабре
    expect(await ProviderService.tick(utc('2026-12-14T07:00:00'))).toBe(1);
  });

  it('если Telegram не принял сообщение, напоминание повторится при следующем запуске', async () => {
    await enableTelegram();
    let fail = true;
    stubTelegram(async () => (fail
      ? new Response(JSON.stringify({ ok: false, description: 'boom' }), { status: 500 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await admin.api(`/api/providers/panel/0`, 'PUT', { pay_day: 15 });
    expect(await ProviderService.tick(utc('2026-11-14T07:00:00'))).toBe(0);
    fail = false;
    expect(await ProviderService.tick(utc('2026-11-14T07:15:00'))).toBe(1);
  });

  it('ничего не шлёт, если напоминания или Telegram выключены, и учитывает свои дни', async () => {
    const fetchMock = stubTelegram(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await admin.api(`/api/providers/panel/0`, 'PUT', { pay_day: 15 });
    expect(await ProviderService.tick(utc('2026-11-14T07:00:00'))).toBe(0); // Telegram не настроен

    await enableTelegram();
    ProviderService.saveSettings({ remind_enabled: false, remind_days: [1, 0], remind_hour: 6 });
    expect(await ProviderService.tick(utc('2026-11-14T07:00:00'))).toBe(0);

    ProviderService.saveSettings({ remind_enabled: true, remind_days: [3], remind_hour: 6 });
    expect(await ProviderService.tick(utc('2026-11-14T07:00:00'))).toBe(0);
    expect(await ProviderService.tick(utc('2026-11-12T07:00:00'))).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('смена даты платежа сбрасывает отметки об отправленных напоминаниях', async () => {
    await enableTelegram();
    stubTelegram(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await admin.api(`/api/providers/panel/0`, 'PUT', { pay_day: 15 });
    expect(await ProviderService.tick(utc('2026-11-14T07:00:00'))).toBe(1);
    await admin.api(`/api/providers/panel/0`, 'PUT', { pay_day: 15, amount: 100 });
    expect(await ProviderService.tick(utc('2026-11-14T08:00:00'))).toBe(1);
  });
});
