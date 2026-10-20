const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

module.exports = function alertsRouter(io) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    const { status, zoneId, limit } = req.query;
    const alerts = db.getAlerts({ status, zoneId, limit: Math.min(500, Number(limit) || 200) });
    res.json({ alerts });
  });

  router.post('/:id/ack', requireAuth, requireRole('ADMIN', 'OPERATOR'), (req, res) => {
    const alert = db.getAlert(req.params.id);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    db.updateAlert(alert.id, {
      status: 'ACKNOWLEDGED',
      acknowledgedBy: req.user.username,
      acknowledgedAt: new Date().toISOString()
    });

    db.addAudit({
      id: uuid(),
      at: new Date().toISOString(),
      actor: req.user.username,
      action: 'ALERT_ACK',
      zoneId: alert.zoneId,
      detail: `Acknowledged alert ${alert.id} (${alert.level}): ${alert.message}`
    });

    const updated = db.getAlert(alert.id);
    if (io) io.emit('alert:updated', updated);
    res.json({ alert: updated });
  });

  router.post('/:id/resolve', requireAuth, requireRole('ADMIN', 'OPERATOR'), (req, res) => {
    const alert = db.getAlert(req.params.id);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    const { resolutionNotes } = req.body || {};

    db.updateAlert(alert.id, {
      status: 'RESOLVED',
      resolvedBy: req.user.username,
      resolvedAt: new Date().toISOString(),
      resolutionNotes: resolutionNotes || 'Resolved by operator review'
    });

    db.addAudit({
      id: uuid(),
      at: new Date().toISOString(),
      actor: req.user.username,
      action: 'ALERT_RESOLVED',
      zoneId: alert.zoneId,
      detail: `Resolved alert ${alert.id}. Notes: ${resolutionNotes || 'None'}`
    });

    const updated = db.getAlert(alert.id);
    if (io) io.emit('alert:updated', updated);
    res.json({ alert: updated });
  });

  return router;
};
