import crypto from 'node:crypto';

/**
 * Пресеты сигнатурных пакетов AmneziaWG (I1–I5): клиент отправляет их перед рукопожатием, чтобы начало
 * соединения выглядело для DPI как известный протокол. Параметры клиентские — на ноду не записываются.
 *
 * - `quic` — настоящий пакет QUIC v1 Initial (RFC 9000/9001) с TLS ClientHello и нужным SNI: ключи Initial
 *   выводятся из DCID по открытой соли, поэтому DPI, который расшифровывает Initial ради SNI, увидит корректный
 *   ClientHello. Пакет короткий, а до 1200 байт (минимум датаграммы Initial) дополняется тегом `<r N>`:
 *   целиком в `<b 0x…>` он занял бы 2400 символов, и конфигурация клиента перестала бы помещаться в QR-код.
 * - `dns` — запрос A-записи домена со случайным идентификатором;
 * - `stun` — STUN Binding Request (RFC 5389) со случайным идентификатором транзакции.
 */
export const SIGNATURE_PRESETS = ['quic', 'dns', 'stun'] as const;
export type SignaturePreset = (typeof SIGNATURE_PRESETS)[number];

/** Минимальный размер датаграммы с пакетом QUIC Initial от клиента (RFC 9000, 14.1) */
const QUIC_DATAGRAM_SIZE = 1200;
const QUIC_V1_INITIAL_SALT = Buffer.from('38762cf7f55934b34d179ae6a4c80cadccbb7f0a', 'hex');

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Домен для SNI/DNS-запроса: строчные ASCII-метки (IDN — в punycode), не IP-адрес */
export function normalizeSignatureDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_RE.test(domain) || /^\d+$/.test(domain.split('.').pop() as string)) return null;
  return domain;
}

const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);

/** Целое переменной длины QUIC (RFC 9000, 16) — до 2^30 − 1 */
function varint(n: number): Buffer {
  if (n < 0x40) return u8(n);
  if (n < 0x4000) return u16(0x4000 | n);
  const out = Buffer.alloc(4);
  out.writeUInt32BE((0x80000000 | n) >>> 0);
  return out;
}

function hkdfExpandLabel(secret: Buffer, label: string, length: number): Buffer {
  const full = Buffer.from(`tls13 ${label}`, 'ascii');
  const info = Buffer.concat([u16(length), u8(full.length), full, u8(0)]);
  // Длина не больше одного блока SHA-256, поэтому достаточно первого шага HKDF-Expand
  return crypto.createHmac('sha256', secret).update(Buffer.concat([info, u8(1)])).digest().subarray(0, length);
}

/** Ключи клиента для пакета Initial (RFC 9001, 5.2) */
export function quicInitialKeys(dcid: Buffer): { key: Buffer; iv: Buffer; hp: Buffer } {
  const initial = crypto.createHmac('sha256', QUIC_V1_INITIAL_SALT).update(dcid).digest();
  const client = hkdfExpandLabel(initial, 'client in', 32);
  return {
    key: hkdfExpandLabel(client, 'quic key', 16),
    iv: hkdfExpandLabel(client, 'quic iv', 12),
    hp: hkdfExpandLabel(client, 'quic hp', 16),
  };
}

const extension = (type: number, data: Buffer) => Buffer.concat([u16(type), u16(data.length), data]);
const transportParam = (id: number, value: Buffer) => Buffer.concat([varint(id), varint(value.length), value]);

