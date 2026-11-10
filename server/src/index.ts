import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import type { TLSSocket } from 'node:tls';
import express, { Request } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { initDatabase, db } from './db/index.js';
import { AuthService, type SessionUser } from './services/auth.service.js';
import { requireAuth } from './middleware/auth.middleware.js';
import { loginIpLimiter, loginUserLimiter, migrationCodeLimiter, reauthLimiter } from './middleware/rate-limit.js';
import { authRouter } from './routes/auth.js';
import { serversRouter } from './routes/servers.js';
import { clientsRouter } from './routes/clients.js';
import { subscribersRouter } from './routes/subscribers.js';
import { subscriptionRouter } from './routes/subscription.js';
import { securityRouter } from './routes/security.js';
import { settingsRouter } from './routes/settings.js';
import { subscriptionSettingsRouter } from './routes/subscription-settings.js';
import { federationRouter, cleanupFederationLimits } from './routes/federation.js';
import { partnersRouter } from './routes/partners.js';
import { remotePanelsRouter } from './routes/remote-panels.js';
import { versionRouter } from './routes/version.js';
import { migrationRouter } from './routes/migration.js';
import { probesRouter } from './routes/probes.js';
import { ProbeService } from './services/probe.service.js';
import { bridgesRouter } from './routes/bridges.js';
import { eventsRouter } from './routes/events.js';
import { telegramRouter } from './routes/telegram.js';
import { backupsRouter } from './routes/backups.js';
import { nodeUpdatesRouter } from './routes/node-updates.js';
import { providersRouter } from './routes/providers.js';
import { NodeUpdateService } from './services/node-update.service.js';
import { ProviderService } from './services/provider.service.js';
import { BackupService } from './services/backup.service.js';
import { LiveService } from './services/live.service.js';
import { REVALIDATE, staticHeaders } from './middleware/static-cache.js';
import { BridgeService } from './services/bridge.service.js';
import { ExtraPortsService } from './services/extra-ports.service.js';
import { migrationGuard, subscriptionFreeze } from './middleware/migration-guard.js';
import { MigrationService } from './services/migration.service.js';
import { PANEL_VERSION } from './services/version.service.js';
import { PartnerService } from './services/partner.service.js';
import { FederationClient } from './services/federation-client.service.js';
import { ProvisionService } from './services/provision.service.js';
import { SubscriptionService } from './services/subscription.service.js';
import { CdnService } from './services/cdn.service.js';
import { PanelAddressService } from './services/panel-address.service.js';
import { SslService, http01Challenges } from './services/ssl.service.js';
import { errorHandler } from './middleware/error-handler.js';
import { securityHeaders } from './middleware/security-headers.js';
import { cloudflareClientIp } from './middleware/cloudflare.js';
import { CloudflarePanelService } from './services/cloudflare-panel.service.js';
import { PanelIngressService } from './services/panel-ingress.service.js';
import { httpsRedirectLocation } from './utils/net.js';

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL?] Необработанное отклонение промиса:', reason);
});

// Initialize SQLite database
initDatabase();

// Ensure initial admin exists (пароль никогда не пишется в лог, кроме сгенерированного один раз)
AuthService.ensureDefaultAdmin(process.env.PANEL_USER, process.env.PANEL_PASSWORD);

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

const isEncrypted = (req: Request) => Boolean((req.socket as TLSSocket).encrypted);

app.use(securityHeaders);
app.use(cloudflareClientIp);

// Let's Encrypt HTTP-01 challenge responder (когда панель сама слушает 80 порт)
app.get('/.well-known/acme-challenge/:token', (req, res) => {
  const keyAuth = http01Challenges.get(req.params.token);
  if (keyAuth) {
    res.type('text/plain').send(keyAuth);
  } else {
    res.status(404).send('Challenge not found');
  }
});

// Public Subscription Endpoint — доступен и по HTTP, чтобы выданные ранее ссылки не ломались после включения HTTPS.
// У перенесённой на другой сервер панели ссылки перенаправляются на новый адрес
app.use('/sub', subscriptionFreeze, subscriptionRouter);

