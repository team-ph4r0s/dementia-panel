import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, getSetting, initDatabase, setSetting } from '../src/db/index.js';
import { PanelAddressService } from '../src/services/panel-address.service.js';
import { BridgeService } from '../src/services/bridge.service.js';
import { FailoverService } from '../src/services/failover.service.js';
import { encryptSecret } from '../src/services/secrets.service.js';
import { createAdminApi } from './helpers/api.js';
import { startTestServer, type TestEnv } from './test-app.js';

/**
 * Смена публичного IP панели: обнаружение, предупреждение, автообновление и перевод зависимостей на новый адрес
 * (A-запись домена панели, мосты с «Панелью через мост», резервный домен, публичный адрес по IP). Cloudflare подменён.
 */

const ZONE = 'a'.repeat(32);
const RECORD = 'b'.repeat(32);
const OLD = '203.0.113.5';
const NEW = '198.51.100.77';

let env: TestEnv;
let api: ReturnType<typeof createAdminApi>['api'];

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  ({ api } = createAdminApi(env, 'ipadmin', 'IpAdminPass-1'));
});
afterAll(async () => { await env.close(); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.exec("DELETE FROM bridges; DELETE FROM events; DELETE FROM settings WHERE key LIKE 'cf_%' OR key LIKE 'panel_%' OR key LIKE 'failover_%' OR key = 'public_url'");
});

function cloudflare(record: Record<string, unknown>) {
  const calls: { method: string; path: string; body: any }[] = [];
  let current = { id: RECORD, type: 'A', name: 'panel.example.com', proxied: true, ...record };
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
    if (String(url).startsWith(env.baseUrl)) return realFetch(url, init);
    const path = String(url).replace('https://api.cloudflare.com/client/v4', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (method === 'PATCH') current = { ...current, ...body };
    return Response.json({ success: true, result: current });
  }));
  return calls;
}

function panelOnCloudflare() {
  setSetting('cf_token', encryptSecret('cf-token'));
  setSetting('cf_panel_enabled', '1');
  setSetting('cf_panel_domain', 'panel.example.com');
  setSetting('cf_panel_zone', ZONE);
  setSetting('cf_panel_record', RECORD);
  setSetting('cf_panel_ip', OLD);
}

describe('обнаружение смены IP', () => {
  it('новый адрес — предупреждение в журнале и в состоянии; вернулся прежний — предупреждение снимается', async () => {
    setSetting('panel_origin_ip', OLD);
    await PanelAddressService.check(async () => NEW);
    expect(PanelAddressService.status()).toMatchObject({ known: OLD, detected: NEW, changed: true });
    const event = db.prepare("SELECT level, message FROM events WHERE type = 'panel.ip_changed'").get() as any;
    expect(event.level).toBe('warning');
    expect(event.message).toContain(NEW);

    // Повтор того же ответа не плодит записи в журнале
    await PanelAddressService.check(async () => NEW);
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'panel.ip_changed'").get() as any).n).toBe(1);

    await PanelAddressService.check(async () => OLD);
    expect(PanelAddressService.status()).toMatchObject({ detected: null, changed: false });
  });

  it('без известного адреса и при ошибке определения ничего не делает', async () => {
    await PanelAddressService.check(async () => NEW);
    expect(getSetting('panel_ip_detected')).toBeNull();
    setSetting('panel_origin_ip', OLD);
    await PanelAddressService.check(async () => null);
    expect(getSetting('panel_ip_detected')).toBeNull();
  });

  it('автообновление применяет адрес только после двух одинаковых ответов подряд', async () => {
    setSetting('panel_origin_ip', OLD);
    setSetting('panel_ip_auto', '1');
    const apply = vi.spyOn(PanelAddressService, 'apply').mockResolvedValue({ ip: NEW, previous: OLD, steps: [] });
    await PanelAddressService.check(async () => NEW);
    expect(apply).not.toHaveBeenCalled();
    await PanelAddressService.check(async () => '192.0.2.9'); // другой ответ сбрасывает счёт
    await PanelAddressService.check(async () => '192.0.2.9');
    expect(apply).toHaveBeenCalledWith('192.0.2.9');
  });

  it('без автообновления не применяет сам', async () => {
    setSetting('panel_origin_ip', OLD);
    const apply = vi.spyOn(PanelAddressService, 'apply');
    for (let i = 0; i < 3; i++) await PanelAddressService.check(async () => NEW);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('применение нового IP', () => {
  it('A-запись домена панели, мосты, резервный домен и публичный адрес по IP переводятся на новый адрес', async () => {
    panelOnCloudflare();
    setSetting('panel_origin_ip', OLD);
    setSetting('public_url', `https://${OLD}:3001`);
    setSetting('failover_domain', 'sub.example.com');
    db.prepare("INSERT INTO bridges (name, host, ssh_port, ssh_user, country, status, panel_forward) VALUES ('Москва', '198.51.100.80', 22, 'root', 'ru', 'online', 1)").run();
    const calls = cloudflare({ content: OLD });
    const applyBridge = vi.spyOn(BridgeService, 'requestApply').mockResolvedValue({ success: true });
    const reconcile = vi.spyOn(FailoverService, 'reconcile').mockResolvedValue();

    const res = await api('/api/security/panel-ip', 'POST', { ip: NEW });
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: `/zones/${ZONE}/dns_records/${RECORD}`, body: { content: NEW } });
    expect(getSetting('cf_panel_ip')).toBe(NEW);
    expect(getSetting('panel_origin_ip')).toBe(NEW);
    expect(getSetting('public_url')).toBe(`https://${NEW}:3001`);
    expect(applyBridge).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalled();
    expect(res.body.steps.every((s: any) => s.ok)).toBe(true);
    expect(res.body.steps.map((s: any) => s.title)).toEqual([
      'DNS panel.example.com', 'Публичный адрес панели', 'Мост «Москва»', 'Резервный домен sub.example.com',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('cf-token');
  });

  it('чужую запись не трогает: A-запись указывает не на прежний IP панели', async () => {
    panelOnCloudflare();
    setSetting('panel_origin_ip', OLD);
    const calls = cloudflare({ content: '192.0.2.200' });
    const res = await PanelAddressService.apply(NEW);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(res.steps[0]).toMatchObject({ ok: false, title: 'DNS panel.example.com' });
    expect(getSetting('cf_panel_ip')).toBe(OLD);
    // Адрес для мостов всё равно обновлён — он описывает сам сервер панели
    expect(getSetting('panel_origin_ip')).toBe(NEW);
  });

  it('API: неверный адрес — 400; включение автообновления', async () => {
    expect((await api('/api/security/panel-ip', 'POST', { ip: 'not-an-ip' })).status).toBe(400);
    expect((await api('/api/security/panel-ip/auto', 'PUT', { auto: 'yes' })).status).toBe(400);
    const on = await api('/api/security/panel-ip/auto', 'PUT', { auto: true });
    expect(on.body.auto).toBe(true);
    setSetting('panel_origin_ip', OLD);
    setSetting('panel_ip_detected', NEW);
    expect((await api('/api/security/panel-ip')).body).toMatchObject({ known: OLD, detected: NEW, changed: true, auto: true });
  });
});
