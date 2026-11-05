import crypto from 'node:crypto';
import { db, transaction, getSetting, setSetting } from '../db/index.js';
import { encryptSecret, decryptSecret } from './secrets.service.js';
import { EventService } from './event.service.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Гостевая сессия короче: гостю выдают доступ «посмотреть», а не постоянный вход */
const GUEST_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Сколько помнится IP, с которого администратор входил (исключение из блокировки по логину) */
const KNOWN_IP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;
/** Допустимый логин администратора (тот же набор символов проверяет install.sh) */
export const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

export type SessionRole = 'admin' | 'guest';
export interface SessionUser {
  id: number;
  username: string;
  role: SessionRole;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Логин — буква и 9 символов a-z0-9, пароль — 20 символов A-Za-z0-9 (без знаков, которые путаются при вводе) */
const LOGIN_FIRST = 'abcdefghijklmnopqrstuvwxyz';
const LOGIN_REST = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomString(alphabet: string, length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) result += alphabet[crypto.randomInt(alphabet.length)];
  return result;
}

export class AuthService {
  /** Случайный логин администратора (не «admin»: его угадывают первым) */
  static randomLogin(): string {
    return randomString(LOGIN_FIRST, 1) + randomString(LOGIN_REST, 9);
  }

  static randomPassword(): string {
    return randomString(PASSWORD_ALPHABET, 20);
  }

  /**
   * Hash a plain-text password using native crypto.scryptSync
   */
  static hashPassword(password: string, customSalt?: string): { hash: string; salt: string } {
    const salt = customSalt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { hash, salt };
  }

  /**
   * Verify a password against a stored hash and salt
   */
  static verifyPassword(password: string, hash: string, salt: string): boolean {
    const computed = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
  }

  /**
   * Ensure an admin exists. Uses PANEL_USER / PANEL_PASSWORD when provided; whatever is missing
   * (login and/or password) is generated randomly and printed once.
   */
  static ensureDefaultAdmin(username?: string, password?: string): void {
    const adminCount = db.prepare('SELECT COUNT(*) as count FROM admins').get() as { count: number };
    if (adminCount.count > 0) return;

    const user = username || this.randomLogin();
    const generated = !password;
    const pass = password || this.randomPassword();
    const { hash, salt } = this.hashPassword(pass);
    db.prepare('INSERT INTO admins (username, password_hash, salt) VALUES (?, ?, ?)').run(user, hash, salt);

    if (generated) {
      console.log('==================================================================');
      console.log(`[AUTH] Создан администратор. Логин: ${user}  Пароль: ${pass}`);
      console.log('[AUTH] Сохраните их: пароль больше показан не будет (новый выдаёт: node dist/cli/reset-admin.js).');
      console.log('==================================================================');
    } else {
      console.log(`[AUTH] Создан администратор "${user}" (пароль из PANEL_PASSWORD)`);
    }
  }

  /**
   * Set credentials of the (first) admin, creating it if needed; drops all sessions
   */
  /**
   * Аварийная установка логина и пароля (CLI reset-admin). resetTotp — ещё и отключить 2FA: иначе при потере аутентификатора
   * и кодов восстановления новый пароль не помог бы войти. Доступ к CLI уже требует root на сервере панели.
   */
  static isTotpEnabled(): boolean {
    const row = db.prepare('SELECT totp_enabled FROM admins ORDER BY id LIMIT 1').get() as { totp_enabled: number } | undefined;
    return Boolean(row?.totp_enabled);
  }

