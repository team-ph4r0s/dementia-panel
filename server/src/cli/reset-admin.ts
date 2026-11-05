/**
 * Установка логина и пароля администратора из командной строки (его же вызывает install.sh).
 * Данные из окружения, чтобы пароль не светился в списке процессов:
 *
 *   node dist/cli/reset-admin.js                                   новый случайный пароль; логин прежний
 *   PANEL_USER=name PANEL_PASSWORD='...' node dist/cli/reset-admin.js   свои значения
 *   PANEL_RESET_2FA=1 node dist/cli/reset-admin.js (или --reset-2fa)    ещё и отключить 2FA (потерян аутентификатор)
 *
 * Не заданный логин остаётся прежним (если администратора ещё нет — генерируется случайный); не заданный пароль генерируется
 * случайным и показывается один раз. Пароль, переданный через окружение, не выводится.
 */
import { db, initDatabase } from '../db/index.js';
import { AuthService, MIN_PASSWORD_LENGTH } from '../services/auth.service.js';

const providedPassword = process.env.PANEL_PASSWORD || '';

if (providedPassword && providedPassword.length < MIN_PASSWORD_LENGTH) {
  console.error(`Пароль должен содержать не менее ${MIN_PASSWORD_LENGTH} символов (переменная PANEL_PASSWORD)`);
  process.exit(1);
}

initDatabase();
const existing = db.prepare('SELECT username FROM admins ORDER BY id LIMIT 1').get() as { username: string } | undefined;
const username = process.env.PANEL_USER || existing?.username || AuthService.randomLogin();
const password = providedPassword || AuthService.randomPassword();
// PANEL_RESET_2FA=1 — ещё и отключить двухфакторную аутентификацию (потерян аутентификатор и коды восстановления)
const resetTotp = process.env.PANEL_RESET_2FA === '1' || process.argv.includes('--reset-2fa');
AuthService.resetAdmin(username, password, { resetTotp });

console.log(`Учётные данные администратора "${username}" обновлены, все сессии завершены.`);
if (resetTotp) {
  console.log('Двухфакторная аутентификация отключена — включите её заново в учётной записи панели.');
} else if (AuthService.isTotpEnabled()) {
  console.log('Двухфакторная аутентификация остаётся включённой: при входе нужен код. Если аутентификатор и коды восстановления');
  console.log('утеряны, повторите с отключением 2FA: PANEL_RESET_2FA=1 node server/dist/cli/reset-admin.js (или флаг --reset-2fa).');
}
if (!providedPassword) {
  console.log(`Новый пароль: ${password}`);
  console.log('Сохраните его: он показан один раз.');
}
console.log('Если вход заблокирован из-за неудачных попыток, счётчики сбросятся после перезапуска службы: systemctl restart dementia');
