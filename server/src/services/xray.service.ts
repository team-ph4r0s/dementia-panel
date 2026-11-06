import crypto from 'node:crypto';
import { formatEndpointHost } from '../utils/net.js';
import { toXrayKey, VlessParams, vlessParamsFromRow, XRAY_API_PORT, XRAY_INBOUND_TAG } from '../utils/vless-params.js';

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
   * - клиенты без client_uuid или неактивные (enabled/subscriber_active, как в AwgService.generateServerConfig) не попадают.
   */
  static generateServerConfig(server: any, clients: any[]): string {
    const params = this.params(server);
    const users = clients
      .filter((client) => client.client_uuid && client.enabled && !client.owner_blocked && client.subscriber_active !== 0)
      .map((client) => ({ id: client.client_uuid, flow: params.xray_flow, email: `c${client.id}`, level: 0 }));

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
            network: 'tcp',
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
          sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
        },
      ],
      outbounds: [{ protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'block' }],
      routing: {
        domainStrategy: 'AsIs',
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
    const params = vlessParamsFromRow(server);
    const query = [
      ['type', 'tcp'],
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
    const params = vlessParamsFromRow(server);
    return {
      name,
      type: 'vless',
      server: endpointHost || server.host,
      port: endpointPort ?? server.awg_port,
      uuid: client.client_uuid,
      network: 'tcp',
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
}