  static resetAdmin(username: string, password: string, options: { resetTotp?: boolean } = {}): void {
    const { hash, salt } = this.hashPassword(password);
    transaction(() => {
      const admin = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get() as { id: number } | undefined;
      if (admin) {
        db.prepare('UPDATE admins SET username = ?, password_hash = ?, salt = ? WHERE id = ?').run(username, hash, salt, admin.id);
        if (options.resetTotp) {
          db.prepare('UPDATE admins SET totp_secret = NULL, totp_enabled = 0, recovery_codes = NULL WHERE id = ?').run(admin.id);
        }
      } else {
        db.prepare('INSERT INTO admins (username, password_hash, salt) VALUES (?, ?, ?)').run(username, hash, salt);
      }
      db.exec('DELETE FROM sessions');
      db.exec('DELETE FROM trusted_login_ips');
    });
  }

  /**
   * Запомнить IP успешного входа: блокировка по логину (защита от распределённого перебора) на него не действует,
   * иначе любой мог бы закрыть администратору вход, отправив 10 неверных паролей.
   */
  static rememberLoginIp(ip: string): void {
    db.prepare(`
      INSERT INTO trusted_login_ips (ip, last_login_at) VALUES (?, ?)
      ON CONFLICT(ip) DO UPDATE SET last_login_at = excluded.last_login_at
    `).run(ip, new Date().toISOString());
  }

  static isKnownLoginIp(ip: string): boolean {
    const row = db.prepare('SELECT last_login_at FROM trusted_login_ips WHERE ip = ?').get(ip) as { last_login_at: string } | undefined;
    return Boolean(row) && Date.now() - new Date(row!.last_login_at).getTime() < KNOWN_IP_TTL_MS;
  }

  private static createSession(adminId: number, ip?: string, userAgent?: string, role: SessionRole = 'admin'): string {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + (role === 'guest' ? GUEST_SESSION_TTL_MS : SESSION_TTL_MS)).toISOString();
    db.prepare('INSERT INTO sessions (token, admin_id, expires_at, ip, user_agent, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hashToken(token), adminId, expiresAt, ip?.slice(0, 100) ?? null, userAgent?.slice(0, 500) ?? null, role);
    return token;
  }

  static touchSession(token: string): void {
    db.prepare('UPDATE sessions SET last_activity = ? WHERE token = ?').run(new Date().toISOString(), hashToken(token));
  }

  /**
   * Authenticate admin and generate a session token
   */
  static login(username: string, password: string): { token: string; user: SessionUser } | null {
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username) as any;
    if (!admin) {
      // Выравнивание времени ответа, чтобы нельзя было перебирать логины
      this.hashPassword(password);
      return null;
    }

    if (!this.verifyPassword(password, admin.password_hash, admin.salt)) return null;