// При включённом HTTPS остальные запросы по обычному HTTP перенаправляются на HTTPS
app.use((req, res, next) => {
  if (!SslService.isActive() || isEncrypted(req)) return next();
  // Проверка запуска (install.sh опрашивает http://127.0.0.1:порт) не раскрывает ничего, кроме статуса
  // Проверка запуска (install.sh опрашивает http://127.0.0.1:порт) не раскрывает ничего, кроме статуса
  if (req.path === '/api/health') return next();
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Панель доступна только по HTTPS', https: true });
  }
  // Хост редиректа — домен сертификата, а не заголовок Host (его может подставить кто угодно)
  const location = httpsRedirectLocation(req.headers.host, req.originalUrl, SslService.getStatus().domain);
  if (!location) return res.status(403).type('text/plain').send('Панель доступна только по HTTPS');
  res.redirect(302, location);
});

app.use(express.json({ limit: '1mb' }));

// Во время переноса на другой сервер изменения блокируются, после переноса панель заморожена
app.use('/api', migrationGuard);

// Любая успешная запись через API обновляет интерфейсы администраторов по WebSocket
app.use('/api', LiveService.middleware);

// Public Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    https: SslService.isActive(),
    timestamp: new Date().toISOString(),
  });
});

// API для панелей партнёров (авторизация по партнёрскому токену, только HTTPS)
app.use('/api/federation/v1', federationRouter);

// Authentication routes (login, me, logout, change-password)
app.use('/api/auth', authRouter);

// Перенос панели на другой сервер (часть маршрутов — по коду переноса, остальные — для администратора)
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
app.use('/api/providers', providersRouter);
app.use('/api/version', versionRouter);
app.use('/api', requireAuth, clientsRouter);

// Unknown API routes must not fall through to the SPA
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Метод API не найден' });
});

// Serve frontend if built
const clientDistCandidates = [
  path.resolve(process.cwd(), 'client/dist'),
  path.resolve(process.cwd(), '../client/dist'),
];
const clientDistPath = clientDistCandidates.find((p) => fs.existsSync(p));
if (clientDistPath) {
  app.use(express.static(clientDistPath, { setHeaders: staticHeaders(clientDistPath) }));
  // Запасной маршрут SPA: оболочка всегда с проверкой (см. middleware/static-cache.ts)
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', REVALIDATE);
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

// JSON error handler (в т.ч. некорректный JSON в теле запроса)
app.use(errorHandler);

// ==============================================================================
// HTTP и HTTPS на одном порту: первый байт 0x16 — TLS ClientHello
// ==============================================================================

const httpServer = http.createServer(app);
let httpsServer: https.Server | null = null;

function loadTls(): void {
  if (!SslService.hasCertificate()) return;
  try {
    const { cert, key } = SslService.readCertificate();
    if (httpsServer) {
      httpsServer.setSecureContext({ cert, key });
    } else {
      httpsServer = https.createServer({ cert, key }, app);
      httpsServer.on('upgrade', handleUpgrade);
      httpsServer.on('tlsClientError', () => {});
    }
    console.log('🔒 TLS-сертификат загружен');
  } catch (err) {
    console.error('Ошибка загрузки SSL сертификатов, HTTPS недоступен:', err);
  }
}

SslService.onCertificateChanged(loadTls);

const panelConnection = (socket: net.Socket) => {
  socket.on('error', () => socket.destroy());
  // Соединение, не приславшее ни байта, закрывается (дальше таймауты задают HTTP/HTTPS-серверы)
  socket.setTimeout(30000, () => socket.destroy());
  socket.once('data', (chunk) => {
    socket.setTimeout(0);
    socket.pause();
    socket.unshift(chunk);
    const target = chunk[0] === 0x16 && httpsServer && SslService.isActive() ? httpsServer : httpServer;
    target.emit('connection', socket);
    process.nextTick(() => socket.resume());
  });
};
const mainServer = net.createServer(panelConnection);
PanelIngressService.configure(() => net.createServer(panelConnection));

// ==============================================================================
// WebSocket: живые логи установки и сигнал «данные изменились» для интерфейса. Первое сообщение — {type: 'auth', token}.
// ==============================================================================

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
wss.on('error', (err) => console.error('[WS] Ошибка сервера:', err));

function handleUpgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
  const pathname = (req.url || '').split('?')[0];
  const encrypted = Boolean((socket as TLSSocket).encrypted);
  if (pathname !== '/ws' || (SslService.isActive() && !encrypted)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}
httpServer.on('upgrade', handleUpgrade);

const send = (ws: WebSocket, payload: unknown) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
};

