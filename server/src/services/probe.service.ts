import crypto from 'node:crypto';
import net from 'node:net';
import { db, getSetting, setSetting, transaction } from '../db/index.js';
import { HttpError } from '../utils/http.js';
import { PANEL_VERSION } from './version.service.js';
import { ProvisionService } from './provision.service.js';
import type { StubHit } from './stub.service.js';
import { globalpingCountries, GlobalpingRateLimitError, startGlobalpingHttp, waitGlobalping, type GlobalpingMeasurement } from './globalping.service.js';

/**
 * Проверка доступности нод из выбранных стран. Сама панель стоит в одной стране, поэтому проверку выполняют узлы публичного
 * сервиса check-host.net (бесплатный API без ключа).
 *
 * Основной способ — заглушка на ноде (stub.service.ts): узлы обращаются к ней по HTTP и UDP, а панель по журналу заглушки
 * на самой ноде проверяет, что обращения действительно дошли. Ответ ICMP или TCP провайдер может подделать, а запись в
 * журнале на сервере — нет. Для нод без SSH (ноды партнёров) остаётся TCP-подключение к заданному порту по ответу
 * check-host.net. Ping не используется: его ответы подделываются.
 *
 * Функция отключена, пока администратор её не включит: адреса нод уходят на сторонний сервис.
 * Результаты — таблица probe_results, настройки — settings с префиксом probe_ (docs/probes.md).
 */

const API_BASE = 'https://check-host.net';
const NODE_ID = /^[a-z0-9-]+\.node\.check-host\.net$/;
const COUNTRY_CODE = /^[a-z]{2}$/;
const REQUEST_ID = /^[A-Za-z0-9]{3,40}$/;

export const MAX_PROBE_COUNTRIES = 8;
export const MIN_INTERVAL_MINUTES = 10;
export const MAX_INTERVAL_MINUTES = 1440;
const DEFAULT_INTERVAL_MINUTES = 30;
/** Сколько проверяющих узлов от страны привлекается к одной проверке */
const NODES_PER_COUNTRY = 2;
const COUNTRIES_TTL_MS = 24 * 60 * 60 * 1000;
/** Минимальный промежуток между ручными запусками */
const MANUAL_COOLDOWN_MS = 60 * 1000;
/** check-host.net под нагрузкой отдаёт результаты через 1–2 минуты: не дождавшиеся узлы в итог не входят */
const POLL_TOTAL_MS = 150 * 1000;
/** Пауза между опросами результата растёт до этого значения (меньше запросов к сервису) */
const POLL_MAX_DELAY_MS = 8000;
/** Сколько нод проверяется одновременно (запросы к check-host.net и SSH к нодам) */
const PARALLEL_SERVERS = 3;

export interface ProbeSettings {
  enabled: boolean;
  /** Коды стран ISO 3166-1 alpha-2 в нижнем регистре, в порядке показа */
  countries: string[];
  interval_minutes: number;
  /** Дописывать результаты к названию ноды в подписке */
  show_in_name: boolean;
  /** Дописывать пояснение к описанию подписки */
  show_in_description: boolean;
  /** Второй источник — Globalping (пробы в сетях провайдеров); выключен, пока администратор не включит (инвариант 32) */
  globalping: boolean;
}

export interface ProbeCountry {
  code: string;
  /** Английское название из check-host.net (русское строит интерфейс) */
  name: string;
  nodes: string[];
  cities: string[];
  /** Пробы Globalping в стране: всего и в сетях провайдеров (есть, только если источник включён) */
  gp_probes?: number;
  gp_eyeball?: number;
}

export type ProbeStatus = 'ok' | 'partial' | 'fail';
/** stub — заглушка с подтверждением по журналу ноды, tcp — подключение к порту по ответу check-host.net */
export type ProbeMethod = 'stub' | 'tcp';

export interface ProbeResult {
  server_id: number;
  country: string;
  method: string;
  /** Узлы страны, с которых нода доступна (для заглушки — по UDP, как у AmneziaWG; без данных UDP — по TCP) */
  ok_nodes: number;
  total_nodes: number;
  /** Заглушка: сколько узлов дошло по TCP и по UDP (по журналу ноды); null — неизвестно */
  tcp_ok: number | null;
  udp_ok: number | null;
  /** Узлы, получившие ответ, хотя до ноды запрос не дошёл: ответ подделан по дороге */
  spoofed: number;
  /** Результат подтверждён журналом заглушки на ноде */
  verified: boolean;
  rtt_ms: number | null;
  checked_at: string;
  status: ProbeStatus;
  /** Globalping: сколько проб дошло до заглушки и сколько участвовало (входят в ok_nodes/total_nodes); null — не использовался */
  gp_ok: number | null;
  gp_total: number | null;
  /** Пробы Globalping были в сетях провайдеров (false — в стране нашлись только пробы в дата-центрах) */
  gp_eyeball: boolean | null;
}

