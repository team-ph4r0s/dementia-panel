import crypto from 'node:crypto';
import { formatEndpointHost } from '../utils/net.js';
import { VlessParams, vlessParamsFromRow } from '../utils/vless-params.js';

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
  static buildVlessLink(_server: any, _client: any, _name: string, _endpointHost?: string, _endpointPort?: number): string {
    void formatEndpointHost;
    throw new Error('XrayService.buildVlessLink: не реализовано');
  }

  /**
   * Прокси mihomo: `{name, type: 'vless', server, port, uuid, network: 'tcp', tls: true, udp: true, flow,
   * servername, client-fingerprint, reality-opts: {public-key, short-id}}`.
   */
  static buildMihomoProxy(_server: any, _client: any, _name: string, _endpointHost?: string, _endpointPort?: number): Record<string, unknown> {
    throw new Error('XrayService.buildMihomoProxy: не реализовано');
  }
}
