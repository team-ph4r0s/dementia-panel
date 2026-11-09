import { getSetting, setSetting } from '../db/index.js';
import { HttpError, base64HeaderValue } from '../utils/http.js';

/**
 * Оформление подписки для Incy (https://docs.incy.cc/en/subscription-format/).
 * Значения хранятся в таблице settings с префиксом sub_.
 */
export interface SubscriptionSettings {
  /** Название подписки; {user} заменяется именем пользователя. До 25 символов после подстановки. */
  title: string;
  description: string;
  update_interval: number;
  /** Объявление на главном экране, до 200 символов */
  announce: string;
  announce_url: string;
  support_url: string;
  support_email: string;
  web_page_url: string;
  sort_order: '' | 'ping' | 'name' | 'none';
  hide_url: boolean;
  /** mihomo: группа «Авто» (fallback) — приложение само переходит на следующую работающую ноду */
  clash_auto: boolean;
}

export const TITLE_MAX = 25;
const ANNOUNCE_MAX = 200;
const DESCRIPTION_MAX = 500;
const SORT_ORDERS = ['', 'ping', 'name', 'none'] as const;

const DEFAULTS: SubscriptionSettings = {
  title: '{user}',
  description: '',
  update_interval: 12,
  announce: '',
  announce_url: '',
  support_url: '',
  support_email: '',
  web_page_url: '',
  sort_order: '',
  hide_url: false,
  clash_auto: true,
};

export function readSubscriptionSettings(): SubscriptionSettings {
  const interval = Number(getSetting('sub_update_interval'));
  const sort = getSetting('sub_sort_order') || '';
  return {
    title: getSetting('sub_title') || DEFAULTS.title,
    description: getSetting('sub_description') || '',
    update_interval: Number.isInteger(interval) && interval > 0 ? interval : DEFAULTS.update_interval,
    announce: getSetting('sub_announce') || '',
    announce_url: getSetting('sub_announce_url') || '',
    support_url: getSetting('sub_support_url') || '',
    support_email: getSetting('sub_support_email') || '',
    web_page_url: getSetting('sub_web_page_url') || '',
    sort_order: (SORT_ORDERS as readonly string[]).includes(sort) ? (sort as SubscriptionSettings['sort_order']) : '',
    hide_url: getSetting('sub_hide_url') === '1',
    clash_auto: getSetting('sub_clash_auto') !== '0',
  };
}

/**
 * URL для заголовка: только http(s), в ASCII-виде (punycode/percent-encoding), чтобы заголовок был валидным
 */
function normalizeUrl(value: unknown, label: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `${label}: укажите ссылку вида https://example.com`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpError(400, `${label}: допустимы только http:// и https://`);
  }
  return url.href;
}

function limitText(value: unknown, max: number, label: string): string {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if ([...text].length > max) throw new HttpError(400, `${label}: не длиннее ${max} символов`);
  return text;
}

export function renderTitle(template: string, userName: string): string {
  const title = (template || DEFAULTS.title).split('{user}').join(userName);
  const chars = [...title];
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX - 1).join('') + '…' : title;
}

export function updateSubscriptionSettings(body: Record<string, unknown>): SubscriptionSettings {
  const current = readSubscriptionSettings();
  const next: SubscriptionSettings = { ...current };

  if (body.title !== undefined) {
    const title = limitText(body.title, 64, 'Название');
    // Проверяем длину без подстановки имени: {user} может сделать название длиннее, тогда оно обрезается
    if ([...title.split('{user}').join('')].length > TITLE_MAX) {
      throw new HttpError(400, `Название подписки: не длиннее ${TITLE_MAX} символов (без учёта {user})`);
    }
    next.title = title || DEFAULTS.title;
  }
  if (body.description !== undefined) next.description = limitText(body.description, DESCRIPTION_MAX, 'Описание');
  if (body.update_interval !== undefined) {
    const hours = Number(body.update_interval);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new HttpError(400, 'Интервал обновления: от 1 до 168 часов');
    next.update_interval = hours;
  }
  if (body.announce !== undefined) next.announce = limitText(body.announce, ANNOUNCE_MAX, 'Объявление');
  if (body.announce_url !== undefined) next.announce_url = normalizeUrl(body.announce_url, 'Ссылка объявления');
  if (body.support_url !== undefined) next.support_url = normalizeUrl(body.support_url, 'Ссылка поддержки');
  if (body.web_page_url !== undefined) next.web_page_url = normalizeUrl(body.web_page_url, 'Сайт');
  if (body.support_email !== undefined) {
    const email = String(body.support_email ?? '').trim();
    if (email && !/^[\x21-\x7e]+@[\x21-\x7e]+\.[a-z]{2,}$/i.test(email)) throw new HttpError(400, 'Некорректный email поддержки');
    next.support_email = email;
  }
  if (body.sort_order !== undefined) {
    const sort = String(body.sort_order);
    if (!(SORT_ORDERS as readonly string[]).includes(sort)) throw new HttpError(400, 'Некорректный порядок сортировки');
    next.sort_order = sort as SubscriptionSettings['sort_order'];
  }
  if (body.hide_url !== undefined) next.hide_url = Boolean(body.hide_url);
  if (body.clash_auto !== undefined) next.clash_auto = Boolean(body.clash_auto);

  const store = (key: string, value: string) => setSetting(key, value || null);
  store('sub_title', next.title === DEFAULTS.title ? '' : next.title);
  store('sub_description', next.description);
  store('sub_update_interval', next.update_interval === DEFAULTS.update_interval ? '' : String(next.update_interval));
  store('sub_announce', next.announce);
  store('sub_announce_url', next.announce_url);
  store('sub_support_url', next.support_url);
  store('sub_support_email', next.support_email);
  store('sub_web_page_url', next.web_page_url);
  store('sub_sort_order', next.sort_order);
  store('sub_hide_url', next.hide_url ? '1' : '');
  store('sub_clash_auto', next.clash_auto ? '' : '0');

  return next;
}

/**
 * HTTP-заголовки подписки. Текстовые значения передаются с префиксом base64:, чтобы допускать кириллицу и эмодзи.
 */
export function buildSubscriptionHeaders(settings: SubscriptionSettings, userName: string, extraDescription: string | null = null): Record<string, string> {
  const headers: Record<string, string> = {
    'Profile-Title': base64HeaderValue(renderTitle(settings.title, userName)),
    'Profile-Update-Interval': String(settings.update_interval),
  };
  const description = [settings.description, extraDescription].filter(Boolean).join('\n');
  if (description) headers['Profile-Description'] = base64HeaderValue(description);
  if (settings.announce) headers['Announce'] = base64HeaderValue(settings.announce);
  if (settings.announce_url) headers['Announce-Url'] = settings.announce_url;
  if (settings.support_url) headers['Support-Url'] = settings.support_url;
  if (settings.support_email) headers['Support-Email'] = settings.support_email;
  if (settings.web_page_url) headers['Profile-Web-Page-Url'] = settings.web_page_url;
  if (settings.sort_order) headers['Sort-Order'] = settings.sort_order;
  if (settings.hide_url) headers['Hide-Url'] = '1';
  return headers;
}
