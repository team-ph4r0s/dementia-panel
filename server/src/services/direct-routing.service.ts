import { getSetting, setSetting } from '../db/index.js';
import { HttpError } from '../utils/http.js';
import { complementCidrs, isCidr6, mergeRanges, parseCidr4, type Range } from '../utils/cidr.js';

/**
 * «Напрямую, мимо VPN»: страны, домены и сети, трафик к которым клиент отправляет не через туннель (docs/direct-routing.md).
 *
 * Маршрутизация выполняется на устройстве пользователя, панель только раздаёт правила:
 * - mihomo/Clash: правила `DOMAIN-SUFFIX` / `GEOIP` / `IP-CIDR` → `DIRECT` (работает и для AWG, и для VLESS);
 * - AmneziaWG (.conf, `awg://`, JSON Incy): домены невозможны, `AllowedIPs` = весь IPv4 минус сети выбранных стран и свои сети.
 * Выдача подписок синхронная и не ходит в сеть: списки сетей стран скачиваются при сохранении настроек и по кнопке «Обновить».
 */

export interface DirectRoutingSettings {
  enabled: boolean;
  /** Коды стран ISO 3166-1 alpha-2 в нижнем регистре */
  countries: string[];
  /** Домены (суффиксы): `ru`, `example.com` */
  domains: string[];
  /** Свои сети IPv4/IPv6 */
  cidrs: string[];
  /** Исключать сети стран и свои IPv4 из AllowedIPs конфигов AmneziaWG */
  awg: boolean;
}

export interface DirectCountryStatus {
  country: string;
  /** Сколько сетей IPv4 в списке, 0 — список ещё не загружен */
  networks: number;
  updated_at: string | null;
}

export const MAX_DIRECT_COUNTRIES = 20;
export const MAX_DIRECT_ENTRIES = 500;
const COUNTRY_CODE = /^[a-z]{2}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GEO_SOURCE = 'https://www.ipdeny.com/ipblocks/data/aggregated';
const MAX_GEO_LINES = 30000;
const GEO_TIMEOUT_MS = 20000;

/** Национальный домен верхнего уровня, если он отличается от кода страны, и дополнительные домены страны */
const TLD_ALIASES: Record<string, string> = { gb: 'uk' };
const EXTRA_DOMAINS: Record<string, string[]> = { ru: ['su', 'xn--p1ai'] };

/** Домены страны, которые добавляются в правила вместе с её сетями (`.ru`, `.su`, `.рф` для России) */
export function countryDomains(country: string): string[] {
  return [TLD_ALIASES[country] ?? country, ...(EXTRA_DOMAINS[country] ?? [])];
}

function normalizeDomain(raw: string): string {
  let value = raw.trim().toLowerCase().replace(/^\*?\./, '').replace(/\.$/, '');
  if (!value) return '';
  if (/[^\x00-\x7f]/.test(value)) {
    try {
      value = new URL(`http://${value}`).hostname;
    } catch {
      throw new HttpError(400, `Некорректный домен: ${raw.trim().slice(0, 60)}`);
    }
  }
  if (!DOMAIN.test(value)) throw new HttpError(400, `Некорректный домен: ${raw.trim().slice(0, 60)}`);
  return value;
}

function normalizeCidr(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  const range = parseCidr4(value);
  if (range) {
    const bits = value.includes('/') ? Number(value.split('/')[1]) : 32;
    // Короче /8 — это, по сути, «весь интернет напрямую»
    if (bits < 8) throw new HttpError(400, `Сеть слишком большая (минимум /8): ${value}`);
    return value.includes('/') ? value : `${value}/32`;
  }
  if (isCidr6(value)) return value.toLowerCase();
  throw new HttpError(400, `Некорректная сеть: ${value.slice(0, 60)}`);
}

/** Список из массива или текста (по строкам и запятым), без пустых и повторов */
function toList(value: unknown, label: string, normalize: (item: string) => string): string[] {
  const items = Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[\s,;]+/);
  const out: string[] = [];
  for (const item of items) {
    const normalized = normalize(item);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  if (out.length > MAX_DIRECT_ENTRIES) throw new HttpError(400, `${label}: не больше ${MAX_DIRECT_ENTRIES} записей`);
  return out;
}

