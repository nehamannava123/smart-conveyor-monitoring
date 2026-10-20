const test = require('node:test');
const assert = require('node:assert/strict');
const { model, extractFeatures, FEATURES } = require('../server/services/mlPredictor');

test('mlPredictor - feature extraction consistency', () => {
  const zone = { inclineDeg: 22, curveSeverity: 0.15 };
  const reading = {
    alignmentMm: -18.5,
    vibrationMms: 4.8,
    slipPct: 2.1,
    tensionPct: 82,
    loadPct: 98,
    tempC: 72
  };

  const f = extractFeatures(zone, reading);
  assert.equal(f.alignmentAbs, 18.5);
  assert.equal(f.vibrationMms, 4.8);
  assert.equal(f.slipPct, 2.1);
  assert.equal(f.tensionDeficit, 8);
  assert.equal(f.loadExcess, 8);
  assert.equal(f.tempExcess, 7);
  assert.equal(f.inclineAbsDeg, 22);
  assert.equal(f.curveSeverity, 15);
});

test('mlPredictor - data quality check catches missing and stale telemetry', () => {
  const invalidReading = { alignmentMm: 0, vibrationMms: 2.0 };
  const q1 = model.checkDataQuality(invalidReading);
  assert.equal(q1.ok, false);
  assert.ok(q1.warnings.some((w) => w.includes('tensionPct')));

  const staleReading = {
    ts: Date.now() - 120000,
    alignmentMm: 0,
    vibrationMms: 2.0,
    tensionPct: 95,
    slipPct: 0.5,
    loadPct: 60,
    tempC: 45
  };
  const q2 = model.checkDataQuality(staleReading);
  assert.equal(q2.ok, false);
  assert.ok(q2.warnings.some((w) => w.includes('stale')));

  const goodReading = {
    ts: Date.now(),
    alignmentMm: 0,
    vibrationMms: 2.0,
    tensionPct: 95,
    slipPct: 0.5,
    loadPct: 60,
    tempC: 45
  };
  const q3 = model.checkDataQuality(goodReading);
  assert.equal(q3.ok, true);
});

test('mlPredictor - inference returns structured metrics and directional explainability', () => {
  assert.ok(model.ready, 'ML model artifact should be loaded and ready');

  const zone = { id: 'zone-b', inclineDeg: 22, curveSeverity: 0.05 };
  const reading = {
    ts: Date.now(),
    alignmentMm: 28.0,
    vibrationMms: 8.5,
    slipPct: 6.2,
    tensionPct: 65,
    loadPct: 110,
    tempC: 85
  };

  const pred = model.predict(zone, reading);
  assert.equal(pred.status, 'VALID');
  assert.ok(pred.probability >= 0 && pred.probability <= 1, 'Probability must be in [0, 1]');
  assert.ok(pred.contributions && pred.contributions.length > 0, 'Explainability contributions should exist');
  assert.ok(typeof pred.topFactor === 'string', 'Top factor should be a named feature string');
  assert.ok(FEATURES.includes(pred.topFactor));

  const modelKeys = Object.keys(pred.models);
  assert.ok(modelKeys.includes('Logistic Regression'));
  assert.ok(modelKeys.includes('Random Forest'));
  assert.ok(modelKeys.includes('Gradient Boosting'));
});

test('mlPredictor - metadata documents synthetic provenance vs real-world validation', () => {
  const meta = model.getMetrics();
  assert.ok(meta.trainingProvenance, 'Provenance must be present');
  assert.equal(meta.trainingProvenance.isFieldValidated, false, 'Must clearly state synthetic unvalidated field status');
  assert.ok(meta.baselines['Majority Class Prior'], 'Must include Majority Class Prior baseline');
  assert.ok(meta.baselines['Heuristic Sensor Threshold'], 'Must include Heuristic Threshold baseline');
  assert.ok(meta.rulDisclaimer, 'Must include RUL disclaimer');
  assert.equal(meta.modelCount, 9, 'Must evaluate and report all 9 active models');
});

