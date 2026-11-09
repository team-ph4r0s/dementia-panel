import { Router } from 'express';
import { db, transaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import {
  countryStatuses, readDirectRouting, refreshCountries, updateDirectRouting,
} from '../services/direct-routing.service.js';
import { readSubscriptionSettings, updateSubscriptionSettings } from '../services/subscription-settings.service.js';

export const subscriptionSettingsRouter = Router();

subscriptionSettingsRouter.use(requireAuth);

const SUB_NAME_MAX = 64;

function listServers() {
  return db.prepare(`
    SELECT id, name, host, status, sub_name, sub_order
    FROM servers ORDER BY sub_order, id
  `).all();
}

// GET /api/subscription-settings — оформление подписки и отображаемые имена серверов
subscriptionSettingsRouter.get('/', (req, res) => {
  res.json({ settings: readSubscriptionSettings(), servers: listServers(), direct: directState() });
});

/** Настройки «напрямую, мимо VPN» и состояние списков сетей по странам */
function directState() {
  const settings = readDirectRouting();
  return { ...settings, countries_status: countryStatuses(settings.countries) };
}

// POST /api/subscription-settings/direct/refresh — { countries?: string[] } скачать сети стран (по умолчанию — выбранных)
subscriptionSettingsRouter.post('/direct/refresh', asyncHandler(async (req, res) => {
  const requested = Array.isArray(req.body?.countries) ? req.body.countries.map((c: unknown) => String(c).toLowerCase()) : readDirectRouting().countries;
  const results = await refreshCountries([...new Set<string>(requested)]);
  res.json({ results, direct: directState() });
}));

// PUT /api/subscription-settings — { settings?: {...}, servers?: [{ id, sub_name, sub_order }] }
subscriptionSettingsRouter.put('/', asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const servers = body.servers;
  if (servers !== undefined && !Array.isArray(servers)) throw new HttpError(400, 'servers должен быть массивом');

  const updates = (servers ?? []).map((s: any) => {
    const id = Number(s?.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Некорректный идентификатор сервера');
    const name = String(s?.sub_name ?? '').replace(/[\r\n#]/g, ' ').trim();
    if ([...name].length > SUB_NAME_MAX) throw new HttpError(400, `Имя сервера в подписке не длиннее ${SUB_NAME_MAX} символов`);
    const order = Number(s?.sub_order ?? 0);
    if (!Number.isInteger(order) || order < 0 || order > 10000) throw new HttpError(400, 'Некорректный порядок сервера');
    return { id, name: name || null, order };
  });

  const directBody = body.direct;
  if (directBody !== undefined && (typeof directBody !== 'object' || directBody === null || Array.isArray(directBody))) {
    throw new HttpError(400, 'direct должен быть объектом');
  }

  let missing: string[] = [];
  const settings = transaction(() => {
    const result = body.settings !== undefined ? updateSubscriptionSettings(body.settings ?? {}) : readSubscriptionSettings();
    const stmt = db.prepare('UPDATE servers SET sub_name = ?, sub_order = ? WHERE id = ?');
    for (const u of updates) stmt.run(u.name, u.order, u.id);
    if (directBody !== undefined) missing = updateDirectRouting(directBody).missing;
    return result;
  });

  // Сети стран без загруженного списка подтягиваются сразу: сбой сети сохранение не отменяет, он виден в состоянии
  const refresh = missing.length ? await refreshCountries(missing) : [];
  res.json({ settings, servers: listServers(), direct: directState(), refresh });
}));
