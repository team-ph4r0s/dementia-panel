import { Router, type Request } from 'express';
import { db } from '../db/index.js';
import { AwgService } from '../services/awg.service.js';
import { cdnReady, XrayService } from '../services/xray.service.js';
import { SubscriptionService } from '../services/subscription.service.js';
import { buildSubscriptionHeaders, readSubscriptionSettings } from '../services/subscription-settings.service.js';
import { contentDisposition } from '../utils/http.js';
import { paramsFromRow } from '../utils/awg-params.js';
import { countryFlag, ProbeService } from '../services/probe.service.js';
import { BridgeService } from '../services/bridge.service.js';
import { renderSubscriptionPage } from './subscription-page.js';

/** Названия доп. параметров AWG 3.x в amnezia-wg-option mihomo */
const MIHOMO_EXTRA_KEYS: Record<string, string> = {
  ContentPaddingAddition: 'content-padding-addition',
  RekeyAfterTime: 'rekey-after-time',
  RekeyTimeout: 'rekey-timeout',
  RejectAfterTime: 'reject-after-time',
  KeepaliveTimeout: 'keepalive-timeout',
  MaxHandshakeAttempts: 'max-handshake-attempts',
  RandomTrailers: 'random-trailers',
  DisableCookies: 'disable-cookies',
};

