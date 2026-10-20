/**
 * HillGuard Maintenance Work Order Service
 * =========================================
 * Manages conversion of alerts into actionable work orders, technician assignment,
 * status transitions, inspection checklists, and repair documentation.
 */

const { v4: uuid } = require('uuid');
const db = require('../config/db');

const WORK_ORDER_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'AWAITING_PARTS',
  'RESOLVED',
  'CLOSED'
];

function createWorkOrder(data, actor) {
  const workOrder = {
    id: `WO-${Date.now().toString().slice(-6)}`,
    title: data.title || `Maintenance Task: ${data.cause || 'Conveyor Inspection'}`,
    description: data.description || 'Address abnormal operating telemetry or triggered alert condition.',
    zoneId: data.zoneId,
    zoneName: data.zoneName || data.zoneId,
    assetId: data.assetId || null,
    originatingAlertId: data.alertId || null,
    severity: data.severity || 'MEDIUM', // LOW | MEDIUM | HIGH | CRITICAL
    priority: data.priority || 'HIGH',
    status: 'OPEN',
    assignedTechnician: data.assignedTechnician || null,
    checklist: Array.isArray(data.checklist) && data.checklist.length > 0
      ? data.checklist
      : [
          { item: 'Inspect mechanical components for wear, loose fasteners, or physical obstruction', completed: false },
          { item: 'Verify electrical sensor calibration and cable continuity', completed: false },
          { item: 'Test run under controlled low-speed conditions and verify telemetry normalization', completed: false }
        ],
    repairNotes: '',
    partsReplaced: [],
    createdBy: actor,
    createdAt: new Date().toISOString(),
    assignedAt: null,
    startedAt: null,
    resolvedAt: null,
    closedAt: null,
    history: [
      { status: 'OPEN', actor, timestamp: new Date().toISOString(), note: 'Work order created' }
    ]
  };

  db.addWorkOrder(workOrder);

  // Link originating alert if present
  if (data.alertId) {
    db.updateAlert(data.alertId, { workOrderId: workOrder.id });
  }

  return workOrder;
}

function updateWorkOrderStatus(id, newStatus, actor, note = '') {
  if (!WORK_ORDER_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}. Must be one of ${WORK_ORDER_STATUSES.join(', ')}`);
  }

  const wo = db.getWorkOrder(id);
  if (!wo) return null;

  const patch = { status: newStatus };
  const now = new Date().toISOString();

  if (newStatus === 'ASSIGNED' && !wo.assignedAt) patch.assignedAt = now;
  if (newStatus === 'IN_PROGRESS' && !wo.startedAt) patch.startedAt = now;
  if (newStatus === 'RESOLVED') patch.resolvedAt = now;
  if (newStatus === 'CLOSED') patch.closedAt = now;

  const history = Array.isArray(wo.history) ? [...wo.history] : [];
  history.push({ status: newStatus, actor, timestamp: now, note });
  patch.history = history;

  return db.updateWorkOrder(id, patch);
}

function updateWorkOrderDetails(id, patchData, actor) {
  const wo = db.getWorkOrder(id);
  if (!wo) return null;

  const allowedFields = ['title', 'description', 'assignedTechnician', 'priority', 'checklist', 'repairNotes', 'partsReplaced'];
  const update = {};
  for (const f of allowedFields) {
    if (patchData[f] !== undefined) update[f] = patchData[f];
  }

  return db.updateWorkOrder(id, update);
}

module.exports = {
  WORK_ORDER_STATUSES,
  createWorkOrder,
  updateWorkOrderStatus,
  updateWorkOrderDetails
};