test('mlPredictor - candidate evaluation audit records all 8 investigated models', () => {
  const meta = model.getMetrics();
  assert.ok(meta.candidateEvaluationReport, 'Candidate evaluation report must exist');
  const evaluated = meta.candidateEvaluationReport.evaluated;
  assert.equal(evaluated.length, 8, 'Must audit all 8 candidate architectures');

  const names = evaluated.map((e) => e.name);
  assert.ok(names.includes('Isolation Forest'));
  assert.ok(names.includes('Neural Autoencoder'));
  assert.ok(names.includes('Physics-Informed Hybrid'));
  assert.ok(names.includes('TSPulse'));
  assert.ok(names.includes('TCNs'));
  assert.ok(names.includes('PatchTST & IBM TinyTimeMixer'));
  assert.ok(names.includes('YOLOv8/11-seg'));
  assert.ok(names.includes('RT-DETR'));

  const tsPulse = evaluated.find((e) => e.name === 'TSPulse');
  assert.equal(tsPulse.status, 'REJECTED');

  const patchTst = evaluated.find((e) => e.name === 'PatchTST & IBM TinyTimeMixer');
  assert.equal(patchTst.status, 'DEFERRED');
});

test('mlPredictor - multi-task inference separates hazard forecasting, anomaly detection, and fault classification', () => {
  const zone = { id: 'zone-c', inclineDeg: -12.5, curveSeverity: 0.35 };
  const nominalReading = {
    ts: Date.now(),
    alignmentMm: 0.5,
    vibrationMms: 2.1,
    slipPct: 0.6,
    tensionPct: 92,
    loadPct: 65,
    tempC: 48
  };

  const predNominal = model.predict(zone, nominalReading);
  assert.equal(predNominal.status, 'VALID');
  assert.ok(predNominal.tasks, 'Task breakdown must exist');
  assert.equal(predNominal.tasks.anomalyDetection.status, 'NOMINAL');
  assert.equal(predNominal.tasks.hazardForecasting10m.status, 'NOMINAL');

  const faultReading = {
    ts: Date.now(),
    alignmentMm: 32.0,
    vibrationMms: 9.2,
    slipPct: 7.5,
    tensionPct: 58,
    loadPct: 125,
    tempC: 92
  };

  const predFault = model.predict(zone, faultReading);
  assert.equal(predFault.tasks.anomalyDetection.isAnomaly, true);
  assert.equal(predFault.tasks.hazardForecasting10m.status, 'HIGH HAZARD');
  assert.equal(predFault.classifiedFault, 'MISTRACKING');
});

test('mlPredictor - Isolation Forest and Neural Autoencoder anomaly metrics and residuals', () => {
  const zone = { id: 'zone-a', inclineDeg: 2, curveSeverity: 0.05 };
  const reading = {
    ts: Date.now(),
    alignmentMm: 28.0,
    vibrationMms: 12.0,
    slipPct: 4.8,
    tensionPct: 62,
    loadPct: 110,
    tempC: 88
  };

  const pred = model.predict(zone, reading);
  const ifModel = pred.models['Isolation Forest'];
  assert.ok(ifModel, 'Isolation Forest output must be present');
  assert.equal(ifModel.type, 'anomaly_detector');
  assert.ok(ifModel.anomalyScore > 0, 'Anomaly score must be positive');

  const aeModel = pred.models['Neural Autoencoder'];
  assert.ok(aeModel, 'Neural Autoencoder output must be present');
  assert.equal(aeModel.type, 'autoencoder_reconstruction');
  assert.ok(aeModel.reconstructionMse > 0, 'Reconstruction MSE must be positive');
  assert.ok(Array.isArray(aeModel.residuals), 'Residuals must be an array');
  assert.equal(aeModel.residuals.length, 8, 'Must provide residual for each of the 8 feature channels');
});

test('mlPredictor - Physics-Informed Hybrid enforces CEMA mechanical constraints', () => {
  const zoneSevere = { id: 'zone-d', inclineDeg: -14.0, curveSeverity: 0.45 };
  // Severe slack tension + heavy load + high slip breaching CEMA catenary sag and Euler slip limits
  const readingViolation = {
    ts: Date.now(),
    alignmentMm: 14.0,
    vibrationMms: 4.5,
    slipPct: 6.8, // severe slip on steep downhill
    tensionPct: 45, // severe tension loss -> catenary sag > 2.5%
    loadPct: 130, // material overload
    tempC: 68
  };

  const pred = model.predict(zoneSevere, readingViolation);
  const piModel = pred.models['Physics-Informed Hybrid'];
  assert.ok(piModel, 'Physics-Informed Hybrid output must be present');
  assert.equal(piModel.type, 'physics_hybrid');
  assert.equal(piModel.physicalConstraintStatus, 'VIOLATION');
  assert.ok(piModel.probability >= 0.70, 'Physical safety boundary violation must floor hazard probability >= 0.70');
});

