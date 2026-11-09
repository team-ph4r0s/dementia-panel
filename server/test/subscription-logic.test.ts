import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { ProvisionService } from '../src/services/provision.service.js';
import { SubscriptionService } from '../src/services/subscription.service.js';
import { updateSubscriptionSettings } from '../src/services/subscription-settings.service.js';
import { createAdminApi } from './helpers/api.js';
import { insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { stubSsh } from './helpers/ssh-stub.js';
import { startTestServer } from './test-app.js';

/**
 * Подписки: приостановка по сроку и лимиту трафика, содержимое публичной ссылки, заголовки (только ASCII),
 * проверка данных пользователей и стабильность ключей при редактировании.
 */

let env: Awaited<ReturnType<typeof startTestServer>>;
let admin: ReturnType<typeof createAdminApi>;

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  admin = createAdminApi(env, 'admin_subscriptions');
});

afterAll(async () => {
  await env.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const subscriptionOf = (id: number) => (db.prepare('SELECT token FROM subscribers WHERE id = ?').get(id) as { token: string }).token;
const DAY = 86_400_000;

describe('приостановка подписчика (SubscriptionService)', () => {
  it('isExpired и isOverLimit', () => {
    expect(SubscriptionService.isExpired({ expire_at: null })).toBe(false);
    expect(SubscriptionService.isExpired({ expire_at: new Date(Date.now() - 1000).toISOString() })).toBe(true);
    expect(SubscriptionService.isExpired({ expire_at: new Date(Date.now() + DAY).toISOString() })).toBe(false);
    const usage = { upload: 400, download: 600, used: 1000 };
    expect(SubscriptionService.isOverLimit({ traffic_limit: 0 }, usage)).toBe(false);
    expect(SubscriptionService.isOverLimit({ traffic_limit: 1001 }, usage)).toBe(false);
    expect(SubscriptionService.isOverLimit({ traffic_limit: 1000 }, usage)).toBe(true);
  });

  it('истёкший срок приостанавливает подписчика и синхронизирует его установленные ноды, продление возобновляет', () => {
    const sync = vi.spyOn(ProvisionService, 'requestSync').mockResolvedValue({ success: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const online = insertServer();
    const uninstalled = insertServer({ status: 'uninstalled' });
    const subscriber = insertSubscriber({ expireAt: new Date(Date.now() + DAY).toISOString() });
    insertClient(online, { subscriberId: subscriber });
    insertClient(uninstalled, { subscriberId: subscriber });

    SubscriptionService.refreshSuspension(subscriber);
    expect(db.prepare('SELECT suspended FROM subscribers WHERE id = ?').get(subscriber)).toEqual({ suspended: 0 });
    expect(sync).not.toHaveBeenCalled();

    db.prepare("UPDATE subscribers SET expire_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(subscriber);
    SubscriptionService.refreshSuspension(subscriber);
    expect(db.prepare('SELECT suspended FROM subscribers WHERE id = ?').get(subscriber)).toEqual({ suspended: 1 });
    expect(sync.mock.calls.map((call) => call[0])).toEqual([online]);

    // Повторный пересчёт без изменений не вызывает лишних синхронизаций
    SubscriptionService.refreshSuspension(subscriber);
    expect(sync).toHaveBeenCalledTimes(1);

    db.prepare('UPDATE subscribers SET expire_at = ? WHERE id = ?').run(new Date(Date.now() + DAY).toISOString(), subscriber);
    SubscriptionService.refreshSuspension(subscriber);
    expect(db.prepare('SELECT suspended FROM subscribers WHERE id = ?').get(subscriber)).toEqual({ suspended: 0 });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('лимит трафика считается по всем клиентам пользователя на всех нодах; сброс трафика возобновляет подписку', async () => {
    vi.spyOn(ProvisionService, 'requestSync').mockResolvedValue({ success: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = insertServer();
    const b = insertServer();
    const subscriber = insertSubscriber({ trafficLimit: 1000 });
    const first = insertClient(a, { subscriberId: subscriber });
    const second = insertClient(b, { subscriberId: subscriber });

    db.prepare('UPDATE clients SET total_rx = 300, total_tx = 300 WHERE id = ?').run(first.id);
    db.prepare('UPDATE clients SET total_rx = 200, total_tx = 100 WHERE id = ?').run(second.id);
    expect(SubscriptionService.getUsage(subscriber)).toEqual({ upload: 500, download: 400, used: 900 });
    SubscriptionService.refreshSuspension();
    expect(db.prepare('SELECT suspended FROM subscribers WHERE id = ?').get(subscriber)).toEqual({ suspended: 0 });

    db.prepare('UPDATE clients SET total_tx = total_tx + 100 WHERE id = ?').run(second.id);
    SubscriptionService.refreshSuspension();
    expect(db.prepare('SELECT suspended FROM subscribers WHERE id = ?').get(subscriber)).toEqual({ suspended: 1 });
    // На ноде клиенты приостановленного подписчика неактивны
    expect(ProvisionService.getServerClients(a).find((c) => c.id === first.id).subscriber_active).toBe(0);

    const reset = await admin.api(`/api/subscribers/${subscriber}/reset-traffic`, 'POST');
    expect(reset.body).toMatchObject({ suspended: false, traffic_used: 0, total_rx: 0, total_tx: 0 });
    expect(ProvisionService.getServerClients(a).find((c) => c.id === first.id).subscriber_active).toBe(1);
  });
});

describe('публичная ссылка подписки', () => {
  async function buildSubscription() {
    stubSsh();
    const kept = insertServer({ name: 'Основной', host: '203.0.113.21' });
    const second = insertServer({ name: 'Второй', host: '203.0.113.22' });
    const hidden = insertServer({ name: 'Не установлен', status: 'uninstalled' });
    db.prepare('UPDATE servers SET sub_name = ?, sub_order = 2 WHERE id = ?').run('🇩🇪 Германия', kept);
    db.prepare('UPDATE servers SET sub_order = 1 WHERE id = ?').run(second);
    const subscriber = insertSubscriber({ name: 'Иван Петров' });
    insertClient(kept, { subscriberId: subscriber, name: 'visible-1' });
    insertClient(second, { subscriberId: subscriber, name: 'visible-2' });
    insertClient(hidden, { subscriberId: subscriber, name: 'on-uninstalled' });
    insertClient(kept, { subscriberId: subscriber, name: 'disabled', enabled: 0 });
    insertClient(kept, { subscriberId: subscriber, name: 'pending', ip: 'pending:abc' });
    insertClient(kept, { subscriberId: subscriber, name: 'imported', external: 1 });
    const blocked = insertClient(second, { subscriberId: subscriber, name: 'blocked' });
    db.prepare("UPDATE clients SET remote_state = 'blocked' WHERE id = ?").run(blocked.id);
    return { subscriber, token: subscriptionOf(subscriber) };
  }

  it('содержит только готовые клиенты установленных нод в порядке сортировки, имена из настроек', async () => {
    const { token } = await buildSubscription();

    const res = await env.request(`/sub/${token}?format=json`);
    const body = await res.json();

    expect(body).toMatchObject({ type: 'amneziawg', version: 1 });
    expect(body.servers.map((s: any) => s.name)).toEqual(['Второй', '🇩🇪 Германия']);
    const configs = body.servers.map((s: any) => Buffer.from(s.config, 'base64url').toString('utf-8'));
    expect(configs[0]).toContain('Endpoint = 203.0.113.22:51820');
    expect(configs[1]).toContain('Endpoint = 203.0.113.21:51820');
    for (const conf of configs) expect(conf).toMatch(/PrivateKey = \S+/);
  });

  it('формат Incy: base64 со ссылками awg://…#имя, имя закодировано', async () => {
    const { token } = await buildSubscription();
    const res = await env.request(`/sub/${token}`);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const links = Buffer.from(await res.text(), 'base64').toString('utf-8').split('\n');
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.startsWith('awg://'))).toBe(true);
    expect(decodeURIComponent(links[1].split('#')[1])).toBe('🇩🇪 Германия');
  });

  it('заголовки: только допустимые символы HTTP, текст в base64, userinfo с трафиком и сроком', async () => {
    const { subscriber, token } = await buildSubscription();
    const expire = new Date(Date.now() + 10 * DAY);
    db.prepare('UPDATE subscribers SET traffic_limit = 5000, expire_at = ? WHERE id = ?').run(expire.toISOString(), subscriber);
    db.prepare('UPDATE clients SET total_rx = 111, total_tx = 222 WHERE subscriber_id = ? AND name = ?').run(subscriber, 'visible-1');
    await admin.api('/api/subscription-settings', 'PUT', { settings: { title: 'VPN {user}', announce: 'Скидка 🎉', description: 'Описание', support_url: 'https://example.com/поддержка' } });

    const res = await env.request(`/sub/${token}`);

    for (const [name, value] of res.headers) {
      expect(value, name).toMatch(/^[\x20-\x7e]*$/);
    }
    expect(res.headers.get('subscription-userinfo')).toBe(`upload=111; download=222; total=5000; expire=${Math.floor(expire.getTime() / 1000)}`);
    expect(Buffer.from(res.headers.get('profile-title')!.replace('base64:', ''), 'base64').toString('utf-8')).toBe('VPN Иван Петров');
    expect(Buffer.from(res.headers.get('announce')!.replace('base64:', ''), 'base64').toString('utf-8')).toBe('Скидка 🎉');
    expect(res.headers.get('support-url')).toBe('https://example.com/%D0%BF%D0%BE%D0%B4%D0%B4%D0%B5%D1%80%D0%B6%D0%BA%D0%B0');
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''%D0%98%D0%B2%D0%B0%D0%BD");
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('приостановленный подписчик получает пустой список, но видит статистику; отключённый — 403; неизвестный токен — 404', async () => {
    const { subscriber, token } = await buildSubscription();
    db.prepare("UPDATE subscribers SET expire_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(subscriber);
    const expired = await env.request(`/sub/${token}?format=json`);
    expect(expired.status).toBe(200);
    expect((await expired.json()).servers).toEqual([]);
    expect(expired.headers.get('subscription-userinfo')).toContain('expire=1577836800');

    db.prepare('UPDATE subscribers SET enabled = 0 WHERE id = ?').run(subscriber);
    expect((await env.request(`/sub/${token}`)).status).toBe(403);
    expect((await env.request('/sub/sub_unknown')).status).toBe(404);
    expect((await env.request(`/sub/${token.toUpperCase()}`)).status).toBe(404);
  });

  it('формат mihomo выбирается по User-Agent и параметру, ответ — YAML (JSON) с прокси на каждый сервер', async () => {
    const { token } = await buildSubscription();
    const byAgent = await env.request(`/sub/${token}`, { headers: { 'User-Agent': 'clash-verge/v2.0' } });
    expect(byAgent.headers.get('content-type')).toContain('text/yaml');
    const config = JSON.parse(await byAgent.text());
    expect(config.proxies.map((p: any) => p.name)).toEqual(['Второй', '🇩🇪 Германия']);
    expect(config.proxies[0]).toMatchObject({ type: 'wireguard', server: '203.0.113.22', 'allowed-ips': ['0.0.0.0/0', '::/0'] });
    // Группа выбора начинается с «Авто» (fallback по порядку подписки); выключается настройкой clash_auto
    expect(config['proxy-groups']).toEqual([
      { name: 'Dementia', type: 'select', proxies: ['Авто', 'Второй', '🇩🇪 Германия'] },
      { name: 'Авто', type: 'fallback', proxies: ['Второй', '🇩🇪 Германия'], url: 'https://www.gstatic.com/generate_204', interval: 300, lazy: true },
    ]);
    updateSubscriptionSettings({ clash_auto: false });
    try {
      const manual = JSON.parse(await (await env.request(`/sub/${token}?format=clash`)).text());
      expect(manual['proxy-groups']).toEqual([{ name: 'Dementia', type: 'select', proxies: ['Второй', '🇩🇪 Германия'] }]);
    } finally {
      updateSubscriptionSettings({ clash_auto: true });
    }

    const byQuery = await env.request(`/sub/${token}?format=mihomo`);
    expect(byQuery.headers.get('content-type')).toContain('text/yaml');
    const incy = await env.request(`/sub/${token}?format=incy`, { headers: { 'User-Agent': 'clash-verge' } });
    expect(incy.headers.get('content-type')).toContain('text/plain');
  });

  it('подписка без нод — пустой список, а mihomo получает прокси DIRECT в группе', async () => {
    const subscriber = insertSubscriber();
    const token = subscriptionOf(subscriber);
    expect((await (await env.request(`/sub/${token}?format=json`)).json()).servers).toEqual([]);
    const clash = JSON.parse(await (await env.request(`/sub/${token}?format=clash`)).text());
    expect(clash.proxies).toEqual([]);
    expect(clash['proxy-groups'][0].proxies).toEqual(['DIRECT']);
  });
});

describe('управление пользователями подписки (админ-API)', () => {
  it.each([
    ['без имени', {}],
    ['имя не строка', { name: 123 }],
    ['слишком длинное имя', { name: 'x'.repeat(65) }],
    ['server_ids не массив', { name: 'a', server_ids: '1' }],
    ['server_ids с нечислом', { name: 'a', server_ids: ['abc'] }],
    ['server_ids с отрицательным', { name: 'a', server_ids: [-1] }],
    ['несуществующий сервер', { name: 'a', server_ids: [999999] }],
    ['отрицательный лимит', { name: 'a', traffic_limit: -1 }],
    ['дробный лимит', { name: 'a', traffic_limit: 1.5 }],
    ['лимит не число', { name: 'a', traffic_limit: 'много' }],
    ['дата не парсится', { name: 'a', expire_at: 'завтра' }],
  ])('создание отклоняет: %s', async (_name, body) => {
    expect((await admin.api('/api/subscribers', 'POST', body)).status).toBe(400);
  });

  it('создание без нод допустимо; лимит и срок сохраняются, список содержит расчётные поля', async () => {
    const expire = new Date(Date.now() + 3 * DAY).toISOString();
    const res = await admin.api('/api/subscribers', 'POST', { name: '  Мария  ', traffic_limit: 12345, expire_at: expire });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Мария', traffic_limit: 12345, expire_at: expire, expired: false, suspended: false, peer_count: 0, server_ids: [] });
    expect(res.body.token).toMatch(/^sub_[0-9a-f]{32}$/);
  });

  it('редактирование состава нод не пересоздаёт ключи существующих клиентов', async () => {
    stubSsh();
    const a = insertServer();
    const b = insertServer();
    const created = await admin.api('/api/subscribers', 'POST', { name: 'Стабильные ключи', server_ids: [a] });
    const keyOnA = () => (db.prepare('SELECT client_public_key FROM clients WHERE subscriber_id = ? AND server_id = ?').get(created.body.id, a) as any)?.client_public_key;
    const original = keyOnA();

    // Идентификаторы строками, как могут прийти из формы: состав тот же, ключи прежние
    expect((await admin.api(`/api/subscribers/${created.body.id}`, 'PUT', { server_ids: [String(a)] })).status).toBe(200);
    expect(keyOnA()).toBe(original);

    const added = await admin.api(`/api/subscribers/${created.body.id}`, 'PUT', { server_ids: [a, b] });
    expect(added.body.peer_count).toBe(2);
    expect(keyOnA()).toBe(original);

    const removed = await admin.api(`/api/subscribers/${created.body.id}`, 'PUT', { server_ids: [b] });
    expect(removed.body.server_ids).toEqual([b]);
    expect(keyOnA()).toBeUndefined();
  });

  it('отключение и включение подписчика синхронизирует ноды; переименование обновляет имена клиентов', async () => {
    const ssh = stubSsh();
    const server = insertServer({ name: 'Нода-1' });
    const created = await admin.api('/api/subscribers', 'POST', { name: 'Старое', server_ids: [server] });
    await vi.waitFor(() => expect(ssh.calls.length).toBeGreaterThanOrEqual(1));
    const before = ssh.calls.length;

    await admin.api(`/api/subscribers/${created.body.id}`, 'PUT', { enabled: false });
    await vi.waitFor(() => expect(ssh.calls.length).toBeGreaterThan(before));
    expect(ProvisionService.getServerClients(server).find((c) => c.subscriber_id === created.body.id).subscriber_active).toBe(0);

    await admin.api(`/api/subscribers/${created.body.id}`, 'PUT', { enabled: true, name: 'Новое' });
    expect(db.prepare('SELECT name FROM clients WHERE subscriber_id = ?').get(created.body.id)).toEqual({ name: 'Новое (Нода-1)' });
    expect(ProvisionService.getServerClients(server).find((c) => c.subscriber_id === created.body.id).subscriber_active).toBe(1);
  });

  it('несуществующий пользователь — 404 на всех действиях', async () => {
    for (const [method, path] of [
      ['PUT', '/api/subscribers/999999'], ['DELETE', '/api/subscribers/999999'],
      ['POST', '/api/subscribers/999999/reset-token'], ['POST', '/api/subscribers/999999/reset-traffic'],
    ]) {
      expect((await admin.api(path, method, {})).status, `${method} ${path}`).toBe(404);
    }
  });
});
