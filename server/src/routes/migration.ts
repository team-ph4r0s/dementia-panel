import { NextFunction, Request, Response, Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { migrationCodeLimiter, reauthLimiter } from '../middleware/rate-limit.js';
import { AuthService } from '../services/auth.service.js';
import { MigrationService } from '../services/migration.service.js';
import { asyncHandler, contentDisposition, HttpError } from '../utils/http.js';

/**
 * Перенос панели на другой сервер (docs/migration.md). Часть маршрутов публичная: новый сервер ещё не имеет сессии и
 * доказывает знание кода переноса заголовком X-Migration-Auth (производная от кода, сам код по сети не передаётся).
 */
export const migrationRouter = Router();

function requireMigrationAuth(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || 'unknown';
  const blockedMs = migrationCodeLimiter.blockedFor(ip);
  if (blockedMs > 0) {
    res.setHeader('Retry-After', Math.ceil(blockedMs / 1000));
    return res.status(429).json({ error: `Слишком много неверных кодов. Повторите через ${Math.ceil(blockedMs / 60000)} мин.` });
  }
  const auth = req.get('x-migration-auth') ?? '';
  if (!/^[0-9a-f]{64}$/.test(auth) || !MigrationService.verifyAuth(auth)) {
    migrationCodeLimiter.registerFailure(ip);
    return res.status(403).json({ error: 'Неверный или просроченный код переноса' });
  }
  migrationCodeLimiter.reset(ip);
  next();
}

// GET /api/migration/archive — зашифрованный архив для нового сервера (по коду переноса)
migrationRouter.get('/archive', requireMigrationAuth, asyncHandler(async (req, res) => {
  const archive = MigrationService.buildArchive();
  console.log(`[MIGRATION] Архив переноса передан ${req.ip ?? 'неизвестному адресу'}: изменения в панели заблокированы до завершения переноса`);
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/octet-stream').send(archive);
}));

// POST /api/migration/finish — новая панель запущена: эта замораживается; body: { newUrl }
migrationRouter.post('/finish', requireMigrationAuth, (req, res) => {
  const newUrl = typeof req.body?.newUrl === 'string' ? req.body.newUrl.trim().slice(0, 300) : null;
  MigrationService.finish(newUrl);
  console.log(`[MIGRATION] Перенос завершён, панель заморожена${newUrl ? `; новый адрес ${JSON.stringify(newUrl)}` : ''}`);
  res.json({ success: true });
});

// Дальше — только для администратора
migrationRouter.use(requireAuth);

// GET /api/migration/status
migrationRouter.get('/status', (req, res) => {
  res.json(MigrationService.getStatus());
});

// POST /api/migration/prepare — выдать код переноса (по паролю администратора); показывается один раз
migrationRouter.post('/prepare', asyncHandler(async (req: AuthenticatedRequest, res) => {
  const password = req.body?.password;
  if (typeof password !== 'string' || !password) throw new HttpError(400, 'Введите пароль администратора');

  const key = `admin:${req.user!.id}`;
  const blockedMs = reauthLimiter.blockedFor(key);
  if (blockedMs > 0) throw new HttpError(429, `Слишком много неверных паролей. Повторите через ${Math.ceil(blockedMs / 60000)} мин.`);
  if (!(await AuthService.confirmPasswordAsync(req.user!.id, password))) {
    reauthLimiter.registerFailure(key);
    throw new HttpError(400, 'Неверный пароль');
  }
  reauthLimiter.reset(key);

  const { code, expiresAt } = MigrationService.prepare();
  console.log('[MIGRATION] Выдан код переноса панели (действует 1 час)');
  res.json({ code, expiresAt });
}));

// GET /api/migration/download — тот же архив файлом (если новому серверу недоступен адрес этой панели)
migrationRouter.get('/download', asyncHandler(async (req, res) => {
  const archive = MigrationService.buildArchive();
  console.log('[MIGRATION] Архив переноса скачан администратором: изменения в панели заблокированы до завершения переноса');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', contentDisposition('attachment', `dementia-migration-${new Date().toISOString().slice(0, 10)}.dpm`));
  res.type('application/octet-stream').send(archive);
}));

// POST /api/migration/cancel — отменить перенос (или снять блокировку изменений)
migrationRouter.post('/cancel', (req, res) => {
  MigrationService.cancel();
  console.log('[MIGRATION] Перенос отменён администратором');
  res.json({ success: true });
});
