import crypto from 'node:crypto';
import { formatEndpointHost } from '../utils/net.js';
import {
  toXrayKey, VlessParams, vlessParamsFromRow, XRAY_API_PORT, XRAY_CDN_INBOUND_TAG, XRAY_INBOUND_TAG,
} from '../utils/vless-params.js';
import { decryptSecret } from './secrets.service.js';


/** ALPN входа через CDN: Cloudflare говорит с клиентом по h2, с нодой — по HTTP/1.1 (h2 к источнику по умолчанию выключен) */
const CDN_ALPN = ['h2', 'http/1.1'];

/** Готов ли вход через CDN: включён, есть домен, порт и сертификат с ключом */
export function cdnReady(server: any): boolean {
  return Boolean(server?.cdn_enabled && server.cdn_domain && server.cdn_port && server.cdn_cert && server.cdn_key);
}

/** PEM для inline-сертификата Xray (`certificate`/`key` — массивы строк): файлы на ноде не нужны, конфиг целиком из БД */
function pemLines(pem: string): string[] {
  return pem.replace(/\r/g, '').split('\n').filter((line) => line.length > 0);
}

/** Частные сети явным списком: geoip.dat в образе не требуется (без него Xray не запустился бы) */
const PRIVATE_NETWORKS = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16',
  '::1/128', 'fc00::/7', 'fe80::/10',
];

/**
 * VLESS + Reality (Xray-core): аналог AwgService для нод с `protocol = 'vless'`.
 *
 * Конфиг ноды генерируется целиком из БД (инвариант 10): всё, чего нет в БД, при синхронизации исчезнет с ноды.
 * Активные клиенты — те же, что для AWG (`ProvisionService.getServerClients`, инвариант 13).
 */
export class XrayService {
  static generateUuid(): string {
    return crypto.randomUUID();
  }

  static params(server: any): VlessParams {
    return vlessParamsFromRow(server);
  }

