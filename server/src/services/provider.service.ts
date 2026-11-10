import { db, getSetting, setSetting } from '../db/index.js';
import { decryptSecret, encryptSecret } from './secrets.service.js';
import { TelegramService } from './telegram.service.js';
import { MigrationService } from './migration.service.js';
import { HttpError } from '../utils/http.js';
import {
  cleanText, daysBetween, DEFAULT_REMIND_DAYS, DEFAULT_REMIND_HOUR_UTC, isoDate, nextDueDate, PROVIDER_CURRENCIES, reminderText,
  validateAmount, validateCabinetUrl, validatePayDay, validatePayMonth, validateRemindDays,
} from '../utils/providers.js';

export type ProviderTargetType = 'panel' | 'node' | 'bridge';

export interface ProviderItem {
  target_type: ProviderTargetType;
  target_id: number;
  name: string;
  host: string | null;
  country: string | null;
  url: string | null;
  login: string | null;
  password_saved: boolean;
  amount: number | null;
  currency: string;
  pay_day: number | null;
  pay_month: number | null;
  next_due: string | null;
  days_left: number | null;
}

export interface ProviderSettings {
  remind_enabled: boolean;
  remind_days: number[];
  remind_hour: number;
}

interface AccountRow {
  target_type: ProviderTargetType;
  target_id: number;
  url: string | null;
  login: string | null;
  password: string | null;
  amount: number | null;
  currency: string;
  pay_day: number | null;
  pay_month: number | null;
}

export function parseTargetType(value: string): ProviderTargetType {
  if (value === 'panel' || value === 'node' || value === 'bridge') return value;
  throw new HttpError(404, 'Неизвестный тип сервера');
}

export class ProviderService {
  static getSettings(): ProviderSettings {
    let days = DEFAULT_REMIND_DAYS;
    try { days = validateRemindDays(JSON.parse(getSetting('providers_remind_days') ?? 'null') ?? DEFAULT_REMIND_DAYS); } catch { /* прежние по умолчанию */ }
    const hour = Number(getSetting('providers_remind_hour') ?? DEFAULT_REMIND_HOUR_UTC);
    return {
      remind_enabled: getSetting('providers_remind_enabled') !== '0',
      remind_days: days,
      remind_hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_REMIND_HOUR_UTC,
    };
  }

  static saveSettings(input: { remind_enabled?: unknown; remind_days?: unknown; remind_hour?: unknown }): ProviderSettings {
    try {
      if (typeof input.remind_enabled !== 'boolean') throw new Error('Некорректные настройки напоминаний');
      const days = validateRemindDays(input.remind_days);
      const hour = Number(input.remind_hour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Час напоминания (UTC) — число от 0 до 23');
      setSetting('providers_remind_enabled', input.remind_enabled ? '1' : '0');
      setSetting('providers_remind_days', JSON.stringify(days));
      setSetting('providers_remind_hour', String(hour));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'Некорректные настройки');
    }
    return this.getSettings();
  }

  /** Панель, мосты и ноды (без нод партнёров) — всё, за что администратор платит провайдеру */
  private static targets(): Array<{ type: ProviderTargetType; id: number; name: string; host: string | null; country: string | null }> {
    const nodes = db.prepare('SELECT id, name, host, country FROM servers WHERE remote_panel_id IS NULL ORDER BY id').all() as Array<{ id: number; name: string; host: string; country: string | null }>;
    const bridges = db.prepare('SELECT id, name, host, country FROM bridges ORDER BY id').all() as Array<{ id: number; name: string; host: string; country: string | null }>;
    return [
      { type: 'panel', id: 0, name: 'Панель', host: null, country: null },
      ...nodes.map((n) => ({ type: 'node' as const, id: n.id, name: n.name, host: n.host, country: n.country })),
      ...bridges.map((b) => ({ type: 'bridge' as const, id: b.id, name: b.name, host: b.host, country: b.country })),
    ];
  }

  private static accounts(): Map<string, AccountRow> {
    const rows = db.prepare('SELECT * FROM provider_accounts').all() as unknown as AccountRow[];
    return new Map(rows.map((r) => [`${r.target_type}:${r.target_id}`, r]));
  }

  static list(now = new Date()): ProviderItem[] {
    const accounts = this.accounts();
    return this.targets().map((t) => {
      const a = accounts.get(`${t.type}:${t.id}`);
      let nextDue: string | null = null;
      let daysLeft: number | null = null;
      if (a?.pay_day) {
        const due = nextDueDate(now, a.pay_day, a.pay_month);
        nextDue = isoDate(due);
        daysLeft = daysBetween(now, due);
      }
      return {
        target_type: t.type, target_id: t.id, name: t.name, host: t.host, country: t.country,
        url: a?.url ?? null, login: a?.login ?? null, password_saved: Boolean(a?.password),
        amount: a?.amount ?? null, currency: a?.currency ?? 'RUB', pay_day: a?.pay_day ?? null, pay_month: a?.pay_month ?? null,
        next_due: nextDue, days_left: daysLeft,
      };
    });
  }

