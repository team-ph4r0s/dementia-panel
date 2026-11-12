import { get } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { AuthService } from '../src/services/auth.service.js';
import { startTestServer } from './test-app.js';

describe('API: Подписчики и подписки (интеграционное тестирование)', () => {
  let testEnv: Awaited<ReturnType<typeof startTestServer>>;
  let adminToken: string;
  let serverId: number;

  beforeAll(async () => {
    initDatabase();
    AuthService.resetAdmin('admin_sub_test', 'TestPassword123!');
    const login = AuthService.login('admin_sub_test', 'TestPassword123!');
    adminToken = login!.token;
    testEnv = await startTestServer();

    // Создаём тестовый сервер и переводим его в online
    const res = await testEnv.request('/api/servers', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Финляндия #1',
        host: '203.0.113.50',
        ssh_port: 22,
        ssh_password: 'test-ssh-password',
        awg_port: 51820,
        subnet: '10.9.0.1/24',
      }),
    });
    const s = await res.json();
    serverId = s.id;
    // Имитируем успешную установку сервера
    db.prepare("UPDATE servers SET status = 'online', sub_name = '🇫🇮 Хельсинки' WHERE id = ?").run(serverId);
  });

  afterAll(async () => {
    await testEnv.close();
  });

  const authHeaders = () => ({
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  });

  let subscriberId: number;
  let subToken: string;

  it('сохраняет, нормализует и очищает страну ноды для карты', async () => {
    const path = `/api/servers/${serverId}/country`;
    const setCountry = (country: unknown) => testEnv.request(path, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ country }),
    });
    expect((await setCountry('Finland')).status).toBe(400);
    const updated = await setCountry(' fi ');
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ country: 'FI', status: 'online' });
    const saved = await testEnv.request(`/api/servers/${serverId}`, { headers: authHeaders() });
    expect(await saved.json()).toMatchObject({ country: 'FI' });
    expect(await (await setCountry(null)).json()).toMatchObject({ country: null });
  });

  it('создаёт подписчика и автоматически генерирует для него клиента на выбранном сервере', async () => {
    const res = await testEnv.request('/api/subscribers', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name: 'Иван Петров',
        traffic_limit: 10 * 1024 * 1024 * 1024, // 10 GB
        expire_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        server_ids: [serverId],
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    subscriberId = data.id;
    subToken = data.token;

    expect(data.name).toBe('Иван Петров');
    expect(subToken).toMatch(/^sub_[a-f0-9]{32}$/);
    expect(data.traffic_limit).toBe(10 * 1024 * 1024 * 1024);
    expect(data.servers).toHaveLength(1);
    expect(data.servers[0].id).toBe(serverId);
    expect(data.servers[0].client_ip).toBe('10.9.0.2');
  });

  it('публичный эндпоинт подписки /sub/:token доступен без авторизации и возвращает конфиг Incy/AWG', async () => {
    const res = await testEnv.request(`/sub/${subToken}`);
    expect(res.status).toBe(200);

    // Проверяем заголовки
    expect(res.headers.get('subscription-userinfo')).toContain('total=10737418240');
    expect(res.headers.get('profile-title')).toBeTruthy();
    expect(res.headers.get('content-disposition')).toContain('.txt');

    // Тело — base64 список awg:// ссылок
    const text = await res.text();
    const decoded = Buffer.from(text, 'base64').toString('utf-8');
    expect(decoded).toContain('awg://');
    expect(decoded).toContain(encodeURIComponent('🇫🇮 Хельсинки'));
  });

  it('показывает HTML при навигации браузера и сохраняет машинные форматы', async () => {
    const path = `/sub/${subToken}`;
    const headers = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
    // fetch подставляет собственный Sec-Fetch-Mode, поэтому отправляем заголовки навигации через HTTP.
    const navigate = (url: string) => new Promise<Response>((resolve, reject) => {
      get(testEnv.baseUrl + url, { headers }, async (incoming) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(chunk);
          resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: incoming.headers as Record<string, string> }));
        } catch (error) {
          reject(error);
        }
      }).on('error', reject);
    });
    const raw = await testEnv.request(path);
    const payload = await raw.text();
    const response = await navigate(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-disposition')).toBeNull();
    const html = await response.text();
    expect(html).toContain('Иван Петров');
    expect(html).toContain('🇫🇮 Хельсинки');
    expect(html).toContain('href="?format=clash"');
    expect(html).not.toContain('awg://');
    // кнопки приложений ведут на полный адрес подписки, а скрипт страницы отдаётся отдельным файлом (CSP без inline)
    expect(html).toContain(`incy://import/${testEnv.baseUrl}${path}`);
    const script = await testEnv.request('/sub/page.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('javascript');

    const vpn = await testEnv.request(path, { headers: { Accept: headers.Accept, 'User-Agent': 'Incy/1.0' } });
    expect(await vpn.text()).toBe(payload);
    for (const format of ['awg', 'incy', 'json', 'clash', 'mihomo', 'unknown', '']) {
      const url = `${path}?format=${format}`;
      const explicit = await navigate(url);
      const baseline = await testEnv.request(url);
      expect(explicit.headers.get('content-type')).toBe(baseline.headers.get('content-type'));
      expect(explicit.headers.get('content-type')).not.toContain('text/html');
      expect(await explicit.text()).toBe(await baseline.text());
    }
  });

  it('поддерживает формат Clash/mihomo (?format=clash)', async () => {
    const res = await testEnv.request(`/sub/${subToken}?format=clash`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/yaml');

    const yaml = await res.text();
    const config = JSON.parse(yaml);
    expect(config.proxies).toHaveLength(1);
    expect(config.proxies[0].name).toBe('🇫🇮 Хельсинки');
    expect(config.proxies[0].type).toBe('wireguard');
    expect(config.proxies[0]['amnezia-wg-option']).toBeDefined();
    expect(config['proxy-groups']).toHaveLength(1);
    expect(config.rules).toEqual(['IP-CIDR,203.0.113.50/32,DIRECT,no-resolve', 'MATCH,Dementia']);
  });

  it('поддерживает формат JSON (?format=json)', async () => {
    const res = await testEnv.request(`/sub/${subToken}?format=json`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.type).toBe('amneziawg');
    expect(data.version).toBe(1);
    expect(data.servers).toHaveLength(1);
    expect(data.servers[0].name).toBe('🇫🇮 Хельсинки');
    expect(typeof data.servers[0].config).toBe('string');
  });

  it('сброс токена подписчика делает старую ссылку недействительной', async () => {
    const resetRes = await testEnv.request(`/api/subscribers/${subscriberId}/reset-token`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(resetRes.status).toBe(200);
    const data = await resetRes.json();
    const newToken = data.token;
    expect(newToken).not.toBe(subToken);

    // Старый токен -> 404
    const oldSubRes = await testEnv.request(`/sub/${subToken}`);
    expect(oldSubRes.status).toBe(404);

    // Новый токен -> 200
    const newSubRes = await testEnv.request(`/sub/${newToken}`);
    expect(newSubRes.status).toBe(200);
    subToken = newToken;
  });

  it('список подписчиков использует постоянное число SQL-запросов', async () => {
    for (let i = 0; i < 4; i++) {
      db.prepare('INSERT INTO subscribers (name, token) VALUES (?, ?)').run(`query-count-${i}`, `query-token-${i}`);
    }
    const spy = vi.spyOn(db, 'prepare');
    try {
      const res = await testEnv.request('/api/subscribers', { headers: authHeaders() });
      expect(res.status).toBe(200);
      const items = await res.json();
      expect(items).toHaveLength(5);
      const listQueries = spy.mock.calls.filter(([sql]) => sql.includes('FROM subscribers') || sql.includes('FROM clients'));
      expect(listQueries).toHaveLength(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('отключение подписчика возвращает 403 в /sub/:token', async () => {
    const disableRes = await testEnv.request(`/api/subscribers/${subscriberId}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(disableRes.status).toBe(200);

    const subRes = await testEnv.request(`/sub/${subToken}`);
    expect(subRes.status).toBe(403);
    expect(await subRes.text()).toContain('Subscription is disabled');
  });

  it('удаление подписчика удаляет связанных клиентов с серверов', async () => {
    const delRes = await testEnv.request(`/api/subscribers/${subscriberId}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(delRes.status).toBe(200);

    // Клиент подписчика был удалён с сервера
    const clientsRes = await testEnv.request(`/api/servers/${serverId}/clients`, {
      headers: authHeaders(),
    });
    const clients = await clientsRes.json();
    expect(clients).toHaveLength(0);
  });
});
