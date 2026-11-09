import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler, HttpError, parseId } from '../utils/http.js';
import { BridgeService } from '../services/bridge.service.js';
import { ensurePanelOriginIp, FailoverService } from '../services/failover.service.js';

/**
 * Мосты в странах пользователей (docs/bridges.md). Только для администратора.
 */
export const bridgesRouter = Router();

bridgesRouter.use(requireAuth);

// GET /api/bridges — мосты с привязанными нодами и состоянием «нужен мост»
bridgesRouter.get('/', (req, res) => {
  res.json(BridgeService.list());
});

// POST /api/bridges — добавить мост и сразу установить его ({install: false} — только добавить)
bridgesRouter.post('/', asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const id = BridgeService.create(body);
  if (body.links !== undefined) {
    const linked = await BridgeService.setLinks(id, body.links);
    if (!linked.success) throw new HttpError(400, linked.error ?? 'Не удалось привязать ноды');
  }
  if (body.install === false) return res.status(201).json({ success: true, bridge: BridgeService.get(id) });
  const result = await BridgeService.install(id);
  res.status(201).json({ ...result, bridge: BridgeService.get(id) });
}));

// Резервный домен подписок (docs/bridges.md#failover): GET — состояние, POST — {domain, include_panel?, origin_ip?, token?, email?},
// DELETE — выключить. Маршруты объявлены до /:id
bridgesRouter.get('/failover', (req, res) => {
  res.json(FailoverService.status());
});

bridgesRouter.post('/failover', asyncHandler(async (req, res) => {
  res.json(await FailoverService.configure(req.body ?? {}));
}));

bridgesRouter.delete('/failover', asyncHandler(async (req, res) => {
  res.json(await FailoverService.disable());
}));

// POST /api/bridges/failover/check-dns — что публичный DNS отвечает на резервный домен
bridgesRouter.post('/failover/check-dns', asyncHandler(async (req, res) => {
  res.json(await FailoverService.checkDns());
}));

// POST /api/bridges/:id/panel-check — путь «мост → панель» по шагам: TCP, TLS с нужным именем, ответ панели
bridgesRouter.post('/:id/panel-check', asyncHandler(async (req, res) => {
  res.json(await FailoverService.checkBridge(parseId(req.params.id)));
}));

// PUT /api/bridges/:id — имя, адрес, SSH-доступ, страна, пересылка панели (panel_forward)
bridgesRouter.put('/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const body = req.body ?? {};
  const before = BridgeService.get(id);
  // Пересылке панели нужен IPv4 сервера панели — определяется до записи, ошибка ничего не меняет
  if (body.panel_forward === true) await ensurePanelOriginIp(body.origin_ip);
  BridgeService.update(id, body);
  const after = BridgeService.get(id);
  let applyError: string | undefined;
  if (Boolean(after.panel_forward) !== Boolean(before.panel_forward) && after.status !== 'uninstalled') {
    const result = await BridgeService.requestApply(id);
    if (!result.success) {
      BridgeService.update(id, { panel_forward: Boolean(before.panel_forward) });
      throw new HttpError(502, `Мост не принял правила: ${result.error}. Пересылка панели возвращена как была.`);
    }
  }
  await FailoverService.reconcile().catch((err: any) => { applyError = err.message; });
  res.json({ ...BridgeService.get(id), ...(applyError ? { warning: applyError } : {}) });
}));

// PUT /api/bridges/:id/links — { links: [{ server_id, mode }] }: ноды моста и режим для каждой
bridgesRouter.put('/:id/links', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const result = await BridgeService.setLinks(id, req.body?.links);
  res.status(result.success ? 200 : 502).json({ ...result, bridge: BridgeService.get(id) });
}));

// PUT /api/bridges/:id/links/:serverId/cascade — {port: number | null}
bridgesRouter.put('/:id/links/:serverId/cascade', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const result = await BridgeService.setCascade(id, parseId(req.params.serverId), req.body?.port);
  res.status(result.success ? 200 : 502).json({ ...result, bridge: BridgeService.get(id) });
}));

// POST /api/bridges/:id/install — установка (повторная) с журналом
bridgesRouter.post('/:id/install', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const result = await BridgeService.install(id);
  res.status(result.success ? 200 : 502).json({ ...result, bridge: BridgeService.get(id) });
}));

// POST /api/bridges/:id/apply — применить правила пересылки
bridgesRouter.post('/:id/apply', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  BridgeService.get(id);
  const result = await BridgeService.requestApply(id);
  res.status(result.success ? 200 : 502).json({ ...result, bridge: BridgeService.get(id) });
}));

// POST /api/bridges/:id/test-ssh
bridgesRouter.post('/:id/test-ssh', asyncHandler(async (req, res) => {
  res.json(await BridgeService.testSsh(parseId(req.params.id)));
}));

// DELETE /api/bridges/:id (?teardown=1 — убрать правила с сервера; ?force=1 — удалить из панели даже при ошибке)
bridgesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const bridge = BridgeService.get(id);
  if (BridgeService.isInstalling(id)) throw new HttpError(409, 'Дождитесь окончания установки');
  BridgeService.requireNoCascade('bridge_id', id);
  if (req.query.teardown === '1' && bridge.status !== 'uninstalled') {
    const result = await BridgeService.teardown(id);
    if (!result.success && req.query.force !== '1') {
      throw new HttpError(502, `Не удалось убрать правила с моста: ${result.error}. Удалите принудительно или очистите сервер вручную.`);
    }
  }
  BridgeService.requireNoCascade('bridge_id', id);
  db.prepare('DELETE FROM bridges WHERE id = ?').run(id);
  await FailoverService.reconcile().catch(() => {});
  res.json({ success: true });
}));
