import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { NodeUpdateService } from '../services/node-update.service.js';

export const nodeUpdatesRouter = Router();
nodeUpdatesRouter.use(requireAuth);
nodeUpdatesRouter.get('/', (_req, res) => res.json(NodeUpdateService.overview()));
nodeUpdatesRouter.put('/', (req, res) => res.json(NodeUpdateService.saveSettings(req.body)));
nodeUpdatesRouter.post('/check', (req, res) => {
  NodeUpdateService.start('check', req.body?.server_ids);
  res.status(202).json({ started: true });
});
nodeUpdatesRouter.post('/update', (req, res) => {
  NodeUpdateService.start('update', req.body?.server_ids);
  res.status(202).json({ started: true });
});
