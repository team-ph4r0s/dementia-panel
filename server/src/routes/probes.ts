import { Router } from 'express';
import { db, transaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { MAX_PROBE_COUNTRIES, ProbeService } from '../services/probe.service.js';

/**
 * Проверка доступности нод из выбранных стран (docs/probes.md). Только для администратора.
 */
export const probesRouter = Router();

probesRouter.use(requireAuth);

function overview() {
  const settings = ProbeService.readSettings();
  const servers = db.prepare("SELECT id, name, host, status, probe_port, stub_port, remote_panel_id FROM servers WHERE status != 'uninstalled' ORDER BY id").all();
  return {
    settings,
    globalping_budget: ProbeService.globalpingBudget(settings),
    status: ProbeService.getStatus(),
    max_countries: MAX_PROBE_COUNTRIES,
    servers,
    results: ProbeService.allResults(),
  };
}

// GET /api/probes — настройки, состояние и свежие результаты
probesRouter.get('/', (req, res) => {
  res.json(overview());
});

// GET /api/probes/countries — страны, где у check-host.net есть проверяющие узлы
probesRouter.get('/countries', asyncHandler(async (req, res) => {
  res.json(await ProbeService.listCountries());
}));

// PUT /api/probes — { settings?: {...}, servers?: [{ id, probe_port }] }
probesRouter.put('/', (req, res) => {
  const body = req.body ?? {};
  if (body.servers !== undefined && !Array.isArray(body.servers)) throw new HttpError(400, 'servers должен быть массивом');

  transaction(() => {
    for (const s of body.servers ?? []) {
      const id = Number(s?.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Некорректный идентификатор сервера');
      ProbeService.setServerProbePort(id, s.probe_port);
    }
    if (body.settings !== undefined) ProbeService.updateSettings(body.settings ?? {});
  });
  res.json(overview());
});

// POST /api/probes/run — проверить сейчас (в фоне, не чаще раза в минуту)
probesRouter.post('/run', (req, res) => {
  ProbeService.startManualRun();
  res.status(202).json({ started: true });
});
