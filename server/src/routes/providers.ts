import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler, parseId } from '../utils/http.js';
import { ProviderService, parseTargetType } from '../services/provider.service.js';
import { TelegramService } from '../services/telegram.service.js';

/**
 * Вкладка «Провайдеры» (docs/providers.md). Только для администратора: гость сюда не допускается (в белом списке его нет).
 */
export const providersRouter = Router();
providersRouter.use(requireAuth);

providersRouter.get('/', (req, res) => {
  const telegram = TelegramService.getSettings();
  res.json({
    items: ProviderService.list(),
    settings: ProviderService.getSettings(),
    telegram_ready: telegram.enabled && telegram.bot_token_saved && Boolean(telegram.chat_id),
  });
});

providersRouter.put('/settings', (req, res) => {
  res.json({ settings: ProviderService.saveSettings(req.body ?? {}) });
});

providersRouter.put('/:type/:id', (req, res) => {
  const type = parseTargetType(req.params.type);
  const id = type === 'panel' ? 0 : parseId(req.params.id);
  ProviderService.save(type, id, req.body ?? {});
  res.json({ items: ProviderService.list() });
});

providersRouter.delete('/:type/:id', (req, res) => {
  const type = parseTargetType(req.params.type);
  ProviderService.remove(type, type === 'panel' ? 0 : parseId(req.params.id));
  res.json({ items: ProviderService.list() });
});

// Пароль от кабинета по явному запросу администратора; в списке его нет
providersRouter.get('/:type/:id/password', (req, res) => {
  const type = parseTargetType(req.params.type);
  res.json({ password: ProviderService.revealPassword(type, type === 'panel' ? 0 : parseId(req.params.id)) });
});
