const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app } = require('../server/index');
const { issueToken } = require('../server/services/authService');

let serverInstance;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    serverInstance = http.createServer(app);
    serverInstance.listen(0, '127.0.0.1', () => {
      const port = serverInstance.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => {
    serverInstance.close(resolve);
  });
});

test('API GET /api/health - returns system health and readiness', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.mlModelReady, true);
  assert.ok(data.zonesCount >= 5);
});

test('API GET /api/audit - enforces ADMIN-only access', async () => {
  const viewerToken = issueToken({ id: 'v1', username: 'viewer', role: 'VIEWER' });
  const adminToken = issueToken({ id: 'a1', username: 'admin', role: 'ADMIN' });

  // 1. Viewer attempt -> 403 Forbidden
  const viewerRes = await fetch(`${baseUrl}/api/audit`, {
    headers: { Authorization: `Bearer ${viewerToken}` }
  });
  assert.equal(viewerRes.status, 403, 'Viewer must be denied access to audit logs');

  // 2. Admin attempt -> 200 OK
  const adminRes = await fetch(`${baseUrl}/api/audit`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(adminRes.status, 200, 'Admin must be granted access to audit logs');
  const data = await adminRes.json();
  assert.ok(Array.isArray(data.auditLog));
});

test('API Assets & Work Orders Workflow', async () => {
  const operatorToken = issueToken({ id: 'op1', username: 'operator', role: 'OPERATOR' });
  const adminToken = issueToken({ id: 'ad1', username: 'admin', role: 'ADMIN' });

  // 1. List assets
  const assetsRes = await fetch(`${baseUrl}/api/assets`, {
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.equal(assetsRes.status, 200);
  const { assets } = await assetsRes.json();
  assert.ok(assets.length > 0);

  // 2. Create work order
  const createRes = await fetch(`${baseUrl}/api/work-orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${operatorToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      zoneId: 'zone-b',
      assetId: assets[0].id,
      title: 'Inspect motor bearing temperatures',
      priority: 'HIGH'
    })
  });
  assert.equal(createRes.status, 201);
  const { workOrder } = await createRes.json();
  assert.equal(workOrder.status, 'OPEN');

  // 3. Update work order status: IN_PROGRESS
  const patchRes1 = await fetch(`${baseUrl}/api/work-orders/${workOrder.id}/status`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${operatorToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'IN_PROGRESS', note: 'Technician on-site' })
  });
  assert.equal(patchRes1.status, 200);
  const { workOrder: inProgWo } = await patchRes1.json();
  assert.equal(inProgWo.status, 'IN_PROGRESS');

  // 4. Non-admin cannot close work order
  const closeFailRes = await fetch(`${baseUrl}/api/work-orders/${workOrder.id}/status`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${operatorToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'CLOSED', note: 'Unauthorized closure attempt' })
  });
  assert.equal(closeFailRes.status, 403, 'Non-admin cannot close work order');

  // 5. Admin can close work order
  const closeOkRes = await fetch(`${baseUrl}/api/work-orders/${workOrder.id}/status`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'CLOSED', note: 'Signed off by maintenance superintendent' })
  });
  assert.equal(closeOkRes.status, 200);
  const { workOrder: closedWo } = await closeOkRes.json();
  assert.equal(closedWo.status, 'CLOSED');
});

test('API Reports & CSV Export', async () => {
  const adminToken = issueToken({ id: 'ad1', username: 'admin', role: 'ADMIN' });

  // 1. Summary endpoint
  const sumRes = await fetch(`${baseUrl}/api/reports/summary`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(sumRes.status, 200);
  const sumData = await sumRes.json();
  assert.ok(sumData.systemStatus);
  assert.ok(sumData.alertMetrics);
  assert.ok(sumData.workOrderBacklog);

  // 2. Export alerts CSV
  const csvAlertsRes = await fetch(`${baseUrl}/api/reports/export/alerts.csv`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(csvAlertsRes.status, 200);
  assert.ok(csvAlertsRes.headers.get('content-type').includes('text/csv'));
  const csvText = await csvAlertsRes.text();
  assert.ok(csvText.includes('ID,CreatedAt,ZoneID'));

  // 3. Export work orders CSV
  const csvWoRes = await fetch(`${baseUrl}/api/reports/export/work-orders.csv`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(csvWoRes.status, 200);
  assert.ok(csvWoRes.headers.get('content-type').includes('text/csv'));
});
