const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { computeRisk } = require('../services/riskEngine');
const { model: mlModel } = require('../services/mlPredictor');
const { tickZone, resetZone } = require('../services/simulator');

module.exports = function zonesRouter(io) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    const zones = db.getZones().map((z) => {
      let latest = db.getReadings(z.id, 1)[0] || null;
      if (!latest) {
        latest = tickZone(z);
      }
      const risk = computeRisk(z, latest);
      const ml = mlModel.predict(z, latest);
      return {
        ...z,
        latestReading: latest,
        latestRisk: risk,
        latestMl: ml,
        riskScore: risk?.score ?? 0,
        riskLevel: risk?.level ?? 'NORMAL'
      };
    });
    res.json({ zones });
  });

  router.get('/:id/history', requireAuth, (req, res) => {
    const zone = db.getZone(req.params.id);
    if (!zone) return res.status(404).json({ error: 'Zone not found' });
    const limit = Math.min(500, Number(req.query.limit) || 120);
    res.json({ zoneId: zone.id, readings: db.getReadings(zone.id, limit) });
  });

  // Manual control: start / stop / reset. Requires OPERATOR or ADMIN.
  router.post('/:id/control', requireAuth, requireRole('ADMIN', 'OPERATOR'), (req, res) => {
    const zone = db.getZone(req.params.id);
    if (!zone) return res.status(404).json({ error: 'Zone not found' });
    const { action } = req.body || {};
    if (!['START', 'STOP', 'RESET'].includes(action)) {
      return res.status(400).json({ error: 'action must be START, STOP, or RESET' });
    }

    let newStatus = zone.status;
    if (action === 'START') newStatus = 'RUNNING';
    if (action === 'STOP') newStatus = 'STOPPED';
    if (action === 'RESET') {
      // Clear the in-memory injected fault as well as resetting the zone's
      // persisted risk counters; otherwise the UI says 'reset' while the
      // simulator continues replaying the previous fault episode.
      resetZone(zone.id);
      newStatus = 'RUNNING';
    }

    db.updateZone(zone.id, {
      status: newStatus,
      consecutiveCritical: 0,
      lastAction: action,
      lastActionBy: req.user.username,
      lastActionAt: new Date().toISOString()
    });

    db.addAudit({
      id: uuid(),
      at: new Date().toISOString(),
      actor: req.user.username,
      action: `MANUAL_${action}`,
      zoneId: zone.id,
      detail: `Zone ${zone.name} set to ${newStatus} by ${req.user.username} (${req.user.role})`
    });

    io.emit('automation:action', {
      zoneId: zone.id,
      action: `MANUAL_${action}`,
      reason: `Manual override by ${req.user.username}`,
      at: new Date().toISOString()
    });

    res.json({ zone: db.getZone(zone.id) });
  });

  return router;
};
