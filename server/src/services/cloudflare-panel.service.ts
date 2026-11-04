import net from 'node:net';
import { db, getSetting, setSetting, transaction } from '../db/index.js';
import { detectPublicIpv4 } from '../utils/net.js';
import { HttpError } from '../utils/http.js';
import { SslService, cfFetch, validateDomain } from './ssl.service.js';
import { encryptSecret } from './secrets.service.js';
import { PanelIngressService } from './panel-ingress.service.js';
import { EventService } from './event.service.js';

export const CLOUDFLARE_HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
const KEYS = ['cf_panel_enabled', 'cf_panel_domain', 'cf_panel_zone', 'cf_panel_record', 'cf_panel_ip', 'cf_panel_port', 'cf_panel_error', 'public_url', 'cf_token'];

/** Only DNS records for the explicit panel hostname; never changes nodes, bridges, containers or zone-wide TLS settings. */
export class CloudflarePanelService {
  static status() {
    const port = Number(getSetting('cf_panel_port')) || 443;
    return {
      enabled: getSetting('cf_panel_enabled') === '1', domain: getSetting('cf_panel_domain') ?? '',
      origin_ip: getSetting('cf_panel_ip') ?? '', port,
      url: getSetting('cf_panel_domain') ? `https://${getSetting('cf_panel_domain')}${port === 443 ? '' : `:${port}`}` : null,
      token_saved: Boolean(getSetting('cf_token')), email: getSetting('ssl_email') ?? '',
      listener_ready: PanelIngressService.isOpen(port), error: getSetting('cf_panel_error'),
      https_ports: CLOUDFLARE_HTTPS_PORTS,
    };
  }

  static assertDedicatedDomain(domain: string): void {
    const name = domain.toLowerCase().replace(/\.$/, '');
    const used = db.prepare(`SELECT host FROM servers UNION SELECT host FROM bridges`).all() as { host: string }[];
    if (used.some((s) => s.host.toLowerCase().replace(/\.$/, '') === name)) {
      throw new HttpError(409, 'Этот домен используется нодой или мостом. Для панели нужен отдельный поддомен; VPN должен подключаться напрямую.');
    }
  }

  private static async api(token: string, path: string, init?: RequestInit): Promise<any> {
    let data: any;
    try { data = await cfFetch(token, path, init); }
    catch { throw new HttpError(502, 'Не удалось связаться с Cloudflare. Проверьте подключение и повторите операцию.'); }
    if (data?.success !== true) throw new HttpError(400, 'Cloudflare отклонил запрос. Проверьте токен и права Zone:Read, DNS:Edit для выбранной зоны.');
    return data.result;
  }

