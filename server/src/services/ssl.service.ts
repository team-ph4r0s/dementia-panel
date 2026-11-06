import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { getSetting, setSetting } from '../db/index.js';
import { sslDir } from '../config.js';
import { decryptSecret, encryptSecret } from './secrets.service.js';
import * as acme from 'acme-client';
import { generate as generateSelfSigned } from 'selfsigned';

export const certPath = path.join(sslDir, 'fullchain.pem');
export const keyPath = path.join(sslDir, 'privkey.pem');
export const accountKeyPath = path.join(sslDir, 'acme-account.key');

const RENEW_BEFORE_DAYS = 30;

// In-memory challenge store for HTTP-01
export const http01Challenges = new Map<string, string>();

export interface SslStatus {
  enabled: boolean;
  hasCert: boolean;
  domain: string | null;
  mode: string | null;
  expiresAt: string | null;
  autoRenew: boolean;
  cfTokenSaved: boolean;
  email: string | null;
}

const TLS_SETTINGS = ['ssl_enabled', 'ssl_mode', 'ssl_domain', 'ssl_expires_at', 'ssl_email', 'cf_token', 'ssl_alt_names'] as const;
let tlsQueue: Promise<unknown> = Promise.resolve();

type CertificateListener = () => void;
const listeners: CertificateListener[] = [];

export function validateDomain(domain: unknown): string {
  const clean = String(domain ?? '').trim().toLowerCase();
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(clean)) {
    throw new Error('Укажите корректное доменное имя');
  }
  return clean;
}

