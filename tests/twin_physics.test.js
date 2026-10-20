const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app } = require('../server/index');
const { issueToken } = require('../server/services/authService');
const {
  validateAndSanitizeParams,
  solveConveyorPhysics,
  compareScenarios
} = require('../server/services/twinPhysics');

let serverInstance;
let baseUrl;
const adminToken = issueToken({ id: 'adm-1', username: 'admin', role: 'ADMIN' });

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

test('twinPhysics - parameter validation and defensive clamping', () => {
  const clamped = validateAndSanitizeParams({
    beltSpeedMs: 99.0, // max is 6.0
    materialLoadTph: -500, // min is 0
    inclineDeg: -45, // min is -18
    beltTensionKn: 5, // min is 15
    idlerMisalignmentMm: 120, // max is 45
    frictionCoeff: 0.95, // max is 0.50
    faultCondition: 'INVALID_FAULT'
  });

  assert.equal(clamped.beltSpeedMs, 6.0);
  assert.equal(clamped.materialLoadTph, 0);
  assert.equal(clamped.inclineDeg, -18);
  assert.equal(clamped.beltTensionKn, 15);
  assert.equal(clamped.idlerMisalignmentMm, 45);
  assert.equal(clamped.frictionCoeff, 0.50);
  assert.equal(clamped.faultCondition, 'NONE');
});

test('twinPhysics - CEMA / ISO 5048 physical calculations and regenerative power', () => {
  const result = solveConveyorPhysics({
    beltSpeedMs: 3.5,
    materialLoadTph: 2200,
    inclineDeg: -8.5,
    beltTensionKn: 75,
    idlerMisalignmentMm: 0,
    frictionCoeff: 0.32,
    faultCondition: 'NONE'
  });

  assert.ok(result.calculated, 'calculated results should be present');
  // q_m = 2200 / (3.6 * 3.5) ~ 174.6 kg/m
  assert.ok(result.calculated.materialLinearMassKgm > 170 && result.calculated.materialLinearMassKgm < 180);
  assert.ok(result.calculated.catenarySagPercent > 0.2 && result.calculated.catenarySagPercent < 2.5);

  // Downhill negative slope (-8.5 deg) at 2200 t/h produces net gravity assistance => regenerative
  assert.ok(result.calculated.mechanicalPowerKw < 0, 'downhill run should generate negative mechanical power');
  assert.equal(result.calculated.isRegenerative, true);

  // Governing equations metadata present
  assert.ok(result.governingEquations.length >= 4);
});

test('twinPhysics - threshold violation detection for severe misalignment and slack belt', () => {
  const result = solveConveyorPhysics({
    beltSpeedMs: 4.0,
    materialLoadTph: 3500,
    inclineDeg: 5.0,
    beltTensionKn: 20, // dangerously low tension
    idlerMisalignmentMm: 35, // severe misalignment
    frictionCoeff: 0.25,
    faultCondition: 'BELT_MISTRACKING'
  });

  assert.ok(result.violations.length >= 2, 'should trigger at least sag and drift violations');
  const metricNames = result.violations.map(v => v.metric);
  assert.ok(metricNames.includes('Lateral Belt Drift') || metricNames.includes('Catenary Sag'));
});

test('twinPhysics - comparative scenario analysis', () => {
  const baseline = {
    beltSpeedMs: 3.5, materialLoadTph: 2200, inclineDeg: -8.5,
    beltTensionKn: 75, idlerMisalignmentMm: 0, frictionCoeff: 0.32, faultCondition: 'NONE'
  };
  const modified = {
    beltSpeedMs: 4.5, materialLoadTph: 3000, inclineDeg: -8.5,
    beltTensionKn: 75, idlerMisalignmentMm: 20, frictionCoeff: 0.32, faultCondition: 'NONE'
  };

  const comp = compareScenarios(baseline, modified);
  assert.ok(comp.baseline && comp.modified && comp.deltas);
  assert.equal(comp.deltas.beltSpeedDelta, 1.0);
  assert.equal(comp.deltas.materialLoadDelta, 800);
  assert.ok(comp.deltas.lateralDriftDeltaMm > 15);
});

test('API Digital Twin - assembly topology, simulation, and scenario persistence workflow', async () => {
  // 1. GET /api/twin/assembly
  const resAssembly = await fetch(`${baseUrl}/api/twin/assembly`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(resAssembly.status, 200);
  const dataAssembly = await resAssembly.json();
  assert.ok(dataAssembly.assembly.components.length >= 5);

  // 2. POST /api/twin/simulate
  const resSim = await fetch(`${baseUrl}/api/twin/simulate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      params: { beltSpeedMs: 3.5, materialLoadTph: 2000, inclineDeg: -5, beltTensionKn: 70 }
    })
  });
  assert.equal(resSim.status, 200);
  const dataSim = await resSim.json();
  assert.ok(dataSim.calculated.catenarySagPercent);

  // 3. POST /api/twin/compare
  const resComp = await fetch(`${baseUrl}/api/twin/compare`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseline: { beltSpeedMs: 3.5, materialLoadTph: 2000 },
      modified: { beltSpeedMs: 4.0, materialLoadTph: 2500 }
    })
  });
  assert.equal(resComp.status, 200);
  const dataComp = await resComp.json();
  assert.ok(dataComp.deltas);

  // 4. POST /api/twin/scenarios (Save experiment)
  const resSave = await fetch(`${baseUrl}/api/twin/scenarios`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test Regenerative Experiment',
      notes: 'Testing CEMA limits',
      params: { beltSpeedMs: 3.5, materialLoadTph: 2200, inclineDeg: -8.5, beltTensionKn: 75 }
    })
  });
  assert.equal(resSave.status, 201);
  const dataSave = await resSave.json();
  const scenarioId = dataSave.id;

  // 5. GET /api/twin/scenarios
  const resList = await fetch(`${baseUrl}/api/twin/scenarios`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(resList.status, 200);
  const dataList = await resList.json();
  assert.ok(dataList.some((s) => s.id === scenarioId));

  // 6. DELETE /api/twin/scenarios/:id
  const resDel = await fetch(`${baseUrl}/api/twin/scenarios/${scenarioId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(resDel.status, 200);
});
