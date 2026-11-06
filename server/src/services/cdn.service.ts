import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { db, getSetting } from '../db/index.js';
import { HttpError } from '../utils/http.js';
import { nodeProtocol } from '../utils/vless-params.js';
import { SslService, cfFetch, validateDomain } from './ssl.service.js';
import { decryptSecret, encryptSecret } from './secrets.service.js';
import { CLOUDFLARE_HTTPS_PORTS } from './cloudflare-panel.service.js';
import { ProvisionService } from './provision.service.js';
import { EventService } from './event.service.js';
import { LiveService } from './live.service.js';

/** Продление сертификата входа через CDN — за 30 дней до окончания, как у сертификата панели */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const CF_ID_RE = /^[a-f0-9]{32}$/i;

/** Колонки входа через CDN: снимок для отката */
const CDN_COLUMNS = [
  'cdn_enabled', 'cdn_domain', 'cdn_port', 'cdn_address', 'cdn_zone', 'cdn_record', 'cdn_origin_ip',
  'cdn_cert', 'cdn_key', 'cdn_expires_at', 'cdn_error',
] as const;

export interface CdnInput {
  domain?: unknown;
  port?: unknown;
  address?: unknown;
  origin_ip?: unknown;
  token?: unknown;
  email?: unknown;
}

function certificateExpiry(certPem: string): string | null {
  try {
    return new Date(new crypto.X509Certificate(certPem).validTo).toISOString();
  } catch {
    return null;
  }
}

function certificateCovers(certPem: string | null, domain: string): boolean {
  if (!certPem) return false;
  try {
    const x509 = new crypto.X509Certificate(certPem);
    return x509.checkHost(domain) !== undefined && new Date(x509.validTo).getTime() - Date.now() > RENEW_BEFORE_MS;
  } catch {
    return false;
  }
}

/**
 * Вход через CDN Cloudflare для ноды VLESS (docs/vless.md#cdn).
 *
 * Клиент подключается к адресу Cloudflare (домен с оранжевым облаком или «чистый» IP Cloudflare), Cloudflare по TLS
 * пересылает запросы XHTTP на ноду: `cdn_port` из HTTPS-портов Cloudflare, сертификат Let's Encrypt домена (DNS-01 тем же
 * токеном, что и у панели) встраивается в config.json ноды (XrayService.generateServerConfig). Reality-вход ноды не меняется.
 *
 * Правила (инвариант 46): трогаем только A-запись выбранного имени и только если она свободна или наша; изменения
 * TLS/DNS — через `SslService.exclusive`; приватный ключ сертификата — `encryptSecret`, в API не отдаётся.
 */
export class CdnService {
  private static load(serverId: number): any {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    if (!server) throw new HttpError(404, 'Сервер не найден');
    if (server.remote_panel_id) throw new HttpError(400, 'Недоступно для ноды партнёра');
    if (nodeProtocol(server) !== 'vless') throw new HttpError(400, 'Вход через CDN доступен только для нод VLESS');
    return server;
  }

  private static snapshot(server: any): Record<string, unknown> {
    return Object.fromEntries(CDN_COLUMNS.map((key) => [key, server[key] ?? null]));
  }