interface CountryAggregate {
  ok: number;
  total: number;
  rtts: number[];
  tcpOk: number | null;
  udpOk: number | null;
  spoofed: number;
  gpOk?: number;
  gpTotal?: number;
  gpEyeball?: boolean;
}

/** Сколько ждать пробы Globalping (обычно отвечают за несколько секунд) */
const GLOBALPING_WAIT_MS = 30 * 1000;

interface CheckOutcome {
  method: ProbeMethod;
  verified: boolean;
  countries: Map<string, CountryAggregate>;
}

interface StartedCheck {
  requestId: string;
  /** Узел → страна и адрес, с которого он проверяет */
  nodes: Map<string, { country: string; ip: string | null }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const IP = /^[0-9a-fA-F.:]{2,45}$/;

async function providerFetch(path: string): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': `dementia-panel/${PANEL_VERSION}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`check-host.net ответил HTTP ${res.status}`);
  return res.json();
}

/** Результат одного HTTP-узла: [[1, время, "OK", "200", ip]] — успех, [[0, …]] — отказ, прочее — нет результата */
export function parseHttpResult(value: unknown): { ok: boolean; rtt: number | null } | null {
  const entry = Array.isArray(value) && Array.isArray(value[0]) ? (value[0] as unknown[]) : null;
  if (!entry) return null;
  if (entry[0] === 1) return { ok: true, rtt: typeof entry[1] === 'number' && Number.isFinite(entry[1]) ? Math.round(entry[1] * 1000) : null };
  if (entry[0] === 0) return { ok: false, rtt: null };
  return null;
}

/** Результат одного TCP-узла: объект с time — успех, с error — отказ */
export function parseTcpResult(value: unknown): { ok: boolean; rtt: number | null } | null {
  const entry = Array.isArray(value) ? value[0] : null;
  if (!entry || typeof entry !== 'object') return null;
  if (typeof (entry as any).time === 'number' && Number.isFinite((entry as any).time)) return { ok: true, rtt: Math.round((entry as any).time * 1000) };
  if ('error' in entry) return { ok: false, rtt: null };
  return null;
}

/** Результат одного UDP-узла: {time} — пришёл ответ, {timeout}/{error} — ответа нет (что не значит, что пакет не дошёл) */
export function parseUdpResult(value: unknown): { ok: boolean; rtt: number | null } | null {
  const entry = Array.isArray(value) ? value[0] : null;
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as any;
  if (typeof e.time === 'number' && Number.isFinite(e.time) && !e.timeout) return { ok: true, rtt: Math.round(e.time * 1000) };
  if ('timeout' in e || 'error' in e) return { ok: false, rtt: null };
  return null;
}

export function probeStatus(ok: number, total: number): ProbeStatus {
  if (total > 0 && ok === total) return 'ok';
  return ok === 0 ? 'fail' : 'partial';
}