  /**
   * Полный config.json Xray для ноды (строка JSON с отступами).
   * - inbound `XRAY_INBOUND_TAG` на `0.0.0.0:<awg_port>` tcp, security reality (privateKey — `toXrayKey`),
   *   clients: `{id: client_uuid, flow, email: 'c<client.id>'}` — email нужен для статистики трафика по клиенту;
   * - api-inbound dokodemo-door на 127.0.0.1:XRAY_API_PORT (HandlerService, StatsService), policy со статистикой
   *   uplink/downlink пользователей, outbounds freedom + blackhole, routing api → api;
   * - routing `IPIfNonMatch`: запросы в частные сети блокируются и по IP, и по домену, который в них резолвится;
   * - транспорт Reality-входа — `raw` (tcp) или `xhttp` с путём `xhttp_path` (сервер принимает любой режим — `auto`);
   * - вход через CDN (`cdnReady`): inbound `XRAY_CDN_INBOUND_TAG` на `cdn_port`, XHTTP + TLS с сертификатом домена
   *   прямо в config.json; flow пустой (через CDN Vision не нужен), email тот же — трафик суммируется;
   * - клиенты без client_uuid или неактивные (enabled/subscriber_active, как в AwgService.generateServerConfig) не попадают.
   */
  static generateServerConfig(server: any, clients: any[]): string {
    const params = this.params(server);
    const active = clients
      .filter((client) => client.client_uuid && client.enabled && !client.owner_blocked && client.subscriber_active !== 0);
    const users = active.map((client) => ({ id: client.client_uuid, flow: params.xray_flow, email: `c${client.id}`, level: 0 }));
    const sniffing = { enabled: true, destOverride: ['http', 'tls', 'quic'] };
    const realityStream = params.xray_transport === 'xhttp'
      ? { network: 'xhttp', xhttpSettings: { path: params.xhttp_path, mode: 'auto' } }
      : { network: 'tcp' };
    const cdnInbounds = cdnReady(server)
      ? [{
        tag: XRAY_CDN_INBOUND_TAG,
        listen: '0.0.0.0',
        port: Number(server.cdn_port),
        protocol: 'vless',
        settings: { clients: active.map((client) => ({ id: client.client_uuid, flow: '', email: `c${client.id}`, level: 0 })), decryption: 'none' },
        streamSettings: {
          network: 'xhttp',
          xhttpSettings: { path: params.xhttp_path, mode: 'auto' },
          security: 'tls',
          tlsSettings: {
            alpn: CDN_ALPN,
            certificates: [{ certificate: pemLines(server.cdn_cert), key: pemLines(decryptSecret(server.cdn_key) ?? '') }],
          },
        },
        sniffing,
      }]
      : [];

    return JSON.stringify({
      log: { loglevel: 'warning' },
      api: { tag: 'api', services: ['HandlerService', 'StatsService'] },
      stats: {},
      policy: { levels: { 0: { statsUserUplink: true, statsUserDownlink: true } } },
      inbounds: [
        {
          tag: 'api',
          listen: '127.0.0.1',
          port: XRAY_API_PORT,
          protocol: 'dokodemo-door',
          settings: { address: '127.0.0.1' },
        },
        {
          tag: XRAY_INBOUND_TAG,
          listen: '0.0.0.0',
          port: server.awg_port,
          protocol: 'vless',
          settings: { clients: users, decryption: 'none' },
          streamSettings: {
            ...realityStream,
            security: 'reality',
            realitySettings: {
              show: false,
              dest: params.reality_dest,
              xver: 0,
              serverNames: [params.reality_sni],
              privateKey: toXrayKey(server.server_private_key),
              shortIds: params.reality_short_ids,
            },
          },
          sniffing,
        },
        ...cdnInbounds,
      ],
      outbounds: [{ protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'block' }],
      routing: {
        // IPIfNonMatch: домен из запроса клиента резолвится и сверяется с IP-правилами. С AsIs правило частных сетей
        // обходилось доменом, указывающим на 127.0.0.1 (localtest.me и т.п.), — клиент VPN достучался бы до API Xray
        // на 127.0.0.1:XRAY_API_PORT и до служб самого хоста
        domainStrategy: 'IPIfNonMatch',
        rules: [
          { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
          { type: 'field', ip: PRIVATE_NETWORKS, outboundTag: 'block' },
        ],
      },
    }, null, 2);
  }

  /**
   * Ссылка `vless://<uuid>@<host>:<port>?type=tcp&security=reality&pbk=…&fp=…&sni=…&sid=…&flow=…&encryption=none#<имя>`.
   * Хост — `formatEndpointHost(host)` (IPv6 в скобках); `endpointHost` подменяет адрес (мосты, BridgeService.routesFor).
   * Имя кодируется encodeURIComponent.
   */
  static buildVlessLink(server: any, client: any, name: string, endpointHost?: string, endpointPort?: number): string {
    // Запись подписки «через CDN» (server.via_cdn) — та же нода, другой вход
    if (server.via_cdn) return this.buildVlessCdnLink(server, client, name);
    const params = vlessParamsFromRow(server);
    const query = [
      ['type', params.xray_transport],
      ...(params.xray_transport === 'xhttp'
        ? [['path', params.xhttp_path], ['host', params.reality_sni], ['mode', params.xhttp_mode]]
        : []),
      ['security', 'reality'],
      ['pbk', toXrayKey(server.server_public_key)],
      ['fp', params.xray_fingerprint],
      ['sni', params.reality_sni],
      ['sid', params.reality_short_ids[0] ?? ''],
      ...(params.xray_flow ? [['flow', params.xray_flow]] : []),
      ['encryption', 'none'],
    ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    const host = formatEndpointHost(endpointHost || server.host);
    const port = endpointPort ?? server.awg_port;
    return `vless://${client.client_uuid}@${host}:${port}?${query}#${encodeURIComponent(name)}`;
  }

  /**
   * Прокси mihomo: `{name, type: 'vless', server, port, uuid, network: 'tcp', tls: true, udp: true, flow,
   * servername, client-fingerprint, reality-opts: {public-key, short-id}}`.
   */
  static buildMihomoProxy(server: any, client: any, name: string, endpointHost?: string, endpointPort?: number): Record<string, unknown> {
    if (server.via_cdn) return this.buildMihomoCdnProxy(server, client, name);
    const params = vlessParamsFromRow(server);
    return {
      name,
      type: 'vless',
      server: endpointHost || server.host,
      port: endpointPort ?? server.awg_port,
      uuid: client.client_uuid,
      network: params.xray_transport,
      ...(params.xray_transport === 'xhttp'
        ? { 'xhttp-opts': { path: params.xhttp_path, host: params.reality_sni, mode: params.xhttp_mode } }
        : {}),
      tls: true,
      udp: true,
      ...(params.xray_flow ? { flow: params.xray_flow } : {}),
      servername: params.reality_sni,
      'client-fingerprint': params.xray_fingerprint,
      'reality-opts': {
        'public-key': toXrayKey(server.server_public_key),
        'short-id': params.reality_short_ids[0] ?? '',
      },
    };
  }

  /** Адрес, к которому клиент подключается через CDN: «чистый» IP/домен Cloudflare (`cdn_address`) или сам домен */
  static cdnEndpoint(server: any): { host: string; port: number; domain: string } {
    return { host: server.cdn_address || server.cdn_domain, port: Number(server.cdn_port), domain: server.cdn_domain };
  }

  /**
   * Ссылка входа через CDN: `vless://<uuid>@<cdn_address|cdn_domain>:<cdn_port>?type=xhttp&path=…&host=<домен>&mode=…
   * &security=tls&sni=<домен>&alpn=h2,http/1.1&fp=…&encryption=none#<имя>`. Без flow: Vision через CDN не используется.
   */
  static buildVlessCdnLink(server: any, client: any, name: string): string {
    const params = vlessParamsFromRow(server);
    const cdn = this.cdnEndpoint(server);
    const query = [
      ['type', 'xhttp'],
      ['path', params.xhttp_path],
      ['host', cdn.domain],
      ['mode', params.xhttp_mode],
      ['security', 'tls'],
      ['sni', cdn.domain],
      ['alpn', CDN_ALPN.join(',')],
      ['fp', params.xray_fingerprint],
      ['encryption', 'none'],
    ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    return `vless://${client.client_uuid}@${formatEndpointHost(cdn.host)}:${cdn.port}?${query}#${encodeURIComponent(name)}`;
  }

  /** Прокси mihomo для входа через CDN (XHTTP + TLS) */
  static buildMihomoCdnProxy(server: any, client: any, name: string): Record<string, unknown> {
    const params = vlessParamsFromRow(server);
    const cdn = this.cdnEndpoint(server);
    return {
      name,
      type: 'vless',
      server: cdn.host,
      port: cdn.port,
      uuid: client.client_uuid,
      network: 'xhttp',
      'xhttp-opts': { path: params.xhttp_path, host: cdn.domain, mode: params.xhttp_mode },
      tls: true,
      udp: true,
      servername: cdn.domain,
      alpn: CDN_ALPN,
      'client-fingerprint': params.xray_fingerprint,
    };
  }
}