  private static write(serverId: number, values: Record<string, unknown>): void {
    const keys = Object.keys(values);
    db.prepare(`UPDATE servers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...(keys.map((k) => values[k]) as any[]),
      serverId
    );
  }

  /** Имя для CDN не должно совпадать с доменом панели, адресом ноды/моста или CDN-доменом другой ноды */
  static assertDedicatedDomain(domain: string, serverId: number): void {
    const name = domain.toLowerCase();
    if ((getSetting('cf_panel_domain') ?? '').toLowerCase() === name) {
      throw new HttpError(409, 'Это домен панели. Для входа через CDN нужен отдельный поддомен.');
    }
    const used = db.prepare(`
      SELECT host AS name FROM servers UNION ALL SELECT host FROM bridges
      UNION ALL SELECT cdn_domain FROM servers WHERE cdn_domain IS NOT NULL AND id != ?
    `).all(serverId) as { name: string }[];
    if (used.some((row) => String(row.name).toLowerCase().replace(/\.$/, '') === name)) {
      throw new HttpError(409, 'Это имя уже используется нодой, мостом или входом через CDN другой ноды. Выберите отдельный поддомен.');
    }
  }

  private static async originIp(server: any, input: unknown): Promise<string> {
    if (input !== undefined && input !== null && input !== '') {
      if (typeof input !== 'string' || !net.isIPv4(input.trim())) throw new HttpError(400, 'IPv4 ноды указан неверно');
      return input.trim();
    }
    if (net.isIPv4(server.host)) return server.host;
    try {
      const { address } = await dns.promises.lookup(server.host, { family: 4 });
      if (net.isIPv4(address)) return address;
    } catch {
      // ниже — понятная ошибка
    }
    throw new HttpError(400, 'Не удалось определить IPv4 ноды: укажите его явно');
  }

  private static async api(token: string, path: string, init?: RequestInit): Promise<any> {
    let data: any;
    try { data = await cfFetch(token, path, init); }
    catch { throw new HttpError(502, 'Не удалось связаться с Cloudflare. Повторите позже.'); }
    if (data?.success !== true) throw new HttpError(400, 'Cloudflare отклонил запрос. Проверьте токен и права Zone:Read, DNS:Edit для зоны.');
    return data.result;
  }

  /**
   * Включить (или изменить) вход через CDN: сертификат, A-запись с проксированием, запись в БД и переустановка
   * контейнера (открывается второй порт). При ошибке всё возвращается как было, включая DNS.
   */
  static async enable(serverId: number, input: CdnInput): Promise<void> {
    const server = this.load(serverId);
    let domain: string;
    try { domain = validateDomain(input.domain); }
    catch (err: any) { throw new HttpError(400, err.message); }
    this.assertDedicatedDomain(domain, serverId);

    const port = input.port === undefined || input.port === null || input.port === '' ? 8443 : Number(input.port);
    if (!CLOUDFLARE_HTTPS_PORTS.includes(port)) {
      throw new HttpError(400, `Порт входа через CDN — один из HTTPS-портов Cloudflare: ${CLOUDFLARE_HTTPS_PORTS.join(', ')}`);
    }
    if (port === Number(server.awg_port)) throw new HttpError(400, 'Порт входа через CDN должен отличаться от порта VLESS ноды');

    let address = '';
    if (input.address !== undefined && input.address !== null && String(input.address).trim() !== '') {
      const raw = String(input.address).trim().toLowerCase();
      if (net.isIP(raw)) address = raw;
      else {
        try { address = validateDomain(raw); }
        catch { throw new HttpError(400, 'Адрес для подключения — IP или домен Cloudflare'); }
      }
    }

    let token: string;
    try { token = SslService.resolveCloudflareToken(input.token); }
    catch (err: any) { throw new HttpError(400, err.message); }
    if (input.email !== undefined && typeof input.email !== 'string') throw new HttpError(400, 'Email должен быть строкой');
    const email = (typeof input.email === 'string' && input.email.trim()) || getSetting('ssl_email');
    const ip = await this.originIp(server, input.origin_ip);

    const before = this.snapshot(server);
    let dnsChange: { zone: string; id: string; previous: any | null } | null = null;

    await SslService.exclusive(async () => {
      let zones: { id: string; name: string }[];
      try { zones = await SslService.getCloudflareZones(token); }
      catch { throw new HttpError(400, 'Не удалось прочитать зоны Cloudflare. Проверьте токен и право Zone:Read.'); }
      const zone = zones.filter((z) => domain === z.name || domain.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
      if (!zone || !CF_ID_RE.test(zone.id)) throw new HttpError(400, 'DNS-зона домена не найдена в Cloudflare. Нужны права Zone:Read и DNS:Edit.');

      const base = `/zones/${zone.id}/dns_records`;
      const records = await this.api(token, `${base}?name=${encodeURIComponent(domain)}&per_page=100`);
      if (!Array.isArray(records) || records.length >= 100) throw new HttpError(502, 'Cloudflare вернул некорректный список DNS-записей');
      const addresses = records.filter((r: any) => ['A', 'AAAA', 'CNAME'].includes(r.type));
      const owned = (r: any) => r.id === server.cdn_record && zone.id === server.cdn_zone;
      if (addresses.length > 1 || addresses.some((r: any) => r.type !== 'A' || (r.content !== ip && !owned(r)))) {
        throw new HttpError(409, 'Для этого имени уже есть другая A/AAAA/CNAME-запись. Выберите свободный поддомен; записи не изменены.');
      }
      const previous = addresses[0] ?? null;
      if (previous && !CF_ID_RE.test(previous.id)) throw new HttpError(502, 'Cloudflare вернул некорректный ID записи');

      // Сертификат: прежний, если он на это имя и не истекает, иначе новый через DNS-01
      let cert = server.cdn_cert as string | null;
      let key = server.cdn_key as string | null;
      if (!certificateCovers(cert, domain) || !decryptSecret(key)) {
        if (!email) throw new HttpError(400, 'Для выпуска сертификата укажите email Let’s Encrypt');
        try {
          const issued = await SslService.obtainDns01Certificate(domain, email, token, zone.id);
          cert = issued.cert;
          key = encryptSecret(issued.key);
        } catch {
          throw new HttpError(502, 'Не удалось выпустить сертификат. Проверьте домен, email и право токена DNS:Edit.');
        }
      }

      this.assertDedicatedDomain(domain, serverId); // за время выпуска могли добавить ноду с этим именем
      const record = await this.api(token, previous ? `${base}/${previous.id}` : base, {
        method: previous ? 'PATCH' : 'POST',
        body: JSON.stringify(previous
          ? { ...(previous.content !== ip ? { content: ip } : {}), proxied: true, ttl: 1 }
          : { type: 'A', name: domain, content: ip, proxied: true, ttl: 1 }),
      });
      if (!record?.id || !CF_ID_RE.test(record.id)) throw new HttpError(502, 'Cloudflare не подтвердил DNS-запись');
      dnsChange = { zone: zone.id, id: record.id, previous };
      if (record.proxied !== true || record.type !== 'A' || record.content !== ip) {
        await this.rollbackDns(token, dnsChange);
        throw new HttpError(502, 'Cloudflare не подтвердил включение проксирования для нужного адреса');
      }

      // Старая запись другого имени (смена домена) удаляется, если она наша
      if (server.cdn_record && server.cdn_zone && server.cdn_domain && server.cdn_domain !== domain) {
        await this.deleteOwnedRecord(token, server).catch(() => {});
      }

      this.write(serverId, {
        cdn_enabled: 1, cdn_domain: domain, cdn_port: port, cdn_address: address || null, cdn_zone: zone.id,
        cdn_record: record.id, cdn_origin_ip: ip, cdn_cert: cert, cdn_key: key,
        cdn_expires_at: cert ? certificateExpiry(cert) : null, cdn_error: null,
      });
    });

    if (server.status !== 'uninstalled') {
      const result = await ProvisionService.requestReinstall(serverId);
      if (!result.success) {
        this.write(serverId, before);
        if (dnsChange) await this.rollbackDns(token, dnsChange).catch(() => {});
        throw new HttpError(502, `Не удалось включить вход через CDN на ноде: ${result.error}. Прежние настройки восстановлены.`);
      }
    }
    EventService.log('info', 'server.cdn_enabled', `Вход через CDN ${domain}:${port} для ноды «${server.name}»`, { kind: 'server', id: serverId });
  }

  private static async rollbackDns(token: string, change: { zone: string; id: string; previous: any | null }): Promise<void> {
    const path = `/zones/${change.zone}/dns_records/${change.id}`;
    if (change.previous) {
      await this.api(token, path, {
        method: 'PATCH',
        body: JSON.stringify({ content: change.previous.content, proxied: change.previous.proxied === true, ttl: change.previous.ttl }),
      });
    } else {
      await this.api(token, path, { method: 'DELETE' });
    }
  }

  /** Удаляет A-запись входа через CDN, только если она всё ещё указывает на сохранённый IP ноды */
  private static async deleteOwnedRecord(token: string, server: any): Promise<void> {
    if (!CF_ID_RE.test(String(server.cdn_zone)) || !CF_ID_RE.test(String(server.cdn_record))) return;
    const path = `/zones/${server.cdn_zone}/dns_records/${server.cdn_record}`;
    const current = await this.api(token, path);
    if (current?.type !== 'A' || current?.name !== server.cdn_domain || current?.content !== server.cdn_origin_ip) return;
    await this.api(token, path, { method: 'DELETE' });
  }

  /**
   * Выключить вход через CDN: inbound убирается синхронизацией, наша A-запись удаляется (ошибка DNS не мешает выключению).
   * Домен и сертификат сохраняются для повторного включения.
   */
  static async disable(serverId: number): Promise<{ warning?: string }> {
    const server = this.load(serverId);
    if (!server.cdn_enabled) return {};
    this.write(serverId, { cdn_enabled: 0, cdn_error: null });
    let warning: string | undefined;
    if (server.status !== 'uninstalled') {
      const result = await ProvisionService.requestSync(serverId);
      if (!result.success) warning = `Нода не обновлена: ${result.error}. Вход отключится при следующей синхронизации.`;
    }
    try {
      const token = SslService.resolveCloudflareToken();
      await SslService.exclusive(() => this.deleteOwnedRecord(token, server));
      this.write(serverId, { cdn_record: null });
    } catch {
      warning = warning ?? 'Не удалось удалить DNS-запись в Cloudflare — удалите её вручную.';
    }
    EventService.log('info', 'server.cdn_disabled', `Вход через CDN выключен для ноды «${server.name}»`, { kind: 'server', id: serverId });
    return warning ? { warning } : {};
  }

  /** При удалении ноды: убрать нашу A-запись (без ошибок — нода удаляется в любом случае) */
  static async forget(server: any): Promise<void> {
    if (!server?.cdn_record) return;
    try {
      const token = SslService.resolveCloudflareToken();
      await SslService.exclusive(() => this.deleteOwnedRecord(token, server));
    } catch {
      // запись останется в Cloudflare; на удаление ноды это не влияет
    }
  }

  /**
   * Продление сертификатов входа через CDN (фоновая задача вместе с SslService.renewIfNeeded; вызывающий проверяет
   * `MigrationService.isBackgroundPaused()`). Новый сертификат попадает на ноду обычной синхронизацией.
   */
  static async renewAll(): Promise<void> {
    const due = (db.prepare(`
      SELECT * FROM servers WHERE protocol = 'vless' AND cdn_enabled = 1 AND cdn_domain IS NOT NULL AND remote_panel_id IS NULL
    `).all() as any[]).filter((s) => !s.cdn_expires_at || new Date(s.cdn_expires_at).getTime() - Date.now() < RENEW_BEFORE_MS);
    for (const server of due) {
      try {
        const token = SslService.resolveCloudflareToken();
        const email = getSetting('ssl_email');
        if (!email) throw new Error('не сохранён email Let’s Encrypt');
        if (!CF_ID_RE.test(String(server.cdn_zone))) throw new Error('не сохранена зона Cloudflare');
        const issued = await SslService.exclusive(() => SslService.obtainDns01Certificate(server.cdn_domain, email, token, server.cdn_zone));
        this.write(server.id, {
          cdn_cert: issued.cert, cdn_key: encryptSecret(issued.key), cdn_expires_at: certificateExpiry(issued.cert), cdn_error: null,
        });
        await ProvisionService.requestSync(server.id);
      } catch (err: any) {
        this.write(server.id, { cdn_error: `Не удалось продлить сертификат входа через CDN: ${err.message}` });
      }
    }
    // Фоновая запись вне /api: интерфейс перечитает данные (инвариант 42)
    if (due.length) LiveService.notify();
  }
}
