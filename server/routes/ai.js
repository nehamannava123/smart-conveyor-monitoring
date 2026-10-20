const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { generateZoneInsight } = require('../services/localInsights');
const { computeRisk } = require('../services/riskEngine');
const { model: mlModel } = require('../services/mlPredictor');

const router = express.Router();

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Scenario simulator: this is a transparent what-if projection, not a causal
// model trained on intervention/outcome data. It perturbs the current sensor
// state for a short horizon and runs the same risk + ML predictors again.
function simulateReading(reading, causeKey, takeAction) {
  const r = { ...reading };
  if (!takeAction) {
    r.alignmentMm = Number((r.alignmentMm * 1.18).toFixed(2));
    r.vibrationMms = Number((r.vibrationMms * 1.18).toFixed(2));
    r.slipPct = Number((r.slipPct * 1.22).toFixed(2));
    r.tensionPct = Number(clamp(r.tensionPct - 7, 0, 100).toFixed(2));
    r.loadPct = Number(clamp(r.loadPct + 6, 0, 130).toFixed(2));
    r.tempC = Number((r.tempC + 4).toFixed(2));
    return r;
  }

  // Model an operator intervention by moving the dominant fault channel
  // toward a safer operating band. Other channels receive a smaller benefit.
  const benefit = {
    alignment: () => { r.alignmentMm *= 0.55; r.vibrationMms *= 0.92; },
    vibration: () => { r.vibrationMms *= 0.55; r.alignmentMm *= 0.90; },
    slip: () => { r.slipPct *= 0.50; r.tensionPct += 6; },
    tension: () => { r.tensionPct += 10; r.slipPct *= 0.82; },
    load: () => { r.loadPct = 90 + (r.loadPct - 90) * 0.45; r.alignmentMm *= 0.90; },
    temp: () => { r.tempC -= 8; r.loadPct = 90 + (r.loadPct - 90) * 0.85; }
  };
  if (benefit[causeKey]) benefit[causeKey]();
  else r.vibrationMms *= 0.85;

  r.alignmentMm = Number(r.alignmentMm.toFixed(2));
  r.vibrationMms = Number(r.vibrationMms.toFixed(2));
  r.slipPct = Number(clamp(r.slipPct, 0, 100).toFixed(2));
  r.tensionPct = Number(clamp(r.tensionPct, 0, 100).toFixed(2));
  r.loadPct = Number(clamp(r.loadPct, 0, 130).toFixed(2));
  r.tempC = Number(clamp(r.tempC, -20, 150).toFixed(2));
  return r;
}


// Kept for frontend compatibility - this deployment never requires an API
// key, so this always reports "configured".
router.get('/status', requireAuth, (req, res) => {
  res.json({ configured: true, mode: 'local-rule-engine' });
});

router.get('/models', requireAuth, (req, res) => {
  res.json(mlModel.getMetrics());
});



router.post('/what-if/:zoneId', requireAuth, (req, res) => {
  const zone = db.getZone(req.params.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });
  const recentReadings = db.getReadings(zone.id, 30);
  const reading = recentReadings[recentReadings.length - 1];
  if (!reading) return res.status(400).json({ error: 'No sensor data yet for this zone' });

  const currentRisk = computeRisk(zone, reading);
  const actionKey = currentRisk.primaryCauseKey;
  const actionText = currentRisk.recommendedActions?.[0] || 'Inspect and correct the dominant fault condition';

  const noActionReading = simulateReading(reading, actionKey, false);
  const withActionReading = simulateReading(reading, actionKey, true);
  const noActionRisk = computeRisk(zone, noActionReading);
  const withActionRisk = computeRisk(zone, withActionReading);
  const noActionMl = mlModel.predict(zone, noActionReading);
  const withActionMl = mlModel.predict(zone, withActionReading);

  res.json({
    zoneId: zone.id,
    horizonMinutes: 10,
    simulationOnly: true,
    current: { risk: currentRisk.score, level: currentRisk.level },
    action: { key: actionKey, text: actionText },
    withoutAction: {
      risk: noActionRisk.score,
      level: noActionRisk.level,
      mlProbability: noActionMl.probability,
      reading: noActionReading
    },
    withAction: {
      risk: withActionRisk.score,
      level: withActionRisk.level,
      mlProbability: withActionMl.probability,
      reading: withActionReading
    },
    riskChange: noActionRisk.score - withActionRisk.score,
    note: 'Scenario projection using synthetic sensor perturbations and the existing risk/ML models; it is not a causal estimate from real intervention-outcome data.'
  });
});

router.post('/analyze/:zoneId', requireAuth, (req, res) => {
  const zone = db.getZone(req.params.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const recentReadings = db.getReadings(zone.id, 30);
  const reading = recentReadings[recentReadings.length - 1];
  if (!reading) return res.status(400).json({ error: 'No sensor data yet for this zone' });

  const risk = computeRisk(zone, reading);
  const mlPrediction = mlModel.predict(zone, reading);
  const insight = generateZoneInsight({ zone, risk, reading, mlPrediction });

  res.json({ zoneId: zone.id, risk, mlPrediction, ...insight });
});

module.exports = router;
