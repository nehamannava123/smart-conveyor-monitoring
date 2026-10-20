/**
 * HillGuard Engineering Digital Twin Physics Engine
 * =================================================
 * Deterministic parameter-driven engineering approximations grounded in
 * CEMA (Conveyor Equipment Manufacturers Association, 7th Ed.) and ISO 5048.
 *
 * Provides:
 *   - Configurable parameter validation within defensible physical bounds.
 *   - Calculation of linear material loading, catenary sag, drive/regenerative power,
 *     Euler capstan drive slip, and idler-induced lateral tracking drift.
 *   - Evaluation of deterministic rule risk and machine-learning hazard forecasting.
 *   - Baseline vs. modified scenario comparative analysis.
 *   - Transparent engineering documentation of governing assumptions and limits.
 *
 * NOTE: This is an analytical parameter-driven engineering model for supervisory
 * investigation and planning. It is not a finite-element or multi-body dynamics solver
 * and must not be used as an SIL-rated safety interlock.
 */

const { computeRisk } = require('./riskEngine');
const { model: mlModel } = require('./mlPredictor');

const PARAM_BOUNDS = {
  beltSpeedMs: { min: 1.0, max: 6.0, default: 3.5, unit: 'm/s', name: 'Belt Speed' },
  materialLoadTph: { min: 0, max: 4500, default: 2200, unit: 't/h', name: 'Material Flow Rate' },
  inclineDeg: { min: -18, max: 18, default: -8.5, unit: '°', name: 'Conveyor Slope (Downhill Negative)' },
  beltTensionKn: { min: 15, max: 130, default: 75, unit: 'kN', name: 'Running Belt Tension' },
  idlerMisalignmentMm: { min: -45, max: 45, default: 0, unit: 'mm', name: 'Idler Misalignment' },
  frictionCoeff: { min: 0.15, max: 0.50, default: 0.32, unit: '—', name: 'Belt/Idler Friction Coeff (μ)' }
};

const FAULT_CONDITIONS = [
  'NONE',
  'IDLER_SEIZURE',
  'BELT_MISTRACKING',
  'MATERIAL_SURGE',
  'TAKEUP_LOSS',
  'REGENERATIVE_OVERSPEED'
];

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function validateAndSanitizeParams(raw = {}) {
  const sanitized = {};
  for (const [key, b] of Object.entries(PARAM_BOUNDS)) {
    const val = Number(raw[key]);
    sanitized[key] = Number.isFinite(val) ? clamp(val, b.min, b.max) : b.default;
  }
  sanitized.faultCondition = FAULT_CONDITIONS.includes(raw.faultCondition)
    ? raw.faultCondition
    : 'NONE';
  return sanitized;
}

/**
 * Calculates conveyor physical dynamics and derives equivalent telemetry.
 */
