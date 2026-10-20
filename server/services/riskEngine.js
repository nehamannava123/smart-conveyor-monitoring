/**
 * HillGuard Predictive Risk Engine (v2 Hardened)
 * ===============================================
 * Evaluates real-time sensor telemetry against physical operating thresholds
 * and statistical deviation metrics (rolling z-score).
 *
 * Design Principles:
 *   1. Deterministic Bounds: Grounded in conveyor engineering standards
 *      (e.g., ISO 10816 vibration limits, CEMA belt training & tension guidelines).
 *   2. Anomaly Detection: Rolling z-score flags unexpected changes even within nominal bands.
 *   3. Separation of Concerns: Rule-based scores are kept inspectable and distinct from ML inference.
 *   4. Zero Target Leakage: Never relies on simulation flags (e.g. activeFault).
 */

const db = require('../config/db');

const LEVELS = { NORMAL: 'NORMAL', WARNING: 'WARNING', CRITICAL: 'CRITICAL' };

// Threshold definitions (units, nominal, warning, critical)
const THRESHOLDS = {
  alignment: { name: 'Belt Tracking', unit: 'mm', warn: 15, crit: 30 },
  vibration: { name: 'Vibration RMS', unit: 'mm/s', warn: 5, crit: 9 },
  slip: { name: 'Drive Slip', unit: '%', warn: 3, crit: 7 },
  tension: { name: 'Tension Deficit', unit: '% deficit', warn: 15, crit: 30 },
  load: { name: 'Overload Excess', unit: '% excess', warn: 10, crit: 25 },
  temp: { name: 'Motor Overheat', unit: '°C excess', warn: 15, crit: 30 }
};

const MITIGATIONS = {
  alignment: [
    'Inspect and re-center the belt at training idlers nearest this zone',
    'Check troughing/return idlers for uneven wear or seized bearings causing drift',
    'Verify material feed chute is centered so ore stream does not push belt laterally',
    'Confirm curve radius and idler tilt angles match engineering design specifications'
  ],
  vibration: [
    'Inspect idler bearings and rollers for flat spots, bearing spalling, or seizure',
    'Check drive pulley alignment, coupling balance, and belt splice condition',
    'Inspect structural truss and support stand anchor bolts for looseness or resonance',
    'Confirm material feed distribution is not producing extreme impact shock'
  ],
  slip: [
    'Inspect gravity or motorized take-up unit and verify tension counterweight travel',
    'Inspect drive pulley ceramic/rubber lagging for abrasive wear or contamination (water/mud/grease)',
    'Clean pulley face and return belt scrapers',
    'Verify motor drive torque settings match current incline load'
  ],
  tension: [
    'Inspect take-up carriage travel limits and verify winches/counterweights are free',
    'Inspect belt for permanent elongation or splice displacement',
    'Verify tension load cells and safety limit switches are reading accurately'
  ],
  load: [
    'Check loading chute skirting for material buildup deflecting material off-center',
    'Inspect feed belt plow and rock boxes',
    'Temporarily throttle upstream feeder rate until load balances'
  ],
  temp: [
    'Inspect motor cooling fan shroud and clear any blocked ventilation grilles',
    'Check gearbox and bearing lubrication levels and operating temperatures',
    'Verify electrical motor current draw against rated full-load amperage',
    'Allow controlled thermal relief period under reduced speed/tonnage'
  ]
};

function recommendedActions(primaryKey) {
  return MITIGATIONS[primaryKey] || ['Inspect zone equipment according to standard preventative checklist'];
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
}

