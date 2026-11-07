import net from 'node:net';
import { db, getSetting, setSetting, transaction } from '../db/index.js';
import { HttpError } from '../utils/http.js';
import { detectPublicIpv4 } from '../utils/net.js';
import { SslService, cfFetch } from './ssl.service.js';
import { EventService } from './event.service.js';
import { LiveService } from './live.service.js';

const CF_ID_RE = /^[a-f0-9]{32}$/i;
/** Сколько проверок подряд должны показать новый адрес, прежде чем автообновление его применит (защита от случайного ответа) */
const CONFIRMATIONS_FOR_AUTO = 2;

export interface AddressStep { ok: boolean; title: string; detail: string }

/**
 * Публичный IPv4 панели и всё, что от него зависит (docs/security.md#panel-ip):
 * A-запись домена панели в Cloudflare (`cf_panel_ip`), адрес, на который мосты пересылают «Панель через мост», и запись
 * прямого IP в резервном домене (`panel_origin_ip`), публичный адрес панели, если он задан IP.
 *
 * Фоновая проверка (`check`) сравнивает фактический адрес с известным: при расхождении — предупреждение в интерфейсе и журнале,
 * а с включённым автообновлением (`panel_ip_auto`) — применение после двух одинаковых ответов подряд. Применение (`apply`)
 * трогает только свои записи: A-запись меняется, лишь если она всё ещё указывает на прежний IP.
 */
export class PanelAddressService {
  /** Адрес, который панель считает своим (на него указывают DNS и мосты) */
  static known(): string | null {
    // Явный адрес → адрес домена в Cloudflare → публичный адрес панели, заданный IP → первый замеченный (установка без домена)
    for (const ip of [getSetting('panel_origin_ip'), getSetting('cf_panel_ip'), this.publicUrlHost(), getSetting('panel_ip_baseline')]) {
      if (ip && net.isIPv4(ip)) return ip;
    }
    return null;
  }

  /** Адрес, на который не удалось перевести A-запись домена панели (пока не получилось — домен ведёт на старый IP) */
  static dnsPending(): string | null {
    const ip = getSetting('panel_ip_dns_pending');
    return ip && net.isIPv4(ip) ? ip : null;
  }

  static status() {
    const detected = getSetting('panel_ip_detected');
    const known = this.known();
    return {
      known,
      detected: detected && net.isIPv4(detected) ? detected : null,
      changed: Boolean(detected && known && detected !== known) || Boolean(this.dnsPending()),
      dns_pending: this.dnsPending(),
      auto: getSetting('panel_ip_auto') === '1',
      checked_at: getSetting('panel_ip_checked_at'),
      // Что зависит от адреса — чтобы было видно, что обновится
      uses: {
        cloudflare_domain: getSetting('cf_panel_enabled') === '1' ? getSetting('cf_panel_domain') : null,
        bridges: (db.prepare('SELECT COUNT(*) AS n FROM bridges WHERE panel_forward = 1').get() as { n: number }).n,
        failover_domain: getSetting('failover_domain'),
        public_url_by_ip: Boolean(known && this.publicUrlHost() === known),
        certificate_ip: getSetting('ssl_mode') === 'selfsigned_ip' && known && getSetting('ssl_domain') === known ? known : null,
      },
    };
  }

  private static publicUrlHost(): string | null {
    const url = getSetting('public_url');
    if (!url) return null;
    try { return new URL(url).hostname; } catch { return null; }
  }