function solveConveyorPhysics(params, zoneRef = null) {
  const p = validateAndSanitizeParams(params);

  // 1. Material linear density q_m (kg/m)
  // q_m = Q / (3.6 * v)
  const qm = p.materialLoadTph / (3.6 * p.beltSpeedMs);
  const qb = 28.5; // Conveyor belt linear mass (approx. EP800/4 1200mm belt ~28.5 kg/m)
  const qTotal = qm + qb;

  // 2. Catenary sag between carrying idlers (spacing a_0 = 1.2m)
  // Sag S = (qTotal * g * a_0^2) / (8 * T)
  const a0 = 1.2; // idler spacing in meters
  const g = 9.80665;
  const tensionN = p.beltTensionKn * 1000;
  const sagMeters = (qTotal * g * (a0 ** 2)) / (8 * Math.max(10000, tensionN));
  const sagPercent = (sagMeters / a0) * 100;

  // 3. Longitudinal Drive / Regenerative Power (1000m overland section reference)
  // Downhill gravity gradient component: F_lift = qTotal * g * L * sin(theta)
  const lengthM = 1000;
  const rad = (p.inclineDeg * Math.PI) / 180;
  const sinIncline = Math.sin(rad);
  const cosIncline = Math.cos(rad);
  const fGravityGradient = qTotal * g * lengthM * sinIncline; // negative if downhill
  // Friction resistance force: F_R = f * L * g * (qb + qm * cos(theta))
  const fFriction = 0.022 * lengthM * g * (qb + qm * cosIncline);
  const effectiveDriveForceN = fFriction + fGravityGradient;
  const mechanicalPowerKw = (effectiveDriveForceN * p.beltSpeedMs) / 1000;

  // 4. Lateral tracking drift from idler misalignment and downhill skew
  let lateralDriftMm = p.idlerMisalignmentMm * 1.15 * (1 + qm / 250) * (1 + Math.abs(sinIncline) * 0.5);

  // 5. Apply fault perturbations
  let faultVibrationBonus = 0;
  let faultSlipBonus = 0;
  let faultTempBonus = 0;
  if (p.faultCondition === 'IDLER_SEIZURE') {
    faultVibrationBonus += 6.5;
    faultTempBonus += 35;
    lateralDriftMm += Math.sign(lateralDriftMm || 1) * 12;
  } else if (p.faultCondition === 'BELT_MISTRACKING') {
    lateralDriftMm += Math.sign(lateralDriftMm || 1) * 24;
  } else if (p.faultCondition === 'MATERIAL_SURGE') {
    lateralDriftMm += 14;
    faultVibrationBonus += 3.0;
  } else if (p.faultCondition === 'TAKEUP_LOSS') {
    faultSlipBonus += 7.5;
  } else if (p.faultCondition === 'REGENERATIVE_OVERSPEED') {
    faultSlipBonus += 4.5;
    faultVibrationBonus += 4.0;
  }

  // 6. Euler Capstan Drive Slip Ratio (T1/T2 vs e^(mu * wrap))
  // Wrap angle theta_wrap ~ 210 deg = 3.665 rad
  const wrapAngleRad = (210 * Math.PI) / 180;
  const maxCapstanRatio = Math.exp(p.frictionCoeff * wrapAngleRad);
  // Estimate tension ratio based on load & inclination
  const tensionRatio = 1.0 + Math.abs(effectiveDriveForceN) / Math.max(20000, tensionN * 0.6);
  const capstanSafetyMargin = maxCapstanRatio / Math.max(1.0, tensionRatio);
  const calculatedSlipPct = Number(
    Math.max(
      0.3,
      clamp(
        (1.0 / Math.max(0.5, capstanSafetyMargin)) * 1.8 + faultSlipBonus,
        0.2,
        25.0
      )
    ).toFixed(2)
  );

  // 7. Synthetic equivalent sensor readings
  const syntheticReading = {
    alignmentMm: Number(lateralDriftMm.toFixed(2)),
    vibrationMms: Number(
      clamp(1.8 + (p.beltSpeedMs / 3.5) * 1.2 + (qm / 150) * 0.8 + faultVibrationBonus, 0.5, 35.0).toFixed(2)
    ),
    slipPct: calculatedSlipPct,
    tensionPct: Number(clamp((p.beltTensionKn / 80) * 100, 10, 150).toFixed(1)),
    loadPct: Number(clamp((p.materialLoadTph / 2500) * 100, 0, 160).toFixed(1)),
    tempC: Number(
      clamp(42 + (Math.abs(mechanicalPowerKw) / 250) * 18 + faultTempBonus, 15, 130).toFixed(1)
    ),
    ts: Date.now()
  };

  // 8. Deterministic Risk Evaluation & ML Model Prediction
  const zone = zoneRef || {
    id: 'zone-c',
    name: 'Curved Descent (Zone C)',
    inclineDeg: p.inclineDeg,
    curveSeverity: 0.45,
    status: 'ACTIVE'
  };

  const riskResult = computeRisk(zone, syntheticReading);
  const mlResult = mlModel.predict(zone, syntheticReading);

  // 9. Engineering threshold violation checks
  const violations = [];
  if (sagPercent > 2.5) {
    violations.push({
      metric: 'Catenary Sag',
      value: `${sagPercent.toFixed(2)}%`,
      limit: '< 2.0% CEMA recommended (< 2.5% max)',
      severity: sagPercent > 3.2 ? 'CRITICAL' : 'WARNING',
      description: 'Excessive sag causes belt flapping, material wedging, and idler bearing impact loading.'
    });
  }
  if (Math.abs(lateralDriftMm) > 25) {
    violations.push({
      metric: 'Lateral Belt Drift',
      value: `${lateralDriftMm.toFixed(1)} mm`,
      limit: '±25 mm max tracking tolerance',
      severity: Math.abs(lateralDriftMm) > 35 ? 'CRITICAL' : 'WARNING',
      description: 'Severe belt deviation risks structural interference with idler stands and edge tear.'
    });
  }
  if (p.beltTensionKn < 35) {
    violations.push({
      metric: 'Belt Tension Deficit',
      value: `${p.beltTensionKn} kN`,
      limit: '> 40 kN minimum take-up tension',
      severity: 'CRITICAL',
      description: 'Insufficient tension compromises Euler capstan friction grip on drive pulley, causing slip.'
    });
  }
  if (mechanicalPowerKw < -350 && p.inclineDeg < -6) {
    violations.push({
      metric: 'Regenerative Braking Surge',
      value: `${mechanicalPowerKw.toFixed(1)} kW (Regenerative)`,
      limit: '< -350 kW braking grid capacity',
      severity: 'WARNING',
      description: 'Conveyor downhill gravity gradient exceeds steady-state mechanical friction; motor is generating power.'
    });
  }
  if (calculatedSlipPct > 3.0) {
    violations.push({
      metric: 'Drive Pulley Slip',
      value: `${calculatedSlipPct}%`,
      limit: '< 2.0% standard operating slip',
      severity: calculatedSlipPct > 6.0 ? 'CRITICAL' : 'WARNING',
      description: 'Belt velocity lags pulley rim speed; risks severe thermal pulley lag wear and fire.'
    });
  }

  return {
    inputs: p,
    calculated: {
      materialLinearMassKgm: Number(qm.toFixed(1)),
      totalLinearMassKgm: Number(qTotal.toFixed(1)),
      catenarySagPercent: Number(sagPercent.toFixed(2)),
      sagMeters: Number(sagMeters.toFixed(3)),
      mechanicalPowerKw: Number(mechanicalPowerKw.toFixed(1)),
      isRegenerative: mechanicalPowerKw < 0,
      effectiveDriveForceKn: Number((effectiveDriveForceN / 1000).toFixed(2)),
      lateralDriftMm: Number(lateralDriftMm.toFixed(2)),
      capstanSafetyMargin: Number(capstanSafetyMargin.toFixed(2)),
      calculatedSlipPct
    },
    syntheticReading,
    risk: {
      score: riskResult.score,
      level: riskResult.level,
      primaryCause: riskResult.primaryCause,
      channelScores: riskResult.channelScores
    },
    ml: {
      hazardProbability: mlResult.probability,
      prediction: mlResult.models?.['Random Forest']?.prediction || 'NOMINAL',
      topFactor: mlResult.topFactor,
      contributions: mlResult.contributions
    },
    violations,
    governingEquations: [
      { name: 'Linear Material Mass', eq: 'q_m = Q / (3.6 · v) [kg/m]' },
      { name: 'Catenary Sag', eq: 'S = (q_total · g · a_0²) / (8 · T) [%]' },
      { name: 'Overland Gradient & Friction', eq: 'F_U = F_R + q_total · g · L · sin(θ) [N]' },
      { name: 'Mechanical Drive Power', eq: 'P = (F_U · v) / 1000 [kW]' },
      { name: 'Capstan Friction Limit', eq: 'T1 / T2 ≤ e^(μ · θ_wrap) [Euler]' }
    ],
    transparencyNote:
      'Parameter-driven engineering approximation based on CEMA 7th Edition and ISO 5048. Intended for supervisory scenario comparison and planning; not certified for physical machinery emergency controls.'
  };
}

