/**
 * Static definition of the conveyor route across hilly terrain, broken into
 * monitored zones. Each zone has terrain characteristics that make certain
 * dislodgement failure modes more likely - this is what the simulator and
 * risk engine use to produce realistic behaviour.
 *
 * Real-world dislodgement causes modeled here:
 *  - MISTRACKING: belt drifts sideways off idlers, worse on curves/incline transitions
 *  - SLIPPAGE: belt slips on drive pulley, worse on steep inclines under high load
 *  - TENSION_LOSS: take-up/tensioning system can't compensate on long steep runs
 *  - STRUCTURE_VIBRATION: uneven hill terrain + poor idler alignment -> resonance
 *  - MATERIAL_IMBALANCE: uneven loading on inclines shifts belt off-center
 */
const ZONES = [
  {
    id: 'zone-a',
    name: 'Zone A - Foothill Approach',
    description: 'Gentle rising grade at the base of the hill, transition from flat yard.',
    inclineDeg: 8,
    curveSeverity: 0.15, // 0 = straight, 1 = sharp curve
    lengthM: 320,
    baseSpeedMps: 3.2,
    idlerSpacingM: 1.2,
    dominantRisk: 'MATERIAL_IMBALANCE'
  },
  {
    id: 'zone-b',
    name: 'Zone B - Steep Climb',
    description: 'Sustained 22 degree incline, the most demanding section for belt tension and slip.',
    inclineDeg: 22,
    curveSeverity: 0.05,
    lengthM: 480,
    baseSpeedMps: 2.6,
    idlerSpacingM: 1.0,
    dominantRisk: 'SLIPPAGE'
  },
  {
    id: 'zone-c',
    name: 'Zone C - Switchback Curve',
    description: 'Horizontal curve carved around a rock outcrop, high mistracking risk.',
    inclineDeg: 12,
    curveSeverity: 0.75,
    lengthM: 210,
    baseSpeedMps: 2.8,
    idlerSpacingM: 0.9,
    dominantRisk: 'MISTRACKING'
  },
  {
    id: 'zone-d',
    name: 'Zone D - Ridge Descent',
    description: 'Downhill run along an exposed ridge, wind and vibration heavy.',
    inclineDeg: -15,
    curveSeverity: 0.2,
    lengthM: 390,
    baseSpeedMps: 3.4,
    idlerSpacingM: 1.1,
    dominantRisk: 'STRUCTURE_VIBRATION'
  },
  {
    id: 'zone-e',
    name: 'Zone E - Valley Discharge',
    description: 'Final gentle descent into the discharge hopper.',
    inclineDeg: -6,
    curveSeverity: 0.1,
    lengthM: 260,
    baseSpeedMps: 3.0,
    idlerSpacingM: 1.2,
    dominantRisk: 'TENSION_LOSS'
  }
];

function buildInitialZoneState() {
  return ZONES.map((z) => ({
    ...z,
    status: 'RUNNING', // RUNNING | STOPPED | AUTO_STOPPED
    riskScore: 5,
    riskLevel: 'NORMAL',
    lastAction: null,
    lastActionBy: null,
    lastActionAt: null,
    consecutiveCritical: 0,
    faultInjected: null // active simulated fault, if any
  }));
}

module.exports = { ZONES, buildInitialZoneState };