function parseStored(key: string): string[] {
  try {
    const parsed = JSON.parse(getSetting(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function readDirectRouting(): DirectRoutingSettings {
  return {
    enabled: getSetting('direct_enabled') === '1',
    countries: parseStored('direct_countries').filter((c) => COUNTRY_CODE.test(c)),
    domains: parseStored('direct_domains'),
    cidrs: parseStored('direct_cidrs'),
    awg: getSetting('direct_awg') === '1',
  };
}

/** Проверяет и сохраняет настройки; возвращает сохранённые и список стран, чьи сети нужно (пере)загрузить */
export function updateDirectRouting(body: Record<string, unknown>): { settings: DirectRoutingSettings; missing: string[] } {
  const next = readDirectRouting();
  if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
  if (body.awg !== undefined) next.awg = Boolean(body.awg);
  if (body.countries !== undefined) {
    if (!Array.isArray(body.countries)) throw new HttpError(400, 'countries должен быть массивом');
    const codes = body.countries.map((c) => String(c).trim().toLowerCase());
    if (codes.some((c) => !COUNTRY_CODE.test(c))) throw new HttpError(400, 'Страна задаётся двухбуквенным кодом ISO (например, ru)');
    next.countries = [...new Set(codes)];
    if (next.countries.length > MAX_DIRECT_COUNTRIES) throw new HttpError(400, `Можно выбрать не более ${MAX_DIRECT_COUNTRIES} стран`);
  }
  if (body.domains !== undefined) next.domains = toList(body.domains, 'Домены', normalizeDomain);
  if (body.cidrs !== undefined) next.cidrs = toList(body.cidrs, 'Сети', normalizeCidr);

  setSetting('direct_enabled', next.enabled ? '1' : null);
  setSetting('direct_awg', next.awg ? '1' : null);
  setSetting('direct_countries', next.countries.length ? JSON.stringify(next.countries) : null);
  setSetting('direct_domains', next.domains.length ? JSON.stringify(next.domains) : null);
  setSetting('direct_cidrs', next.cidrs.length ? JSON.stringify(next.cidrs) : null);
  invalidateAllowedIpsCache();
  return { settings: next, missing: next.countries.filter((c) => !getCountryNetworks(c)) };
}

// ── Сети стран ──────────────────────────────────────────────────────────

const geoKey = (country: string) => `geo_v4_${country}`;

/** Разбор списка сетей страны: только строгие IPv4 CIDR, остальное отбрасывается */
export function parseGeoList(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > MAX_GEO_LINES) throw new Error('Список сетей слишком большой');
  const out = lines.filter((l) => /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(l) && parseCidr4(l));
  if (!out.length) throw new Error('В ответе нет ни одной сети');
  return out;
}

export function getCountryNetworks(country: string): string[] | null {
  const raw = getSetting(geoKey(country));
  return raw ? raw.split('\n') : null;
}

export function countryStatuses(countries: string[]): DirectCountryStatus[] {
  return countries.map((country) => ({
    country,
    networks: getCountryNetworks(country)?.length ?? 0,
    updated_at: getSetting(`${geoKey(country)}_at`),
  }));
}

/** Скачивает сети страны (ipdeny.com, агрегированные зоны) и сохраняет. Бросает ошибку с понятным текстом. */
export async function refreshCountry(country: string): Promise<number> {
  if (!COUNTRY_CODE.test(country)) throw new HttpError(400, 'Некорректный код страны');
  let text: string;
  try {
    const res = await fetch(`${GEO_SOURCE}/${country}-aggregated.zone`, { signal: AbortSignal.timeout(GEO_TIMEOUT_MS) });
    if (!res.ok) throw new Error(res.status === 404 ? 'для этой страны списка нет' : `ответ ${res.status}`);
    text = await res.text();
  } catch (err: any) {
    throw new HttpError(502, `Не удалось загрузить сети страны ${country.toUpperCase()}: ${err?.message ?? 'нет связи'}`);
  }
  let networks: string[];
  try {
    networks = parseGeoList(text);
  } catch (err: any) {
    throw new HttpError(502, `Список сетей страны ${country.toUpperCase()} некорректен: ${err.message}`);
  }
  setSetting(geoKey(country), networks.join('\n'));
  setSetting(`${geoKey(country)}_at`, new Date().toISOString());
  invalidateAllowedIpsCache();
  return networks.length;
}

/** Загружает сети перечисленных стран; ошибки по странам возвращаются, а не прерывают остальные */
export async function refreshCountries(countries: string[]): Promise<{ country: string; error: string | null }[]> {
  const results: { country: string; error: string | null }[] = [];
  for (const country of countries) {
    try {
      await refreshCountry(country);
      results.push({ country, error: null });
    } catch (err: any) {
      results.push({ country, error: err.message });
    }
  }
  return results;
}

// ── Правила для клиентов ────────────────────────────────────────────────

/** Правила mihomo (до итогового `MATCH`), пусто — если функция выключена */
export function buildClashDirectRules(settings = readDirectRouting()): string[] {
  if (!settings.enabled) return [];
  const rules: string[] = [];
  const domains = new Set<string>();
  for (const country of settings.countries) countryDomains(country).forEach((d) => domains.add(d));
  settings.domains.forEach((d) => domains.add(d));
  for (const domain of domains) rules.push(`DOMAIN-SUFFIX,${domain},DIRECT`);
  for (const cidr of settings.cidrs) rules.push(`${cidr.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${cidr},DIRECT,no-resolve`);
  for (const country of settings.countries) rules.push(`GEOIP,${country.toUpperCase()},DIRECT,no-resolve`);
  return rules;
}

let allowedIpsCache: { key: string; value: string[] } | null = null;

export function invalidateAllowedIpsCache(): void {
  allowedIpsCache = null;
}

const FULL_IPV6 = '::/0';

/**
 * `AllowedIPs` клиентского конфига AmneziaWG. Без включённой функции (или без единой загруженной сети) — прежнее
 * `0.0.0.0/0, ::/0`. IPv6 всегда идёт через туннель (защита от утечки, docs/subscriptions.md).
 */
export function awgAllowedIps(settings = readDirectRouting()): string[] {
  if (!settings.enabled || !settings.awg) return ['0.0.0.0/0', FULL_IPV6];
  const sources = settings.countries.map((c) => getCountryNetworks(c)).filter((n): n is string[] => n !== null);
  const own = settings.cidrs.filter((c) => !c.includes(':'));
  const key = JSON.stringify([settings.countries, own, sources.map((s) => s.length)]);
  if (allowedIpsCache?.key === key) return allowedIpsCache.value;

  const ranges: Range[] = [...sources.flat(), ...own].map(parseCidr4).filter((r): r is Range => r !== null);
  const value = ranges.length ? [...complementCidrs(mergeRanges(ranges)), FULL_IPV6] : ['0.0.0.0/0', FULL_IPV6];
  allowedIpsCache = { key, value };
  return value;
}
