/**
 * Кнопки «Добавить в приложение» на странице подписки: ссылки-схемы (deep links), которые открывают приложение
 * и сами добавляют подписку. Схемы Incy и Hiddify сверены с их документацией (октябрь–ноябрь 2026), остальные —
 * общепринятые формы; приложение, не нашедшее схему, просто ничего не откроет, а ссылку можно скопировать вручную.
 * Чистые функции без доступа к БД и сети (docs/subscriptions.md).
 */

export type AppPlatform = 'android' | 'ios' | 'desktop';
/** Какой формат подписки отдавать приложению: основной (Incy), v2ray (только VLESS) или mihomo (YAML) */
export type AppFormat = 'awg' | 'v2ray' | 'clash';
export type AppProtocol = 'awg' | 'vless';

export interface SubscriptionApp {
  id: string;
  name: string;
  platforms: AppPlatform[];
  /** Протоколы панели, которые приложение умеет разобрать из выбранного формата */
  protocols: AppProtocol[];
  format: AppFormat;
  /** Собирает ссылку-схему: `url` — полный адрес подписки в нужном формате, `name` — название профиля */
  deepLink: (url: string, name: string) => string;
}

const enc = encodeURIComponent;
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

export const SUBSCRIPTION_APPS: SubscriptionApp[] = [
  { id: 'incy', name: 'Incy', platforms: ['ios', 'android'], protocols: ['awg', 'vless'], format: 'awg',
    deepLink: (url) => `incy://import/${url}` },
  { id: 'flclash', name: 'FlClash', platforms: ['android', 'desktop'], protocols: ['awg', 'vless'], format: 'clash',
    deepLink: (url, name) => `flclash://install-config?url=${enc(url)}&name=${enc(name)}` },
  { id: 'clash-verge', name: 'Clash Verge Rev', platforms: ['desktop'], protocols: ['awg', 'vless'], format: 'clash',
    deepLink: (url, name) => `clash://install-config?url=${enc(url)}&name=${enc(name)}` },
  { id: 'hiddify', name: 'Hiddify', platforms: ['android', 'ios', 'desktop'], protocols: ['vless'], format: 'v2ray',
    deepLink: (url, name) => `hiddify://import/${url}#${enc(name)}` },
  { id: 'v2rayng', name: 'v2rayNG', platforms: ['android'], protocols: ['vless'], format: 'v2ray',
    deepLink: (url, name) => `v2rayng://install-sub?url=${enc(url)}&name=${enc(name)}` },
  { id: 'happ', name: 'Happ', platforms: ['android', 'ios', 'desktop'], protocols: ['vless'], format: 'v2ray',
    deepLink: (url) => `happ://add/${url}` },
  { id: 'streisand', name: 'Streisand', platforms: ['ios'], protocols: ['vless'], format: 'v2ray',
    deepLink: (url, name) => `streisand://import/${url}#${enc(name)}` },
  { id: 'shadowrocket', name: 'Shadowrocket', platforms: ['ios'], protocols: ['vless'], format: 'v2ray',
    deepLink: (url, name) => `shadowrocket://add/sub://${b64(url)}?remark=${enc(name)}` },
  { id: 'sing-box', name: 'sing-box', platforms: ['android', 'ios', 'desktop'], protocols: ['vless'], format: 'v2ray',
    deepLink: (url, name) => `sing-box://import-remote-profile?url=${enc(url)}#${enc(name)}` },
  { id: 'nekobox', name: 'NekoBox', platforms: ['android'], protocols: ['vless'], format: 'v2ray',
    deepLink: (url, name) => `sn://subscription?url=${enc(url)}&name=${enc(name)}` },
];

/** Адрес подписки нужного формата: основной формат — без параметра */
export function subscriptionUrl(base: string, format: AppFormat): string {
  return format === 'awg' ? base : `${base}?format=${format}`;
}

/** Приложения, подходящие подписке: хотя бы один из её протоколов приложение понимает */
export function appsFor(protocols: Set<AppProtocol>): SubscriptionApp[] {
  return SUBSCRIPTION_APPS.filter((app) => app.protocols.some((p) => protocols.has(p)));
}
