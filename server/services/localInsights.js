/**
 * Local Insight Generator
 * ---------------------------------------------------------------------
 * Produces the same kind of plain-English diagnosis and recommended
 * actions a "Run AI analysis" button would show - but composed entirely
 * from local data (the rule-based risk engine, the trained ML model, and
 * the computer-vision metrics) using templated natural-language
 * generation. Zero network calls, zero API key, works fully offline.
 *
 * This keeps the same feature (readable diagnosis + recommendations in
 * the dashboard) while keeping the whole project dependency-free beyond
 * npm packages already bundled.
 */

const CAUSE_EXPLANATIONS = {
  'Belt mistracking': {
    explanation: 'the belt centerline is drifting away from its normal running line, the classic precursor to a belt walking off its idlers and derailing.',
    actions: [
      'Inspect self-training/troughing idlers in this zone for wear or seizure',
      'Check belt edge guides and training frames for correct alignment',
      'Verify the belt splice is square and not inducing a lateral pull'
    ]
  },
  'Drive slippage': {
    explanation: 'the belt is slipping against the drive pulley, which reduces effective tension and accelerates surface wear - especially dangerous on steep inclined sections.',
    actions: [
      'Check and increase belt tension via the take-up system',
      'Inspect drive pulley lagging for wear or contamination (oil/water/fines)',
      'Reduce feed rate temporarily to lower the load on the drive'
    ]
  },
  'Tension loss': {
    explanation: 'belt tension has dropped below the level needed to keep the belt properly seated on idlers over this run, particularly on longer inclined spans.',
    actions: [
      'Inspect the take-up/tensioning unit for correct counterweight or winch tension',
      'Check for belt stretch or splice elongation',
      'Verify tension sensors/limit switches are reporting correctly'
    ]
  },
  'Structural vibration': {
    explanation: 'unusual vibration levels suggest possible idler misalignment, bearing wear, or structural resonance excited by the uneven terrain in this zone.',
    actions: [
      'Inspect idler bearings and rollers for wear, flat spots, or seizure',
      'Check support structure and idler frames for looseness',
      'Look for material buildup on idlers causing imbalance'
    ]
  },
  'Material imbalance': {
    explanation: 'uneven material loading is shifting weight to one side of the belt, which is more likely to induce mistracking on inclined sections.',
    actions: [
      'Check the loading chute/skirt for uneven feed distribution',
      'Inspect for material spillage or buildup on one side of the belt',
      'Verify chute liners and deflectors are correctly positioned'
    ]
  },
  'Motor overheating': {
    explanation: 'elevated motor temperature usually points to sustained overload or slip, and can indicate developing mechanical resistance in the drive train.',
    actions: [
      'Check for excessive load or a jammed/obstructed conveyor point',
      'Inspect motor cooling and ventilation',
      'Verify drive alignment and coupling condition'
    ]
  }
};

function urgencyLine(level) {
  if (level === 'CRITICAL') return 'This needs attention now - do not leave this zone unattended at this risk level.';
  if (level === 'WARNING') return 'This should be checked this shift; it does not yet require an immediate stop.';
  return 'No immediate action required; continue routine monitoring.';
}

function generateZoneInsight({ zone, risk, reading, mlPrediction }) {
  const causeInfo = CAUSE_EXPLANATIONS[risk.primaryCause] || {
    explanation: 'sensor readings are within a range that warrants attention.',
    actions: ['Perform a visual inspection of this zone', 'Review recent sensor trends for this zone']
  };

  let mlLine = '';
  if (mlPrediction && mlPrediction.ready) {
    if (mlPrediction.status === 'UNRELIABLE_INPUT') {
      mlLine = `ML Note: Sensor telemetry is flagged as degraded or out-of-range; prediction suppressed.`;
    } else {
      mlLine = `The trained ML model independently estimates a ${Math.round(mlPrediction.probability * 100)}% probability of a dislodgement event in roughly the next 10 minutes for this zone, with "${(mlPrediction.topFactor || '').replace(/([A-Z])/g, ' $1').toLowerCase()}" as its top contributing factor.`;
    }
  }

  const lines = [
    `${zone.name} is currently ${zone.status.replace('_', ' ').toLowerCase()}. Rule-based risk score: ${risk.score}/100 (${risk.level}).`,
    mlLine,
    `Diagnosis: the leading indicator is ${risk.primaryCause.toLowerCase()} — ${causeInfo.explanation}`,
    `Recommended actions: ${causeInfo.actions.slice(0, 3).join('; ')}.`,
    urgencyLine(risk.level)
  ].filter(Boolean);

  return {
    text: lines.join(' '),
    source: 'local-rule-engine',
    generatedAt: new Date().toISOString()
  };
}

function generateVideoInsight(cvResult) {
  const worst = cvResult.perFrame.reduce((a, b) => (b.score > a.score ? b : a), cvResult.perFrame[0]);
  const avgVibration = cvResult.perFrame.reduce((sum, f) => sum + f.vibration, 0) / cvResult.perFrame.length;

  const lines = [
    `Across ${cvResult.frameCount} analyzed frames, the belt's tracked centerline reached a peak lateral drift of ${worst.driftPct}% of frame width at frame #${worst.frameIndex}, with an average vibration proxy of ${avgVibration.toFixed(1)}.`,
    `Overall visual risk score: ${cvResult.overallScore}/100 (${cvResult.overallLevel}), peaking at ${cvResult.peakScore}/100.`
  ];

  if (cvResult.overallLevel === 'CRITICAL' || worst.driftPct > 9) {
    lines.push('This drift pattern is consistent with visible belt mistracking. Inspect training idlers and edge guides near the section shown in the flagged frame, and verify the troughing angle is correct.');
  } else if (cvResult.overallLevel === 'WARNING') {
    lines.push('Drift is elevated but not yet severe — worth a closer physical inspection of belt alignment in this section on the next pass.');
  } else {
    lines.push('Drift and vibration stayed within a normal range for this clip; no mistracking is visually apparent.');
  }

  if (avgVibration > 10) {
    lines.push('The elevated frame-to-frame vibration across the clip may also indicate loose or worn idlers, or structural resonance — worth checking independently of the alignment finding.');
  }

  lines.push(urgencyLine(cvResult.overallLevel));

  return {
    text: lines.join(' '),
    source: 'local-computer-vision',
    generatedAt: new Date().toISOString()
  };
}

module.exports = { generateZoneInsight, generateVideoInsight };
