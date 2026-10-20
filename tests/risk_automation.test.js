const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRisk, LEVELS, THRESHOLDS } = require('../server/services/riskEngine');
const { evaluateAutomation } = require('../server/services/automation');

test('riskEngine - deterministic thresholds and channel scoring', () => {
  const zone = { id: 'zone-a', inclineDeg: 8, curveSeverity: 0.15 };

  // 1. Nominal readings
  const nominalReading = {
    alignmentMm: 2.0,
    vibrationMms: 2.1,
    slipPct: 0.8,
    tensionPct: 98,
    loadPct: 60,
    tempC: 48
  };
  const nominalRisk = computeRisk(zone, nominalReading);
  assert.equal(nominalRisk.level, LEVELS.NORMAL);
  assert.ok(nominalRisk.score < 40, 'Nominal readings should yield score < 40');

  // 2. Critical alignment mistracking (>= 30mm)
  const mistrackReading = {
    alignmentMm: 34.0,
    vibrationMms: 2.5,
    slipPct: 0.8,
    tensionPct: 95,
    loadPct: 60,
    tempC: 48
  };
  const mistrackRisk = computeRisk(zone, mistrackReading);
  assert.equal(mistrackRisk.level, LEVELS.CRITICAL);
  assert.equal(mistrackRisk.primaryCauseKey, 'alignment');
  assert.ok(mistrackRisk.recommendedActions.length > 0);
});

test('automation - alert deduplication and simulated emergency stop', () => {
  const testZoneId = `zone-test-${Date.now()}`;
  const zone = {
    id: testZoneId,
    name: 'Test Zone',
    status: 'RUNNING',
    consecutiveCritical: 0
  };

  const criticalRisk = {
    score: 85,
    level: 'CRITICAL',
    primaryCause: 'Belt mistracking',
    primaryCauseKey: 'alignment',
    contributors: [],
    recommendedActions: []
  };

  const reading = { alignmentMm: 35.0, ts: Date.now() };

  // 1. First tick generates alert
  const res1 = evaluateAutomation(zone, criticalRisk, reading, null);
  assert.ok(res1.alert, 'First critical reading must generate an alert');
  assert.equal(zone.consecutiveCritical, 1);
  assert.equal(res1.autoStopTriggered, false);

  // 2. Second tick should suppress duplicate alert (score didn't jump significantly)
  const res2 = evaluateAutomation(zone, criticalRisk, reading, null);
  assert.equal(res2.alert, null, 'Duplicate alert should be suppressed within window');
  assert.equal(zone.consecutiveCritical, 2);
});
