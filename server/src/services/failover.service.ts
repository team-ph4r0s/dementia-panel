import net from 'node:net';
import { db, getSetting, setSetting, transaction } from '../db/index.js';
import { HttpError } from '../utils/http.js';
import { detectPublicIpv4 } from '../utils/net.js';
import { SslService, cfFetch, validateDomain } from './ssl.service.js';
import { encryptSecret } from './secrets.service.js';
import { panelPort } from './bridge.service.js';
import { EventService } from './event.service.js';
import { LiveService } from './live.service.js';

const CF_ID_RE = /^[a-f0-9]{32}$/i;
/** TTL A-записей резервного домена: мост, ушедший в offline, быстро пропадает из ответа DNS */
const RECORD_TTL = 60;
const KEYS = ['failover_domain', 'failover_zone', 'failover_records', 'failover_include_panel', 'failover_error'] as const;

export interface FailoverInput {
  domain?: unknown;
  include_panel?: unknown;
  origin_ip?: unknown;
  token?: unknown;
  email?: unknown;
}

/**
 * IPv4 сервера панели — куда мосты пересылают порт панели. Порядок: явно указанный → адрес из настройки домена Cloudflare
 * → сохранённый ранее → определённый автоматически. Сохраняется в `panel_origin_ip`.
 */
export async function ensurePanelOriginIp(input?: unknown): Promise<string> {
  if (input !== undefined && input !== null && input !== '') {
    if (typeof input !== 'string' || !net.isIPv4(input.trim())) throw new HttpError(400, 'IPv4 сервера панели указан неверно');
    setSetting('panel_origin_ip', input.trim());
    return input.trim();
  }
  const known = getSetting('panel_origin_ip') || getSetting('cf_panel_ip');
  if (known && net.isIPv4(known)) {
    if (!getSetting('panel_origin_ip')) setSetting('panel_origin_ip', known);
    return known;
  }
  const detected = await detectPublicIpv4();
  if (!detected || !net.isIPv4(detected)) throw new HttpError(400, 'Не удалось определить публичный IPv4 панели — укажите его вручную');
  setSetting('panel_origin_ip', detected);
  return detected;
}

