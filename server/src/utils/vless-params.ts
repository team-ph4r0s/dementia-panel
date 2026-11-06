import crypto from 'node:crypto';

/**
 * Протокол ноды. `awg` — AmneziaWG (исходный), `vless` — VLESS + Reality (Xray-core) по TCP.
 *
 * Контракт VLESS (общий для сервера, подписок и интерфейса):
 * - порт — `servers.awg_port` (TCP), применённый порт — `deployed_port`, как у AWG;
 * - ключи Reality x25519 — `server_private_key`/`server_public_key` в обычном base64 (как у AWG,
 *   генерируются `AwgService.generateKeyPair`); в config.json и ссылки они идут в base64url без `=`
 *   (`toXrayKey`);
 * - клиент VLESS: `client_uuid` (секрет, как приватный ключ), `client_ip = ''`, `client_public_key = ''`,
 *   `client_private_key = ''`;
 * - параметры Reality — колонки `reality_sni`, `reality_dest`, `reality_short_ids` (JSON), `xray_flow`,
 *   `xray_fingerprint`; транспорт — `xray_transport` (`tcp` | `xhttp`), `xhttp_path`, `xhttp_mode` (миграция v16);
 *   читаются `vlessParamsFromRow`, проверяются `validateVlessParams`;
 * - вход через CDN (Cloudflare) — колонки `cdn_*`, см. CdnService: отдельный inbound VLESS + XHTTP + TLS.
 */
export type NodeProtocol = 'awg' | 'vless';
export const NODE_PROTOCOLS: readonly NodeProtocol[] = ['awg', 'vless'];

export function nodeProtocol(row: { protocol?: string | null } | null | undefined): NodeProtocol {
  return row?.protocol === 'vless' ? 'vless' : 'awg';
}

/** Образ Xray-core для нод VLESS (аналог инварианта 15 для AWG) */
export const XRAY_IMAGE = 'ghcr.io/xtls/xray-core:latest';
/** Поля контейнера ноды VLESS (servers.container_name / conf_path) */
export const XRAY_CONTAINER = 'dementia-xray';
export const XRAY_CONF_DIR = '/opt/dementia-xray';
export const XRAY_CONF_PATH = `${XRAY_CONF_DIR}/config.json`;
/** Порт gRPC API Xray внутри контейнера (только 127.0.0.1): добавление/удаление пользователей и статистика */
export const XRAY_API_PORT = 10085;
/** Тег inbound VLESS в config.json (по нему работают `xray api adu/rmu`) */
export const XRAY_INBOUND_TAG = 'vless-in';
export const DEFAULT_VLESS_PORT = 443;

export const VLESS_FLOWS = ['xtls-rprx-vision', ''] as const;
export type VlessFlow = (typeof VLESS_FLOWS)[number];
/** Транспорт Reality-входа: RAW/TCP (Vision со splice, быстрее) или XHTTP (HTTP-запросы, устойчивее к анализу потока) */
export const VLESS_TRANSPORTS = ['tcp', 'xhttp'] as const;
export type VlessTransport = (typeof VLESS_TRANSPORTS)[number];
/** Режим XHTTP у клиента. Сервер принимает все (`auto`), в ссылку идёт выбранный */
export const XHTTP_MODES = ['auto', 'packet-up', 'stream-up', 'stream-one'] as const;
export type XhttpMode = (typeof XHTTP_MODES)[number];
/** Тег inbound входа через CDN (VLESS + XHTTP + TLS) */
export const XRAY_CDN_INBOUND_TAG = 'vless-cdn';

export const VLESS_FINGERPRINTS = ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'] as const;

/**
 * Сайты для маскировки Reality по умолчанию: TLS 1.3 + HTTP/2, не за Cloudflare. www.microsoft.com и www.apple.com
 * не используются: Xray 26 предупреждает, что с ними сервер блокируют чаще.
 */
export const DEFAULT_REALITY_TARGETS = [
  'dl.google.com',
  'www.samsung.com',
  'www.nvidia.com',
] as const;

