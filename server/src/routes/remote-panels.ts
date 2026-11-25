import { Router } from 'express';
import { db } from '../db/index.js';
import type { RemotePanelRow } from '../db/types.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { FederationClient } from '../services/federation-client.service.js';
import { asyncHandler, HttpError, parseId } from '../utils/http.js';

/**
 * Подключённые панели партнёров (сторона получателя): /api/remote-panels
 */
export const remotePanelsRouter = Router();

remotePanelsRouter.use(requireAuth);

interface PanelCountsProjection {
  nodes: number;
  clients: number;
}

function serializePanel(p: RemotePanelRow) {
  const { token: _token, ...rest } = p;
  let limits: unknown = null;
  try {
    limits = p.limits ? JSON.parse(p.limits) : null;
  } catch {
    limits = null;
  }
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM servers WHERE remote_panel_id = ? AND status != 'uninstalled') AS nodes,
      (SELECT COUNT(*) FROM clients c JOIN servers s ON s.id = c.server_id WHERE s.remote_panel_id = ?) AS clients
  `).get(p.id, p.id) as unknown as PanelCountsProjection;
  return { ...rest, limits, node_count: counts.nodes, client_count: counts.clients };
}

function getPanelOr404(id: number): RemotePanelRow {
  const panel = db.prepare('SELECT * FROM remote_panels WHERE id = ?').get(id) as unknown as RemotePanelRow | undefined;
  if (!panel) throw new HttpError(404, 'Панель не найдена');
  return panel;
}

remotePanelsRouter.get('/', (req, res) => {
  const panels = db.prepare('SELECT * FROM remote_panels ORDER BY id DESC').all() as unknown as RemotePanelRow[];
  res.json(panels.map(serializePanel));
});

// POST { connect_string: "https://panel#dp_…", name? }
remotePanelsRouter.post('/', asyncHandler(async (req, res) => {
  const id = await FederationClient.connect(String(req.body?.connect_string ?? ''), req.body?.name);
  res.status(201).json(serializePanel(getPanelOr404(id)));
}));

remotePanelsRouter.post('/:id/sync', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  getPanelOr404(id);
  await FederationClient.requestSync(id);
  res.json(serializePanel(getPanelOr404(id)));
}));

remotePanelsRouter.patch('/:id', (req, res) => {
  const id = parseId(req.params.id);
  getPanelOr404(id);
  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > 64) throw new HttpError(400, 'Название: от 1 до 64 символов');
  db.prepare('UPDATE remote_panels SET name = ? WHERE id = ?').run(name, id);
  res.json(serializePanel(getPanelOr404(id)));
});

remotePanelsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const result = await FederationClient.disconnect(id);
  res.json({ success: true, ...result });
}));
