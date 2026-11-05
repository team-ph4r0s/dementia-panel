import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { AuthService, MIN_PASSWORD_LENGTH, USERNAME_PATTERN } from '../services/auth.service.js';
import { requireAuth, AuthenticatedRequest, getBearerToken } from '../middleware/auth.middleware.js';
import { loginIpLimiter, loginUserLimiter, reauthLimiter } from '../middleware/rate-limit.js';
import { HttpError } from '../utils/http.js';
import { EventService } from '../services/event.service.js';
import { LiveService } from '../services/live.service.js';

export const authRouter = Router();

/** Логин длиннее не может существовать (USERNAME_PATTERN — до 64 символов); запас — для имён старых версий */
const MAX_LOGIN_LENGTH = 128;
const MAX_PASSWORD_INPUT = 1024;

// Выход, отзыв сессии, смена пароля или логина завершают сессии — их WebSocket закрываются сразу, а не при следующей рассылке
authRouter.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') res.on('finish', () => LiveService.dropInvalid());
  next();
});

/**
 * Подтверждение паролем для смены учётных данных: неверные попытки ограничены (429 после 5 за 15 минут)
 */
function assertReauthAllowed(adminId: number): string {
  const key = `admin:${adminId}`;
  const blockedMs = reauthLimiter.blockedFor(key);
  if (blockedMs > 0) throw new HttpError(429, `Слишком много неверных паролей. Повторите через ${Math.ceil(blockedMs / 60000)} мин.`);
  return key;
}

// POST /api/auth/login
authRouter.post('/login', (req, res) => {
  const { username, password, totp, recovery_code } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }
  // Длинные строки не доходят ни до ограничителей (ключ хранится в памяти), ни до scrypt
  if (username.length > MAX_LOGIN_LENGTH || password.length > MAX_PASSWORD_INPUT) {
    return res.status(400).json({ error: 'Слишком длинный логин или пароль' });
  }

  const ipKey = req.ip || 'unknown';
  const userKey = username.toLowerCase();
  // Блокировка по логину защищает от перебора с множества адресов, но не должна закрывать вход самому администратору:
  // с IP, откуда он уже входил, действует только лимит по IP
  const userBlockedMs = AuthService.isKnownLoginIp(ipKey) ? 0 : loginUserLimiter.blockedFor(userKey);
  const blockedMs = Math.max(loginIpLimiter.blockedFor(ipKey), userBlockedMs);
  if (blockedMs > 0) {
    res.setHeader('Retry-After', Math.ceil(blockedMs / 1000));
    return res.status(429).json({
      error: `Слишком много неудачных попыток. Повторите через ${Math.ceil(blockedMs / 60000)} мин.`,
    });
  }

  // Перебор кода 2FA (при верном пароле) ограничен отдельно: 5 неверных кодов за 15 минут — затем 429
  const codeKey = `admin:login:${userKey}`;
  const codeSubmitted = Boolean(totp || recovery_code);
  const codeBlockedMs = codeSubmitted ? reauthLimiter.blockedFor(codeKey) : 0;
  if (codeBlockedMs > 0) {
    res.setHeader('Retry-After', Math.ceil(codeBlockedMs / 1000));
    return res.status(429).json({ error: `Слишком много неверных кодов. Повторите через ${Math.ceil(codeBlockedMs / 60000)} мин.` });
  }

  let result = AuthService.loginWithTotp(username, password, totp, recovery_code, req.ip, req.get('user-agent'));
  if (result === 'invalid_code') {
    reauthLimiter.registerFailure(codeKey);
    result = null;
  }

  if (result === 'totp_required') {
    // 2FA включена, клиент должен запросить код и отправить повторно
    return res.json({ totp_required: true });
  }

  if (!result) {
    loginIpLimiter.registerFailure(ipKey);
    loginUserLimiter.registerFailure(userKey);
    // Логин задаёт посторонний: JSON.stringify экранирует переводы строк и не даёт подделать записи журнала
    console.warn(`[AUTH] Неудачная попытка входа для ${JSON.stringify(username.slice(0, 64))} с ${ipKey}`);
    EventService.log('warning', 'auth.login_failed', `Неудачный вход для ${username.slice(0, 64)} с ${ipKey}`);
    return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
  }

  // Счётчик IP сбрасывает только вход администратора: иначе гость с того же адреса (общий NAT) обнулял бы его
  // между сериями попыток подобрать пароль администратора
  if (result.user.role === 'admin') loginIpLimiter.reset(ipKey);
  loginUserLimiter.reset(userKey);
  reauthLimiter.reset(codeKey);
  // Адрес гостя в доверенные не попадает: исключение из блокировки по логину — только для администратора
  if (ipKey !== 'unknown' && result.user.role === 'admin') AuthService.rememberLoginIp(ipKey);
  if (result.user.role === 'guest') {
    EventService.log('info', 'auth.guest_login', `Гость ${result.user.username} вошёл в панель с ${ipKey}`);
  } else {
    EventService.log('info', 'auth.login', `Администратор ${result.user.username} вошёл в панель`, { kind: 'admin', id: result.user.id });
  }
  res.json(result);
});