function readRecords(): Record<string, string> {
  try {
    const parsed = JSON.parse(getSetting('failover_records') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([ip, id]) => net.isIPv4(ip) && typeof id === 'string' && CF_ID_RE.test(id))) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Резервный домен подписок (docs/bridges.md#failover): имя БЕЗ проксирования Cloudflare (DNS only), у которого панель ведёт
 * A-записи на IP мостов с пересылкой панели и (по выбору) на прямой IP панели. Мост пересылает TCP-порт панели как есть, TLS
 * завершается на панели — поэтому имя добавляется в сертификат панели (`ssl_alt_names`), а ссылки подписок выдаются с ним.
 * Приложение, не достучавшись до одного адреса, пробует следующий: одна ссылка — несколько путей.
 *
 * Правила как у домена панели (инвариант 46): трогаем только свои A-записи этого имени, изменения DNS/TLS — через
 * `SslService.exclusive`, токен не отдаётся браузеру.
 */
export class FailoverService {
  static enabled(): boolean {
    return Boolean(getSetting('failover_domain'));
  }

  /** База ссылок подписок: `https://<резервный домен>[:порт]` или null */
  static subscriptionBaseUrl(): string | null {
    const domain = getSetting('failover_domain');
    if (!domain) return null;
    const port = panelPort();
    return `https://${domain}${port === 443 ? '' : `:${port}`}`;
  }

  /** Адреса, которые должны быть в DNS: работающие мосты с пересылкой панели (IPv4) и, по выбору, IP панели */
  static desiredIps(): string[] {
    const ips = new Set<string>();
    const bridges = db.prepare(`
      SELECT host FROM bridges WHERE panel_forward = 1 AND status = 'online' AND needs_apply = 0 ORDER BY id
    `).all() as { host: string }[];
    for (const b of bridges) if (net.isIPv4(b.host)) ips.add(b.host);
    const origin = getSetting('panel_origin_ip');
    if (getSetting('failover_include_panel') !== '0' && origin && net.isIPv4(origin)) ips.add(origin);
    return [...ips];
  }

  static status() {
    const records = readRecords();
    const bridges = db.prepare('SELECT id, name, host, status, panel_forward FROM bridges ORDER BY id').all() as any[];
    return {
      enabled: this.enabled(),
      domain: getSetting('failover_domain') ?? '',
      url: this.subscriptionBaseUrl(),
      port: panelPort(),
      include_panel: getSetting('failover_include_panel') !== '0',
      origin_ip: getSetting('panel_origin_ip') ?? '',
      published: Object.keys(records),
      desired: this.desiredIps(),
      error: getSetting('failover_error'),
      token_saved: Boolean(getSetting('cf_token')),
      email: getSetting('ssl_email') ?? '',
      bridges: bridges.map((b) => ({
        id: b.id, name: b.name, host: b.host, status: b.status, panel_forward: Boolean(b.panel_forward), ipv4: net.isIPv4(b.host),
      })),
    };
  }

  private static async api(token: string, path: string, init?: RequestInit): Promise<any> {
    let data: any;
    try { data = await cfFetch(token, path, init); }
    catch { throw new HttpError(502, 'Не удалось связаться с Cloudflare. Повторите позже.'); }
    if (data?.success !== true) throw new HttpError(400, 'Cloudflare отклонил запрос. Проверьте токен и права Zone:Read, DNS:Edit для зоны.');
    return data.result;
  }

  private static assertDedicated(domain: string): void {
    const name = domain.toLowerCase();
    if ([getSetting('cf_panel_domain'), getSetting('ssl_domain')].some((d) => (d ?? '').toLowerCase() === name)) {
      throw new HttpError(409, 'Это основной домен панели. Для резервного пути нужен отдельный поддомен без проксирования Cloudflare.');
    }
    const used = db.prepare(`
      SELECT host AS name FROM servers UNION ALL SELECT host FROM bridges
      UNION ALL SELECT cdn_domain FROM servers WHERE cdn_domain IS NOT NULL
    `).all() as { name: string }[];
    if (used.some((row) => String(row.name).toLowerCase().replace(/\.$/, '') === name)) {
      throw new HttpError(409, 'Это имя уже используется нодой, мостом или входом через CDN. Выберите отдельный поддомен.');
    }
  }

  /**
   * Включить резервный домен: сертификат панели получает это имя (DNS-01), A-записи — IP мостов и панели (DNS only).
   * При ошибке настройки, сертификат и DNS возвращаются как были.
   */
  static async configure(input: FailoverInput): Promise<ReturnType<typeof FailoverService.status>> {
    let domain: string;
    try { domain = validateDomain(input.domain); }
    catch (err: any) { throw new HttpError(400, err.message); }
    this.assertDedicated(domain);
    if (input.include_panel !== undefined && typeof input.include_panel !== 'boolean') throw new HttpError(400, 'include_panel — true или false');
    let token: string;
    try { token = SslService.resolveCloudflareToken(input.token); }
    catch (err: any) { throw new HttpError(400, err.message); }
    if (input.email !== undefined && typeof input.email !== 'string') throw new HttpError(400, 'Email должен быть строкой');
    const email = (typeof input.email === 'string' && input.email.trim()) || getSetting('ssl_email');
    await ensurePanelOriginIp(input.origin_ip);
    const includePanel = input.include_panel === undefined ? getSetting('failover_include_panel') !== '0' : input.include_panel;
    const forwarding = (db.prepare("SELECT host FROM bridges WHERE panel_forward = 1").all() as { host: string }[]).filter((b) => net.isIPv4(b.host));
    if (!includePanel && forwarding.length === 0) {
      throw new HttpError(400, 'Нет адресов для резервного домена: включите пересылку панели на мосту с IPv4-адресом или оставьте прямой адрес панели.');
    }

    await SslService.exclusive(async () => {
      let zones: { id: string; name: string }[];
      try { zones = await SslService.getCloudflareZones(token); }
      catch { throw new HttpError(400, 'Не удалось прочитать зоны Cloudflare. Проверьте токен и право Zone:Read.'); }
      const zoneOf = (name: string) => zones.filter((z) => name === z.name || name.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
      const zone = zoneOf(domain);
      if (!zone || !CF_ID_RE.test(zone.id)) throw new HttpError(400, 'DNS-зона домена не найдена в Cloudflare. Нужны права Zone:Read и DNS:Edit.');

      // Чужие адресные записи имени не перезаписываем: свободно или только наши A-записи
      const owned = new Set(Object.values(readRecords()));
      const records = await this.api(token, `/zones/${zone.id}/dns_records?name=${encodeURIComponent(domain)}&per_page=100`);
      if (!Array.isArray(records) || records.length >= 100) throw new HttpError(502, 'Cloudflare вернул некорректный список DNS-записей');
      const addresses = records.filter((r: any) => ['A', 'AAAA', 'CNAME'].includes(r.type));
      if (addresses.some((r: any) => !(r.type === 'A' && owned.has(r.id) && getSetting('failover_domain') === domain))) {
        throw new HttpError(409, 'Для этого имени уже есть адресные записи. Выберите свободный поддомен; записи не изменены.');
      }
      if (records.some((r: any) => r.proxied === true)) throw new HttpError(409, 'Имя проксируется Cloudflare — нужен поддомен без оранжевого облака.');

      // Сертификат панели должен покрывать резервное имя: TLS через мост завершается на панели
      const tls = SslService.snapshot();
      const settings = Object.fromEntries(KEYS.map((key) => [key, getSetting(key)]));
      try {
        if (!SslService.coversDomain(domain)) {
          if (!email) throw new HttpError(400, 'Для выпуска сертификата укажите email Let’s Encrypt');
          const status = SslService.getStatus();
          const hasDomainCert = status.enabled && status.hasCert && status.domain && status.mode !== 'selfsigned_ip';
          if (hasDomainCert && status.mode !== 'letsencrypt_cf' && !zoneOf(String(status.domain))) {
            throw new HttpError(400, 'Сертификат панели выпущен не через Cloudflare, а зоны его домена нет в аккаунте — добавить резервное имя нельзя. Выпустите сертификат через Cloudflare (DNS-01).');
          }
          setSetting('ssl_alt_names', JSON.stringify([...new Set([...SslService.altNames(), domain])]));
          try {
            await SslService.issueLetsEncryptCloudflare(hasDomainCert ? String(status.domain) : domain, email, token, false, false);
          } catch {
            throw new HttpError(502, 'Не удалось выпустить сертификат с резервным именем. Проверьте email и право токена DNS:Edit; прежний HTTPS восстановлен.');
          }
        }
        transaction(() => {
          setSetting('failover_domain', domain);
          setSetting('failover_zone', zone.id);
          if (input.include_panel !== undefined) setSetting('failover_include_panel', input.include_panel ? '1' : '0');
          if (settings.failover_domain !== domain) setSetting('failover_records', '{}');
          setSetting('cf_token', encryptSecret(token));
          if (email) setSetting('ssl_email', email);
          setSetting('failover_error', null);
        });
        await this.reconcileLocked(token, true);
      } catch (error) {
        // Откат: наши новые записи удаляются, настройки и сертификат — прежние
        await this.deleteAll(token).catch(() => {});
        SslService.restore(tls);
        transaction(() => { for (const [key, value] of Object.entries(settings)) setSetting(key, value); });
        throw error;
      }
    });
    EventService.log('info', 'failover.configured', `Резервный домен подписок ${domain}`);
    return this.status();
  }

  /** Привести A-записи к нужному набору адресов (фоново после проверки мостов и при изменениях моста) */
  static async reconcile(): Promise<void> {
    if (!this.enabled()) return;
    const desired = this.desiredIps();
    const published = Object.keys(readRecords());
    // Без изменений — без обращения к Cloudflare. Пустой набор не публикуем: лучше прежние адреса, чем пустой DNS
    if (desired.length === 0 || (desired.length === published.length && desired.every((ip) => published.includes(ip)))) return;
    let token: string;
    try { token = SslService.resolveCloudflareToken(); }
    catch (err: any) { setSetting('failover_error', err.message); return; }
    await SslService.exclusive(() => this.reconcileLocked(token, false)).catch((err: any) => {
      setSetting('failover_error', `Не удалось обновить DNS резервного домена: ${err.message}`);
    });
    LiveService.notify();
  }

  private static async reconcileLocked(token: string, strict: boolean): Promise<void> {
    const domain = getSetting('failover_domain');
    const zone = getSetting('failover_zone');
    if (!domain || !zone || !CF_ID_RE.test(zone)) return;
    const desired = this.desiredIps();
    if (desired.length === 0 && !strict) return;
    const records = readRecords();
    const base = `/zones/${zone}/dns_records`;
    for (const ip of desired) {
      if (records[ip]) continue;
      const record = await this.api(token, base, {
        method: 'POST', body: JSON.stringify({ type: 'A', name: domain, content: ip, proxied: false, ttl: RECORD_TTL }),
      });
      if (!record?.id || !CF_ID_RE.test(record.id) || record.proxied === true) throw new HttpError(502, 'Cloudflare не подтвердил DNS-запись');
      records[ip] = record.id;
      setSetting('failover_records', JSON.stringify(records));
    }
    for (const [ip, id] of Object.entries(records)) {
      if (desired.includes(ip)) continue;
      await this.deleteOwned(token, zone, domain, ip, id);
      delete records[ip];
      setSetting('failover_records', JSON.stringify(records));
    }
    setSetting('failover_error', null);
  }

  /** Удаляет запись, только если она всё ещё наша: то же имя, тип A и адрес */
  private static async deleteOwned(token: string, zone: string, domain: string, ip: string, id: string): Promise<void> {
    const path = `/zones/${zone}/dns_records/${id}`;
    let current: any = null;
    try { current = await this.api(token, path); }
    catch { return; }
    if (current?.type === 'A' && current?.name === domain && current?.content === ip) await this.api(token, path, { method: 'DELETE' });
  }

  private static async deleteAll(token: string): Promise<void> {
    const domain = getSetting('failover_domain');
    const zone = getSetting('failover_zone');
    if (!domain || !zone || !CF_ID_RE.test(zone)) return;
    const records = readRecords();
    for (const [ip, id] of Object.entries(records)) {
      await this.deleteOwned(token, zone, domain, ip, id).catch(() => {});
      delete records[ip];
    }
    setSetting('failover_records', JSON.stringify(records));
  }

  /**
   * Выключить: наши A-записи удаляются, имя убирается из списка сертификата (уйдёт при продлении), ссылки подписок снова
   * строятся от публичного адреса панели. Пересылка панели на мостах остаётся — выключается в карточке моста.
   */
  static async disable(): Promise<ReturnType<typeof FailoverService.status>> {
    const domain = getSetting('failover_domain');
    if (!domain) return this.status();
    let warning: string | null = null;
    try {
      const token = SslService.resolveCloudflareToken();
      await SslService.exclusive(() => this.deleteAll(token));
    } catch {
      warning = 'Не удалось удалить DNS-записи в Cloudflare — удалите их вручную.';
    }
    transaction(() => {
      for (const key of KEYS) setSetting(key, null);
      setSetting('ssl_alt_names', JSON.stringify(SslService.altNames().filter((n) => n !== domain)));
      if (warning) setSetting('failover_error', warning);
    });
    EventService.log('info', 'failover.disabled', `Резервный домен подписок ${domain} отключён`);
    return this.status();
  }
}
