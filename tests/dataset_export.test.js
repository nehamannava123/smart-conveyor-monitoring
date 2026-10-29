const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('bundled synthetic dataset has documented schema, size and honest provenance', () => {
  const root = path.join(__dirname, '..', 'data', 'datasets');
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
  const csvPath = path.join(root, metadata.datasetName);
  const stat = fs.statSync(csvPath);
  const fd = fs.openSync(csvPath, 'r');
  const firstLine = Buffer.alloc(4096);
  fs.readSync(fd, firstLine, 0, firstLine.length, 0);
  fs.closeSync(fd);
  const header = firstLine.toString('utf8').split(/\r?\n/, 1)[0].split(',');
  assert.equal(metadata.rows, 25000);
  assert.equal(metadata.provenance, 'SYNTHETIC_SIMULATION');
  assert.equal(metadata.fieldValidated, false);
  assert.ok(stat.size > 1000000, 'dataset should contain a substantial number of rows');
  for (const column of ['alignment_mm','vibration_rms_mm_s','drive_slip_pct','belt_tension_pct','material_load_pct','motor_temperature_c','fault_class','is_anomaly','hazard_event_within_10m']) {
    assert.ok(header.includes(column), `missing column ${column}`);
  }
  assert.ok(metadata.limitations.length >= 3);
  assert.equal(Object.values(metadata.classDistribution).reduce((a,b)=>a+b,0), 25000);
});

test('dataset rows are rectangular, labels are bounded, and candidate partitions are reproducible', () => {
  const root = path.join(__dirname, '..', 'data', 'datasets');
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
  const lines = fs.readFileSync(path.join(root, metadata.datasetName), 'utf8').trimEnd().split(/\r?\n/);
  const header = lines[0].split(',');
  const partitionIndex = header.indexOf('recommended_partition');
  const faultIndex = header.indexOf('fault_class');
  const anomalyIndex = header.indexOf('is_anomaly');
  const hazardIndex = header.indexOf('hazard_event_within_10m');
  assert.equal(lines.length - 1, metadata.rows);
  const partitions = { TRAIN_CANDIDATE: 0, HELDOUT_CANDIDATE: 0, EXTRA_SYNTHETIC: 0 };
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    assert.equal(cells.length, header.length);
    assert.ok(['0','1'].includes(cells[anomalyIndex]));
    assert.ok(['0','1'].includes(cells[hazardIndex]));
    assert.ok(metadata.classDistribution[cells[faultIndex]] > 0);
    partitions[cells[partitionIndex]]++;
  }
  assert.deepEqual(partitions, { TRAIN_CANDIDATE: 20000, HELDOUT_CANDIDATE: 5000, EXTRA_SYNTHETIC: 0 });
});