wss.on('connection', (ws: WebSocket) => {
  let user: SessionUser | null = null;
  let sessionToken = '';
  /** Сессия по-прежнему действительна и принадлежит администратору (выход, отзыв, смена пароля — закрывают сокет) */
  const sessionValid = () => AuthService.validateSession(sessionToken)?.role === 'admin';
  // Некорректный фрейм не должен ронять процесс
  ws.on('error', () => ws.terminate());
  const authTimer = setTimeout(() => {
    if (!user) ws.close(4401, 'auth timeout');
  }, 10000);
  ws.on('close', () => clearTimeout(authTimer));

  ws.on('message', async (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send(ws, { type: 'error', message: 'Некорректное сообщение' });
    }

    if (!user) {
      if (msg?.type === 'auth' && typeof msg.token === 'string') {
        user = AuthService.validateSession(msg.token);
        // Установка нод меняет панель и ноды: гостю (только просмотр) WebSocket не нужен
        if (user?.role === 'guest') user = null;
      }
      if (!user) {
        send(ws, { type: 'error', message: 'Необходима авторизация' });
        return ws.close(4401, 'unauthorized');
      }
      clearTimeout(authTimer);
      sessionToken = msg.token;
      LiveService.add(ws, sessionValid);
      return send(ws, { type: 'auth_ok' });
    }

    // Сессию проверяем перед каждой командой, а не только при входе: отозванный токен не должен запускать установку
    if (!sessionValid()) {
      user = null;
      send(ws, { type: 'error', message: 'Сессия истекла или недействительна' });
      return ws.close(4401, 'session expired');
    }

    try {
      if (msg.type === 'start_install' && Number.isInteger(msg.serverId)) {
        // Установка меняет БД и ноду: пока панель переносится на другой сервер, это потерялось бы (как и записи через API)
        if (MigrationService.isBackgroundPaused()) {
          return send(ws, { type: 'error', message: 'Идёт перенос панели на другой сервер: установка недоступна. Завершите или отмените перенос.' });
        }
        send(ws, { type: 'log', data: `Запуск задачи установки для сервера #${msg.serverId}...\r\n` });
        const result = await ProvisionService.installServer(msg.serverId, (logChunk) => send(ws, { type: 'log', data: logChunk }));
        send(ws, { type: 'install_finished', result });
        LiveService.notify();
      }
    } catch (err: any) {
      send(ws, { type: 'error', message: err.message });
    }
  });
});

// ==============================================================================
// Фоновые задачи
// ==============================================================================

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()!;
      await fn(item).catch(() => {});
    }
  });
  await Promise.all(workers);
}

// Опрос нод: статистика, восстановление статуса, досинхронизация. Следующий цикл — после завершения текущего.
async function statsLoop() {
  try {
    // Пока ноды переходят к новой панели, эта не должна ни синхронизировать их, ни менять статусы
    if (MigrationService.isBackgroundPaused()) return;
    const servers = db.prepare("SELECT id FROM servers WHERE status IN ('online', 'offline', 'error')").all() as { id: number }[];
    await mapLimit(servers, 5, async (s) => {
      await ProvisionService.fetchServerStats(s.id);
      LiveService.notify();
    });
    // Мосты: правила из БД применены и на месте
    await BridgeService.checkAll();
    // Запасные порты нод: правила из БД применены и ведут на нынешний адрес контейнера
    await ExtraPortsService.checkAll();
    SubscriptionService.refreshSuspension();
    PartnerService.refreshSuspension();
    LiveService.notify();
  } catch (err) {
    console.error('[STATS] Ошибка фонового опроса:', err);
  } finally {
    setTimeout(statsLoop, 30000);
  }
}
setTimeout(statsLoop, 5000);