/**
 * Compares a baseline scenario against a modified operating scenario.
 */
function compareScenarios(baselineParams, modifiedParams, zoneRef = null) {
  const base = solveConveyorPhysics(baselineParams, zoneRef);
  const mod = solveConveyorPhysics(modifiedParams, zoneRef);

  const deltas = {
    beltSpeedDelta: Number((mod.inputs.beltSpeedMs - base.inputs.beltSpeedMs).toFixed(2)),
    materialLoadDelta: Number((mod.inputs.materialLoadTph - base.inputs.materialLoadTph).toFixed(0)),
    lateralDriftDeltaMm: Number((mod.calculated.lateralDriftMm - base.calculated.lateralDriftMm).toFixed(2)),
    catenarySagDeltaPct: Number((mod.calculated.catenarySagPercent - base.calculated.catenarySagPercent).toFixed(2)),
    powerDeltaKw: Number((mod.calculated.mechanicalPowerKw - base.calculated.mechanicalPowerKw).toFixed(1)),
    riskScoreDelta: mod.risk.score - base.risk.score,
    mlHazardDelta: Number((mod.ml.hazardProbability - base.ml.hazardProbability).toFixed(3))
  };

  return {
    baseline: base,
    modified: mod,
    deltas,
    evaluatedAt: new Date().toISOString()
  };
}

module.exports = {
  PARAM_BOUNDS,
  FAULT_CONDITIONS,
  validateAndSanitizeParams,
  solveConveyorPhysics,
  compareScenarios
};
