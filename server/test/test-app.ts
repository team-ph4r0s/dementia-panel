import http from 'node:http';
import express from 'express';
import { authRouter } from '../src/routes/auth.js';
import { serversRouter } from '../src/routes/servers.js';
import { clientsRouter } from '../src/routes/clients.js';
import { subscribersRouter } from '../src/routes/subscribers.js';
import { subscriptionRouter } from '../src/routes/subscription.js';
import { securityRouter } from '../src/routes/security.js';
import { settingsRouter } from '../src/routes/settings.js';
import { subscriptionSettingsRouter } from '../src/routes/subscription-settings.js';
import { federationRouter } from '../src/routes/federation.js';
import { partnersRouter } from '../src/routes/partners.js';
import { remotePanelsRouter } from '../src/routes/remote-panels.js';
import { versionRouter } from '../src/routes/version.js';
import { migrationRouter } from '../src/routes/migration.js';
import { probesRouter } from '../src/routes/probes.js';
import { bridgesRouter } from '../src/routes/bridges.js';
import { eventsRouter } from '../src/routes/events.js';
import { telegramRouter } from '../src/routes/telegram.js';
import { backupsRouter } from '../src/routes/backups.js';
import { nodeUpdatesRouter } from '../src/routes/node-updates.js';
import { migrationGuard, subscriptionFreeze } from '../src/middleware/migration-guard.js';
import { requireAuth } from '../src/middleware/auth.middleware.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { securityHeaders } from '../src/middleware/security-headers.js';
import { cloudflareClientIp } from '../src/middleware/cloudflare.js';

export function createTestApp() {
  const app = express();
  app.use(securityHeaders);
  app.use(cloudflareClientIp);
  app.use(express.json({ limit: '1mb' }));

  // Public subscription
  app.use('/sub', subscriptionFreeze, subscriptionRouter);

  // Блокировка изменений во время переноса панели
  app.use('/api', migrationGuard);

  // Federation API
  app.use('/api/federation/v1', federationRouter);

  // Auth routes
  app.use('/api/auth', authRouter);

  // Перенос панели на другой сервер
  app.use('/api/migration', migrationRouter);

  // Protected Admin API Routes
  app.use('/api/servers', requireAuth, serversRouter);
  app.use('/api/subscribers', subscribersRouter);
  app.use('/api/security', securityRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/subscription-settings', subscriptionSettingsRouter);
  app.use('/api/partners', partnersRouter);
  app.use('/api/remote-panels', remotePanelsRouter);
  app.use('/api/probes', probesRouter);
  app.use('/api/bridges', bridgesRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/telegram', telegramRouter);
  app.use('/api/backups', backupsRouter);
  app.use('/api/node-updates', nodeUpdatesRouter);
  app.use('/api/version', versionRouter);
  app.use('/api', requireAuth, clientsRouter);

  // Тот же обработчик ошибок, что и в index.ts
  app.use(errorHandler);

  return app;
}

export async function startTestServer() {
  const app = createTestApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as import('node:net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const request = async (path: string, options: RequestInit = {}) => {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    return fetch(url, options);
  };

  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  return { server, baseUrl, request, close };
}