function stddev(arr, m) {
  if (arr.length < 2) return 0;
  const v = mean(arr.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

function zScoreBoost(history, key, current) {
  if (!history || history.length < 8) return 0;
  const vals = history.map((h) => h[key]).filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (vals.length < 8) return 0;
  const m = mean(vals);
  const sd = stddev(vals, m) || 0.001;
  const z = Math.abs((current - m) / sd);
  // z > 2 standard deviations triggers anomaly boost, capped at 25
  return Math.min(25, Math.max(0, (z - 2) * 12.5));
}

function bandScore(value, warnAt, critAt) {
  if (value <= 0) return 0;
  if (value <= warnAt) return (value / warnAt) * 40;
  if (value <= critAt) return 40 + ((value - warnAt) / (critAt - warnAt)) * 40;
  return Math.min(100, 80 + ((value - critAt) / critAt) * 40);
}

function computeRisk(zone, reading) {
  if (!zone || !reading) {
    return {
      score: 0,
      level: LEVELS.NORMAL,
      primaryCause: 'None',
      primaryCauseKey: 'none',
      contributors: [],
      recommendedActions: []
    };
  }

  const history = db.getReadings(zone.id, 30);

  const inclineFactor = Math.abs(zone.inclineDeg || 0) / 25;
  const curveFactor = zone.curveSeverity || 0;

  // Channel values
  const alignmentAbs = Math.abs(reading.alignmentMm ?? 0);
  const vibrationMms = Math.max(0, reading.vibrationMms ?? 0);
  const slipPct = Math.max(0, reading.slipPct ?? 0);
  const tensionDeficit = Math.max(0, 90 - (reading.tensionPct ?? 90));
  const loadExcess = Math.max(0, (reading.loadPct ?? 50) - 90);
  const tempExcess = Math.max(0, (reading.tempC ?? 45) - 65);

  // Deterministic rule scores
  const alignmentRule = bandScore(alignmentAbs, THRESHOLDS.alignment.warn, THRESHOLDS.alignment.crit);
  const vibrationRule = bandScore(vibrationMms, THRESHOLDS.vibration.warn, THRESHOLDS.vibration.crit);
  const slipRule = bandScore(slipPct, THRESHOLDS.slip.warn, THRESHOLDS.slip.crit);
  const tensionRule = bandScore(tensionDeficit, THRESHOLDS.tension.warn, THRESHOLDS.tension.crit);
  const loadRule = bandScore(loadExcess, THRESHOLDS.load.warn, THRESHOLDS.load.crit);
  const tempRule = bandScore(tempExcess, THRESHOLDS.temp.warn, THRESHOLDS.temp.crit);

  // Anomaly deviation boosts
  const alignmentAnomaly = zScoreBoost(history, 'alignmentMm', reading.alignmentMm);
  const vibrationAnomaly = zScoreBoost(history, 'vibrationMms', reading.vibrationMms);
  const slipAnomaly = zScoreBoost(history, 'slipPct', reading.slipPct);

  const alignmentScore = Math.min(100, alignmentRule + alignmentAnomaly);
  const vibrationScore = Math.min(100, vibrationRule + vibrationAnomaly);
  const slipScore = Math.min(100, slipRule + slipAnomaly);
  const tensionScore = tensionRule;
  const loadScore = loadRule;
  const tempScore = tempRule;

  // Terrain-aware weight configuration
  const weights = {
    alignment: 0.24 + 0.16 * curveFactor,
    vibration: 0.16,
    slip: 0.18 + 0.16 * inclineFactor,
    tension: 0.16 + 0.10 * inclineFactor,
    load: 0.14,
    temp: 0.12
  };
  const wSum = Object.values(weights).reduce((a, b) => a + b, 0);

  const weightedAvg =
    (alignmentScore * weights.alignment +
      vibrationScore * weights.vibration +
      slipScore * weights.slip +
      tensionScore * weights.tension +
      loadScore * weights.load +
      tempScore * weights.temp) /
    wSum;

  const worstChannelScore = Math.max(
    alignmentScore,
    vibrationScore,
    slipScore,
    tensionScore,
    loadScore,
    tempScore
  );

  // Blend weighted average with worst single channel (prevents single-channel catastrophe from dilution)
  const rawScore = 0.40 * weightedAvg + 0.60 * worstChannelScore;
  const score = Math.round(Math.min(100, Math.max(0, rawScore)));

  let level = LEVELS.NORMAL;
  if (score >= 70 || worstChannelScore >= 80) level = LEVELS.CRITICAL;
  else if (score >= 40 || worstChannelScore >= 45) level = LEVELS.WARNING;

  const contributors = [
    { key: 'alignment', label: 'Belt mistracking', score: Math.round(alignmentScore), ruleScore: Math.round(alignmentRule), anomalyScore: Math.round(alignmentAnomaly) },
    { key: 'vibration', label: 'Structural vibration', score: Math.round(vibrationScore), ruleScore: Math.round(vibrationRule), anomalyScore: Math.round(vibrationAnomaly) },
    { key: 'slip', label: 'Drive slippage', score: Math.round(slipScore), ruleScore: Math.round(slipRule), anomalyScore: Math.round(slipAnomaly) },
    { key: 'tension', label: 'Tension loss', score: Math.round(tensionScore), ruleScore: Math.round(tensionRule), anomalyScore: 0 },
    { key: 'load', label: 'Material imbalance', score: Math.round(loadScore), ruleScore: Math.round(loadRule), anomalyScore: 0 },
    { key: 'temp', label: 'Motor overheating', score: Math.round(tempScore), ruleScore: Math.round(tempRule), anomalyScore: 0 }
  ].sort((a, b) => b.score - a.score);

  return {
    score,
    level,
    primaryCause: contributors[0].label,
    primaryCauseKey: contributors[0].key,
    deterministicScore: Math.round(worstChannelScore),
    contributors,
    recommendedActions: recommendedActions(contributors[0].key),
    evaluatedAt: new Date().toISOString()
  };
}

module.exports = { computeRisk, LEVELS, THRESHOLDS, MITIGATIONS };
