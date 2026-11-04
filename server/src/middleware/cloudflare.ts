import net from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { getSetting } from '../db/index.js';

// Published at https://www.cloudflare.com/ips-v4 and /ips-v6 (checked 2026-11-04).
const ranges = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];
const cloudflare = new net.BlockList();
for (const range of ranges) {
  const [ip, prefix] = range.split('/');
  cloudflare.addSubnet(ip, Number(prefix), net.isIPv4(ip) ? 'ipv4' : 'ipv6');
}
export function isCloudflareAddress(value: string): boolean {
  const ip = value.replace(/^::ffff:/i, '');
  const family = net.isIP(ip);
  return Boolean(family && cloudflare.check(ip, family === 4 ? 'ipv4' : 'ipv6'));
}

/** Trust the client-IP header only from Cloudflare's actual socket peer; never trust a public X-Forwarded-For. */
export function cloudflareClientIp(req: Request, _res: Response, next: NextFunction): void {
  const ip = req.headers['cf-connecting-ip'];
  if (getSetting('cf_panel_enabled') === '1' && isCloudflareAddress(req.socket.remoteAddress ?? '') &&
      typeof ip === 'string' && net.isIP(ip)) {
    Object.defineProperty(req, 'ip', { value: ip, configurable: true });
  }
  next();
}