  static configure(input: any): Promise<ReturnType<typeof CloudflarePanelService.status>> {
    return SslService.exclusive(async () => {
      const domain = validateDomain(input?.domain);
      this.assertDedicatedDomain(domain);
      const port = input?.port ?? 443;
      if (!CLOUDFLARE_HTTPS_PORTS.includes(port)) throw new HttpError(400, 'Выберите поддерживаемый HTTPS-порт Cloudflare');
      const token = SslService.resolveCloudflareToken(input?.token);
      if (input?.origin_ip !== undefined && typeof input.origin_ip !== 'string') throw new HttpError(400, 'IPv4 должен быть строкой');
      if (input?.email !== undefined && typeof input.email !== 'string') throw new HttpError(400, 'Email должен быть строкой');
      const ip = input?.origin_ip?.trim() || await detectPublicIpv4();
      if (!ip || !net.isIPv4(ip)) throw new HttpError(400, 'Укажите публичный IPv4 сервера панели: автоматически определить его не удалось');
      let zones: { id: string; name: string }[];
      try { zones = await SslService.getCloudflareZones(token); }
      catch { throw new HttpError(400, 'Не удалось прочитать зоны Cloudflare. Проверьте токен и право Zone:Read.'); }
      const zone = zones.filter((z) => domain === z.name || domain.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
      if (!zone || !/^[a-f0-9]{32}$/i.test(zone.id)) throw new HttpError(400, 'DNS-зона домена не найдена. Нужны права Zone:Read и DNS:Edit на эту зону.');
      const base = `/zones/${zone.id}/dns_records`;
      const records = await this.api(token, `${base}?name=${encodeURIComponent(domain)}&per_page=100`);
      if (!Array.isArray(records) || records.length >= 100) throw new HttpError(502, 'Cloudflare вернул некорректный или слишком большой список DNS-записей');
      const addresses = records.filter((r: any) => ['A', 'AAAA', 'CNAME'].includes(r.type));
      const owned = addresses.length === 1 && addresses[0].id === getSetting('cf_panel_record') &&
        zone.id === getSetting('cf_panel_zone') && domain === getSetting('cf_panel_domain') && addresses[0].content === getSetting('cf_panel_ip');
      if (addresses.length > 1 || addresses.some((r: any) => r.type !== 'A' || (r.content !== ip && !owned))) {
        throw new HttpError(409, 'Для этого имени уже есть другая A/AAAA/CNAME-запись. Используйте отдельный свободный поддомен панели; существующие записи не изменены.');
      }
      const previous = addresses[0];
      if (previous && !/^[a-f0-9]{32}$/i.test(previous.id)) throw new HttpError(502, 'Cloudflare вернул некорректный ID записи');
      const email = typeof input?.email === 'string' && input.email.trim() ? input.email.trim() : getSetting('ssl_email');
      if (!SslService.coversDomain(domain) && !email) throw new HttpError(400, 'Для выпуска сертификата укажите email Let’s Encrypt');
      const tls = SslService.snapshot();
      const settings = Object.fromEntries(KEYS.map((key) => [key, getSetting(key)]));
      const hadListener = PanelIngressService.isOpen(port);
      let recordId: string | null = null;
      let dnsWritten = false;
      try {
        // Reserve the port before touching DNS or the existing certificate.
        await PanelIngressService.open(port);
        if (!SslService.coversDomain(domain)) {
          try { await SslService.issueLetsEncryptCloudflare(domain, email!, token, false, false); }
          catch { throw new HttpError(502, 'Не удалось выпустить сертификат. Проверьте домен, email и права токена на DNS-01; прежний HTTPS будет восстановлен.'); }
        }
        this.assertDedicatedDomain(domain); // Node creation could have completed during the ACME challenge.
        const record = await this.api(token, previous ? `${base}/${previous.id}` : base, {
          method: previous ? 'PATCH' : 'POST',
          body: JSON.stringify(previous ? { ...(previous.content !== ip ? { content: ip } : {}), proxied: true, ttl: 1 }
            : { type: 'A', name: domain, content: ip, proxied: true, ttl: 1 }),
        });
        recordId = record?.id;
        dnsWritten = true;
        if (!recordId || !/^[a-f0-9]{32}$/i.test(recordId) || record.proxied !== true || record.name !== domain || record.type !== 'A' || record.content !== ip) {
          throw new HttpError(502, 'Cloudflare не подтвердил включение проксирования для нужного адреса');
        }
        const url = `https://${domain}${port === 443 ? '' : `:${port}`}`;
        transaction(() => {
          for (const [key, value] of Object.entries({ cf_panel_enabled: '1', cf_panel_domain: domain, cf_panel_zone: zone.id,
            cf_panel_record: recordId!, cf_panel_ip: ip, cf_panel_port: String(port), public_url: url, cf_token: encryptSecret(token) })) setSetting(key, value);
          setSetting('cf_panel_error', null);
        });
        EventService.log('info', 'cloudflare.configured', `Для панели настроен домен ${domain} с проксированием Cloudflare`);
        return this.status();
      } catch (error) {
        let rollbackFailed = false;
        if (dnsWritten && recordId && /^[a-f0-9]{32}$/i.test(recordId)) {
          try {
            await this.api(token, `${base}/${recordId}`, previous
              ? { method: 'PATCH', body: JSON.stringify({ ...(previous.content !== ip ? { content: previous.content } : {}), proxied: previous.proxied === true, ttl: previous.ttl }) }
              : { method: 'DELETE' });
          } catch { rollbackFailed = true; }
        }
        SslService.restore(tls);
        transaction(() => { for (const [key, value] of Object.entries(settings)) setSetting(key, value); });
        if (!hadListener) PanelIngressService.close(port);
        if (rollbackFailed) throw new HttpError(502, 'Настройка не завершена; прежний HTTPS восстановлен. Не удалось откатить DNS — проверьте запись домена в Cloudflare.');
        throw error;
      }
    });
  }

  static disable(): Promise<ReturnType<typeof CloudflarePanelService.status>> {
    return SslService.exclusive(async () => {
      if (getSetting('cf_panel_enabled') !== '1') return this.status();
      const token = SslService.resolveCloudflareToken();
      const zone = getSetting('cf_panel_zone'); const record = getSetting('cf_panel_record');
      if (!zone || !record || !/^[a-f0-9]{32}$/i.test(zone) || !/^[a-f0-9]{32}$/i.test(record)) throw new HttpError(409, 'Не сохранены параметры DNS-записи');
      const current = await this.api(token, `/zones/${zone}/dns_records/${record}`);
      if (current?.name !== getSetting('cf_panel_domain') || current?.content !== getSetting('cf_panel_ip') || current?.type !== 'A') {
        throw new HttpError(409, 'DNS-запись изменилась вне панели; отключите проксирование вручную в Cloudflare');
      }
      await this.api(token, `/zones/${zone}/dns_records/${record}`, { method: 'PATCH', body: JSON.stringify({ proxied: false, ttl: 120 }) });
      setSetting('cf_panel_enabled', '0');
      // Keep HTTPS and its listener: the same URL now connects directly, and subscription links remain valid.
      EventService.log('info', 'cloudflare.disabled', 'Проксирование домена панели через Cloudflare отключено');
      return this.status();
    });
  }

  static async restoreIngress(): Promise<void> {
    const port = Number(getSetting('cf_panel_port'));
    if (!getSetting('cf_panel_domain') || !CLOUDFLARE_HTTPS_PORTS.includes(port)) return;
    try { await PanelIngressService.open(port); setSetting('cf_panel_error', null); }
    catch { setSetting('cf_panel_error', `Не удалось открыть HTTPS-порт ${port}; проверьте занятые порты и права службы`); }
  }
}