export interface VlessParams {
  /** serverName в Reality и `sni` у клиента */
  reality_sni: string;
  /** dest (target) Reality: `host:port`, куда Xray отдаёт чужие подключения */
  reality_dest: string;
  /** shortIds: hex чётной длины 0–16 символов; клиенту выдаётся первый */
  reality_short_ids: string[];
  xray_flow: VlessFlow;
  xray_fingerprint: string;
  xray_transport: VlessTransport;
  /** Путь XHTTP (общий для Reality-входа с XHTTP и входа через CDN) */
  xhttp_path: string;
  xhttp_mode: XhttpMode;
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const SHORT_ID_RE = /^([0-9a-f]{2}){0,8}$/;
/** Путь XHTTP: только безопасные для URL и config.json символы (значение попадает в ссылки и YAML) */
export const XHTTP_PATH_RE = /^\/[A-Za-z0-9._~\/-]{0,63}$/;

export function generateXhttpPath(): string {
  return `/${crypto.randomBytes(8).toString('hex')}`;
}

export function generateShortId(bytes = 8): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function generateVlessParams(): VlessParams {
  const sni = DEFAULT_REALITY_TARGETS[crypto.randomInt(DEFAULT_REALITY_TARGETS.length)];
  return {
    reality_sni: sni,
    reality_dest: `${sni}:443`,
    reality_short_ids: [generateShortId()],
    xray_flow: 'xtls-rprx-vision',
    xray_fingerprint: 'chrome',
    xray_transport: 'tcp',
    xhttp_path: generateXhttpPath(),
    xhttp_mode: 'auto',
  };
}

function parseShortIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Параметры VLESS из строки servers (с подстановкой значений по умолчанию для пустых колонок) */
export function vlessParamsFromRow(row: any): VlessParams {
  const sni = typeof row?.reality_sni === 'string' && row.reality_sni ? row.reality_sni : DEFAULT_REALITY_TARGETS[0];
  return {
    reality_sni: sni,
    reality_dest: typeof row?.reality_dest === 'string' && row.reality_dest ? row.reality_dest : `${sni}:443`,
    reality_short_ids: parseShortIds(row?.reality_short_ids),
    xray_flow: row?.xray_flow === '' ? '' : 'xtls-rprx-vision',
    xray_fingerprint: typeof row?.xray_fingerprint === 'string' && row.xray_fingerprint ? row.xray_fingerprint : 'chrome',
    xray_transport: row?.xray_transport === 'xhttp' ? 'xhttp' : 'tcp',
    xhttp_path: typeof row?.xhttp_path === 'string' && XHTTP_PATH_RE.test(row.xhttp_path) ? row.xhttp_path : '/',
    xhttp_mode: (XHTTP_MODES as readonly string[]).includes(row?.xhttp_mode) ? row.xhttp_mode : 'auto',
  };
}

/** Колонки servers для записи параметров (reality_short_ids — JSON) */
export function vlessParamsToColumns(p: VlessParams): Record<string, string> {
  return {
    reality_sni: p.reality_sni,
    reality_dest: p.reality_dest,
    reality_short_ids: JSON.stringify(p.reality_short_ids),
    xray_flow: p.xray_flow,
    xray_fingerprint: p.xray_fingerprint,
    xray_transport: p.xray_transport,
    xhttp_path: p.xhttp_path,
    xhttp_mode: p.xhttp_mode,
  };
}

/**
 * Проверка параметров VLESS от пользователя или чужой панели. Значения попадают в config.json ноды,
 * ссылки vless:// и YAML mihomo — поэтому только строгие форматы (инварианты 17 и 25).
 * Возвращает текст ошибки или null.
 */
export function validateVlessParams(p: VlessParams): string | null {
  if (typeof p.reality_sni !== 'string' || !HOSTNAME_RE.test(p.reality_sni)) {
    return 'SNI Reality должен быть доменным именем (например, dl.google.com)';
  }
  const dest = typeof p.reality_dest === 'string' ? p.reality_dest.match(/^([^:\s]+):(\d{1,5})$/) : null;
  if (!dest || !HOSTNAME_RE.test(dest[1]) || Number(dest[2]) < 1 || Number(dest[2]) > 65535) {
    return 'Адрес маскировки Reality укажите как домен:порт (например, dl.google.com:443)';
  }
  if (!Array.isArray(p.reality_short_ids) || p.reality_short_ids.length < 1 || p.reality_short_ids.length > 8) {
    return 'Нужен от 1 до 8 shortId';
  }
  if (p.reality_short_ids.some((id) => typeof id !== 'string' || !SHORT_ID_RE.test(id))) {
    return 'shortId — hex-строка чётной длины до 16 символов';
  }
  if (!(VLESS_FLOWS as readonly string[]).includes(p.xray_flow)) return 'Неизвестный flow';
  if (!(VLESS_FINGERPRINTS as readonly string[]).includes(p.xray_fingerprint)) return 'Неизвестный отпечаток TLS (fingerprint)';
  if (!(VLESS_TRANSPORTS as readonly string[]).includes(p.xray_transport)) return 'Транспорт — tcp или xhttp';
  if (typeof p.xhttp_path !== 'string' || !XHTTP_PATH_RE.test(p.xhttp_path)) {
    return 'Путь XHTTP начинается с / и содержит до 64 символов: латиница, цифры, . _ ~ - /';
  }
  if (!(XHTTP_MODES as readonly string[]).includes(p.xhttp_mode)) return 'Режим XHTTP: auto, packet-up, stream-up или stream-one';
  return null;
}

/**
 * Flow, который действительно работает с транспортом ноды. Vision (`xtls-rprx-vision`) в Xray работает только поверх TLS/REALITY
 * напрямую (RAW); на XHTTP он допустим лишь с VLESS Encryption, а у нас `decryption: none` — иначе подключение рвётся с
 * «XTLS only supports TLS and REALITY directly». Поэтому с XHTTP flow пустой; сохранённый `xray_flow` вернётся при переходе на TCP.
 */
export function effectiveFlow(p: Pick<VlessParams, 'xray_flow' | 'xray_transport'>): VlessFlow {
  return p.xray_transport === 'xhttp' ? '' : p.xray_flow;
}

/** Ключ x25519 из base64 (как хранится в БД) в base64url без `=` (формат Xray) */
export function toXrayKey(base64: string): string {
  return Buffer.from(base64, 'base64').toString('base64url');
}

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