// Синхронизация нод и клиентов на панелях партнёров
async function federationLoop() {
  try {
    if (MigrationService.isBackgroundPaused()) return;
    await FederationClient.syncAll();
    LiveService.notify();
  } catch (err) {
    console.error('[FEDERATION] Ошибка синхронизации:', err);
  } finally {
    setTimeout(federationLoop, 60000);
  }
}
setTimeout(federationLoop, 10000);

// После проверки из стран — сквозная проверка мостов и пересчёт, кому из пользователей нужен мост
ProbeService.afterRun = () => BridgeService.afterProbeRun();

// Проверка доступности нод из выбранных стран (если включена): раз в минуту смотрим, не пора ли
async function probeLoop() {
  try {
    if (MigrationService.isBackgroundPaused()) return;
    if (ProbeService.isDue()) await ProbeService.runAll();
    // Сигнал от клиентов (обрыв рукопожатий) учитывается чаще, чем идут проверки из стран
    BridgeService.evaluate(false);
    LiveService.notify();
  } catch (err) {
    console.error('[PROBE] Ошибка проверки:', err);
  } finally {
    setTimeout(probeLoop, 60000);
  }
}
setTimeout(probeLoop, 20000);

async function backupLoop() {
  try {
    await BackupService.runIfDue();
  } catch (err) {
    console.error('[BACKUP] Ошибка фонового копирования:', err);
  } finally {
    setTimeout(backupLoop, 60000);
  }
}
setTimeout(backupLoop, 30000);

async function nodeUpdateLoop() {
  try { await NodeUpdateService.tick(); }
  catch (err) { console.error('[NODE UPDATE] Ошибка обслуживания образов:', err); }
  finally { setTimeout(nodeUpdateLoop, 60000); }
}
setTimeout(nodeUpdateLoop, 45000);

// Напоминания об оплате серверов в Telegram (docs/providers.md): раз в 15 минут, каждое уходит один раз
async function providerReminderLoop() {
  try { await ProviderService.tick(); }
  catch (err) { console.error('[PROVIDERS] Ошибка напоминаний об оплате:', err); }
  finally { setTimeout(providerReminderLoop, 15 * 60 * 1000); }
}
setTimeout(providerReminderLoop, 90000);

setInterval(() => {
  cleanupFederationLimits();
  AuthService.cleanupExpiredSessions();
  loginIpLimiter.cleanup();
  loginUserLimiter.cleanup();
  reauthLimiter.cleanup();
  migrationCodeLimiter.cleanup();
}, 60 * 60 * 1000);

// Смена публичного IP панели: раз в 10 минут (docs/security.md#panel-ip)
setInterval(() => {
  if (MigrationService.isBackgroundPaused()) return;
  PanelAddressService.check().catch((err) => console.error('[IP]', err));
}, 10 * 60 * 1000);
setTimeout(() => {
  if (!MigrationService.isBackgroundPaused()) PanelAddressService.check().catch((err) => console.error('[IP]', err));
}, 60 * 1000);

const renew = () => {
  // Сертификат перенесённой панели продлевает новая
  if (MigrationService.isBackgroundPaused()) return;
  SslService.renewIfNeeded().catch((err) => console.error('[SSL]', err));
  CdnService.renewAll().catch((err) => console.error('[CDN]', err));
};
setTimeout(renew, 60 * 1000);
setInterval(renew, 12 * 60 * 60 * 1000);

loadTls();

const PORT = Number(process.env.PORT) || 3001;
mainServer.listen(PORT, () => {
  void CloudflarePanelService.restoreIngress();
  console.log(`🚀 Dementia Panel ${PANEL_VERSION} running on port ${PORT} (${SslService.isActive() ? 'HTTPS + HTTP для подписок' : 'HTTP'})`);
});
