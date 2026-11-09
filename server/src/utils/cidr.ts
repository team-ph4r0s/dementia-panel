import { isIP } from 'node:net';

/**
 * Работа с IPv4 CIDR для «прямых» адресов: разбор, объединение диапазонов и дополнение до 0.0.0.0/0.
 * Все функции чистые: на вход идут уже проверенные строки.
 */

export type Range = [number, number];

function octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function toInt(o: number[]): number {
  return ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
}

function toIp(value: number): string {
  return [Math.floor(value / 16777216) % 256, Math.floor(value / 65536) % 256, Math.floor(value / 256) % 256, value % 256].join('.');
}

/** IPv4 CIDR `a.b.c.d/n` (n — 1..32; без маски — /32) → диапазон, либо null. Адрес сети выравнивается по маске. */
export function parseCidr4(value: string): Range | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const o = octets(m[1]);
  const bits = m[2] === undefined ? 32 : Number(m[2]);
  if (!o || bits < 1 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const start = Math.floor(toInt(o) / size) * size;
  return [start, start + size - 1];
}

/** Допустимая запись IPv6 CIDR (для правил mihomo): адрес и маска 16..128 */
export function isCidr6(value: string): boolean {
  const m = /^([0-9a-f:.]+)(?:\/(\d{1,3}))?$/i.exec(value.trim());
  if (!m || isIP(m[1]) !== 6) return false;
  const bits = m[2] === undefined ? 128 : Number(m[2]);
  return bits >= 16 && bits <= 128;
}

export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Диапазон → минимальный набор CIDR */
export function rangeToCidrs(range: Range): string[] {
  const out: string[] = [];
  let [start, end] = range;
  while (start <= end) {
    // Наибольший блок, выровненный по start и не выходящий за end
    // (арифметика на Number, а не побитовая: адреса выше 2^31 в 32-битных операциях JS становятся отрицательными)
    let size = 1;
    while (size < 2 ** 32 && start % (size * 2) === 0 && size * 2 <= end - start + 1) size *= 2;
    out.push(`${toIp(start)}/${32 - Math.log2(size)}`);
    start += size;
  }
  return out;
}

/** Весь IPv4 за вычетом `excluded` — списком CIDR (для AllowedIPs) */
export function complementCidrs(excluded: Range[]): string[] {
  const merged = mergeRanges(excluded);
  const out: string[] = [];
  let next = 0;
  for (const [a, b] of merged) {
    if (a > next) out.push(...rangeToCidrs([next, a - 1]));
    next = b + 1;
  }
  if (next <= 0xffffffff) out.push(...rangeToCidrs([next, 0xffffffff]));
  return out;
}
