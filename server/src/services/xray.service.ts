import crypto from 'node:crypto';
import { formatEndpointHost } from '../utils/net.js';
import { VlessParams, toXrayKey, vlessParamsFromRow } from '../utils/vless-params.js';

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
  static generateServerConfig(_server: any, _clients: any[]): string {
    throw new Error('XrayService.generateServerConfig: не реализовано');
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
