const express = require('express');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Audit logs are restricted to ADMINISTRATORS only.
router.get('/', requireAuth, requireRole('ADMIN'), (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 300));
  const { actor, action, zoneId } = req.query;

  let records = db.getAudit(limit * 2);
  if (actor) {
    const actorLower = String(actor).toLowerCase();
    records = records.filter((r) => r.actor && r.actor.toLowerCase().includes(actorLower));
  }
  if (action) {
    const actionLower = String(action).toLowerCase();
    records = records.filter((r) => r.action && r.action.toLowerCase().includes(actionLower));
  }
  if (zoneId) {
    records = records.filter((r) => r.zoneId === zoneId);
  }

  res.json({ auditLog: records.slice(0, limit) });
});

module.exports = router;