    return {
      token: this.createSession(admin.id),
      user: { id: admin.id, username: admin.username, role: 'admin' },
    };
  }

  /**
   * Validate session token. Гостевая сессия действует, только пока гостевой доступ включён (его отключение мгновенно
   * закрывает вход); пользователь такой сессии — гость с id 0, он не совпадает ни с одним администратором.
   */
  static validateSession(token: string): SessionUser | null {
    if (!token) return null;

    const session = db.prepare(`
      SELECT s.admin_id, s.role, a.username
      FROM sessions s
      JOIN admins a ON s.admin_id = a.id
      WHERE s.token = ? AND s.expires_at > ?
    `).get(hashToken(token), new Date().toISOString()) as any;

    if (!session) return null;
    if (session.role === 'guest') {
      const guest = this.getGuestSettings();
      return guest.enabled && guest.username ? { id: 0, username: guest.username, role: 'guest' } : null;
    }
    return { id: session.admin_id, username: session.username, role: 'admin' };
  }

  /**
   * Destroy session
   */
  static logout(token: string): void {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(hashToken(token));
  }

  static cleanupExpiredSessions(): void {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
    db.prepare('DELETE FROM trusted_login_ips WHERE last_login_at <= ?').run(new Date(Date.now() - KNOWN_IP_TTL_MS).toISOString());
  }

  /**
   * Change admin password. All sessions are revoked; a fresh token for the caller is returned.
   */
  static changePassword(adminId: number, oldPass: string, newPass: string, ip?: string, userAgent?: string): string | null {
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(adminId) as any;
    if (!admin) return null;

    if (!this.verifyPassword(oldPass, admin.password_hash, admin.salt)) {
      return null;
    }

    const { hash, salt } = this.hashPassword(newPass);
    return transaction(() => {
      db.prepare('UPDATE admins SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, adminId);
      db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(adminId);
      return this.createSession(adminId, ip, userAgent);
    });
  }

  /** Проверка пароля администратора для действий, которые требуют подтверждения (смена логина, перенос панели) */
  static confirmPassword(adminId: number, password: string): boolean {
    const admin = db.prepare('SELECT password_hash, salt FROM admins WHERE id = ?').get(adminId) as any;
    return Boolean(admin) && this.verifyPassword(password, admin.password_hash, admin.salt);
  }

  /**
   * Смена логина администратора (по текущему паролю). Как и при смене пароля, остальные сессии завершаются, а вызывающему
   * выдаётся новый токен. Возвращает причину отказа или новый токен.
   */
  static changeUsername(adminId: number, password: string, newUsername: string, ip?: string, userAgent?: string): { token: string; username: string } | 'wrong_password' | 'taken' {
    if (!this.confirmPassword(adminId, password)) return 'wrong_password';

    return transaction(() => {
      const taken = db.prepare('SELECT 1 FROM admins WHERE username = ? AND id != ?').get(newUsername, adminId);
      // Логин гостя занят: иначе вход этим логином шёл бы мимо гостевой проверки
      if (taken || newUsername === getSetting('guest_username')) return 'taken' as const;
      db.prepare('UPDATE admins SET username = ? WHERE id = ?').run(newUsername, adminId);
      db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(adminId);
      return { token: this.createSession(adminId, ip, userAgent), username: newUsername };
    });
  }

  // ========== 2FA / TOTP ==========

  /**
   * Генерирует TOTP-код по RFC 6238 (SHA-1, 30с окно, 6 цифр)
   */
  public static generateTotp(secret: Buffer, counter = Math.floor(Date.now() / 1000 / 30)): string {
    const hmac = crypto.createHmac('sha1', secret);
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigUInt64BE(BigInt(counter));
    hmac.update(counterBuf);
    const hash = hmac.digest();

    const offset = hash[hash.length - 1] & 0x0f;
    const code = (hash.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    return code.toString().padStart(6, '0');
  }

  /**
   * Проверяет TOTP-код с окном ±1 (допускается сдвиг часов на 30с)
   */
  public static verifyTotp(secret: Buffer, code: string, window = 1): boolean {
    return this.matchTotp(secret, code, window) !== null;
  }

  /** Номер 30-секундного шага, которому соответствует код (или null) */
  private static matchTotp(secret: Buffer, code: string, window = 1): number | null {
    const now = Math.floor(Date.now() / 1000 / 30);
    for (let i = -window; i <= window; i++) {
      if (this.generateTotp(secret, now + i) === code) return now + i;
    }
    return null;
  }

  /**
   * Генерирует секрет TOTP (base32, 160 бит) и otpauth:// URI для QR-кода
   */
  static generateTotpSecret(username: string): { secret: string; uri: string } {
    const secretBytes = crypto.randomBytes(20);
    const secret = this.base32Encode(secretBytes);
    const uri = `otpauth://totp/Dementia%20Panel:${encodeURIComponent(username)}?secret=${secret}&issuer=Dementia%20Panel`;
    return { secret, uri };
  }

  /** Base32-кодирование (RFC 4648, без паддинга) для TOTP-секрета */
  public static base32Encode(buffer: Buffer): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    let result = '';
    for (const byte of buffer) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        result += alphabet[(value >>> (bits - 5)) & 0x1f];
        bits -= 5;
      }
    }
    if (bits > 0) result += alphabet[(value << (5 - bits)) & 0x1f];
    return result;
  }

  /** Base32-декодирование секрета TOTP */
  public static base32Decode(str: string): Buffer {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    const result: number[] = [];
    for (const char of str.toUpperCase()) {
      const idx = alphabet.indexOf(char);
      if (idx === -1) continue;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        result.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return Buffer.from(result);
  }

  /**
   * Включает 2FA для администратора: сохраняет зашифрованный секрет и генерирует recovery codes
   */
  static enableTotp(adminId: number, totpSecret: string, firstCode: string): { recoveryCodes: string[] } | 'invalid_code' {
    const secretBuf = this.base32Decode(totpSecret);
    if (!this.verifyTotp(secretBuf, firstCode)) return 'invalid_code';

    const recoveryCodes = this.generateRecoveryCodes();
    const hashes = recoveryCodes.map((c) => crypto.createHash('sha256').update(c).digest('hex'));

    return transaction(() => {
      db.prepare('UPDATE admins SET totp_secret = ?, totp_enabled = 1, recovery_codes = ? WHERE id = ?').run(
        encryptSecret(totpSecret),
        JSON.stringify(hashes),
        adminId
      );
      EventService.log('info', 'admin_2fa_enabled', 'Двухфакторная аутентификация включена', { kind: 'admin', id: adminId });
      return { recoveryCodes };
    });
  }

  /** Генерирует 10 recovery codes (8 символов, A-Z0-9, без путаемых 0/O, 1/I) */
  private static generateRecoveryCodes(): string[] {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без 0, O, 1, I
    const codes: string[] = [];
    for (let i = 0; i < 10; i++) {
      codes.push(randomString(alphabet, 8));
    }
    return codes;
  }

  /**
   * Отключает 2FA: удаляет секрет и recovery codes
   */
  static disableTotp(adminId: number): void {
    transaction(() => {
      db.prepare('UPDATE admins SET totp_secret = NULL, totp_enabled = 0, recovery_codes = NULL WHERE id = ?').run(adminId);
      EventService.log('warning', 'admin_2fa_disabled', 'Двухфакторная аутентификация отключена', { kind: 'admin', id: adminId });
      // Сессии не сбрасываем: администратор мог отключить 2FA специально, чтобы не потерять доступ
    });
  }

  /**
   * Проверяет TOTP-код для администратора
   */
  static checkTotp(adminId: number, code: string): boolean {
    // Перехваченный код нельзя использовать повторно, пока он ещё в окне допуска (±30 с)
    const admin = db.prepare('SELECT totp_secret, totp_enabled FROM admins WHERE id = ?').get(adminId) as any;
    if (!admin || !admin.totp_enabled || !admin.totp_secret) return false;

    const secret = decryptSecret(admin.totp_secret);
    if (!secret) return false;
    const step = this.matchTotp(this.base32Decode(secret), code);
    if (step === null || step <= (this.lastTotpStep.get(adminId) ?? -1)) return false;
    this.lastTotpStep.set(adminId, step);
    return true;
  }

  /** Последний принятый при входе шаг TOTP по администраторам (после перезапуска панели начинается заново) */
  private static lastTotpStep = new Map<number, number>();

  /**
   * Использует recovery code (одноразовый): проверяет SHA-256 и удаляет из списка
   */
  static useRecoveryCode(adminId: number, code: string): boolean {
    const admin = db.prepare('SELECT recovery_codes FROM admins WHERE id = ?').get(adminId) as any;
    if (!admin || !admin.recovery_codes) return false;

    const hashes: string[] = JSON.parse(admin.recovery_codes);
    const hash = crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
    const idx = hashes.indexOf(hash);
    if (idx === -1) return false;

    // Удаляем использованный код
    hashes.splice(idx, 1);
    db.prepare('UPDATE admins SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes), adminId);
    return true;
  }

  /**
   * Пересоздаёт recovery codes (администратор потерял старые)
   */
  static rotateRecoveryCodes(adminId: number): string[] {
    const newCodes = this.generateRecoveryCodes();
    const hashes = newCodes.map((c) => crypto.createHash('sha256').update(c).digest('hex'));
    db.prepare('UPDATE admins SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes), adminId);
    EventService.log('warning', 'admin_recovery_codes_rotated', 'Коды восстановления перевыпущены', { kind: 'admin', id: adminId });
    return newCodes;
  }

  /**
   * Расширенная версия login: принимает TOTP или recovery code, если 2FA включена
   */
  static loginWithTotp(
    username: string,
    password: string,
    totp?: string,
    recoveryCode?: string,
    ip?: string,
    userAgent?: string,
  ): { token: string; user: SessionUser } | 'totp_required' | 'invalid_code' | null {
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username) as any;
    if (!admin) return this.loginGuest(username, password, ip, userAgent);

    if (!this.verifyPassword(password, admin.password_hash, admin.salt)) return null;

    // Если 2FA включена, требуем код
    if (admin.totp_enabled) {
      if (!totp && !recoveryCode) return 'totp_required';

      let codeValid = false;
      if (totp) {
        codeValid = this.checkTotp(admin.id, totp);
      } else if (recoveryCode) {
        codeValid = this.useRecoveryCode(admin.id, recoveryCode);
      }

      // Пароль верный, код нет: отличается от неверного пароля, чтобы лимитировать перебор кода отдельно
      if (!codeValid) return 'invalid_code';
    }

    return {
      token: this.createSession(admin.id, ip, userAgent),
      user: { id: admin.id, username: admin.username, role: 'admin' },
    };
  }

  // ========== Гостевой доступ ==========

  /** Гость: отдельные логин и пароль, сессия только для просмотра (ограничения — в auth.middleware.ts) */
  static getGuestSettings(): { enabled: boolean; username: string; has_password: boolean } {
    return {
      enabled: getSetting('guest_enabled') === '1',
      username: getSetting('guest_username') ?? '',
      has_password: Boolean(getSetting('guest_password_hash')),
    };
  }

  /** Логин гостя не должен совпадать с логином администратора: при входе сначала ищется администратор */
  static isAdminUsername(username: string): boolean {
    return Boolean(db.prepare('SELECT 1 FROM admins WHERE username = ?').get(username));
  }

  /**
   * Сохраняет гостевой доступ. Любое изменение (в т.ч. отключение) завершает действующие гостевые сессии.
   * Пароль не обязателен, если он уже задан.
   */
  static saveGuestSettings(input: { enabled: boolean; username: string; password?: string }): { enabled: boolean; username: string; has_password: boolean } {
    transaction(() => {
      setSetting('guest_enabled', input.enabled ? '1' : '0');
      setSetting('guest_username', input.username || null);
      if (input.password) {
        const { hash, salt } = this.hashPassword(input.password);
        setSetting('guest_password_hash', hash);
        setSetting('guest_password_salt', salt);
      }
      db.prepare("DELETE FROM sessions WHERE role = 'guest'").run();
    });
    return this.getGuestSettings();
  }

  private static loginGuest(username: string, password: string, ip?: string, userAgent?: string): { token: string; user: SessionUser } | null {
    const hash = getSetting('guest_password_hash');
    const salt = getSetting('guest_password_salt');
    const matches = getSetting('guest_enabled') === '1' && getSetting('guest_username') === username && Boolean(hash) && Boolean(salt);
    // Хэш считается всегда: по времени ответа нельзя отличить гостевой логин от несуществующего
    const valid = matches ? this.verifyPassword(password, hash!, salt!) : (this.hashPassword(password), false);
    const owner = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get() as { id: number } | undefined;
    if (!valid || !owner) return null;
    return {
      token: this.createSession(owner.id, ip, userAgent, 'guest'),
      user: { id: 0, username, role: 'guest' },
    };
  }
}
