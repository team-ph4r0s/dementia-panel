import { Router } from 'express';
import { SslService } from '../services/ssl.service.js';
import { Fail2banService } from '../services/fail2ban.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { EventService } from '../services/event.service.js';
import { CloudflarePanelService } from '../services/cloudflare-panel.service.js';
import { PanelAddressService } from '../services/panel-address.service.js';

export const securityRouter = Router();

securityRouter.use(requireAuth);

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, message);
  return value.trim();
}

/**
 * Ошибки валидации/внешних сервисов отдаются как 400 с понятным текстом
 */
function wrap<T>(fn: () => Promise<T> | T) {
  return Promise.resolve()
    .then(fn)
    .catch((err: any) => {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, err.message || 'Ошибка операции');
    });
}

// ==============================================================================
// SSL / HTTPS Routes
// ==============================================================================

// GET SSL status
securityRouter.get('/ssl', (req, res) => {
  res.json(SslService.getStatus());
});

// IP-адрес панели (docs/security.md#panel-ip): состояние, применение нового адреса, автообновление
securityRouter.get('/panel-ip', (_req, res) => res.json(PanelAddressService.status()));
securityRouter.post('/panel-ip', asyncHandler(async (req, res) => {
  res.json(await PanelAddressService.apply(req.body?.ip));
}));
securityRouter.put('/panel-ip/auto', (req, res) => res.json(PanelAddressService.setAuto(req.body?.auto)));

securityRouter.get('/cloudflare', (_req, res) => res.json(CloudflarePanelService.status()));
securityRouter.post('/cloudflare', asyncHandler(async (req, res) => {
  res.json(await wrap(() => CloudflarePanelService.configure(req.body)));
}));
securityRouter.delete('/cloudflare', asyncHandler(async (_req, res) => {
  res.json(await wrap(() => CloudflarePanelService.disable()));
}));

// Verify Cloudflare Token
securityRouter.post('/ssl/verify-cf', asyncHandler(async (req, res) => {
  const token = await wrap(() => SslService.resolveCloudflareToken(req.body?.token));
  res.json(await SslService.verifyCloudflareToken(token));
}));

// Get Cloudflare Zones
securityRouter.post('/ssl/cf-zones', asyncHandler(async (req, res) => {
  const token = await wrap(() => SslService.resolveCloudflareToken(req.body?.token));
  res.json(await wrap(() => SslService.getCloudflareZones(token)));
}));

// Issue Let's Encrypt via Cloudflare DNS-01
securityRouter.post('/ssl/issue-cf', asyncHandler(async (req, res) => {
  const { domain, email, token, createARecord = true } = req.body ?? {};
  if (!domain || !email) {
    throw new HttpError(400, 'Домен и email обязательны');
  }
  res.json(await wrap(() => SslService.exclusive(() => SslService.issueLetsEncryptCloudflare(domain, email, SslService.resolveCloudflareToken(token), Boolean(createARecord)))));
}));

// Issue Let's Encrypt via HTTP-01
securityRouter.post('/ssl/issue-http', asyncHandler(async (req, res) => {
  const { domain, email } = req.body ?? {};
  if (!domain || !email) throw new HttpError(400, 'Домен и email обязательны');
  res.json(await wrap(() => SslService.exclusive(() => SslService.issueLetsEncryptHttp(domain, email))));
}));

// Issue Self-Signed IP Certificate
securityRouter.post('/ssl/issue-ip', asyncHandler(async (req, res) => {
  const ip = requireString(req.body?.ip, 'IP адрес или домен обязателен');
  res.json(await wrap(() => SslService.exclusive(() => SslService.generateSelfSignedIpCert(ip))));
}));

// Save Custom Certificate
securityRouter.post('/ssl/custom', asyncHandler(async (req, res) => {
  const { cert, key, domain } = req.body ?? {};
  if (!cert || !key) throw new HttpError(400, 'Сертификат (fullchain) и ключ обязательны');
  await wrap(() => SslService.exclusive(() => SslService.saveCustomCertificate(cert, key, typeof domain === 'string' ? domain : undefined)));
  res.json({ success: true, message: 'Сертификат успешно сохранен' });
}));

// Toggle SSL
securityRouter.post('/ssl/toggle', asyncHandler(async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  if (!enabled && CloudflarePanelService.status().enabled) throw new HttpError(409, 'Сначала отключите проксирование Cloudflare: оно требует HTTPS на сервере');
  await wrap(() => SslService.exclusive(() => SslService.toggleSsl(enabled)));
  EventService.log('info', 'tls.toggled', enabled ? 'HTTPS включён' : 'HTTPS отключён');
  res.json({ success: true, enabled });
}));

// ==============================================================================
// Fail2ban Routes
// ==============================================================================

// GET Fail2ban status
securityRouter.get('/fail2ban', asyncHandler(async (req, res) => {
  res.json(await Fail2banService.getStatus());
}));

// Unban IP
securityRouter.post('/fail2ban/unban', asyncHandler(async (req, res) => {
  res.json(await wrap(() => Fail2banService.unbanIp(req.body?.ip)));
}));

// Ban IP
securityRouter.post('/fail2ban/ban', asyncHandler(async (req, res) => {
  res.json(await wrap(() => Fail2banService.banIp(req.body?.ip)));
}));

// Setup local Fail2ban
securityRouter.post('/fail2ban/setup', asyncHandler(async (req, res) => {
  res.json(await wrap(() => Fail2banService.setupLocal()));
}));
