import net from 'node:net';
import { shellQuote } from '../utils/net.js';
import { DEFAULT_REALITY_TARGETS } from '../utils/vless-params.js';
import { ProvisionService, runExclusive } from './provision.service.js';
import { SshService } from './ssh.service.js';
import { HttpError } from '../utils/http.js';
import { db } from '../db/index.js';

export interface RealityCandidateResult {
  domain: string;
  latency_ms: number | null;
  suitable: boolean;
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

/**
 * Строгая валидация доменного имени:
 * - не URL, не IP, без порта, без схемы, без путей и спецсимволов.
 */
export function isValidDnsDomain(val: unknown): val is string {
  if (typeof val !== 'string') return false;
  const s = val.trim().toLowerCase();
  if (!s || s.length > 253) return false;
  if (net.isIP(s)) return false;
  if (s.includes('/') || s.includes(':') || s.includes('?') || s.includes('#') || s.includes('@')) return false;
  return HOSTNAME_RE.test(s);
}

/**
 * Проверка публичного IP-адреса:
 * исключает loopback, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 0.0.0.0/8, 224.0.0.0/4,
 * а также IPv6 loopback (::1, ::), fc00::/7 (unique local), fe80::/10 (link-local).
 */
export function isPublicIp(ip: string | null | undefined): boolean {
  if (!ip || typeof ip !== 'string') return false;
  const trimmed = ip.trim();
  if (net.isIPv4(trimmed)) {
    const parts = trimmed.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
    const [a, b] = parts;
    if (a === 0) return false; // 0.0.0.0/8
    if (a === 127) return false; // 127.0.0.0/8 loopback
    if (a === 10) return false; // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return false; // 192.168.0.0/16 private
    if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local
    if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 carrier-grade NAT
    if (a >= 224) return false; // 224.0.0.0/4 multicast & reserved
    return true;
  }
  if (net.isIPv6(trimmed)) {
    const lower = trimmed.toLowerCase();
    if (lower === '::1' || lower === '::') return false;
    // ::ffff:a.b.c.d — тот же IPv4-адрес в записи IPv6
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (mapped) return isPublicIp(mapped[1]);
    // fe80::/10 link-local
    const firstHextet = Number.parseInt(lower.split(':')[0] || '0', 16);
    if ((firstHextet & 0xffc0) === 0xfe80) return false;
    // fc00::/7 unique local
    if ((firstHextet & 0xfe00) === 0xfc00) return false;
    return true;
  }
  return false;
}

/**
 * Разбор вывода SSH-проверки кандидатов.
 * Вывод ноды — недоверенные данные: строгий разбор.
 */
export function parseCandidatesStdout(stdout: string, expectedDomains: string[]): RealityCandidateResult[] {
  const byDomain = new Map<string, RealityCandidateResult>();
  const expectedSet = new Set(expectedDomains.map((d) => d.toLowerCase()));
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const [domain, httpVersion, timeSecStr, exitCodeStr, remoteIp] = parts;
    const dLower = domain.toLowerCase();

    // Разрешаем только ожидаемые домены и строго один раз (дубли отбрасываем)
    if (!expectedSet.has(dLower) || byDomain.has(dLower)) continue;

    const exitCode = Number.parseInt(exitCodeStr, 10);
    const timeSec = Number.parseFloat(timeSecStr);

    const isExitOk = Number.isInteger(exitCode) && exitCode === 0;
    const isHttp2 = httpVersion === '2' || httpVersion === '2.0';
    const isPublic = isPublicIp(remoteIp);
    const isValidTime = Number.isFinite(timeSec) && timeSec >= 0 && timeSec <= 60;

    const suitable = isExitOk && isHttp2 && isPublic && isValidTime;
    const latency_ms = suitable ? Math.max(1, Math.round(timeSec * 1000)) : null;

    byDomain.set(dLower, {
      domain: dLower,
      latency_ms,
      suitable,
    });
  }

  // Для любого ожидаемого домена, отсутствовавшего в ответе или не разобранного
  return expectedDomains.map((d) => {
    const found = byDomain.get(d.toLowerCase());
    return found ?? { domain: d.toLowerCase(), latency_ms: null, suitable: false };
  });
}

/**
 * Скрипт проверки для одного SSH-вызова. Строка на домен: `domain<TAB>http_version<TAB>time_total<TAB>exit_code<TAB>remote_ip`
 * — в том же порядке, в каком её читает `parseCandidatesStdout`. Домены — только после `isValidDnsDomain`, в `shellQuote`.
 */
export function buildCandidatesScript(domains: string[]): string {
  return [
    'if ! command -v curl >/dev/null 2>&1; then echo ERR_NO_CURL; exit 0; fi',
    'if ! curl -V 2>/dev/null | grep -i -q HTTP2; then echo ERR_NO_HTTP2; exit 0; fi',
    `for d in ${domains.map((d) => shellQuote(d)).join(' ')}; do`,
    // Код завершения curl (0) стоит в write-out перед адресом: при успехе строка уже в нужном порядке полей
    '  res=$(curl -sS --tlsv1.3 --tls-max 1.3 --http2 --proto =https --connect-timeout 3 --max-time 6 --output /dev/null --write-out "%{http_version}\t%{time_total}\t0\t%{remote_ip}" "https://$d:443" 2>/dev/null)',
    '  ec=$?',
    '  if [ $ec -eq 0 ]; then',
    '    printf "%s\t%s\n" "$d" "$res"',
    '  else',
    '    printf "%s\t0\t0\t%s\t-\n" "$d" "$ec"',
    '  fi',
    'done',
  ].join('\n');
}

export class RealityTargetsService {
  /**
   * Проверка списка сайтов-кандидатов маскировки Reality с ноды по SSH.
   */
  static async checkCandidates(serverId: number, extraDomain?: string): Promise<{ candidates: RealityCandidateResult[] }> {
    return runExclusive(serverId, async () => {
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
      if (!server || server.remote_panel_id !== null) {
        throw new HttpError(404, 'Сервер не найден');
      }

      const domains: string[] = [...DEFAULT_REALITY_TARGETS];
      if (extraDomain) {
        const clean = extraDomain.trim().toLowerCase();
        if (clean && !domains.includes(clean as any)) {
          domains.push(clean);
        }
      }

      const creds = ProvisionService.getCredentials(server);

      // Внутренний скрипт для одного SSH-вызова:
      // 1. Проверяем наличие curl и поддержку HTTP2
      // 2. Для каждого домена вызываем curl с TLS 1.3 и HTTP/2
      // Выводим строго: domain<TAB>http_version<TAB>time_total<TAB>exit_code<TAB>remote_ip
      const checkScript = buildCandidatesScript(domains);

      const result = await SshService.executeCommand(creds, `sh -c ${shellQuote(checkScript)}`, {
        timeoutMs: 30000,
        maxOutputBytes: 64 * 1024,
      });

      if (result.code !== 0 && !result.stdout.includes('ERR_NO_')) {
        throw new HttpError(500, 'Не удалось выполнить проверку кандидатов на сервере');
      }

      if (result.stdout.includes('ERR_NO_CURL')) {
        throw new HttpError(400, 'На сервере не установлен curl');
      }
      if (result.stdout.includes('ERR_NO_HTTP2')) {
        throw new HttpError(400, 'Установленный на сервере curl не поддерживает HTTP/2');
      }

      const candidates = parseCandidatesStdout(result.stdout, domains);
      return { candidates };
    });
  }
}