  static setAuto(enabled: unknown): ReturnType<typeof PanelAddressService.status> {
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'auto — true или false');
    setSetting('panel_ip_auto', enabled ? '1' : '0');
    return this.status();
  }

  /**
   * Фоновая проверка (вызывающий проверяет `MigrationService.isBackgroundPaused()`). `detect` подменяется в тестах.
   */
  static async check(detect: () => Promise<string | null> = detectPublicIpv4): Promise<void> {
    const known = this.known();
    const detected = await detect();
    if (!detected || !net.isIPv4(detected)) return;
    setSetting('panel_ip_checked_at', new Date().toISOString());
    if (!known) {
      // Установка без домена и без заданного IP: запоминаем первый замеченный адрес, чтобы заметить его смену
      setSetting('panel_ip_baseline', detected);
      return;
    }
    if (detected === known) {
      // Прошлое применение не смогло обновить DNS из-за временной ошибки — автообновление повторяет попытку
      if (this.dnsPending() && getSetting('panel_ip_dns_retry') === '1' && getSetting('panel_ip_auto') === '1') {
        await this.apply(this.dnsPending()).catch((err: any) => {
          EventService.log('error', 'panel.ip_update_failed', `Не удалось автоматически обновить IP панели: ${err.message}`);
        });
        return;
      }
      if (getSetting('panel_ip_detected')) {
        transaction(() => { setSetting('panel_ip_detected', null); setSetting('panel_ip_streak', null); });
        LiveService.notify();
      }
      return;
    }
    const previous = getSetting('panel_ip_detected');
    const streak = previous === detected ? Number(getSetting('panel_ip_streak') || 1) + 1 : 1;
    transaction(() => { setSetting('panel_ip_detected', detected); setSetting('panel_ip_streak', String(streak)); });
    if (previous !== detected) {
      EventService.log('warning', 'panel.ip_changed', `Публичный IP панели изменился: был ${known}, сейчас ${detected}. Обновите адрес в «Безопасность → IP-адрес панели».`);
      LiveService.notify();
    }
    if (getSetting('panel_ip_auto') === '1' && streak >= CONFIRMATIONS_FOR_AUTO) {
      await this.apply(detected).catch((err: any) => {
        EventService.log('error', 'panel.ip_update_failed', `Не удалось автоматически обновить IP панели: ${err.message}`);
      });
    }
  }

  /**
   * Перевести всё на новый IP: A-запись домена панели в Cloudflare (только свою и только со старым IP), адрес пересылки мостов,
   * запись в резервном домене, публичный адрес панели, заданный IP. Возвращает отчёт по шагам.
   */
  static async apply(ipInput: unknown): Promise<{ ip: string; previous: string | null; steps: AddressStep[] }> {
    if (typeof ipInput !== 'string' || !net.isIPv4(ipInput.trim())) throw new HttpError(400, 'Укажите IPv4-адрес панели');
    const ip = ipInput.trim();
    let previous: string | null = null;
    const steps: AddressStep[] = [];

    await SslService.exclusive(async () => {
      previous = this.known(); // внутри очереди: два одновременных применения не должны видеть одно и то же «прежнее»
      let dnsFailed: 'retry' | 'manual' | null = null;
      // 1. A-запись домена панели в Cloudflare
      const zone = getSetting('cf_panel_zone');
      const record = getSetting('cf_panel_record');
      const domain = getSetting('cf_panel_domain');
      const recordIp = getSetting('cf_panel_ip');
      if (domain && zone && record && CF_ID_RE.test(zone) && CF_ID_RE.test(record)) {
        try {
          const token = SslService.resolveCloudflareToken();
          const path = `/zones/${zone}/dns_records/${record}`;
          const current = await cfFetch(token, path);
          const r = current?.result;
          if (current?.success !== true || r?.type !== 'A' || r?.name !== domain) {
            dnsFailed = 'manual';
            steps.push({ ok: false, title: `DNS ${domain}`, detail: 'запись не найдена или изменена вне панели — обновите её в Cloudflare вручную' });
          } else if (r.content === ip) {
            setSetting('cf_panel_ip', ip);
            steps.push({ ok: true, title: `DNS ${domain}`, detail: `уже указывает на ${ip}` });
          } else if (r.content !== recordIp) {
            dnsFailed = 'manual';
            steps.push({ ok: false, title: `DNS ${domain}`, detail: `запись указывает на ${r.content}, а не на прежний IP панели — не трогаю, проверьте в Cloudflare` });
          } else {
            const updated = await cfFetch(token, path, { method: 'PATCH', body: JSON.stringify({ content: ip }) });
            if (updated?.success !== true || updated?.result?.content !== ip) throw new Error('Cloudflare не подтвердил изменение');
            setSetting('cf_panel_ip', ip);
            steps.push({ ok: true, title: `DNS ${domain}`, detail: `${recordIp} → ${ip} (оранжевое облако сохранено)` });
          }
        } catch (err: any) {
          dnsFailed = 'retry';
          steps.push({ ok: false, title: `DNS ${domain}`, detail: `ошибка Cloudflare: ${err.message}` });
        }
      }

      // Пока DNS не переведён, адрес считается неприменённым: баннер остаётся, кнопка доступна, автообновление повторит попытку
      setSetting('panel_ip_dns_pending', dnsFailed ? ip : null);
      setSetting('panel_ip_dns_retry', dnsFailed === 'retry' ? '1' : null);

      // 2. Публичный адрес панели, заданный IP
      const host = this.publicUrlHost();
      if (previous && host === previous) {
        const url = new URL(getSetting('public_url')!);
        url.hostname = ip;
        setSetting('public_url', url.toString().replace(/\/+$/, ''));
        steps.push({ ok: true, title: 'Публичный адрес панели', detail: `${url.toString().replace(/\/+$/, '')} — выданные ранее ссылки с ${previous} перестанут работать, раздайте новые` });
      }

      // 3. Самоподписанный сертификат на прежний IP: редирект HTTP → HTTPS и сертификат должны указывать на новый адрес
      if (previous && getSetting('ssl_mode') === 'selfsigned_ip' && getSetting('ssl_domain') === previous) {
        try {
          await SslService.generateSelfSignedIpCert(ip);
          steps.push({ ok: true, title: 'Сертификат HTTPS', detail: `самоподписанный сертификат перевыпущен на ${ip} (браузер спросит доверие заново)` });
        } catch (err: any) {
          steps.push({ ok: false, title: 'Сертификат HTTPS', detail: `не удалось перевыпустить сертификат на ${ip}: ${err.message}` });
        }
      }

      // 4. Адрес для мостов и резервного домена
      transaction(() => {
        setSetting('panel_ip_baseline', ip);
        setSetting('panel_origin_ip', ip);
        setSetting('panel_ip_detected', null);
        setSetting('panel_ip_streak', null);
      });
    });

    // Вне SslService.exclusive: сверка резервного домена сама берёт эту очередь
    const bridges = db.prepare('SELECT id, name, status FROM bridges WHERE panel_forward = 1').all() as any[];
    if (bridges.length) {
      const { BridgeService } = await import('./bridge.service.js');
      for (const b of bridges) {
        if (b.status === 'uninstalled') continue;
        const result = await BridgeService.requestApply(b.id);
        steps.push({ ok: result.success, title: `Мост «${b.name}»`, detail: result.success ? `пересылает панель на ${ip}` : `правила не применены: ${result.error}` });
      }
    }
    if (getSetting('failover_domain')) {
      const { FailoverService } = await import('./failover.service.js');
      await FailoverService.reconcile();
      // Пустой набор не публикуется намеренно; иначе опубликованные записи должны совпасть с нужными (ошибка могла остаться от прошлого раза)
      const desired = FailoverService.desiredIps();
      const published = FailoverService.status().published;
      const synced = desired.length === 0 || (desired.length === published.length && desired.every((a) => published.includes(a)));
      const error = getSetting('failover_error');
      steps.push({
        ok: synced,
        title: `Резервный домен ${getSetting('failover_domain')}`,
        detail: synced ? 'адреса обновлены' : (error ?? 'опубликованные записи не совпадают с нужными — проверьте резервный домен'),
      });
    }
    if (steps.length === 0) steps.push({ ok: true, title: 'Адрес сохранён', detail: 'от IP панели пока ничего не зависит' });

    EventService.log(steps.every((s) => s.ok) ? 'info' : 'warning', 'panel.ip_updated', `IP панели обновлён: ${previous ?? '—'} → ${ip}`);
    LiveService.notify();
    return { ip, previous, steps };
  }
}
