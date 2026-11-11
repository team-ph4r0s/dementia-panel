/**
 * Вкладка «Провайдеры»: проверка введённых данных и расчёт даты ближайшего платежа (docs/providers.md).
 * Чистые функции без БД и сети. Даты считаются в UTC.
 */

export const PROVIDER_CURRENCIES = ['RUB', 'USD', 'EUR'] as const;
export type ProviderCurrency = typeof PROVIDER_CURRENCIES[number];
export const CURRENCY_SYMBOLS: Record<ProviderCurrency, string> = { RUB: '₽', USD: '$', EUR: '€' };

/** Сколько дней до платежа напоминать по умолчанию: накануне и в день платежа */
export const DEFAULT_REMIND_DAYS = [1, 0];
export const DEFAULT_REMIND_HOUR_UTC = 6;
export const MAX_REMIND_DAYS = 30;

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Дата платежа в заданном году/месяце: 31-е в коротком месяце сдвигается на последний день месяца */
function dueIn(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, Math.min(day, daysInMonth(year, month))));
}

/**
 * Ближайшая дата платежа не раньше сегодняшнего дня. Без месяца платёж ежемесячный (в `day` число каждого месяца),
 * с месяцем — раз в год (например, 15/03).
 */
export function nextDueDate(now: Date, day: number, month: number | null): Date {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const y = today.getUTCFullYear();
  if (month) {
    const thisYear = dueIn(y, month, day);
    return thisYear >= today ? thisYear : dueIn(y + 1, month, day);
  }
  const m = today.getUTCMonth() + 1;
  const thisMonth = dueIn(y, m, day);
  if (thisMonth >= today) return thisMonth;
  return m === 12 ? dueIn(y + 1, 1, day) : dueIn(y, m + 1, day);
}

export function daysBetween(now: Date, due: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((due.getTime() - today) / 86400000);
}

/** Убирает управляющие символы (в т.ч. переводы строк) и обрезает по краям */
export function cleanText(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${field}: ожидается строка`);
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (text.length > max) throw new Error(`${field}: не длиннее ${max} символов`);
  return text || null;
}

/**
 * Пароль кабинета хранится в точности как введён (пробелы по краям — часть пароля, #88): он шифруется и никуда не
 * подставляется. null и пустая строка — стереть.
 */
export function cleanSecret(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${field}: ожидается строка`);
  if (value.length > max) throw new Error(`${field}: не длиннее ${max} символов`);
  return value;
}

/** Ссылка на личный кабинет: только http(s), чтобы не получить javascript: в ссылке интерфейса */
export function validateCabinetUrl(value: unknown): string | null {
  const text = cleanText(value, 500, 'Ссылка на кабинет');
  if (!text) return null;
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error('Ссылка на кабинет должна начинаться с http:// или https://'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Ссылка на кабинет должна начинаться с http:// или https://');
  return parsed.toString();
}

export function validateAmount(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100_000_000) throw new Error('Сумма платежа должна быть числом от 0 до 100 000 000');
  return Math.round(n * 100) / 100;
}

export function validatePayDay(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error('День платежа — число от 1 до 31');
  return n;
}

export function validatePayMonth(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 12) throw new Error('Месяц платежа — число от 1 до 12');
  return n;
}

export function validateRemindDays(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('Дни напоминаний — список чисел');
  const days = [...new Set(value.map(Number))];
  if (days.some((n) => !Number.isInteger(n) || n < 0 || n > MAX_REMIND_DAYS)) throw new Error(`Напоминать можно за 0–${MAX_REMIND_DAYS} дней до платежа`);
  if (days.length === 0) throw new Error('Укажите хотя бы один день напоминания');
  return days.sort((a, b) => b - a);
}

export function formatDue(date: Date): string {
  return `${pad2(date.getUTCDate())}.${pad2(date.getUTCMonth() + 1)}`;
}

export function formatAmount(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency as ProviderCurrency] ?? currency;
  const text = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${text} ${symbol}`;
}

/** Текст напоминания (без логина и пароля) */
export function reminderText(opts: { name: string; host: string | null; daysLeft: number; due: Date; amount: number | null; currency: string; url: string | null }): string {
  const when = opts.daysLeft === 0 ? 'Сегодня' : opts.daysLeft === 1 ? 'Завтра' : `Через ${opts.daysLeft} дн.`;
  const lines = [`💳 ${when} (${formatDue(opts.due)}) платёж за сервер «${opts.name}»${opts.host ? ` (${opts.host})` : ''}`];
  if (opts.amount !== null) lines.push(`Сумма: ${formatAmount(opts.amount, opts.currency)}`);
  if (opts.url) lines.push(`Личный кабинет: ${opts.url}`);
  return lines.join('\n');
}
