const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const workOrderService = require('../services/workOrderService');

module.exports = function workOrdersRouter(io) {
  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    const { status, zoneId, assetId, limit } = req.query;
    const workOrders = db.getWorkOrders({
      status,
      zoneId,
      assetId,
      limit: Math.min(500, Number(limit) || 200)
    });
    res.json({ workOrders });
  });

  router.get('/:id', requireAuth, (req, res) => {
    const wo = db.getWorkOrder(req.params.id);
    if (!wo) return res.status(404).json({ error: 'Work order not found' });
    res.json({ workOrder: wo });
  });

  router.post('/', requireAuth, requireRole('ADMIN', 'OPERATOR'), (req, res) => {
    const { zoneId, title } = req.body || {};
    if (!zoneId) {
      return res.status(400).json({ error: 'zoneId is required' });
    }

    const wo = workOrderService.createWorkOrder(req.body, req.user.username);

    db.addAudit({
      id: uuid(),
      at: new Date().toISOString(),
      actor: req.user.username,
      action: 'WORK_ORDER_CREATED',
      zoneId: wo.zoneId,
      detail: `Created work order ${wo.id}: ${wo.title} (Priority: ${wo.priority})`
    });

    if (io) io.emit('workorder:new', wo);
    res.status(201).json({ workOrder: wo });
  });

  router.patch('/:id/status', requireAuth, requireRole('ADMIN', 'OPERATOR'), (req, res) => {
    const { status, note } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status is required' });

    // Closing a work order requires ADMIN
    if (status === 'CLOSED' && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Closing and signing off a work order requires ADMIN role' });
    }

    try {
      const updated = workOrderService.updateWorkOrderStatus(req.params.id, status, req.user.username, note);
      if (!updated) return res.status(404).json({ error: 'Work order not found' });

      db.addAudit({
        id: uuid(),
        at: new Date().toISOString(),
        actor: req.user.username,
        action: 'WORK_ORDER_STATUS_CHANGED',
        zoneId: updated.zoneId,
        detail: `Work order ${updated.id} transitioned to ${status}. Note: ${note || 'None'}`
      });

      if (io) io.emit('workorder:updated', updated);
      res.json({ workOrder: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/:id', requireAuth, requireRole('ADMIN', 'OPERATOR'), (req, res) => {
    const updated = workOrderService.updateWorkOrderDetails(req.params.id, req.body, req.user.username);
    if (!updated) return res.status(404).json({ error: 'Work order not found' });

    db.addAudit({
      id: uuid(),
      at: new Date().toISOString(),
      actor: req.user.username,
      action: 'WORK_ORDER_UPDATED',
      zoneId: updated.zoneId,
      detail: `Updated details on work order ${updated.id}`
    });

    if (io) io.emit('workorder:updated', updated);
    res.json({ workOrder: updated });
  });

  return router;
};
