/**
 * Simulates the IoT sensor layer that would sit physically on the conveyor:
 *   - Belt alignment sensor (mm deviation from center, +/- either side)
 *   - Vibration sensor (mm/s RMS)
 *   - Belt tension sensor (% of rated tension)
 *   - Motor/drive slip sensor (% slip between motor and belt speed)
 *   - Material load sensor (% of rated capacity)
 *   - Motor temperature (deg C)
 *
 * Values evolve over time (random walk) around terrain-driven baselines, and
 * a fault-injection system periodically simulates real dislodgement
 * precursors so the risk engine / automation / dashboard have something
 * meaningful to react to - mirroring real hilly-terrain failure patterns
 * (mistracking on curves, slip on steep grade, tension loss, resonance).
 */
const db = require('../config/db');

// Per-zone running sensor state, kept in memory between ticks (random walk)
const state = new Map();

function initState(zone) {
  state.set(zone.id, {
    alignment: 0, // mm, 0 = perfectly centered
    vibration: 2 + Math.random(), // mm/s baseline
    tensionPct: 95 + Math.random() * 5,
    slipPct: 0.5 + Math.random(),
    loadPct: 50 + Math.random() * 20,
    tempC: 45 + Math.random() * 5,
    faultTicksRemaining: 0,
    faultType: null
  });
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function maybeInjectFault(zone, s) {
  if (s.faultTicksRemaining > 0) return; // fault already active
  // Base probability per tick, scaled by terrain risk factors.
  const inclineFactor = Math.abs(zone.inclineDeg) / 25; // steeper -> more likely
  const curveFactor = zone.curveSeverity;
  const pFault = 0.05 + 0.05 * inclineFactor + 0.05 * curveFactor;
  if (Math.random() < pFault) {
    s.faultType = zone.dominantRisk;
    s.faultTicksRemaining = 6 + Math.floor(Math.random() * 8); // lasts 6-14 ticks
  }
}

function applyFaultDynamics(zone, s) {
  if (s.faultTicksRemaining <= 0) return;
  switch (s.faultType) {
    case 'MISTRACKING':
      s.alignment += (Math.random() - 0.1) * 14 * (1 + zone.curveSeverity);
      s.vibration += Math.random() * 1.1;
      break;
    case 'SLIPPAGE':
      s.slipPct += Math.random() * 6;
      s.tempC += Math.random() * 2;
      s.tensionPct -= Math.random() * 2.6;
      break;
    case 'TENSION_LOSS':
      s.tensionPct -= Math.random() * 5.5;
      s.alignment += (Math.random() - 0.5) * 5;
      break;
    case 'STRUCTURE_VIBRATION':
      s.vibration += Math.random() * 3.8;
      s.alignment += (Math.random() - 0.5) * 3.5;
      break;
    case 'MATERIAL_IMBALANCE':
      s.loadPct += (Math.random() - 0.3) * 24;
      s.alignment += (Math.random() - 0.4) * 6;
      break;
    default:
      break;
  }
  s.faultTicksRemaining -= 1;
  if (s.faultTicksRemaining === 0) s.faultType = null;
}

function driftBackToBaseline(s) {
  // gentle pull back toward normal operating range (self-correcting systems,
  // e.g. auto take-up units, self-training idlers) so faults don't run away
  // forever unless repeatedly re-triggered
  s.alignment += (0 - s.alignment) * 0.12 + (Math.random() - 0.5) * 1.2;
  s.vibration += (2.5 - s.vibration) * 0.15 + (Math.random() - 0.5) * 0.4;
  s.tensionPct += (97 - s.tensionPct) * 0.1 + (Math.random() - 0.5) * 0.8;
  s.slipPct += (0.8 - s.slipPct) * 0.2 + (Math.random() - 0.5) * 0.3;
  s.loadPct += (60 - s.loadPct) * 0.08 + (Math.random() - 0.5) * 3;
  s.tempC += (48 - s.tempC) * 0.08 + (Math.random() - 0.5) * 0.6;

  s.alignment = clamp(s.alignment, -60, 60);
  s.vibration = clamp(s.vibration, 0.5, 20);
  s.tensionPct = clamp(s.tensionPct, 40, 105);
  s.slipPct = clamp(s.slipPct, 0, 25);
  s.loadPct = clamp(s.loadPct, 0, 130);
  s.tempC = clamp(s.tempC, 25, 110);
}

function resetZone(zoneId) {
  state.delete(zoneId);
}

function tickZone(zone) {
  if (!state.has(zone.id)) initState(zone);
  const s = state.get(zone.id);

  if (zone.status === 'RUNNING') {
    maybeInjectFault(zone, s);
    applyFaultDynamics(zone, s);
    // While a fault is actively developing, the belt shouldn't self-correct
    // back to baseline in real time — that's what makes it a fault. Only
    // apply the gentle self-correction once the fault episode has cleared.
    if (!s.faultType) driftBackToBaseline(s);
  } else {
    // stopped conveyor: vibration/slip settle to near-zero, alignment holds
    s.vibration = clamp(s.vibration * 0.7, 0, 20);
    s.slipPct = clamp(s.slipPct * 0.5, 0, 25);
    s.tempC += (30 - s.tempC) * 0.1;
  }

  const reading = {
    ts: Date.now(),
    zoneId: zone.id,
    alignmentMm: Number(s.alignment.toFixed(2)),
    vibrationMms: Number(s.vibration.toFixed(2)),
    tensionPct: Number(s.tensionPct.toFixed(1)),
    slipPct: Number(s.slipPct.toFixed(2)),
    loadPct: Number(s.loadPct.toFixed(1)),
    tempC: Number(s.tempC.toFixed(1)),
    speedMps: zone.status === 'RUNNING' ? zone.baseSpeedMps : 0,
    activeFault: s.faultType
  };

  // Persist a point-in-time risk snapshot alongside telemetry so history and
  // event replay never recompute old readings using future data.
  try {
    const { computeRisk } = require('./riskEngine');
    const risk = computeRisk(zone, reading);
    reading.riskSnapshot = { score: risk.score, level: risk.level, primaryCause: risk.primaryCause, primaryCauseKey: risk.primaryCauseKey, contributors: risk.contributors, evaluatedAt: risk.evaluatedAt };
  } catch (err) {
    reading.riskSnapshot = null;
  }
  db.addReading(zone.id, reading);
  return reading;
}

function tickAll() {
  const zones = db.getZones();
  return zones.map((z) => ({ zone: z, reading: tickZone(z) }));
}

module.exports = { tickAll, tickZone, resetZone };