function buildClientHello(domain: string): Buffer {
  const name = Buffer.from(domain, 'ascii');
  const groups = Buffer.from('001d00170018', 'hex');
  const signatures = Buffer.from('04030804040105030805050108060601', 'hex');
  const transport = Buffer.concat([
    transportParam(0x01, varint(30_000)), // max_idle_timeout
    transportParam(0x03, varint(1472)), // max_udp_payload_size
    transportParam(0x04, varint(15_728_640)), // initial_max_data
    transportParam(0x05, varint(6_291_456)), // initial_max_stream_data_bidi_local
    transportParam(0x06, varint(6_291_456)), // initial_max_stream_data_bidi_remote
    transportParam(0x07, varint(6_291_456)), // initial_max_stream_data_uni
    transportParam(0x08, varint(100)), // initial_max_streams_bidi
    transportParam(0x09, varint(103)), // initial_max_streams_uni
    transportParam(0x0f, Buffer.alloc(0)), // initial_source_connection_id (пустой, как SCID пакета)
  ]);
  const extensions = Buffer.concat([
    extension(0x0000, Buffer.concat([u16(name.length + 3), u8(0), u16(name.length), name])), // server_name
    extension(0x000a, Buffer.concat([u16(groups.length), groups])), // supported_groups
    extension(0x000d, Buffer.concat([u16(signatures.length), signatures])), // signature_algorithms
    extension(0x0010, Buffer.from('0003026833', 'hex')), // ALPN: h3
    extension(0x002b, Buffer.from('020304', 'hex')), // supported_versions: TLS 1.3
    extension(0x002d, Buffer.from('0101', 'hex')), // psk_key_exchange_modes
    extension(0x0033, Buffer.concat([u16(36), u16(0x001d), u16(32), crypto.randomBytes(32)])), // key_share x25519
    extension(0x0039, transport), // quic_transport_parameters
  ]);
  const body = Buffer.concat([
    u16(0x0303),
    crypto.randomBytes(32),
    u8(0), // legacy_session_id: в QUIC пустой
    Buffer.from('0006130113021303', 'hex'), // cipher_suites
    Buffer.from('0100', 'hex'), // compression_methods
    u16(extensions.length),
    extensions,
  ]);
  return Buffer.concat([u8(0x01), u8(0), u16(body.length), body]);
}

/** Защищённый пакет QUIC v1 Initial с ClientHello для домена (без дополнения до 1200 байт) */
export function buildQuicInitial(domain: string, dcid: Buffer = crypto.randomBytes(8)): Buffer {
  const hello = buildClientHello(domain);
  const payload = Buffer.concat([u8(0x06), varint(0), varint(hello.length), hello]); // кадр CRYPTO
  const pn = Buffer.from([1]);
  const length = u16(0x4000 | (pn.length + payload.length + 16));
  const header = Buffer.concat([
    u8(0xc0 | (pn.length - 1)),
    Buffer.from('00000001', 'hex'),
    u8(dcid.length), dcid,
    u8(0), // SCID
    u8(0), // токен
    length,
    pn,
  ]);
  const pnOffset = header.length - pn.length;

  const { key, iv, hp } = quicInitialKeys(dcid);
  const nonce = Buffer.from(iv);
  nonce[nonce.length - 1] ^= pn[0];
  const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce);
  cipher.setAAD(header);
  const packet = Buffer.concat([header, cipher.update(payload), cipher.final(), cipher.getAuthTag()]);

  // Защита заголовка (RFC 9001, 5.4): образец — 16 байт шифротекста через 4 байта от начала номера пакета
  const ecb = crypto.createCipheriv('aes-128-ecb', hp, null);
  ecb.setAutoPadding(false);
  const mask = ecb.update(packet.subarray(pnOffset + 4, pnOffset + 20));
  packet[0] ^= mask[0] & 0x0f;
  for (let i = 0; i < pn.length; i++) packet[pnOffset + i] ^= mask[1 + i];
  return packet;
}

function dnsQuery(domain: string): Buffer {
  const labels = domain.split('.').map((label) => Buffer.concat([u8(label.length), Buffer.from(label, 'ascii')]));
  // Флаги RD, один вопрос; затем имя, тип A, класс IN. Идентификатор запроса подставляет клиент (`<r 2>`)
  return Buffer.concat([Buffer.from('01000001000000000000', 'hex'), ...labels, u8(0), Buffer.from('00010001', 'hex')]);
}

/**
 * Значение I1 для пресета. Домен обязателен для `quic` и `dns` (должен быть уже проверен
 * `normalizeSignatureDomain`). Результат всегда проходит `isValidSignature`.
 */
export function generateSignature(preset: SignaturePreset, domain: string | null): string {
  if (preset === 'stun') return '<b 0x000100002112a442><r 12>';
  if (!domain) throw new Error('Не указан домен');
  if (preset === 'dns') return `<r 2><b 0x${dnsQuery(domain).toString('hex')}>`;
  const packet = buildQuicInitial(domain);
  return `<b 0x${packet.toString('hex')}><r ${QUIC_DATAGRAM_SIZE - packet.length}>`;
}
