const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRisk, THRESHOLDS } = require('../server/services/riskEngine');
const { buildEvaluationDiagnostics } = require('../server/scripts/trainModels');
const fs = require('node:fs');
const path = require('node:path');

test('risk explainability exposes readings, thresholds, weights, contributions and severity rule', () => {
  const zone = { id: `risk-explain-${Date.now()}`, inclineDeg: 12, curveSeverity: 0.4 };
  const reading = { alignmentMm: 24, vibrationMms: 3, tensionPct: 95, slipPct: 1, loadPct: 70, tempC: 50, ts: Date.now() };
  const risk = computeRisk(zone, reading);
  assert.ok(risk.thresholds.alignment.warn === 15);
  assert.ok(risk.contributors.length === 6);
  const alignment = risk.contributors.find(c => c.key === 'alignment');
  assert.equal(alignment.readingValue, 24);
  assert.equal(alignment.warnAt, THRESHOLDS.alignment.warn);
  assert.equal(alignment.critAt, THRESHOLDS.alignment.crit);
  assert.ok(Number.isFinite(alignment.normalizedWeight));
  assert.ok(Number.isFinite(alignment.weightedContribution));
  assert.ok(alignment.triggerReason.includes('warning threshold'));
  assert.ok(risk.scoreMethod.formula.includes('weightedAverage'));
  assert.ok(risk.scoreMethod.levelDecision);
});

test('evaluation diagnostics include PR curve, calibration bins, confusion matrix and fault subgroups', () => {
  const labels = [0, 0, 1, 1, 0, 1];
  const probabilities = [0.1, 0.4, 0.8, 0.7, 0.2, 0.3];
  const faults = ['NORMAL', 'NORMAL', 'MISTRACKING', 'SLIPPAGE', 'NORMAL', 'MISTRACKING'];
  const d = buildEvaluationDiagnostics(labels, probabilities, faults, 0.5);
  assert.equal(d.confusionMatrix.tp, 2);
  assert.equal(d.confusionMatrix.fp, 0);
  assert.equal(d.confusionMatrix.fn, 1);
  assert.equal(d.precisionRecallCurve.length, 19);
  assert.equal(d.calibrationBins.length, 10);
  assert.ok(d.byFaultType.MISTRACKING);
  assert.ok(Number.isFinite(d.falseAlarmRate));
  assert.ok(Number.isFinite(d.missedEventRate));
});

test('digital twin tail pulley maps to an existing route zone', () => {
  const twinSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'twin.js'), 'utf8');
  assert.match(twinSource, /id: 'comp-pulley-tail',[\s\S]*?zoneId: 'zone-e'/);
  assert.doesNotMatch(twinSource, /id: 'comp-pulley-tail',[\s\S]*?zoneId: 'zone-f'/);
});

test('committed ML artifact includes reproducible evaluation diagnostics', () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'models', 'model-artifact.json'), 'utf8'));
  assert.equal(artifact.trainingProvenance.isFieldValidated, false);
  assert.equal(Object.keys(artifact.evaluationDiagnostics || {}).length, 9);
  const ensemble = artifact.evaluationDiagnostics.Ensemble;
  assert.equal(ensemble.precisionRecallCurve.length, 19);
  assert.equal(ensemble.calibrationBins.length, 10);
  assert.ok(ensemble.confusionMatrix && Number.isFinite(ensemble.falseAlarmRate) && Number.isFinite(ensemble.missedEventRate));
});
