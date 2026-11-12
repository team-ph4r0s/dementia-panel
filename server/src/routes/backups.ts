import { Router } from 'express';
import { db, getSetting, setSetting } from '../db/index.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { reauthLimiter } from '../middleware/rate-limit.js';
import { AuthService } from '../services/auth.service.js';
import { BackupService } from '../services/backup.service.js';
import { encryptSecret } from '../services/secrets.service.js';
import { asyncHandler, contentDisposition, HttpError } from '../utils/http.js';

export const backupsRouter = Router();
backupsRouter.use(requireAuth);

backupsRouter.get('/settings', (req, res) => res.json({ settings: BackupService.getSettings() }));
backupsRouter.put('/settings', (req, res) => {
  const body = req.body ?? {};
  if (typeof body.enabled !== 'boolean' || !['yandex', 'google'].includes(body.provider)) throw new HttpError(400, 'Некорректные настройки копирования');
  const interval = Number(body.interval_hours);
  const retention = Number(body.retention);
  if (!Number.isInteger(interval) || interval < 1 || interval > 168 || !Number.isInteger(retention) || retention < 1 || retention > 100) {
    throw new HttpError(400, 'Период — 1–168 часов, хранить — 1–100 копий');
  }
  setSetting('backup_enabled', body.enabled ? '1' : '0');
  setSetting('backup_provider', body.provider);
  setSetting('backup_interval_hours', String(interval));
  setSetting('backup_retention', String(retention));
  for (const [field, key, secret] of [
    ['yandex_username', 'backup_yandex_username', false],
    ['yandex_password', 'backup_yandex_password', true],
    ['google_client_id', 'backup_google_client_id', false],
    ['google_client_secret', 'backup_google_client_secret', true],
    ['google_refresh_token', 'backup_google_refresh_token', true],
    ['google_folder_id', 'backup_google_folder_id', false],
  ] as const) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string' || body[field].length > 4096) throw new HttpError(400, 'Некорректные настройки хранилища');
    setSetting(key, secret ? encryptSecret(body[field].trim() || null) : body[field].trim() || null);
  }
  res.json({ settings: BackupService.getSettings() });
});

backupsRouter.post('/test', asyncHandler(async (req, res) => {
  await BackupService.testStorage();
  res.json({ success: true, message: 'Подключение к хранилищу работает' });
}));
backupsRouter.post('/run', asyncHandler(async (req, res) => {
  const result = await BackupService.runNow();
  res.status(result.success ? 200 : 409).json(result);
}));
backupsRouter.get('/', asyncHandler(async (req, res) => res.json({ backups: await BackupService.list() })));
backupsRouter.get('/:id/download', asyncHandler(async (req, res) => {
  const files = await BackupService.list();
  const file = files.find((item) => item.id === req.params.id);
  if (!file) throw new HttpError(404, 'Резервная копия не найдена');
  const data = await BackupService.download(file.id);
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-disposition', contentDisposition('attachment', file.name));
  res.send(data);
}));
backupsRouter.delete('/:id', asyncHandler(async (req, res) => {
  await BackupService.delete(String(req.params.id));
  res.json({ success: true });
}));
backupsRouter.post('/recovery-key', (req: AuthenticatedRequest, res) => {
  const key = `admin:${req.user!.id}`;
  if (reauthLimiter.blockedFor(key) > 0) throw new HttpError(429, 'Слишком много неверных паролей. Повторите позже');
  const admin = db.prepare('SELECT password_hash, salt FROM admins WHERE id = ?').get(req.user!.id) as { password_hash: string; salt: string };
  if (typeof req.body?.password !== 'string' || !AuthService.verifyPassword(req.body.password, admin.password_hash, admin.salt)) {
    reauthLimiter.registerFailure(key);
    throw new HttpError(400, 'Неверный пароль');
  }
  reauthLimiter.reset(key);
  res.json({ recovery_key: BackupService.recoveryKey() });
});
