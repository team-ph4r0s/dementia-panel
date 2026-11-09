import crypto from 'node:crypto';
import { db, getSetting } from '../db/index.js';
import { awgAllowedIps } from './direct-routing.service.js';
import { allocateIp, formatEndpointHost, parseSubnet } from '../utils/net.js';
import {
  AwgParams,
  AwgVersion,
  generateAwgParams,
  paramsFromRow,
  renderAwgLines,
  validateAwgParams,
} from '../utils/awg-params.js';

export type { AwgParams } from '../utils/awg-params.js';

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export interface ClientNetworkSettings {
  dns: string;
  mtu: number;
  /** AllowedIPs клиента: весь интернет, либо за вычетом «прямых» сетей (direct-routing.service) */
  allowedIps: string[];
}

export class AwgService {
  /**
   * Generate Curve25519 (x25519) keypair in WireGuard/AmneziaWG Base64 format
   */
  static generateKeyPair(): KeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');

    // In PKCS#8 DER format, the raw 32-byte private key starts at byte offset 16
    const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    const privBase64 = privDer.subarray(16).toString('base64');

    // In SPKI DER format, the raw 32-byte public key starts at byte offset 12
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    const pubBase64 = pubDer.subarray(12).toString('base64');

    return {
      privateKey: privBase64,
      publicKey: pubBase64,
    };
  }

  /**
   * Derive public key from a Base64 private key
   */
  static derivePublicKey(privateKeyBase64: string): string {
    const raw = Buffer.from(privateKeyBase64, 'base64');
    const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]);
    const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  }

  /**
   * Generate 32-byte random Pre-shared Key (PSK) in Base64
   */
  static generatePresharedKey(): string {
    return crypto.randomBytes(32).toString('base64');
  }

  /**
   * Randomized AmneziaWG obfuscation parameters (по умолчанию — актуальной версии протокола)
   */
  static generateRandomParams(version?: AwgVersion): AwgParams {
    return generateAwgParams(version);
  }

  /**
   * Validate obfuscation parameters; returns error message or null
   */
  static validateParams(p: AwgParams): string | null {
    return validateAwgParams(p);
  }

  /**
   * Calculate next available IP address for a client on the given server
   */
  static getNextClientIp(serverId: number, subnet = '10.8.0.1/24'): string {
    const rows = db.prepare('SELECT client_ip FROM clients WHERE server_id = ?').all(serverId) as { client_ip: string }[];
    return allocateIp(subnet, rows.map((r) => r.client_ip));
  }

  static getClientNetworkSettings(): ClientNetworkSettings {
    const mtu = Number(getSetting('client_mtu'));
    return {
      dns: getSetting('client_dns') || '1.1.1.1, 8.8.8.8',
      mtu: Number.isInteger(mtu) && mtu >= 576 && mtu <= 1500 ? mtu : 1280,
      allowedIps: awgAllowedIps(),
    };
  }

  /**
   * Generate client .conf file string
   */
  static generateClientConfig(server: any, client: any, settings = AwgService.getClientNetworkSettings()): string {
    // Без ключа строка PresharedKey не пишется: «PresharedKey = null» клиенты WireGuard/AmneziaWG не принимают
    const psk = client.preshared_key || server.preshared_key;
    return `[Interface]
Address = ${client.client_ip}/32
DNS = ${settings.dns}
MTU = ${settings.mtu}
PrivateKey = ${client.client_private_key}
${renderAwgLines(paramsFromRow(server), 'client')}

[Peer]
PublicKey = ${server.server_public_key}
${psk ? `PresharedKey = ${psk}\n` : ''}AllowedIPs = ${settings.allowedIps.join(', ')}
Endpoint = ${formatEndpointHost(server.host)}:${server.awg_port}
PersistentKeepalive = 25
`;
  }

  /**
   * Generate full server config containing interface and all active peers.
   * Peer is active when the client is enabled and (if it belongs to a subscriber) the subscriber is active.
   */
  static generateServerConfig(server: any, clients: any[]): string {
    let conf = `[Interface]
PrivateKey = ${server.server_private_key}
Address = ${server.subnet}
ListenPort = ${server.awg_port}
${renderAwgLines(paramsFromRow(server), 'server')}
`;

    for (const client of clients) {
      if (client.enabled && client.subscriber_active !== 0) {
        const psk = client.preshared_key || server.preshared_key;
        conf += `
[Peer]
PublicKey = ${client.client_public_key}
${psk ? `PresharedKey = ${psk}\n` : ''}AllowedIPs = ${client.client_ip}/32
`;
      }
    }

    return conf;
  }

  /**
   * Network address of the tunnel subnet (used for NAT inside the container)
   */
  static getTunnelNetwork(subnet: string): string {
    return parseSubnet(subnet, false).network;
  }
}