  private static assertTarget(type: ProviderTargetType, id: number): void {
    if (type === 'panel') {
      if (id !== 0) throw new HttpError(404, 'Сервер не найден');
      return;
    }
    const table = type === 'node' ? 'servers' : 'bridges';
    const extra = type === 'node' ? ' AND remote_panel_id IS NULL' : '';
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?${extra}`).get(id)) throw new HttpError(404, 'Сервер не найден');
  }

  /**
   * Сохраняет данные кабинета. `password`: не передан — без изменений, пустая строка/null — стереть.
   * Если после сохранения ничего не заполнено, запись удаляется.
   */
  static save(type: ProviderTargetType, id: number, input: Record<string, unknown>): void {
    this.assertTarget(type, id);
    let url: string | null; let login: string | null; let amount: number | null; let payDay: number | null; let payMonth: number | null;
    let password: string | null | undefined;
    let currency = 'RUB';
    try {
      url = validateCabinetUrl(input.url);
      login = cleanText(input.login, 200, 'Логин');
      amount = validateAmount(input.amount);
      payDay = validatePayDay(input.pay_day);
      payMonth = validatePayMonth(input.pay_month);
      if (payMonth && !payDay) throw new Error('Укажите день платежа');
      if (input.currency !== undefined && input.currency !== null) {
        if (!PROVIDER_CURRENCIES.includes(input.currency as never)) throw new Error('Валюта: RUB, USD или EUR');
        currency = input.currency as string;
      }
      if (input.password !== undefined) password = cleanText(input.password, 500, 'Пароль');
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'Некорректные данные');
    }
    const existing = db.prepare('SELECT password FROM provider_accounts WHERE target_type = ? AND target_id = ?').get(type, id) as { password: string | null } | undefined;
    const storedPassword = password === undefined ? (existing?.password ?? null) : encryptSecret(password);
    if (!url && !login && !storedPassword && amount === null && !payDay) {
      this.remove(type, id);
      return;
    }
    db.prepare(`INSERT INTO provider_accounts (target_type, target_id, url, login, password, amount, currency, pay_day, pay_month, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(target_type, target_id) DO UPDATE SET url = excluded.url, login = excluded.login, password = excluded.password,
        amount = excluded.amount, currency = excluded.currency, pay_day = excluded.pay_day, pay_month = excluded.pay_month, updated_at = excluded.updated_at`)
      .run(type, id, url, login, storedPassword, amount, currency, payDay, payMonth);
    // Дата изменилась — старые отметки «напоминание отправлено» больше не нужны
    db.prepare('DELETE FROM provider_reminders WHERE target_type = ? AND target_id = ?').run(type, id);
  }

  static remove(type: ProviderTargetType, id: number): void {
    db.prepare('DELETE FROM provider_accounts WHERE target_type = ? AND target_id = ?').run(type, id);
    db.prepare('DELETE FROM provider_reminders WHERE target_type = ? AND target_id = ?').run(type, id);
  }

  static revealPassword(type: ProviderTargetType, id: number): string {
    const row = db.prepare('SELECT password FROM provider_accounts WHERE target_type = ? AND target_id = ?').get(type, id) as { password: string | null } | undefined;
    const password = decryptSecret(row?.password ?? null);
    if (!password) throw new HttpError(404, 'Пароль не сохранён');
    return password;
  }

  /**
   * Отправляет в Telegram напоминания, срок которых наступил: за N дней до платежа (по умолчанию накануне и в день платежа),
   * начиная с настроенного часа UTC. Каждое напоминание уходит один раз; при ошибке Telegram повторяется при следующем запуске.
   */
  static async tick(now = new Date()): Promise<number> {
    const settings = this.getSettings();
    if (!settings.remind_enabled || MigrationService.isBackgroundPaused()) return 0;
    if (now.getUTCHours() < settings.remind_hour) return 0;
    const items = this.list(now);

    db.prepare("DELETE FROM provider_reminders WHERE due_date < date('now', '-60 days')").run();
    // Записи удалённых серверов не нужны (id в SQLite не переиспользуются, но таблица не должна пухнуть)
    const live = new Set(items.map((i) => `${i.target_type}:${i.target_id}`));
    for (const row of db.prepare('SELECT target_type, target_id FROM provider_accounts').all() as Array<{ target_type: ProviderTargetType; target_id: number }>) {
      if (!live.has(`${row.target_type}:${row.target_id}`)) this.remove(row.target_type, row.target_id);
    }

    let sent = 0;
    for (const item of items) {
      if (item.days_left === null || item.next_due === null || !settings.remind_days.includes(item.days_left)) continue;
      const done = db.prepare('SELECT 1 FROM provider_reminders WHERE target_type = ? AND target_id = ? AND due_date = ? AND days_before = ?')
        .get(item.target_type, item.target_id, item.next_due, item.days_left);
      if (done) continue;
      const text = reminderText({
        name: item.name, host: item.host, daysLeft: item.days_left, due: new Date(`${item.next_due}T00:00:00Z`),
        amount: item.amount, currency: item.currency, url: item.url,
      });
      if (!(await TelegramService.notify(text))) continue;
      db.prepare('INSERT OR IGNORE INTO provider_reminders (target_type, target_id, due_date, days_before) VALUES (?, ?, ?, ?)')
        .run(item.target_type, item.target_id, item.next_due, item.days_left);
      sent++;
    }
    return sent;
  }
}
