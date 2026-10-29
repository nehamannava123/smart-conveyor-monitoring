/**
 * Export a deterministic, labeled synthetic conveyor dataset for development,
 * model experimentation, and reproducibility. This is NOT field telemetry.
 * Usage: node server/scripts/generateDataset.js [rowCount] [seed]
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRng, sampleSyntheticSample, FEATURES } = require('./trainModels');

const rowCountArg = Number(process.argv[2] || process.env.DATASET_ROWS || 25000);
const seedArg = Number(process.argv[3] || process.env.DATASET_SEED || 42);
if (!Number.isInteger(rowCountArg) || rowCountArg < 100 || rowCountArg > 250000) {
  throw new Error('Row count must be an integer between 100 and 250000.');
}
if (!Number.isInteger(seedArg) || seedArg < 0) throw new Error('Seed must be a non-negative integer.');

const rng = createRng(seedArg);
const zones = ['zone-a', 'zone-b', 'zone-c', 'zone-d', 'zone-e'];
const headers = [
  'sample_id','synthetic_timestamp','zone_id',
  'alignment_mm','vibration_rms_mm_s','drive_slip_pct','belt_tension_pct','material_load_pct','motor_temperature_c','incline_deg','curve_severity',
  ...FEATURES,
  'fault_class','is_anomaly','hazard_event_within_10m','recommended_partition'
];
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const outDir = path.join(__dirname, '..', '..', 'data', 'datasets');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `conveyor_synthetic_${rowCountArg}_seed${seedArg}.csv`);
const stream = fs.createWriteStream(outPath, { encoding: 'utf8' });
stream.write(headers.join(',') + '\n');
const counts = { faultClass: {}, hazardPositive: 0, anomalyPositive: 0 };
const start = Date.UTC(2025, 0, 1, 0, 0, 0);
const intervalMs = 2000; // synthetic 0.5 Hz sample interval; timestamps are simulated
for (let i = 0; i < rowCountArg; i++) {
  const sample = sampleSyntheticSample(rng);
  const r = sample.sensors;
  const f = sample.features;
  const row = [
    `SYN-${String(i + 1).padStart(7, '0')}`,
    new Date(start + i * intervalMs).toISOString(),
    zones[i % zones.length],
    r.alignmentMm, r.vibrationMms, r.slipPct, r.tensionPct, r.loadPct, r.tempC, r.inclineDeg, r.curveSeverity,
    ...FEATURES.map(k => Number(f[k].toFixed(5))),
    sample.faultClass, sample.isAnomaly, sample.hazardLabel, i < Math.floor(rowCountArg * 0.8) ? 'TRAIN_CANDIDATE' : i < rowCountArg ? 'HELDOUT_CANDIDATE' : 'EXTRA_SYNTHETIC'
  ];
  stream.write(row.map(csvCell).join(',') + '\n');
  counts.faultClass[sample.faultClass] = (counts.faultClass[sample.faultClass] || 0) + 1;
  counts.hazardPositive += sample.hazardLabel;
  counts.anomalyPositive += sample.isAnomaly;
}
stream.end();
stream.on('finish', () => {
  const metadata = {
    datasetName: path.basename(outPath),
    rows: rowCountArg,
    seed: seedArg,
    generatedAt: new Date().toISOString(),
    provenance: 'SYNTHETIC_SIMULATION',
    fieldValidated: false,
    samplingIntervalMs: intervalMs,
    samplingNote: 'Timestamps and zone assignments are simulated for development. Rows are independently generated scenarios, not a physically continuous plant recording.',
    labelDefinitions: {
      fault_class: 'Synthetic fault mode assigned by the scenario generator.',
      is_anomaly: '1 for any generated non-NORMAL fault scenario; 0 for NORMAL.',
      hazard_event_within_10m: 'Rule-generated binary label from a synthetic compound hazard score with bounded noise; not an observed real-world event.'
    },
    columns: headers,
    classDistribution: counts.faultClass,
    hazardPositiveCount: counts.hazardPositive,
    anomalyPositiveCount: counts.anomalyPositive,
    limitations: [
      'Not real sensor telemetry and not field validated.',
      'Labels are generated from the same simulation rules used to produce the sensor patterns; model metrics can overstate real-world generalization.',
      'Do not use as the sole basis for safety decisions or production model acceptance.'
    ]
  };
  fs.writeFileSync(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'README.md'), `# HillGuard synthetic conveyor dataset\n\n- **File:** \`${path.basename(outPath)}\`\n- **Rows:** ${rowCountArg.toLocaleString()}\n- **Seed:** ${seedArg}\n- **Provenance:** synthetic simulation only; not field validated.\n- **Regenerate:** \`npm run dataset:generate -- ${rowCountArg} ${seedArg}\`\n\nThe CSV contains raw synthetic sensor channels, derived ML features, a generated fault class, anomaly flag, and a synthetic 10-minute hazard label. The timestamps are simulated at a 2-second interval, but each row is generated independently and should not be interpreted as continuous real-world time-series data. Labels are rule-generated from the synthetic scenario, so held-out metrics measure agreement with these simulation rules rather than proven field performance.\n`);
  console.log(`Generated ${rowCountArg} synthetic rows at ${outPath}`);
  console.log(`Fault classes: ${JSON.stringify(counts.faultClass)}`);
  console.log(`Hazard-positive: ${counts.hazardPositive}; anomaly-positive: ${counts.anomalyPositive}`);
});
