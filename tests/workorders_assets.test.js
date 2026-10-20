const test = require('node:test');
const assert = require('node:assert/strict');
const assetService = require('../server/services/assetService');
const workOrderService = require('../server/services/workOrderService');
const db = require('../server/config/db');

test('assets - registry seeding, retrieval, and maintenance logging', () => {
  const assets = assetService.getAllAssets();
  assert.ok(assets.length >= 5, 'Should seed initial assets across conveyor line');

  const motor = assetService.getAssetById('asset-mot-01');
  assert.ok(motor);
  assert.equal(motor.type, 'MOTOR');
  assert.equal(motor.zoneId, 'zone-b');

  // Log maintenance record
  const record = assetService.addMaintenanceRecord(
    'asset-mot-01',
    { type: 'VIBRATION_SURVEY', notes: 'Laser shaft alignment completed within 0.05mm tolerance.' },
    'technician_1'
  );
  assert.ok(record);
  assert.equal(record.technician, 'technician_1');

  const updatedMotor = assetService.getAssetById('asset-mot-01');
  assert.equal(updatedMotor.maintenanceHistory[0].notes, 'Laser shaft alignment completed within 0.05mm tolerance.');
});

test('workOrders - lifecycle transitions and originating alert link', () => {
  // Create an alert first
  const alert = db.addAlert({
    id: `alt-${Date.now()}`,
    zoneId: 'zone-c',
    level: 'CRITICAL',
    cause: 'Belt mistracking',
    message: 'Severe edge drift detected'
  });

  // Create work order linked to alert
  const wo = workOrderService.createWorkOrder(
    {
      title: 'Realignment of curved training frames',
      zoneId: 'zone-c',
      assetId: 'asset-train-01',
      alertId: alert.id,
      priority: 'CRITICAL',
      assignedTechnician: 'operator'
    },
    'admin'
  );

  assert.ok(wo.id.startsWith('WO-'));
  assert.equal(wo.status, 'OPEN');
  assert.equal(wo.originatingAlertId, alert.id);

  // Verify alert is updated with work order link
  const updatedAlert = db.getAlert(alert.id);
  assert.equal(updatedAlert.workOrderId, wo.id);

  // Transition status: OPEN -> IN_PROGRESS
  const inProgressWo = workOrderService.updateWorkOrderStatus(wo.id, 'IN_PROGRESS', 'operator', 'Field team deployed');
  assert.equal(inProgressWo.status, 'IN_PROGRESS');
  assert.ok(inProgressWo.startedAt);

  // Transition status: IN_PROGRESS -> RESOLVED
  const resolvedWo = workOrderService.updateWorkOrderStatus(wo.id, 'RESOLVED', 'operator', 'Idlers centered and tested');
  assert.equal(resolvedWo.status, 'RESOLVED');
  assert.ok(resolvedWo.resolvedAt);

  // Close work order
  const closedWo = workOrderService.updateWorkOrderStatus(wo.id, 'CLOSED', 'admin', 'Superintendent sign-off');
  assert.equal(closedWo.status, 'CLOSED');
  assert.ok(closedWo.closedAt);
  assert.equal(closedWo.history.length, 4);
});
