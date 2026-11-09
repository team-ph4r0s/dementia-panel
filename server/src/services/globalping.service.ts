import { PANEL_VERSION } from './version.service.js';

/**
 * Второй источник проверки доступности — Globalping (api.globalping.io, бесплатный API без ключа).
 *
 * Узлы check-host.net стоят в дата-центрах, а блокировки часто действуют только в сетях операторов связи. У Globalping
 * есть пробы в сетях провайдеров (метка `eyeball-network`) и больше стран. Адреса проб сервис не раскрывает, поэтому
 * обращение сопоставляется не по адресу, а по метке: для каждой страны — свой HTTP-запрос к заглушке ноды со своей
 * одноразовой меткой в пути, и доступность засчитывается по журналу заглушки на ноде (инвариант 37).
 *
 * UDP Globalping не проверяет. Без ключа — 250 проб в час с одного адреса; при исчерпании лимита обход продолжается
 * без Globalping. Всё, что приходит от сервиса, — внешние данные и проверяется по формату.
 */

const API_BASE = 'https://api.globalping.io/v1';
const MEASUREMENT_ID = /^[A-Za-z0-9_-]{6,64}$/;
const COUNTRY = /^[A-Z]{2}$/;
/** Больше проб на страну за один запрос панель не просит */
const MAX_PROBES = 10;

export class GlobalpingRateLimitError extends Error {
  constructor() {
    super('Globalping: исчерпан лимит бесплатных проверок (250 проб в час), попробуйте увеличить интервал');
  }
}

export interface GlobalpingMeasurement {
  id: string;
  probes: number;
  /** Пробы выбраны из сетей провайдеров (иначе в стране нашлись только пробы в дата-центрах) */
  eyeball: boolean;
}

async function api(path: string, init?: { method: string; body: unknown }): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': `dementia-panel/${PANEL_VERSION}`,
      ...(init ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Число проб по странам (код в нижнем регистре): всего и в сетях провайдеров */
export async function globalpingCountries(): Promise<Map<string, { total: number; eyeball: number }>> {
  const { status, body } = await api('/probes');
  if (status !== 200 || !Array.isArray(body)) throw new Error(`Globalping ответил HTTP ${status}`);
  const counts = new Map<string, { total: number; eyeball: number }>();
  for (const probe of body) {
    const country = probe?.location?.country;
    if (typeof country !== 'string' || !COUNTRY.test(country)) continue;
    const entry = counts.get(country.toLowerCase()) ?? { total: 0, eyeball: 0 };
    entry.total++;
    if (Array.isArray(probe.tags) && probe.tags.includes('eyeball-network')) entry.eyeball++;
    counts.set(country.toLowerCase(), entry);
  }
  return counts;
}

async function create(host: string, port: number, path: string, country: string, limit: number, eyeball: boolean): Promise<GlobalpingMeasurement | null> {
  const { status, body } = await api('/measurements', {
    method: 'POST',
    body: {
      type: 'http',
      target: host,
      locations: [{ country: country.toUpperCase(), limit, ...(eyeball ? { tags: ['eyeball-network'] } : {}) }],
      measurementOptions: { protocol: 'HTTP', port, request: { method: 'GET', path } },
    },
  });
  if (status === 429) throw new GlobalpingRateLimitError();
  // 422 — в стране нет подходящих проб
  if (status === 422) return null;
  const probes = Number(body?.probesCount);
  if (status !== 202 || !MEASUREMENT_ID.test(String(body?.id)) || !Number.isInteger(probes) || probes < 1) {
    throw new Error(`Globalping отклонил запрос (HTTP ${status})`);
  }
  return { id: String(body.id), probes: Math.min(probes, MAX_PROBES), eyeball };
}

/**
 * HTTP-запрос `http://host:port<path>` с проб страны: сначала из сетей провайдеров, а если таких проб нет — из любых.
 * null — в стране нет проб.
 */
export async function startGlobalpingHttp(host: string, port: number, path: string, country: string, limit: number): Promise<GlobalpingMeasurement | null> {
  return (await create(host, port, path, country, limit, true)) ?? (await create(host, port, path, country, limit, false));
}

/**
 * Ждёт завершения измерения и возвращает, сколько проб сообщили об ответе HTTP 200. Это только заявление проб:
 * дошёл ли запрос до ноды, решает журнал заглушки.
 */
export async function waitGlobalping(id: string, totalMs: number, delayMs: number): Promise<{ claimedOk: number; done: boolean }> {
  const deadline = Date.now() + totalMs;
  let claimedOk = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const { status, body } = await api(`/measurements/${encodeURIComponent(id)}`);
    if (status === 200 && Array.isArray(body?.results)) {
      claimedOk = body.results.filter((r: any) => r?.result?.status === 'finished' && r.result.statusCode === 200).length;
      if (body.status !== 'in-progress') return { claimedOk: Math.min(claimedOk, MAX_PROBES), done: true };
    }
    if (Date.now() > deadline) return { claimedOk: Math.min(claimedOk, MAX_PROBES), done: false };
  }
}