function mihomoValue(value: string): string | number | boolean {
  if (/^(on|true)$/i.test(value)) return true;
  if (/^(off|false)$/i.test(value)) return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

/**
 * amnezia-wg-option для mihomo: version 3 включает параметры AWG 3.x (S3/S4, диапазоны H, защиту заголовков)
 */
export function mihomoAmneziaOption(server: any): Record<string, unknown> {
  const p = paramsFromRow(server);
  const option: Record<string, unknown> = { jc: p.jc, jmin: p.jmin, jmax: p.jmax, s1: p.s1, s2: p.s2 };
  if (p.awg_version === 3) option.version = 3;
  if (p.s3 !== null) option.s3 = p.s3;
  if (p.s4 !== null) option.s4 = p.s4;
  Object.assign(option, { h1: p.h1, h2: p.h2, h3: p.h3, h4: p.h4 });
  for (const key of ['i1', 'i2', 'i3', 'i4', 'i5'] as const) if (p[key]) option[key] = p[key];
  if (p.header_protection_key) option['header-protection-key'] = p.header_protection_key;
  for (const [key, value] of Object.entries(p.extra_params)) {
    if (MIHOMO_EXTRA_KEYS[key]) option[MIHOMO_EXTRA_KEYS[key]] = mihomoValue(value);
  }
  return option;
}

export const subscriptionRouter = Router();

type Format = 'awg' | 'json' | 'clash' | 'v2ray';

function isBrowserNavigation(req: Request): boolean {
  return req.query.format === undefined
    && req.get('sec-fetch-mode') === 'navigate'
    && req.get('sec-fetch-dest') === 'document'
    && /(?:^|,)\s*text\/html\s*(?:;|,|$)/i.test(req.get('accept') ?? '')
    && Boolean(req.accepts('html'));
}

/**
 * Формат по ?format= или по User-Agent: клиенты на ядре mihomo (Clash Verge Rev, FlClash, Mihomo Party,
 * Clash Meta for Android) понимают AmneziaWG только в собственном YAML-формате с amnezia-wg-option.
 */
export function detectFormat(query: unknown, userAgent: string | undefined): Format {
  if (query === 'json') return 'json';
  if (query === 'clash' || query === 'mihomo') return 'clash';
  if (query === 'awg' || query === 'incy') return 'awg';
  if (query === 'v2ray') return 'v2ray';
  if (userAgent && /mihomo|clash[\s.-]?meta|clash[\s-]?verge|flclash|clashmi|clash\.party/i.test(userAgent)) return 'clash';
  if (userAgent && /v2rayn|v2rayng|hiddify|streisand|(?:^|[\s/])happ(?:[\s/;.()-]|$)|nekobox/i.test(userAgent)) return 'v2ray';
  return 'awg';
}

/**
 * Конфигурация mihomo в виде JSON (валидный YAML 1.2): прокси, группа выбора и правило по умолчанию
 */
export function buildClashConfig(entries: { name: string; server: any; client: any }[], dns: string[], mtu: number): string {
  const used = new Set<string>();
  const proxies = entries.map(({ name, server, client }) => {
    let unique = name;
    for (let i = 2; used.has(unique); i++) unique = `${name} ${i}`;
    used.add(unique);
    if (server.protocol === 'vless') return XrayService.buildMihomoProxy(server, client, unique);
    const psk = client.preshared_key || server.preshared_key;
    return {
      name: unique,
      type: 'wireguard',
      server: server.host,
      port: server.awg_port,
      ip: `${client.client_ip}/32`,
      'private-key': client.client_private_key,
      'public-key': server.server_public_key,
      // null в pre-shared-key ломает разбор профиля в mihomo — без ключа поле не добавляется
      ...(psk ? { 'pre-shared-key': psk } : {}),
      // ::/0 оставлен намеренно: IPv6-трафик клиента не должен идти мимо туннеля (утечка адреса)
      'allowed-ips': ['0.0.0.0/0', '::/0'],
      mtu,
      udp: true,
      dns,
      'remote-dns-resolve': true,
      'amnezia-wg-option': mihomoAmneziaOption(server),
    };
  });

  const group = 'Dementia';
  return JSON.stringify(
    {
      'mixed-port': 7890,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'warning',
      proxies,
      'proxy-groups': [{ name: group, type: 'select', proxies: proxies.length ? proxies.map((p) => p.name) : ['DIRECT'] }],
      rules: [`MATCH,${group}`],
    },
    null,
    2
  );
}

/**
 * GET /sub/:token — публичная подписка.
 *
 * - по умолчанию: формат Incy — смешанный base64-список ссылок `awg://` и `vless://`;
 * - `?format=json`: JSON-контейнер Incy с AWG-конфигами и VLESS-ссылками;
 * - `?format=clash` или User-Agent клиента mihomo: YAML-конфигурация mihomo;
 * - `?format=v2ray` или User-Agent VLESS-клиента: base64-список только ссылок `vless://`.
 */
subscriptionRouter.get('/:token', (req, res) => {
  const { token } = req.params;
  const format = detectFormat(req.query.format, req.get('user-agent'));
  const showPage = format === 'awg' && isBrowserNavigation(req);

  res.setHeader('Cache-Control', 'no-store');
  res.vary('Accept').vary('Sec-Fetch-Mode').vary('Sec-Fetch-Dest').vary('User-Agent');

  const subscriber = db.prepare('SELECT * FROM subscribers WHERE token = ?').get(token) as any;
  if (!subscriber) {
    return res.status(404).type('text/plain').send('Subscription not found');
  }

  if (!subscriber.enabled) {
    return res.status(403).type('text/plain').send('Subscription is disabled');
  }

  const usage = SubscriptionService.getUsage(subscriber.id);
  const expired = SubscriptionService.isExpired(subscriber);
  const overLimit = SubscriptionService.isOverLimit(subscriber, usage);
  const active = !expired && !overLimit;
  const expire = subscriber.expire_at ? Math.floor(new Date(subscriber.expire_at).getTime() / 1000) : 0;

  res.setHeader(
    'Subscription-Userinfo',
    `upload=${usage.upload}; download=${usage.download}; total=${subscriber.traffic_limit || 0}; expire=${expire}`
  );
  const subscriptionSettings = readSubscriptionSettings();
  for (const [name, value] of Object.entries(buildSubscriptionHeaders(subscriptionSettings, subscriber.name, ProbeService.getLegend()))) {
    res.setHeader(name, value);
  }

  // Все установленные ноды пользователя: временно недоступная нода не должна пропадать из приложения
  const peers = active
    ? (db.prepare(`
        SELECT c.*, s.name AS server_name, s.sub_name, s.host, s.awg_port, s.server_public_key, s.preshared_key AS server_psk,
          s.protocol, s.reality_sni, s.reality_dest, s.reality_short_ids, s.xray_flow, s.xray_fingerprint,
          s.xray_transport, s.xhttp_path, s.xhttp_mode, s.cdn_enabled, s.cdn_domain, s.cdn_port, s.cdn_address,
          s.cdn_cert IS NOT NULL AND s.cdn_key IS NOT NULL AS cdn_has_cert,
          s.awg_version, s.jc, s.jmin, s.jmax, s.s1, s.s2, s.s3, s.s4, s.h1, s.h2, s.h3, s.h4,
          s.i1, s.i2, s.i3, s.i4, s.i5, s.header_protection_key, s.extra_params
        FROM clients c
        JOIN servers s ON c.server_id = s.id
        WHERE c.subscriber_id = ? AND c.enabled = 1 AND c.external = 0 AND s.status != 'uninstalled'
          AND c.client_ip NOT LIKE 'pending:%' AND COALESCE(c.remote_state, '') != 'blocked' AND s.server_public_key IS NOT NULL
        ORDER BY s.sub_order, s.id
      `).all(subscriber.id) as any[])
    : [];

  const settings = AwgService.getClientNetworkSettings();
  // Доступность нод из выбранных стран дописывается к названию (если включено)
  const marks = ProbeService.getNameMarks();
  // Ноды, недоступные из страны пользователя, выдаются через мост этой страны: меняется только Endpoint (docs/bridges.md)
  const routes = BridgeService.routesFor(subscriber.country);
  const entries = peers.filter((p) => p.protocol !== 'vless' || p.client_uuid).flatMap((p) => {
    const route = routes.get(p.server_id);
    const direct = {
      name: [p.sub_name || p.server_name, marks.get(p.server_id), route ? `🌉 ${countryFlag(subscriber.country)}` : null].filter(Boolean).join(' · '),
      server: { ...p, preshared_key: p.server_psk, ...(route ? { host: route.host, awg_port: route.port } : {}) },
      client: p,
    };
    // Нода VLESS с готовым входом через CDN — вторая запись: адрес Cloudflare вместо IP ноды (docs/vless.md#cdn).
    // Мост её не трогает: у неё свой адрес и порт
    const viaCdn = p.protocol === 'vless' && cdnReady({ ...p, cdn_cert: p.cdn_has_cert, cdn_key: p.cdn_has_cert })
      ? [{ name: [p.sub_name || p.server_name, 'CDN'].join(' · '), server: { ...p, via_cdn: true }, client: p }]
      : [];
    return [direct, ...viaCdn];
  });

  if (showPage) {
    return res.type('html').send(renderSubscriptionPage({
      title: subscriber.name,
      status: expired ? 'Срок истёк' : overLimit ? 'Лимит исчерпан' : 'Активна',
      active,
      expire,
      used: usage.used,
      limit: subscriber.traffic_limit,
      nodes: entries.map((entry) => entry.name),
    }));
  }

  res.setHeader('Content-Disposition', contentDisposition('inline', `${subscriber.name}.${format === 'clash' ? 'yaml' : 'txt'}`));

  if (format === 'clash') {
    const dns = settings.dns.split(',').map((s) => s.trim()).filter(Boolean);
    return res.type('text/yaml; charset=utf-8').send(buildClashConfig(entries, dns, settings.mtu));
  }

  if (format === 'json') {
    const servers = entries.map((e) => e.server.protocol === 'vless'
      ? { name: e.name, protocol: 'vless', link: XrayService.buildVlessLink(e.server, e.client, e.name) }
      : { name: e.name, config: Buffer.from(AwgService.generateClientConfig(e.server, e.client, settings)).toString('base64url') });
    return res.json({ type: 'amneziawg', version: 1, servers });
  }

  const links = entries.filter((e) => format !== 'v2ray' || e.server.protocol === 'vless').map((e) => {
    if (e.server.protocol === 'vless') return XrayService.buildVlessLink(e.server, e.client, e.name);
    const config = Buffer.from(AwgService.generateClientConfig(e.server, e.client, settings)).toString('base64url');
    return `awg://${config}#${encodeURIComponent(e.name)}`;
  });
  res.type('text/plain; charset=utf-8').send(Buffer.from(links.join('\n')).toString('base64'));
});
