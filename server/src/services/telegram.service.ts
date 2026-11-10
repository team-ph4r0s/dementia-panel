import { getSetting, setSetting } from '../db/index.js';
import { decryptSecret, encryptSecret } from './secrets.service.js';
import { MigrationService } from './migration.service.js';
import type { EventLevel } from './event.service.js';
import { formatTelegramError, normalizeBotToken, normalizeChatId } from '../utils/telegram.js';

export interface TelegramSettings {
  enabled: boolean;
  chat_id: string;
  bot_token_saved: boolean;
  notify_info: boolean;
}

export class TelegramService {
  static getSettings(): TelegramSettings {
    return {
      enabled: getSetting('telegram_enabled') === '1',
      chat_id: getSetting('telegram_chat_id') ?? '',
      bot_token_saved: Boolean(getSetting('telegram_bot_token')),
      notify_info: getSetting('telegram_notify_info') === '1',
    };
  }

  static saveSettings(input: { enabled: boolean; chat_id: string; bot_token?: string; notify_info: boolean }): TelegramSettings {
    const chatId = normalizeChatId(input.chat_id);
    setSetting('telegram_enabled', input.enabled ? '1' : '0');
    setSetting('telegram_chat_id', chatId || null);
    setSetting('telegram_notify_info', input.notify_info ? '1' : '0');
    if (input.bot_token !== undefined) {
      const token = normalizeBotToken(input.bot_token);
      setSetting('telegram_bot_token', encryptSecret(token || null));
    }
    return this.getSettings();
  }

  static async test(settings?: { bot_token?: string; chat_id?: string }): Promise<{ success: boolean; message: string }> {
    const rawToken = settings?.bot_token ? normalizeBotToken(settings.bot_token) : decryptSecret(getSetting('telegram_bot_token'));
    const token = rawToken ? normalizeBotToken(rawToken) : '';
    const chatId = settings?.chat_id !== undefined ? normalizeChatId(settings.chat_id) : (getSetting('telegram_chat_id') ?? '');
    if (!token || !chatId) return { success: false, message: 'Укажите токен бота и ID чата' };
    return this.send(token, chatId, 'Dementia Panel: проверка уведомлений');
  }

  static async detectChatId(botToken?: string): Promise<{ success: boolean; chat_id?: string; name?: string; message: string }> {
    const rawToken = botToken ? normalizeBotToken(botToken) : decryptSecret(getSetting('telegram_bot_token'));
    const token = rawToken ? normalizeBotToken(rawToken) : '';
    if (!token) return { success: false, message: 'Сначала укажите токен бота' };

    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20&allowed_updates=["message","channel_post"]`, {
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json() as {
        ok?: boolean;
        description?: string;
        result?: Array<{
          message?: { chat?: { id: number | string; title?: string; username?: string; first_name?: string } };
          channel_post?: { chat?: { id: number | string; title?: string; username?: string; first_name?: string } };
        }>;
      };
      if (!response.ok || data.ok !== true) {
        return { success: false, message: formatTelegramError(data.description, response.status) };
      }
      const updates = data.result ?? [];
      for (let i = updates.length - 1; i >= 0; i--) {
        const item = updates[i];
        const chat = item.message?.chat ?? item.channel_post?.chat;
        if (chat && chat.id) {
          const name = chat.title || (chat.username ? `@${chat.username}` : chat.first_name) || 'Чат';
          return {
            success: true,
            chat_id: String(chat.id),
            name,
            message: `Найден ID чата: ${chat.id} (${name})`,
          };
        }
      }
      return {
        success: false,
        message: 'Сообщений пока нет. Отправьте боту команду /start в Telegram и нажмите кнопку снова.',
      };
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : '';
      return { success: false, message: `Не удалось связаться с Telegram (api.telegram.org)${detail}` };
    }
  }

  static async deliverEvent(event: { level: EventLevel; type: string; message: string }): Promise<void> {
    try {
      if (getSetting('telegram_enabled') !== '1') return;
      if (event.level === 'info' && getSetting('telegram_notify_info') !== '1') return;
      const rawToken = decryptSecret(getSetting('telegram_bot_token'));
      const token = rawToken ? normalizeBotToken(rawToken) : '';
      const chatId = getSetting('telegram_chat_id');
      if (!token || !chatId || MigrationService.isBackgroundPaused()) return;
      const label = event.level === 'error' ? 'Ошибка' : event.level === 'warning' ? 'Предупреждение' : 'Событие';
      await this.send(token, chatId, `${label}: ${event.message}`);
    } catch (err) {
      console.error('Не удалось отправить уведомление в Telegram:', err instanceof Error ? err.message : 'неизвестная ошибка');
    }
  }

  /** Произвольное сообщение администратору (напоминания об оплате). false — Telegram выключен, не настроен или не принял сообщение */
  static async notify(text: string): Promise<boolean> {
    try {
      if (getSetting('telegram_enabled') !== '1') return false;
      const rawToken = decryptSecret(getSetting('telegram_bot_token'));
      const token = rawToken ? normalizeBotToken(rawToken) : '';
      const chatId = getSetting('telegram_chat_id');
      if (!token || !chatId || MigrationService.isBackgroundPaused()) return false;
      return (await this.send(token, chatId, text)).success;
    } catch (err) {
      console.error('Не удалось отправить уведомление в Telegram:', err instanceof Error ? err.message : 'неизвестная ошибка');
      return false;
    }
  }

  private static async send(token: string, chatId: string, text: string): Promise<{ success: boolean; message: string }> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json() as { ok?: boolean; description?: string };
      if (!response.ok || data.ok !== true) {
        return { success: false, message: formatTelegramError(data.description, response.status) };
      }
      return { success: true, message: 'Тестовое сообщение отправлено' };
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : '';
      return { success: false, message: `Не удалось связаться с Telegram (api.telegram.org)${detail}` };
    }
  }
}
