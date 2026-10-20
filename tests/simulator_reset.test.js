const test = require('node:test');
const assert = require('node:assert/strict');
const simulator = require('../server/services/simulator');

test('simulator reset - clears prior in-memory fault state before next reading', () => {
  const zone = {
    id: 'test-reset-zone', status: 'STOPPED', baseSpeedMps: 2.5,
    inclineDeg: 18, curveSeverity: 0.6, dominantRisk: 'MISTRACKING'
  };
  simulator.resetZone(zone.id);
  const reading = simulator.tickZone(zone);
  assert.equal(reading.activeFault, null);
  assert.equal(reading.speedMps, 0);
  assert.equal(reading.zoneId, zone.id);
  simulator.resetZone(zone.id);
});