function validateEmail(email: unknown): string {
  const clean = String(email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error('Укажите корректный email');
  return clean;
}

export async function cfFetch(token: string, url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${url}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  return res.json();
}

/**
 * Проверка сертификата и ключа; возвращает дату окончания и основное имя
 */
function inspectCertificate(certPem: string, keyPem: string): { validTo: string; subject: string } {
  let x509: crypto.X509Certificate;
  let key: crypto.KeyObject;
  try {
    x509 = new crypto.X509Certificate(certPem);
    key = crypto.createPrivateKey(keyPem);
  } catch {
    throw new Error('Некорректный формат сертификата или ключа (ожидается PEM)');
  }
  if (!x509.checkPrivateKey(key)) {
    throw new Error('Приватный ключ не соответствует сертификату');
  }
  const validTo = new Date(x509.validTo);
  if (validTo.getTime() <= Date.now()) {
    throw new Error('Срок действия сертификата истёк');
  }
  // Имя берётся из CN, а у сертификатов без CN (современный Let's Encrypt) — из первого имени SAN
  const san = /(?:DNS:|IP Address:)([^,\s]+)/.exec(x509.subjectAltName ?? '')?.[1];
  const cn = /CN=([^\n,]+)/.exec(x509.subject)?.[1] ?? san ?? 'custom';
  return { validTo: validTo.toISOString(), subject: cn };
}

export class SslService {
  /** Certificate mutations and panel-domain setup share a lock, including automatic renewal. */
  static exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = tlsQueue.catch(() => {}).then(fn);
    tlsQueue = next.catch(() => {});
    return next;
  }

  static resolveCloudflareToken(input?: unknown): string {
    if (input !== undefined && typeof input !== 'string') throw new Error('Токен Cloudflare должен быть строкой');
    const token = typeof input === 'string' ? input.trim() : '';
    const value = token || this.getSavedCloudflareToken();
    if (!value) throw new Error(getSetting('cf_token') ? 'Не удалось прочитать сохранённый токен Cloudflare. Введите его заново.' : 'Укажите токен Cloudflare');
    if (/[\r\n]/.test(value) || value.length > 4096) throw new Error('Некорректный токен Cloudflare');
    return value;
  }

  /** In-memory rollback only: never returned by an API or logged. */
  static snapshot() {
    return {
      settings: Object.fromEntries(TLS_SETTINGS.map((key) => [key, getSetting(key)])),
      cert: fs.existsSync(certPath) ? fs.readFileSync(certPath) : null,
      key: fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : null,
    };
  }

  static restore(snapshot: ReturnType<typeof SslService.snapshot>): void {
    for (const [file, value] of [[certPath, snapshot.cert], [keyPath, snapshot.key]] as const) {
      if (value) fs.writeFileSync(file, value, { mode: file === keyPath ? 0o600 : 0o644 });
      else fs.rmSync(file, { force: true });
    }
    for (const [key, value] of Object.entries(snapshot.settings)) setSetting(key, value);
    for (const listener of listeners) listener();
  }

  static coversDomain(domain: string): boolean {
    if (!this.isActive() || getSetting('ssl_mode') === 'selfsigned_ip') return false;
    try {
      const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
      return Boolean(cert.checkHost(domain)) && Date.parse(cert.validTo) > Date.now();
    } catch { return false; }
  }
  static onCertificateChanged(listener: CertificateListener): void {
    listeners.push(listener);
  }

  private static saveCertificate(certPem: string, keyPem: string, mode: string, domain: string, extra: Record<string, string | null> = {}) {
    const info = inspectCertificate(certPem, keyPem);
    fs.writeFileSync(keyPath, keyPem.trim() + '\n', { mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
    fs.writeFileSync(certPath, certPem.trim() + '\n', { mode: 0o644 });

    setSetting('ssl_enabled', '1');
    setSetting('ssl_mode', mode);
    setSetting('ssl_domain', domain || info.subject);
    setSetting('ssl_expires_at', info.validTo);
    for (const [key, value] of Object.entries(extra)) setSetting(key, value);

    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error('Ошибка применения нового сертификата:', err);
      }
    }
  }

  /** Дополнительные имена сертификата панели (резервный домен подписок) */
  static altNames(): string[] {
    try {
      const parsed = JSON.parse(getSetting('ssl_alt_names') || '[]');
      return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
    } catch {
      return [];
    }
  }

  static hasCertificate(): boolean {
    return fs.existsSync(certPath) && fs.existsSync(keyPath);
  }

  static isActive(): boolean {
    return getSetting('ssl_enabled') === '1' && this.hasCertificate();
  }

  static readCertificate(): { cert: Buffer; key: Buffer } {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  }

  /**
   * Get current SSL status and configuration
   */
  static getStatus(): SslStatus {
    const mode = getSetting('ssl_mode');
    return {
      enabled: getSetting('ssl_enabled') === '1',
      hasCert: this.hasCertificate(),
      domain: getSetting('ssl_domain'),
      mode,
      expiresAt: getSetting('ssl_expires_at'),
      autoRenew: mode === 'letsencrypt_cf' || mode === 'letsencrypt_http',
      cfTokenSaved: Boolean(getSetting('cf_token')),
      email: getSetting('ssl_email'),
    };
  }

  /**
   * Verify Cloudflare API token
   */
  static async verifyCloudflareToken(token: string): Promise<{ valid: boolean; message: string }> {
    try {
      const data = await cfFetch(token, '/user/tokens/verify');
      if (data.success && data.result?.status === 'active') {
        return { valid: true, message: 'Токен Cloudflare успешно подтвержден!' };
      }
      return { valid: false, message: data.errors?.[0]?.message || 'Токен Cloudflare недействителен' };
    } catch (err: any) {
      return { valid: false, message: `Ошибка проверки токена: ${err.message}` };
    }
  }

  /**
   * Get list of Cloudflare zones accessible with this token
   */
  static async getCloudflareZones(token: string): Promise<{ id: string; name: string }[]> {
    const data = await cfFetch(token, '/zones?status=active&per_page=50');
    if (!data.success) {
      throw new Error(data.errors?.[0]?.message || 'Не удалось получить список зон Cloudflare');
    }
    return (data.result || []).map((z: any) => ({ id: z.id, name: z.name }));
  }

  /**
   * ACME-аккаунт сохраняется между выпусками, чтобы не упираться в лимиты Let's Encrypt
   */
  private static async getAcmeClient(): Promise<acme.Client> {
    let accountKey: Buffer;
    if (fs.existsSync(accountKeyPath)) {
      accountKey = fs.readFileSync(accountKeyPath);
    } else {
      accountKey = await acme.crypto.createPrivateKey();
      fs.writeFileSync(accountKeyPath, accountKey, { mode: 0o600 });
    }
    return new acme.Client({ directoryUrl: acme.directory.letsencrypt.production, accountKey });
  }

  /**
   * Automatically issue Let's Encrypt certificate using Cloudflare DNS-01 API
   */
  static async issueLetsEncryptCloudflare(
    domain: string,
    email: string,
    cfToken: string,
    createARecord = true,
    persistToken = true
  ): Promise<{ success: boolean; error?: string }> {
    const cleanDomain = validateDomain(domain);
    const cleanEmail = validateEmail(email);

    // 1. Find matching Cloudflare Zone (самое длинное совпадение)
    const zones = await this.getCloudflareZones(cfToken);
    const matchedZone = zones
      .filter((z) => cleanDomain === z.name || cleanDomain.endsWith('.' + z.name))
      .sort((a, b) => b.name.length - a.name.length)[0];

    if (!matchedZone) {
      throw new Error(
        `Зона для домена ${cleanDomain} не найдена в вашем аккаунте Cloudflare. Убедитесь, что домен добавлен в Cloudflare.`
      );
    }

    // 2. Optional: Automatically add/update DNS A-record to this server's public IP
    if (createARecord) {
      try {
        const publicIpRes = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) });
        const { ip } = (await publicIpRes.json()) as any;
        if (net.isIPv4(ip)) {
          const existing = await cfFetch(
            cfToken,
            `/zones/${matchedZone.id}/dns_records?type=A&name=${encodeURIComponent(cleanDomain)}`
          );
          // Reissuing a certificate must never turn off the panel's orange cloud.
          const proxied = existing.result?.[0]?.proxied === true ||
            (getSetting('cf_panel_enabled') === '1' && getSetting('cf_panel_domain') === cleanDomain);
          const record = { type: 'A', name: cleanDomain, content: ip, proxied, ttl: proxied ? 1 : 120 };
          if (existing.result && existing.result.length > 0) {
            await cfFetch(cfToken, `/zones/${matchedZone.id}/dns_records/${existing.result[0].id}`, {
              method: 'PUT',
              body: JSON.stringify(record),
            });
          } else {
            await cfFetch(cfToken, `/zones/${matchedZone.id}/dns_records`, { method: 'POST', body: JSON.stringify(record) });
          }
        }
      } catch (e) {
        console.warn('Не удалось автоматически создать A-запись в Cloudflare (продолжаем DNS-01 challenge):', e);
      }
    }

    // 3. Request ACME certificate via DNS-01. Дополнительные имена (резервный домен подписок, FailoverService) — в том же
    // сертификате: продление их сохраняет. Имя без зоны в аккаунте пропускается, чтобы не сорвать выпуск основного
    const extra = this.altNames()
      .filter((name) => name !== cleanDomain)
      .map((name) => ({ name, zone: zones.filter((z) => name === z.name || name.endsWith('.' + z.name)).sort((a, b) => b.name.length - a.name.length)[0] }))
      .filter((entry) => entry.zone)
      .map((entry) => ({ name: entry.name, zoneId: entry.zone!.id }));
    const { cert, key } = await this.obtainDns01Certificate(cleanDomain, cleanEmail, cfToken, matchedZone.id, extra);

    this.saveCertificate(cert, key, 'letsencrypt_cf', cleanDomain, {
      ssl_email: cleanEmail,
      ...(persistToken ? { cf_token: encryptSecret(cfToken) } : {}),
    });
    return { success: true };
  }

  /**
   * Сертификат Let's Encrypt для имени через DNS-01 в зоне Cloudflare — без сохранения: его использует и сертификат панели,
   * и вход через CDN на нодах VLESS (CdnService). TXT-записи удаляются после проверки.
   */
  static async obtainDns01Certificate(
    domain: string,
    email: string,
    cfToken: string,
    zoneId: string,
    extra: { name: string; zoneId: string }[] = []
  ): Promise<{ cert: string; key: string }> {
    const cleanDomain = validateDomain(domain);
    const cleanEmail = validateEmail(email);
    const zoneOf = new Map(extra.map((e) => [validateDomain(e.name), e.zoneId]));
    const client = await this.getAcmeClient();
    const [key, csr] = await acme.crypto.createCsr(
      zoneOf.size ? { commonName: cleanDomain, altNames: [cleanDomain, ...zoneOf.keys()] } : { commonName: cleanDomain }
    );
    const createdRecordIds = new Map<string, string>();
    const zonesByToken = new Map<string, string>();

    const cert = await client.auto({
      csr,
      email: cleanEmail,
      termsOfServiceAgreed: true,
      challengePriority: ['dns-01'],
      challengeCreateFn: async (authz, challenge, keyAuthorization) => {
        if (challenge.type !== 'dns-01') return;
        const challengeZone = zoneOf.get(authz.identifier.value) ?? zoneId;
        zonesByToken.set(challenge.token, challengeZone);
        const cfData = await cfFetch(cfToken, `/zones/${challengeZone}/dns_records`, {
          method: 'POST',
          body: JSON.stringify({
            type: 'TXT',
            name: `_acme-challenge.${authz.identifier.value}`,
            content: keyAuthorization,
            ttl: 120,
          }),
        });
        if (!cfData.success) {
          throw new Error(cfData.errors?.[0]?.message || 'Не удалось создать TXT-запись в Cloudflare');
        }
        createdRecordIds.set(challenge.token, cfData.result.id);
        // Wait for DNS propagation across Cloudflare authoritative servers
        await new Promise((r) => setTimeout(r, 15000));
      },
      challengeRemoveFn: async (authz, challenge) => {
        const recId = createdRecordIds.get(challenge.token);
        if (recId) {
          await cfFetch(cfToken, `/zones/${zonesByToken.get(challenge.token) ?? zoneId}/dns_records/${recId}`, { method: 'DELETE' }).catch(() => {});
        }
      },
    });

    return { cert, key: key.toString() };
  }

  /**
   * Let's Encrypt проверяет HTTP-01 только на 80 порту. Если панель слушает другой порт,
   * на время выпуска поднимается вспомогательный HTTP-сервер на 80.
   */
  private static async withPort80<T>(fn: () => Promise<T>): Promise<T> {
    if (Number(process.env.PORT) === 80) return fn();

    const helper = http.createServer((req, res) => {
      const match = /^\/\.well-known\/acme-challenge\/([\w-]+)$/.exec(req.url || '');
      const keyAuth = match ? http01Challenges.get(match[1]) : undefined;
      if (keyAuth) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(keyAuth);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve, reject) => {
      helper.once('error', (err: any) =>
        reject(
          new Error(
            err.code === 'EADDRINUSE'
              ? 'Порт 80 занят другим процессом — HTTP-01 невозможен. Освободите порт 80 или используйте Cloudflare DNS-01.'
              : `Не удалось открыть порт 80: ${err.message}`
          )
        )
      );
      helper.listen(80, resolve);
    });

    try {
      return await fn();
    } finally {
      helper.close();
    }
  }

  /**
   * Issue Let's Encrypt certificate using HTTP-01 challenge (requires port 80 open)
   */
  static async issueLetsEncryptHttp(domain: string, email: string): Promise<{ success: boolean; error?: string }> {
    const cleanDomain = validateDomain(domain);
    const cleanEmail = validateEmail(email);

    const { cert, key } = await this.withPort80(async () => {
      const client = await this.getAcmeClient();
      const [key, csr] = await acme.crypto.createCsr({ commonName: cleanDomain });
      const cert = await client.auto({
        csr,
        email: cleanEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          if (challenge.type === 'http-01') http01Challenges.set(challenge.token, keyAuthorization);
        },
        challengeRemoveFn: async (authz, challenge) => {
          if (challenge.type === 'http-01') http01Challenges.delete(challenge.token);
        },
      });
      return { cert, key };
    });

    this.saveCertificate(cert, key.toString(), 'letsencrypt_http', cleanDomain, { ssl_email: cleanEmail });
    return { success: true };
  }

  /**
   * Generate self-signed certificate with IP or DNS SAN for accessing panel by IP
   */
  static async generateSelfSignedIpCert(ipOrDomain: string): Promise<{ success: boolean; error?: string }> {
    const target = String(ipOrDomain ?? '').trim();
    const isIp = net.isIP(target) !== 0;
    if (!isIp) validateDomain(target);

    const notAfterDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const pems = await generateSelfSigned([{ name: 'commonName', value: target }], {
      keySize: 2048,
      algorithm: 'sha256',
      notAfterDate,
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [isIp ? { type: 7, ip: target } : { type: 2, value: target }],
        },
      ],
    });

    this.saveCertificate(pems.cert, pems.private, 'selfsigned_ip', target);
    return { success: true };
  }

  /**
   * Save existing / custom certificate from uploaded strings
   */
  static saveCustomCertificate(certContent: string, keyContent: string, domain?: string): void {
    if (typeof certContent !== 'string' || typeof keyContent !== 'string') {
      throw new Error('Сертификат и ключ должны быть строками в формате PEM');
    }
    this.saveCertificate(certContent, keyContent, 'custom', domain?.trim() || '');
  }

  /**
   * Включает HTTPS на уже лежащем в data/ssl сертификате (перенос панели: сертификат приехал из архива). Режим выпуска,
   * домен и почта сохраняются, поэтому автопродление продолжает работать; дата окончания перечитывается из сертификата.
   */
  static activateExisting(): { domain: string | null; expiresAt: string } {
    if (!this.hasCertificate()) throw new Error('Сертификат не найден');
    const info = inspectCertificate(fs.readFileSync(certPath, 'utf-8'), fs.readFileSync(keyPath, 'utf-8'));
    if (!getSetting('ssl_domain')) setSetting('ssl_domain', info.subject);
    setSetting('ssl_expires_at', info.validTo);
    setSetting('ssl_enabled', '1');
    for (const listener of listeners) listener();
    return { domain: getSetting('ssl_domain'), expiresAt: info.validTo };
  }

  /** Удаляет сертификат и отключает HTTPS (токен Cloudflare и почта ACME сохраняются) */
  static clearCertificate(): void {
    for (const file of [certPath, keyPath]) fs.rmSync(file, { force: true });
    for (const key of ['ssl_enabled', 'ssl_mode', 'ssl_domain', 'ssl_expires_at']) setSetting(key, null);
    for (const listener of listeners) listener();
  }

  /** Токен Cloudflare, сохранённый при прежнем выпуске сертификата */
  static getSavedCloudflareToken(): string | null {
    try {
      return decryptSecret(getSetting('cf_token'));
    } catch {
      return null;
    }
  }

  /**
   * Toggle SSL on/off (применяется сразу, без перезапуска)
   */
  static toggleSsl(enabled: boolean): void {
    if (enabled && !this.hasCertificate()) {
      throw new Error('Сертификаты не найдены. Сначала выпустите или загрузите сертификат.');
    }
    setSetting('ssl_enabled', enabled ? '1' : '0');
    for (const listener of listeners) listener();
  }

  /**
   * Продление сертификата Let's Encrypt за 30 дней до окончания
   */
  static renewIfNeeded(): Promise<void> {
    return this.exclusive(() => this.doRenewIfNeeded());
  }

  private static async doRenewIfNeeded(): Promise<void> {
    const status = this.getStatus();
    if (!status.autoRenew || !status.hasCert || !status.domain) return;

    const expiresAt = status.expiresAt ? new Date(status.expiresAt).getTime() : 0;
    if (expiresAt - Date.now() > RENEW_BEFORE_DAYS * 24 * 60 * 60 * 1000) return;

    const email = getSetting('ssl_email');
    if (!email) {
      console.warn('[SSL] Продление невозможно: не сохранён email ACME-аккаунта. Выпустите сертификат заново.');
      return;
    }

    console.log(`[SSL] Продление сертификата для ${status.domain}...`);
    try {
      if (status.mode === 'letsencrypt_cf') {
        const token = decryptSecret(getSetting('cf_token'));
        if (!token) throw new Error('не сохранён токен Cloudflare');
        await this.issueLetsEncryptCloudflare(status.domain, email, token, false);
      } else {
        await this.issueLetsEncryptHttp(status.domain, email);
      }
      console.log('[SSL] Сертификат успешно продлён');
    } catch (err: any) {
      console.error(`[SSL] Ошибка продления сертификата: ${err.message}`);
    }
  }
}