/** Флаг страны из двух букв кода (региональные индикаторы Unicode) */
export function countryFlag(code: string): string {
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

const STATUS_MARK: Record<ProbeStatus, string> = { ok: '✅', partial: '⚠️', fail: '❌' };

export function countryNameRu(code: string): string {
  try {
    return new Intl.DisplayNames(['ru'], { type: 'region' }).of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/**
 * Сопоставление обращений из журнала заглушки с проверяющими узлами. HTTP-запрос несёт одноразовую метку проверки, поэтому
 * обращение с меткой с незнакомого адреса (узел вышел в сеть не с того адреса, что сообщил check-host.net) засчитывается
 * узлу, который сообщил об успехе, но ещё не сопоставлен; этот адрес затем используется и для UDP.
 */
export function matchStubHits(
  hits: StubHit[],
  nonce: string,
  sinceEpoch: number,
  nodes: Map<string, { ip: string | null }>,
  claimedOk: (id: string) => boolean
): { tcp: Set<string>; udp: Set<string> } {
  const owner = new Map<string, string>();
  for (const [id, info] of nodes) if (info.ip) owner.set(info.ip, id);

  const tcp = new Set<string>();
  const unknown: string[] = [];
  for (const hit of hits) {
    if (hit.proto !== 'tcp' || !hit.path.includes(nonce)) continue;
    const id = owner.get(hit.ip);
    if (id) tcp.add(id);
    else if (!unknown.includes(hit.ip)) unknown.push(hit.ip);
  }
  const waiting = [...nodes.keys()].filter((id) => !tcp.has(id) && claimedOk(id));
  for (const ip of unknown) {
    const id = waiting.shift();
    if (!id) break;
    tcp.add(id);
    owner.set(ip, id);
  }

  const udp = new Set<string>();
  for (const hit of hits) {
    if (hit.proto !== 'udp' || hit.at < sinceEpoch) continue;
    const id = owner.get(hit.ip);
    if (id) udp.add(id);
  }
  return { tcp, udp };
}

export class ProbeService {
  private static running = false;
  /** Пауза перед опросом результатов; тесты обнуляют её */
  static pollDelayMs: number | null = null;
  /** Сколько всего ждать ответы узлов; тесты уменьшают */
  static pollTotalMs = POLL_TOTAL_MS;
  /** Вызывается после каждого обхода (мосты пересчитывают, кому нужен мост); задаёт index.ts */
  static afterRun: (() => Promise<void>) | null = null;
  private static countriesCache: { at: number; list: ProbeCountry[]; ips: Map<string, string> } | null = null;
  private static gpCountriesCache: { at: number; counts: Map<string, { total: number; eyeball: number }> } | null = null;
  /** Лимит Globalping исчерпан в текущем обходе — до конца обхода к нему не обращаемся */
  private static gpLimited = false;

  // ---- Настройки ----

  static readSettings(): ProbeSettings {
    let countries: string[] = [];
    try {
      const parsed = JSON.parse(getSetting('probe_countries') || '[]');
      if (Array.isArray(parsed)) countries = parsed.filter((c) => typeof c === 'string' && COUNTRY_CODE.test(c)).slice(0, MAX_PROBE_COUNTRIES);
    } catch {
      countries = [];
    }
    const interval = Number(getSetting('probe_interval'));
    return {
      enabled: getSetting('probe_enabled') === '1',
      countries,
      interval_minutes: Number.isInteger(interval) && interval >= MIN_INTERVAL_MINUTES && interval <= MAX_INTERVAL_MINUTES ? interval : DEFAULT_INTERVAL_MINUTES,
      show_in_name: getSetting('probe_in_name') !== '0',
      show_in_description: getSetting('probe_in_description') !== '0',
      globalping: getSetting('probe_globalping') === '1',
    };
  }

  static updateSettings(body: Record<string, unknown>): ProbeSettings {
    const next = { ...this.readSettings() };

    if (body.countries !== undefined) {
      if (!Array.isArray(body.countries)) throw new HttpError(400, 'countries должен быть массивом кодов стран');
      const codes = [...new Set(body.countries.map((c) => String(c).trim().toLowerCase()))];
      if (codes.some((c) => !COUNTRY_CODE.test(c))) throw new HttpError(400, 'Страна задаётся двухбуквенным кодом (например, ru)');
      if (codes.length > MAX_PROBE_COUNTRIES) throw new HttpError(400, `Можно выбрать не более ${MAX_PROBE_COUNTRIES} стран`);
      next.countries = codes;
    }
    if (body.interval_minutes !== undefined) {
      const minutes = Number(body.interval_minutes);
      if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
        throw new HttpError(400, `Интервал проверки: от ${MIN_INTERVAL_MINUTES} до ${MAX_INTERVAL_MINUTES} минут`);
      }
      next.interval_minutes = minutes;
    }
    if (body.show_in_name !== undefined) next.show_in_name = Boolean(body.show_in_name);
    if (body.show_in_description !== undefined) next.show_in_description = Boolean(body.show_in_description);
    if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
    if (body.globalping !== undefined) next.globalping = Boolean(body.globalping);
    if (next.enabled && next.countries.length === 0) throw new HttpError(400, 'Выберите хотя бы одну страну для проверки');

    const wasEnabled = this.readSettings().enabled;
    setSetting('probe_enabled', next.enabled ? '1' : null);
    setSetting('probe_countries', next.countries.length ? JSON.stringify(next.countries) : null);
    setSetting('probe_interval', next.interval_minutes === DEFAULT_INTERVAL_MINUTES ? null : String(next.interval_minutes));
    setSetting('probe_in_name', next.show_in_name ? null : '0');
    setSetting('probe_in_description', next.show_in_description ? null : '0');
    setSetting('probe_globalping', next.globalping ? '1' : null);
    // Включение (или смена списка стран) — первая проверка при ближайшем обходе
    if (next.enabled && !wasEnabled) setSetting('probe_last_run', null);

    // Результаты стран, которые больше не проверяются, не должны попасть в подписку
    if (next.countries.length) {
      db.prepare(`DELETE FROM probe_results WHERE country NOT IN (${next.countries.map(() => '?').join(',')})`).run(...next.countries);
    } else {
      db.exec('DELETE FROM probe_results');
    }
    return next;
  }

  /** Порт TCP-проверки сервера (для нод без заглушки, например нод партнёров): null — не задан */
  static setServerProbePort(serverId: number, port: unknown): void {
    let value: number | null = null;
    if (port !== null && port !== undefined && port !== '') {
      value = Number(port);
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw new HttpError(400, 'Порт TCP-проверки: число от 1 до 65535');
    }
    const current = db.prepare('SELECT probe_port FROM servers WHERE id = ?').get(serverId) as { probe_port: number | null } | undefined;
    if (!current) throw new HttpError(404, 'Сервер не найден');
    if (current.probe_port === value) return;
    db.prepare('UPDATE servers SET probe_port = ? WHERE id = ?').run(value, serverId);
    db.prepare('DELETE FROM probe_results WHERE server_id = ?').run(serverId);
  }

  static getStatus(): { running: boolean; last_run: string | null; error: string | null; next_run: string | null } {
    const lastRun = getSetting('probe_last_run');
    const settings = this.readSettings();
    return {
      running: this.running,
      last_run: lastRun,
      error: getSetting('probe_error'),
      next_run: settings.enabled && lastRun ? new Date(new Date(lastRun).getTime() + settings.interval_minutes * 60000).toISOString() : null,
    };
  }

  // ---- Список стран провайдера ----

  private static async loadNodes(): Promise<{ list: ProbeCountry[]; ips: Map<string, string> }> {
    const cached = this.countriesCache;
    if (cached && Date.now() - cached.at < COUNTRIES_TTL_MS) return cached;

    try {
      const data = await providerFetch('/nodes/hosts');
      const byCode = new Map<string, ProbeCountry>();
      const ips = new Map<string, string>();
      for (const [id, info] of Object.entries<any>(data?.nodes ?? {})) {
        const location = info?.location;
        if (!NODE_ID.test(id) || !Array.isArray(location) || typeof location[0] !== 'string' || !COUNTRY_CODE.test(location[0])) continue;
        const country = byCode.get(location[0]) ?? { code: location[0], name: String(location[1] ?? location[0]).slice(0, 60), nodes: [], cities: [] };
        country.nodes.push(id);
        const city = typeof location[2] === 'string' ? location[2].slice(0, 60) : '';
        if (city && !country.cities.includes(city)) country.cities.push(city);
        byCode.set(location[0], country);
        if (typeof info.ip === 'string' && IP.test(info.ip)) ips.set(id, info.ip);
      }
      const list = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
      if (list.length === 0) throw new Error('пустой список узлов');
      this.countriesCache = { at: Date.now(), list, ips };
      return this.countriesCache;
    } catch (err: any) {
      if (cached) return cached;
      throw new HttpError(502, `Не удалось получить список стран у check-host.net: ${err.message}`);
    }
  }

  /** Число проб Globalping по странам (кэш на сутки); при сбое — прежний кэш или пусто: источник необязательный */
  private static async loadGlobalpingCountries(): Promise<Map<string, { total: number; eyeball: number }>> {
    const cached = this.gpCountriesCache;
    if (cached && Date.now() - cached.at < COUNTRIES_TTL_MS) return cached.counts;
    try {
      this.gpCountriesCache = { at: Date.now(), counts: await globalpingCountries() };
      return this.gpCountriesCache.counts;
    } catch {
      return cached?.counts ?? new Map();
    }
  }

  /**
   * Страны, в которых есть проверяющие узлы (кэш на сутки): check-host.net, а при включённом Globalping — и страны,
   * где есть только его пробы (у них `nodes` пуст). К Globalping панель не обращается, пока источник выключен.
   */
  static async listCountries(): Promise<ProbeCountry[]> {
    const gp = this.readSettings().globalping ? await this.loadGlobalpingCountries() : new Map<string, { total: number; eyeball: number }>();
    let list: ProbeCountry[];
    try {
      list = (await this.loadNodes()).list;
    } catch (err) {
      if (gp.size === 0) throw err;
      list = [];
    }
    const merged = new Map(list.map((c) => [c.code, { ...c }]));
    for (const [code, count] of gp) {
      const country = merged.get(code) ?? { code, name: code.toUpperCase(), nodes: [], cities: [] };
      country.gp_probes = count.total;
      country.gp_eyeball = count.eyeball;
      merged.set(code, country);
    }
    return [...merged.values()].sort((a, b) => a.code.localeCompare(b.code));
  }

  static resetCountriesCache(): void {
    this.countriesCache = null;
    this.gpCountriesCache = null;
  }

  // ---- Проверка ----

  private static async startCheck(
    type: 'http' | 'tcp' | 'udp',
    target: string,
    nodeIds: string[],
    countryOfNode: Map<string, string>,
    ipOfNode: Map<string, string>
  ): Promise<StartedCheck> {
    const started = await providerFetch(`/check-${type}?host=${encodeURIComponent(target)}&${nodeIds.map((n) => `node=${encodeURIComponent(n)}`).join('&')}`);
    if (started?.ok !== 1 || !REQUEST_ID.test(String(started.request_id))) {
      throw new Error(typeof started?.error === 'string' ? started.error.slice(0, 120) : 'check-host.net отклонил запрос');
    }
    // Страна и адрес узла: из ответа на запуск, иначе из списка узлов
    const nodes = new Map<string, { country: string; ip: string | null }>();
    for (const id of nodeIds) {
      const info = started.nodes?.[id];
      const code = Array.isArray(info) && typeof info[0] === 'string' && COUNTRY_CODE.test(info[0]) ? info[0] : countryOfNode.get(id);
      const ip = Array.isArray(info) && typeof info[3] === 'string' && IP.test(info[3]) ? info[3] : ipOfNode.get(id) ?? null;
      if (code) nodes.set(id, { country: code, ip });
    }
    return { requestId: String(started.request_id), nodes };
  }

  /** Опрос результатов, пока все узлы не ответят или не выйдет время */
  private static async pollResults(check: StartedCheck, firstDelayMs: number): Promise<Record<string, unknown>> {
    const ids = [...check.nodes.keys()];
    const deadline = Date.now() + this.pollTotalMs;
    let results: Record<string, unknown> = {};
    for (let attempt = 0; ; attempt++) {
      await sleep(this.pollDelayMs ?? Math.min(firstDelayMs + attempt * 1000, POLL_MAX_DELAY_MS));
      results = (await providerFetch(`/check-result/${check.requestId}`)) ?? {};
      const pending = ids.filter((id) => results[id] === null || results[id] === undefined);
      if (pending.length === 0 || Date.now() > deadline) break;
    }
    return results;
  }

  private static addToCountry(map: Map<string, CountryAggregate>, country: string, entry: { ok: boolean; rtt: number | null; tcpOk: boolean | null; udpOk: boolean | null; spoofed: boolean }) {
    const a = map.get(country) ?? { ok: 0, total: 0, rtts: [], tcpOk: null, udpOk: null, spoofed: 0 };
    a.total++;
    if (entry.ok) {
      a.ok++;
      if (entry.rtt !== null) a.rtts.push(entry.rtt);
    }
    if (entry.tcpOk !== null) a.tcpOk = (a.tcpOk ?? 0) + (entry.tcpOk ? 1 : 0);
    if (entry.udpOk !== null) a.udpOk = (a.udpOk ?? 0) + (entry.udpOk ? 1 : 0);
    if (entry.spoofed) a.spoofed++;
    map.set(country, a);
  }

  /** TCP-подключение к host:port с проверяющих узлов (по их ответу, без подтверждения на ноде) */
  static async checkTcp(host: string, port: number, nodeIds: string[], countryOfNode: Map<string, string>, ipOfNode = new Map<string, string>()): Promise<CheckOutcome> {
    const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
    const check = await this.startCheck('tcp', target, nodeIds, countryOfNode, ipOfNode);
    const results = await this.pollResults(check, 2500);
    const countries = new Map<string, CountryAggregate>();
    for (const [id, info] of check.nodes) {
      const parsed = parseTcpResult(results[id]);
      if (!parsed) continue;
      this.addToCountry(countries, info.country, { ok: parsed.ok, rtt: parsed.rtt, tcpOk: parsed.ok, udpOk: null, spoofed: false });
    }
    return { method: 'tcp', verified: false, countries };
  }

  /**
   * Проверка заглушкой: HTTP-запрос с одноразовой меткой и UDP-пакет на порт заглушки, затем сверка с журналом на ноде.
   * Нода доступна с узла, если до неё дошёл его запрос — TCP с меткой или UDP. UDP только дополняет картину: проверка UDP у
   * check-host.net доходит до нод не всегда, и если в журнале нет ни одного UDP-пакета от узлов, UDP считается неизвестным
   * (udp_ok = null), а не «не дошёл». Если журнал прочитать не удалось, засчитываются ответы узлов без подтверждения (verified = false).
   */
  static async checkStub(
    server: { id: number; host: string; stub_port: number },
    nodeIds: string[],
    countryOfNode: Map<string, string>,
    ipOfNode = new Map<string, string>(),
    errors: string[] = [],
    globalpingCountries: string[] = []
  ): Promise<CheckOutcome> {
    const nonce = crypto.randomBytes(8).toString('hex');
    const host = net.isIPv6(server.host) ? `[${server.host}]` : server.host;
    const since = Math.floor(Date.now() / 1000) - 5;
    // Нет узлов check-host.net в выбранных странах (страны только с пробами Globalping) — этот источник пропускается
    const empty: StartedCheck = { requestId: '', nodes: new Map() };

    // Globalping идёт одновременно с check-host.net; журнал заглушки читается один раз, после обоих
    const gpPromise = this.runGlobalping(server, globalpingCountries, errors);
    const [http, udp] = nodeIds.length
      ? await Promise.all([
        this.startCheck('http', `http://${host}:${server.stub_port}/${nonce}`, nodeIds, countryOfNode, ipOfNode),
        this.startCheck('udp', `${host}:${server.stub_port}`, nodeIds, countryOfNode, ipOfNode).catch(() => null),
      ])
      : [empty, null];
    const [httpResults, udpResults] = await Promise.all([
      nodeIds.length ? this.pollResults(http, 3000) : Promise.resolve({} as Record<string, unknown>),
      udp ? this.pollResults(udp, 3000) : Promise.resolve({} as Record<string, unknown>),
    ]);
    const gp = await gpPromise;

    let hits: StubHit[] | null = null;
    try {
      hits = await ProvisionService.readProbeHits(server.id);
    } catch (err: any) {
      errors.push(`журнал заглушки не прочитан, результат не подтверждён: ${err.message}`);
    }

    // Адрес узла из любого из двух запусков
    const nodes = new Map(http.nodes);
    for (const [id, info] of udp?.nodes ?? []) {
      const known = nodes.get(id);
      if (!known) nodes.set(id, info);
      else if (!known.ip && info.ip) nodes.set(id, { ...known, ip: info.ip });
    }
    const matched = hits ? matchStubHits(hits.filter((h) => !gp.some((item) => h.path.includes(item.nonce))), nonce, since, nodes, (id) => parseHttpResult(httpResults[id])?.ok === true) : null;
    // UDP-пакеты check-host.net в этот раз до ноды не дошли ни от одного узла — данных по UDP нет
    const udpKnown = Boolean(udp && matched && matched.udp.size > 0);

    const countries = new Map<string, CountryAggregate>();
    for (const [id, info] of nodes) {
      const httpResult = parseHttpResult(httpResults[id]);
      const udpResult = udp ? parseUdpResult(udpResults[id]) : null;
      if (!httpResult && !udpResult) continue;
      if (matched) {
        const tcpOk = matched.tcp.has(id);
        const udpOk = matched.udp.has(id);
        this.addToCountry(countries, info.country, {
          ok: tcpOk || udpOk,
          rtt: httpResult?.ok ? httpResult.rtt : null,
          tcpOk: httpResult ? tcpOk : null,
          udpOk: udpKnown && udpResult ? udpOk : null,
          spoofed: httpResult?.ok === true && !tcpOk,
        });
      } else {
        const ok = httpResult?.ok === true;
        this.addToCountry(countries, info.country, { ok, rtt: ok ? httpResult!.rtt : null, tcpOk: ok, udpOk: null, spoofed: false });
      }
    }

    // Пробы Globalping: у каждой страны своя метка, адреса проб неизвестны — считаются разные адреса в журнале с этой меткой
    for (const item of gp) {
      const confirmed = hits
        ? Math.min(new Set(hits.filter((h) => h.proto === 'tcp' && h.path.includes(item.nonce)).map((h) => h.ip)).size, item.probes)
        : item.claimedOk;
      const a = countries.get(item.country) ?? { ok: 0, total: 0, rtts: [], tcpOk: null, udpOk: null, spoofed: 0 };
      a.total += item.probes;
      a.ok += confirmed;
      a.tcpOk = (a.tcpOk ?? 0) + confirmed;
      // Проба сообщила об ответе, а до ноды её запрос не дошёл — ответ подделан по дороге
      if (hits) a.spoofed += Math.max(0, item.claimedOk - confirmed);
      a.gpOk = confirmed;
      a.gpTotal = item.probes;
      a.gpEyeball = item.eyeball;
      countries.set(item.country, a);
    }
    return { method: 'stub', verified: hits !== null, countries };
  }

  /**
   * Запросы к заглушке ноды с проб Globalping: на каждую страну — отдельное измерение со своей меткой в пути. Сбой или
   * исчерпанный лимит не ломают проверку: в итог попадает то, что успело выполниться, остальное — в примечания.
   */
  private static async runGlobalping(
    server: { host: string; stub_port: number },
    countries: string[],
    errors: string[]
  ): Promise<(GlobalpingMeasurement & { country: string; nonce: string; claimedOk: number })[]> {
    // IPv6-адрес ноды Globalping как цель HTTP не принимает
    if (!countries.length || this.gpLimited || net.isIPv6(server.host)) return [];
    const started: (GlobalpingMeasurement & { country: string; nonce: string })[] = [];
    for (const country of countries) {
      const nonce = crypto.randomBytes(8).toString('hex');
      try {
        const measurement = await startGlobalpingHttp(server.host, server.stub_port, `/${nonce}`, country, NODES_PER_COUNTRY);
        if (measurement) started.push({ ...measurement, country, nonce });
      } catch (err: any) {
        if (err instanceof GlobalpingRateLimitError) {
          this.gpLimited = true;
          errors.push(err.message);
          break;
        }
        errors.push(`Globalping (${country.toUpperCase()}): ${err.message}`);
      }
    }
    return Promise.all(started.map(async (item) => {
      try {
        const { claimedOk } = await waitGlobalping(item.id, Math.min(this.pollTotalMs, GLOBALPING_WAIT_MS), this.pollDelayMs ?? 2000);
        return { ...item, claimedOk };
      } catch {
        return { ...item, claimedOk: 0 };
      }
    }));
  }

  static isDue(): boolean {
    const settings = this.readSettings();
    if (!settings.enabled || settings.countries.length === 0 || this.running) return false;
    const lastRun = getSetting('probe_last_run');
    return !lastRun || Date.now() - new Date(lastRun).getTime() >= settings.interval_minutes * 60000;
  }

  private static saveResults(serverId: number, outcome: CheckOutcome): void {
    const now = new Date().toISOString();
    transaction(() => {
      const upsert = db.prepare(`
        INSERT INTO probe_results (server_id, country, method, ok_nodes, total_nodes, tcp_ok, udp_ok, spoofed, verified, rtt_ms, checked_at, gp_ok, gp_total, gp_eyeball)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id, country) DO UPDATE SET method = excluded.method, ok_nodes = excluded.ok_nodes,
          total_nodes = excluded.total_nodes, tcp_ok = excluded.tcp_ok, udp_ok = excluded.udp_ok, spoofed = excluded.spoofed,
          verified = excluded.verified, rtt_ms = excluded.rtt_ms, checked_at = excluded.checked_at,
          gp_ok = excluded.gp_ok, gp_total = excluded.gp_total, gp_eyeball = excluded.gp_eyeball
      `);
      for (const [country, a] of outcome.countries) {
        upsert.run(
          serverId, country, outcome.method, a.ok, a.total, a.tcpOk, a.udpOk, a.spoofed, outcome.verified ? 1 : 0,
          a.rtts.length ? Math.round(a.rtts.reduce((x, y) => x + y, 0) / a.rtts.length) : null, now,
          a.gpTotal === undefined ? null : a.gpOk ?? 0, a.gpTotal ?? null, a.gpTotal === undefined ? null : a.gpEyeball ? 1 : 0
        );
      }
    });
  }

  /** Проверяет все установленные ноды из выбранных стран и сохраняет результаты */
  static async runAll(): Promise<{ checked: number; errors: string[] }> {
    const settings = this.readSettings();
    if (!settings.enabled || settings.countries.length === 0) throw new HttpError(400, 'Проверка из стран отключена');
    if (this.running) throw new HttpError(409, 'Проверка уже выполняется');

    this.running = true;
    this.gpLimited = false;
    const errors: string[] = [];
    let checked = 0;
    try {
      // Страны, в которых есть пробы Globalping (если источник включён)
      const gpCounts = settings.globalping ? await this.loadGlobalpingCountries() : new Map<string, { total: number; eyeball: number }>();
      const gpCountries = settings.countries.filter((code) => gpCounts.has(code));
      if (settings.globalping && gpCounts.size === 0) errors.push('Globalping недоступен — проверка только через check-host.net');
      // Без Globalping check-host.net обязателен; с ним обход продолжается и при недоступном check-host.net
      const { list: countries, ips: ipOfNode } = await this.loadNodes().catch((err) => {
        if (!gpCountries.length) throw err;
        errors.push(err.message);
        return { list: [] as ProbeCountry[], ips: new Map<string, string>() };
      });
      const byCode = new Map(countries.map((c) => [c.code, c]));
      const countryOfNode = new Map<string, string>();
      for (const c of countries) for (const id of c.nodes) countryOfNode.set(id, c.code);

      const nodeIds: string[] = [];
      const missing: string[] = [];
      for (const code of settings.countries) {
        const country = byCode.get(code);
        if (country) nodeIds.push(...country.nodes.slice(0, NODES_PER_COUNTRY));
        else if (!gpCountries.includes(code)) missing.push(code.toUpperCase());
      }
      if (missing.length) errors.push(`нет проверяющих узлов в странах: ${missing.join(', ')}`);
      if (nodeIds.length === 0 && gpCountries.length === 0) throw new Error('для выбранных стран нет проверяющих узлов');

      const servers = db.prepare("SELECT id, name, host, status, probe_port, stub_port, remote_panel_id FROM servers WHERE status != 'uninstalled' AND (protocol IS NULL OR protocol = 'awg') ORDER BY id").all() as {
        id: number;
        name: string;
        host: string;
        status: string;
        probe_port: number | null;
        stub_port: number | null;
        remote_panel_id: number | null;
      }[];

      // Ноды проверяются параллельно: ожидание результатов check-host.net (до 150 с) не складывается по числу нод
      const queue = [...servers];
      const worker = async () => {
        for (let server = queue.shift(); server; server = queue.shift()) await checkServer(server);
      };
      const checkServer = async (server: (typeof servers)[number]) => {
        try {
          // Заглушка ставится на свои ноды автоматически (на ноды партнёров SSH-доступа нет)
          if (!server.remote_panel_id && !server.stub_port && server.status === 'online') {
            try {
              server.stub_port = await ProvisionService.ensureProbeStub(server.id);
            } catch (err: any) {
              errors.push(`${server.name}: ${err.message}`);
            }
          }
          let outcome: CheckOutcome;
          if (server.stub_port) {
            const notes: string[] = [];
            outcome = await this.checkStub({ id: server.id, host: server.host, stub_port: server.stub_port }, nodeIds, countryOfNode, ipOfNode, notes, gpCountries);
            // Сообщение о лимите Globalping одно на весь обход, остальные — с именем ноды
            for (const note of notes) {
              if (!note.startsWith('Globalping: исчерпан')) errors.push(`${server.name}: ${note}`);
              else if (!errors.includes(note)) errors.push(note);
            }
          } else if (server.probe_port && nodeIds.length) {
            outcome = await this.checkTcp(server.host, server.probe_port, nodeIds, countryOfNode, ipOfNode);
          } else {
            errors.push(
              server.remote_panel_id
                ? `${server.name}: нода партнёра — укажите TCP-порт для проверки`
                : `${server.name}: заглушка проверки не установлена (нода недоступна по SSH?)`
            );
            return;
          }
          this.saveResults(server.id, outcome);
          checked++;
        } catch (err: any) {
          errors.push(`${server.name}: ${err.message}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL_SERVERS, servers.length) }, worker));
    } catch (err: any) {
      errors.push(err.message);
    } finally {
      this.running = false;
      setSetting('probe_last_run', new Date().toISOString());
      setSetting('probe_error', errors.length ? errors.join('; ').slice(0, 500) : null);
    }
    if (this.afterRun) await this.afterRun().catch((err) => console.error('[PROBE] Ошибка после проверки:', err));
    return { checked, errors };
  }

  /** Ручной запуск: не чаще раза в минуту; выполняется в фоне */
  static startManualRun(): void {
    const settings = this.readSettings();
    if (!settings.enabled || settings.countries.length === 0) throw new HttpError(400, 'Сначала включите проверку и выберите страны');
    if (this.running) throw new HttpError(409, 'Проверка уже выполняется');
    const lastRun = getSetting('probe_last_run');
    if (lastRun && Date.now() - new Date(lastRun).getTime() < MANUAL_COOLDOWN_MS) {
      throw new HttpError(429, 'Проверку можно запускать не чаще раза в минуту');
    }
    this.runAll().catch((err) => console.error('[PROBE] Ошибка проверки:', err));
  }

  // ---- Результаты ----

  /** Результаты не старше трёх интервалов (но не менее двух часов): устаревшие в подписку не попадают */
  static freshSince(): string {
    const minutes = Math.max(this.readSettings().interval_minutes * 3, 120);
    return new Date(Date.now() - minutes * 60000).toISOString();
  }

  private static toResult(r: any): ProbeResult {
    return {
      server_id: r.server_id,
      country: r.country,
      method: r.method,
      ok_nodes: r.ok_nodes,
      total_nodes: r.total_nodes,
      tcp_ok: r.tcp_ok ?? null,
      udp_ok: r.udp_ok ?? null,
      spoofed: r.spoofed ?? 0,
      verified: Boolean(r.verified),
      rtt_ms: r.rtt_ms ?? null,
      checked_at: r.checked_at,
      status: probeStatus(r.ok_nodes, r.total_nodes),
      gp_ok: r.gp_ok ?? null,
      gp_total: r.gp_total ?? null,
      gp_eyeball: r.gp_eyeball === null || r.gp_eyeball === undefined ? null : Boolean(r.gp_eyeball),
    };
  }

  static resultsFor(serverId: number): ProbeResult[] {
    const settings = this.readSettings();
    if (!settings.enabled) return [];
    const since = this.freshSince();
    const rows = db.prepare('SELECT * FROM probe_results WHERE server_id = ? AND checked_at >= ?').all(serverId, since) as any[];
    return rows
      .filter((r) => settings.countries.includes(r.country))
      .sort((a, b) => settings.countries.indexOf(a.country) - settings.countries.indexOf(b.country))
      .map((r) => this.toResult(r));
  }

  static allResults(): ProbeResult[] {
    const settings = this.readSettings();
    if (!settings.enabled) return [];
    const rows = db.prepare('SELECT * FROM probe_results WHERE checked_at >= ? ORDER BY server_id').all(this.freshSince()) as any[];
    return rows
      .filter((r) => settings.countries.includes(r.country))
      .sort((a, b) => a.server_id - b.server_id || settings.countries.indexOf(a.country) - settings.countries.indexOf(b.country))
      .map((r) => this.toResult(r));
  }

  // ---- Подписка ----

  /** Пометки для названий нод в подписке: serverId → «🇷🇺✅ 🇰🇿❌» */
  static getNameMarks(): Map<number, string> {
    const marks = new Map<number, string>();
    const settings = this.readSettings();
    if (!settings.enabled || !settings.show_in_name) return marks;
    const perServer = new Map<number, string[]>();
    for (const r of this.allResults()) {
      const list = perServer.get(r.server_id) ?? [];
      list.push(`${countryFlag(r.country)}${STATUS_MARK[r.status]}`);
      perServer.set(r.server_id, list);
    }
    for (const [id, list] of perServer) marks.set(id, list.join(' '));
    return marks;
  }

  /** Пояснение к описанию подписки; null, если проверка выключена или свежих результатов нет */
  static getLegend(): string | null {
    const settings = this.readSettings();
    if (!settings.enabled || !settings.show_in_description || settings.countries.length === 0) return null;
    const results = this.allResults();
    if (results.length === 0) return null;
    const shown = settings.countries.filter((c) => results.some((r) => r.country === c));
    const checkedAt = new Date(results.reduce((max, r) => (r.checked_at > max ? r.checked_at : max), ''));
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${pad(checkedAt.getUTCDate())}.${pad(checkedAt.getUTCMonth() + 1)} ${pad(checkedAt.getUTCHours())}:${pad(checkedAt.getUTCMinutes())} UTC`;
    return (
      `Доступность нод из стран: ${shown.map((c) => `${countryFlag(c)} ${countryNameRu(c)}`).join(', ')}. ` +
      `${STATUS_MARK.ok} доступна, ${STATUS_MARK.partial} не везде, ${STATUS_MARK.fail} недоступна. Проверено ${date}.`
    );
  }
}