// GET /api/auth/me
authRouter.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/logout
authRouter.post('/logout', requireAuth, (req: AuthenticatedRequest, res) => {
  const token = getBearerToken(req);
  if (token) AuthService.logout(token);
  res.json({ success: true, message: 'Выход выполнен' });
});

// POST /api/auth/change-password
authRouter.post('/change-password', requireAuth, (req: AuthenticatedRequest, res) => {
  const { oldPassword, newPassword } = req.body ?? {};
  if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || !oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Старый и новый пароли обязательны' });
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Новый пароль должен содержать не менее ${MIN_PASSWORD_LENGTH} символов` });
  }

  const limiterKey = assertReauthAllowed(req.user!.id);
  const token = AuthService.changePassword(req.user!.id, oldPassword, newPassword, req.ip, req.get('user-agent'));
  if (!token) {
    reauthLimiter.registerFailure(limiterKey);
    return res.status(400).json({ error: 'Неверный старый пароль' });
  }
  reauthLimiter.reset(limiterKey);
  EventService.log('info', 'auth.password_changed', 'Пароль администратора изменён', { kind: 'admin', id: req.user!.id });
  res.json({ success: true, token, message: 'Пароль успешно изменен. Остальные сессии завершены.' });
});

// POST /api/auth/change-username — смена логина администратора по текущему паролю
authRouter.post('/change-username', requireAuth, (req: AuthenticatedRequest, res) => {
  const { password, newUsername } = req.body ?? {};
  if (typeof password !== 'string' || typeof newUsername !== 'string' || !password || !newUsername.trim()) {
    return res.status(400).json({ error: 'Текущий пароль и новый логин обязательны' });
  }
  const username = newUsername.trim();
  if (!USERNAME_PATTERN.test(username)) {
    return res.status(400).json({ error: 'Логин: от 1 до 64 символов — латинские буквы, цифры и . _ @ -' });
  }
  if (username === req.user!.username) {
    return res.status(400).json({ error: 'Новый логин совпадает с текущим' });
  }

  const limiterKey = assertReauthAllowed(req.user!.id);
  const result = AuthService.changeUsername(req.user!.id, password, username, req.ip, req.get('user-agent'));
  if (result === 'wrong_password') {
    reauthLimiter.registerFailure(limiterKey);
    return res.status(400).json({ error: 'Неверный пароль' });
  }
  reauthLimiter.reset(limiterKey);
  if (result === 'taken') return res.status(409).json({ error: 'Такой логин уже занят' });

  console.log(`[AUTH] Логин администратора изменён с ${JSON.stringify(req.user!.username)} на ${JSON.stringify(result.username)}`);
  EventService.log('info', 'auth.username_changed', `Логин администратора изменён на ${result.username}`, { kind: 'admin', id: req.user!.id });
  res.json({
    success: true,
    token: result.token,
    user: { id: req.user!.id, username: result.username, role: 'admin' },
    message: 'Логин изменён. Остальные сессии завершены.',
  });
});

// ========== Гостевой доступ ==========

// GET /api/auth/guest — настройки гостевого доступа (пароль не возвращается)
authRouter.get('/guest', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json(AuthService.getGuestSettings());
});

// PUT /api/auth/guest — включить/отключить гостя, задать логин и пароль (по паролю администратора).
// Любое изменение завершает действующие гостевые сессии.
authRouter.put('/guest', requireAuth, (req: AuthenticatedRequest, res) => {
  const { enabled, username, password, current_password } = req.body ?? {};
  if (typeof enabled !== 'boolean' || typeof current_password !== 'string' || !current_password) {
    return res.status(400).json({ error: 'Укажите, включить ли гостевой доступ, и пароль администратора' });
  }

  const current = AuthService.getGuestSettings();
  const guestName = typeof username === 'string' ? username.trim() : current.username;
  if (enabled || guestName) {
    if (!USERNAME_PATTERN.test(guestName)) {
      return res.status(400).json({ error: 'Логин гостя: от 1 до 64 символов — латинские буквы, цифры и . _ @ -' });
    }
    if (AuthService.isAdminUsername(guestName)) {
      return res.status(409).json({ error: 'Этот логин принадлежит администратору — выберите другой' });
    }
  }
  if (password !== undefined && (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH)) {
    return res.status(400).json({ error: `Пароль гостя должен содержать не менее ${MIN_PASSWORD_LENGTH} символов` });
  }
  if (enabled && !password && !current.has_password) {
    return res.status(400).json({ error: 'Задайте пароль гостя' });
  }

  const limiterKey = assertReauthAllowed(req.user!.id);
  if (!AuthService.confirmPassword(req.user!.id, current_password)) {
    reauthLimiter.registerFailure(limiterKey);
    return res.status(400).json({ error: 'Неверный пароль' });
  }
  reauthLimiter.reset(limiterKey);
  if (password && AuthService.confirmPassword(req.user!.id, password)) {
    return res.status(400).json({ error: 'Пароль гостя не должен совпадать с паролем администратора' });
  }

  const saved = AuthService.saveGuestSettings({ enabled, username: guestName, password: password || undefined });
  EventService.log('warning', 'auth.guest_updated', enabled ? `Гостевой доступ включён (логин ${saved.username})` : 'Гостевой доступ отключён', { kind: 'admin', id: req.user!.id });
  res.json(saved);
});

// ========== 2FA / TOTP ==========

// POST /api/auth/totp/setup — генерирует секрет и otpauth URI для QR-кода
authRouter.post('/totp/setup', requireAuth, (req: AuthenticatedRequest, res) => {
  const { secret, uri } = AuthService.generateTotpSecret(req.user!.username);
  res.json({ secret, uri });
});

// POST /api/auth/totp/enable — включает 2FA после подтверждения первым кодом
authRouter.post('/totp/enable', requireAuth, (req: AuthenticatedRequest, res) => {
  const { secret, code, password } = req.body ?? {};
  if (typeof secret !== 'string' || typeof code !== 'string' || typeof password !== 'string' || !secret || !code || !password) {
    return res.status(400).json({ error: 'Секрет, код и пароль обязательны' });
  }
  const limiterKey = assertReauthAllowed(req.user!.id);
  if (!AuthService.confirmPassword(req.user!.id, password)) {
    reauthLimiter.registerFailure(limiterKey);
    return res.status(400).json({ error: 'Неверный пароль' });
  }
  reauthLimiter.reset(limiterKey);

  const result = AuthService.enableTotp(req.user!.id, secret, code);
  if (result === 'invalid_code') {
    return res.status(400).json({ error: 'Неверный код. Проверьте приложение-аутентификатор.' });
  }

  res.json({ success: true, recovery_codes: result.recoveryCodes, message: 'Двухфакторная аутентификация включена. Сохраните коды восстановления.' });
});

// POST /api/auth/totp/disable — отключает 2FA (требует пароль)
authRouter.post('/totp/disable', requireAuth, (req: AuthenticatedRequest, res) => {
  const { password } = req.body ?? {};
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Пароль обязателен' });
  }

  const limiterKey = assertReauthAllowed(req.user!.id);
  if (!AuthService.confirmPassword(req.user!.id, password)) {
    reauthLimiter.registerFailure(limiterKey);
    return res.status(400).json({ error: 'Неверный пароль' });
  }
  reauthLimiter.reset(limiterKey);

  AuthService.disableTotp(req.user!.id);
  res.json({ success: true, message: 'Двухфакторная аутентификация отключена' });
});

// POST /api/auth/totp/recovery/rotate — пересоздаёт коды восстановления (требует пароль)
authRouter.post('/totp/recovery/rotate', requireAuth, (req: AuthenticatedRequest, res) => {
  const { password } = req.body ?? {};
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Пароль обязателен' });
  }

  const limiterKey = assertReauthAllowed(req.user!.id);
  if (!AuthService.confirmPassword(req.user!.id, password)) {
    reauthLimiter.registerFailure(limiterKey);
    return res.status(400).json({ error: 'Неверный пароль' });
  }
  reauthLimiter.reset(limiterKey);

  const newCodes = AuthService.rotateRecoveryCodes(req.user!.id);
  res.json({ success: true, recovery_codes: newCodes, message: 'Новые коды восстановления созданы. Старые более не действительны.' });
});

// ========== Управление сессиями ==========

// GET /api/auth/sessions — список активных сессий
authRouter.get('/sessions', requireAuth, (req: AuthenticatedRequest, res) => {
  const currentToken = getBearerToken(req);
  const currentHash = currentToken ? crypto.createHash('sha256').update(currentToken).digest('hex') : null;

  const sessions = db.prepare(`
    SELECT id, ip, user_agent, last_activity, created_at, role
    FROM sessions
    WHERE admin_id = ? AND expires_at > ?
    ORDER BY last_activity DESC
  `).all(req.user!.id, new Date().toISOString()) as any[];

  const items = sessions.map((s) => ({
    id: s.id,
    ip: s.ip || 'Неизвестно',
    user_agent: s.user_agent || 'Неизвестно',
    last_activity: s.last_activity,
    created_at: s.created_at,
    role: s.role === 'guest' ? 'guest' : 'admin',
    current: currentHash ? (db.prepare('SELECT 1 FROM sessions WHERE id = ? AND token = ?').get(s.id, currentHash) !== undefined) : false,
  }));

  res.json({ sessions: items });
});

// DELETE /api/auth/sessions/:id — отзыв сессии
authRouter.delete('/sessions/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  const sessionId = parseInt(req.params.id, 10);
  if (isNaN(sessionId)) return res.status(400).json({ error: 'Неверный ID сессии' });

  // Проверяем, что сессия принадлежит текущему администратору
  const sess = db.prepare('SELECT admin_id FROM sessions WHERE id = ?').get(sessionId) as any;
  if (!sess || sess.admin_id !== req.user!.id) {
    return res.status(404).json({ error: 'Сессия не найдена' });
  }

  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  res.json({ success: true, message: 'Сессия завершена' });
});
