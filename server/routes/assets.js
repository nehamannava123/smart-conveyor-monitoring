const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const assetService = require('../services/assetService');

module.exports = function assetsRouter(io) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    const assets = assetService.getAllAssets(req.query.zoneId);
    res.json({ assets });
  });

  router.get('/:id', requireAuth, (req, res) => {
    const asset = assetService.getAssetById(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json({ asset });
  });

  router.post('/', requireAuth, requireRole('ADMIN'), (req, res) => {
    const { name, zoneId, type } = req.body || {};
    if (!name || !zoneId) {
      return res.status(400).json({ error: 'Asset name and zoneId are required' });
    }
    const asset = assetService.createAsset(req.body, req.user.username);
    db.addAudit({
      id: uuid(),
      at: new Date().toISOString(),
      actor: req.user.username,
      action: 'ASSET_CREATED',
      zoneId: asset.zoneId,
      detail: `Created asset ${asset.name} (${asset.type}) in ${asset.zoneId}`
    });
    if (io) io.emit('assets:updated', { action: 'CREATED', asset });
    res.status(201).json({ asset });
  });

  router.post('/:id/maintenance-log', requireAuth, requireRole('ADMIN', 'OPERATOR'), (req, res) => {
    const record = assetService.addMaintenanceRecord(req.params.id, req.body, req.user.username);
    if (!record) return res.status(404).json({ error: 'Asset not found' });
    db.addAudit({
      id: uuid(),
      at: new Date().toISOString(),
      actor: req.user.username,
      action: 'ASSET_MAINTENANCE_LOGGED',
      zoneId: null,
      detail: `Logged maintenance on asset ${req.params.id}: ${record.notes}`
    });
    const asset = assetService.getAssetById(req.params.id);
    if (io) io.emit('assets:updated', { action: 'MAINTENANCE_LOGGED', asset });
    res.json({ asset, record });
  });

  return router;
};
