/**
 * HillGuard ML Inference & Diagnostics Engine
 * ===========================================
 * Loads pre-trained versioned model artifacts from disk (data/models/model-artifact.json)
 * instead of expensive startup retraining.
 *
 * Implements:
 *   - Identical causal feature extraction between training and inference.
 *   - Data quality checks (missing/stale sensor detection).
 *   - Distinct prediction tasks:
 *       1. 10m Hazard Forecasting (Logistic, Sparse L1, Decision Tree, Random Forest,
 *          Gradient Boosting, Ensemble, Physics-Informed Hybrid)
 *       2. Unsupervised Anomaly Detection (Isolation Forest, Neural Autoencoder)
 *       3. Multi-class Fault Classification (Diagnostic Attribution)
 *   - Directional feature influence & per-sensor reconstruction attribution.
 *   - Transparent reporting of synthetic training provenance vs. real-world limitations.
 */

const fs = require('fs');
const path = require('path');
const {
  FEATURES,
  predictLogistic,
  predictTree,
  predictRandomForest,
  predictGradientBoosting,
  predictIsolationForest,
  predictAutoencoder,
  predictPhysicsInformed,
  extractCemaPhysicsFeatures,
  trainAndExportArtifact
} = require('../scripts/trainModels');

const ARTIFACT_PATH = path.join(__dirname, '..', '..', 'data', 'models', 'model-artifact.json');

const SUPERVISED_MODEL_NAMES = [
  'Logistic Regression',
  'Sparse Regression (L1)',
  'Decision Tree',
  'Random Forest',
  'Gradient Boosting',
  'Physics-Informed Hybrid'
];

const ANOMALY_MODEL_NAMES = [
  'Isolation Forest',
  'Neural Autoencoder'
];

const ALL_MODEL_NAMES = [
  'Logistic Regression',
  'Sparse Regression (L1)',
  'Decision Tree',
  'Random Forest',
  'Gradient Boosting',
  'Ensemble',
  'Physics-Informed Hybrid',
  'Isolation Forest',
  'Neural Autoencoder'
];

function extractFeatures(zone, reading) {
  if (!reading) return null;
  return {
    alignmentAbs: Math.abs(reading.alignmentMm ?? 0),
    vibrationMms: Math.max(0, reading.vibrationMms ?? 0),
    slipPct: Math.max(0, reading.slipPct ?? 0),
    tensionDeficit: Math.max(0, 90 - (reading.tensionPct ?? 90)),
    loadExcess: Math.max(0, (reading.loadPct ?? 50) - 90),
    tempExcess: Math.max(0, (reading.tempC ?? 45) - 65),
    inclineAbsDeg: Math.abs(zone?.inclineDeg ?? 0),
    curveSeverity: (zone?.curveSeverity ?? 0) * 100
  };
}

function vectorize(featureObj) {
  return FEATURES.map((f) => featureObj[f]);
}

class PredictiveModelSuite {
  constructor() {
    this.ready = false;
    this.artifact = null;
    this.metrics = {};
    this.baselines = {};
    this.scaler = null;
    this.loadArtifact();
  }

  loadArtifact(artifactPath = ARTIFACT_PATH) {
    try {
      if (!fs.existsSync(artifactPath)) {
        console.warn(`[ML] Model artifact not found at ${artifactPath}. Bootstrapping default artifact...`);
        this.artifact = trainAndExportArtifact(artifactPath);
      } else {
        const raw = fs.readFileSync(artifactPath, 'utf8');
        this.artifact = JSON.parse(raw);
      }

      if (!this.artifact.schemaVersion || !this.artifact.models) {
        throw new Error('Incompatible or invalid model artifact schema.');
      }

      this.scaler = this.artifact.scaler;
      this.metrics = this.artifact.evaluationMetrics || {};
      this.baselines = this.artifact.baselines || {};
      this.ready = true;
      console.log(`[ML] Loaded model artifact v${this.artifact.schemaVersion} (${this.artifact.modelType || 'MultiModelHazardSuite'}) trained on ${this.artifact.trainingProvenance?.sampleCount || 'N/A'} synthetic events.`);
    } catch (err) {
      this.ready = false;
      this.artifact = null;
      console.error('[ML] Failed to load model artifact:', err.message);
    }
  }

  train() {
    if (!this.ready) {
      this.loadArtifact();
    }
  }

  _standardize(raw) {
    if (!this.scaler) return raw;
    return raw.map((v, j) => (v - this.scaler.mean[j]) / (this.scaler.std[j] || 1));
  }

  checkDataQuality(reading) {
    const warnings = [];
    if (!reading) {
      return { ok: false, warnings: ['Missing telemetry reading'] };
    }
    const requiredKeys = ['alignmentMm', 'vibrationMms', 'tensionPct', 'slipPct', 'loadPct', 'tempC'];
    for (const k of requiredKeys) {
      if (reading[k] === undefined || reading[k] === null || Number.isNaN(reading[k])) {
        warnings.push(`Sensor channel "${k}" is missing or NaN`);
      }
    }
    if (reading.ts && Date.now() - reading.ts > 60000) {
      warnings.push(`Sensor readings are stale (${Math.round((Date.now() - reading.ts) / 1000)}s old)`);
    }
    if (Math.abs(reading.alignmentMm) > 120) warnings.push('Alignment reading outside physical sensor range');
    if (reading.vibrationMms > 40) warnings.push('Vibration reading outside physical sensor range');
    if (reading.slipPct < 0 || reading.slipPct > 50) warnings.push('Slip reading outside physical range');

    return {
      ok: warnings.length === 0,
      warnings
    };
  }

  predict(zone, reading) {
    if (!this.ready || !this.artifact) {
      return {
        ready: false,
        status: 'MODEL_UNAVAILABLE',
        probability: 0,
        models: {},
        dataQuality: { ok: false, warnings: ['Model artifact is not loaded'] },
        notice: 'ML inference unavailable; relying on deterministic rule engine.'
      };
    }

    const quality = this.checkDataQuality(reading);
    if (!quality.ok) {
      return {
        ready: true,
        status: 'UNRELIABLE_INPUT',
        probability: 0,
        models: {},
        dataQuality: quality,
        notice: 'Input sensor data is missing, stale, or out-of-range. Prediction suppressed.'
      };
    }

    const f = extractFeatures(zone, reading);
    const raw = vectorize(f);
    const xs = this._standardize(raw);

    const weights = this.artifact.models.logistic?.weights || new Array(raw.length).fill(0);
    const contributions = FEATURES.map((name, j) => ({
      feature: name,
      influence: Number((xs[j] * weights[j]).toFixed(3)),
      featureValue: Number(raw[j].toFixed(2))
    })).sort((a, b) => Math.abs(b.influence) - Math.abs(a.influence));

    // Supervised Model Probabilities
    const piResult = this.artifact.models.physicsInformed
      ? predictPhysicsInformed(this.artifact.models.physicsInformed, xs, f)
      : { probability: 0, esi: 0, physicalConstraintStatus: 'COMPLIANT' };

    const probabilities = {
      'Logistic Regression': predictLogistic(this.artifact.models.logistic, xs),
      'Sparse Regression (L1)': predictLogistic(this.artifact.models.sparseLogistic, xs),
      'Decision Tree': predictTree(this.artifact.models.decisionTree, xs),
      'Random Forest': predictRandomForest(this.artifact.models.randomForest, xs),
      'Gradient Boosting': predictGradientBoosting(this.artifact.models.gradientBoosting, xs),
      'Physics-Informed Hybrid': piResult.probability
    };

    // 5-model baseline ensemble average
    const baseline5 = [
      'Logistic Regression',
      'Sparse Regression (L1)',
      'Decision Tree',
      'Random Forest',
      'Gradient Boosting'
    ];
    const ensembleProb = baseline5.reduce((s, k) => s + (probabilities[k] || 0), 0) / baseline5.length;

    // Unsupervised Anomaly Detection
    const ifScore = this.artifact.models.isolationForest
      ? predictIsolationForest(this.artifact.models.isolationForest, xs)
      : 0.5;
    const ifThreshold = this.artifact.models.isolationForest?.threshold || 0.515;
    const ifIsAnomaly = ifScore >= ifThreshold;

    const aeResult = this.artifact.models.autoencoder
      ? predictAutoencoder(this.artifact.models.autoencoder, xs)
      : { mse: 0, anomalyScore: 0, isAnomaly: false, residuals: [] };

    const models = {};
    for (const name of SUPERVISED_MODEL_NAMES) {
      const prob = probabilities[name] ?? 0;
      models[name] = {
        type: name === 'Physics-Informed Hybrid' ? 'physics_hybrid' : 'binary_classifier',
        probability: Number(prob.toFixed(3)),
        prediction: prob >= 0.5 ? 'HIGH HAZARD' : 'NOMINAL',
        accuracyPct: this.metrics[name]?.accuracy ?? null,
        f1Score: this.metrics[name]?.f1 ?? null,
        rocAuc: this.metrics[name]?.rocAuc ?? null,
        physicalConstraintStatus: name === 'Physics-Informed Hybrid' ? piResult.physicalConstraintStatus : undefined,
        cemaStressIndex: name === 'Physics-Informed Hybrid' ? piResult.esi : undefined
      };
    }

    models['Ensemble'] = {
      type: 'ensemble_voter',
      probability: Number(ensembleProb.toFixed(3)),
      prediction: ensembleProb >= 0.5 ? 'HIGH HAZARD' : 'NOMINAL',
      accuracyPct: this.metrics['Ensemble']?.accuracy ?? null,
      f1Score: this.metrics['Ensemble']?.f1 ?? null,
      rocAuc: this.metrics['Ensemble']?.rocAuc ?? null
    };

    models['Isolation Forest'] = {
      type: 'anomaly_detector',
      anomalyScore: Number(ifScore.toFixed(3)),
      probability: Number(ifScore.toFixed(3)),
      prediction: ifIsAnomaly ? 'ANOMALOUS' : 'NOMINAL',
      threshold: ifThreshold,
      accuracyPct: this.metrics['Isolation Forest']?.accuracy ?? null,
      f1Score: this.metrics['Isolation Forest']?.f1 ?? null,
      rocAuc: this.metrics['Isolation Forest']?.rocAuc ?? null
    };

    models['Neural Autoencoder'] = {
      type: 'autoencoder_reconstruction',
      anomalyScore: Number(aeResult.anomalyScore.toFixed(3)),
      probability: Number(aeResult.anomalyScore.toFixed(3)),
      prediction: aeResult.isAnomaly ? 'ANOMALOUS' : 'NOMINAL',
      reconstructionMse: aeResult.mse,
      threshold: aeResult.threshold,
      residuals: aeResult.residuals,
      accuracyPct: this.metrics['Neural Autoencoder']?.accuracy ?? null,
      f1Score: this.metrics['Neural Autoencoder']?.f1 ?? null,
      rocAuc: this.metrics['Neural Autoencoder']?.rocAuc ?? null
    };

    // Task C: Fault Classification
    let classifiedFault = 'NORMAL';
    if (f.alignmentAbs > 18) classifiedFault = 'MISTRACKING';
    else if (f.slipPct > 3.5) classifiedFault = 'SLIPPAGE';
    else if (f.vibrationMms > 6) classifiedFault = 'STRUCTURE_VIBRATION';
    else if (f.tensionDeficit > 15) classifiedFault = 'TENSION_LOSS';
    else if (f.tempExcess > 15) classifiedFault = 'MOTOR_OVERHEAT';
    else if (f.loadExcess > 15) classifiedFault = 'MATERIAL_IMBALANCE';

    return {
      ready: true,
      status: 'VALID',
      task: 'Dislodgement Hazard Forecasting (~10 min horizon)',
      probability: Number(ensembleProb.toFixed(3)),
      ensembleProbability: Number(ensembleProb.toFixed(3)),
      topFactor: contributions[0]?.feature || null,
      contributions: contributions.slice(0, 4),
      models,
      tasks: {
        hazardForecasting10m: {
          ensembleProbability: Number(ensembleProb.toFixed(3)),
          status: ensembleProb >= 0.5 ? 'HIGH HAZARD' : 'NOMINAL'
        },
        anomalyDetection: {
          isAnomaly: ifIsAnomaly || aeResult.isAnomaly,
          isolationScore: Number(ifScore.toFixed(3)),
          autoencoderMse: aeResult.mse,
          status: (ifIsAnomaly || aeResult.isAnomaly) ? 'ANOMALY DETECTED' : 'NOMINAL'
        },
        faultClassification: {
          mode: classifiedFault
        }
      },
      classifiedFault,
      dataQuality: quality,
      syntheticNotice: 'Trained on synthetic physics-model sensor perturbations; evaluate against empirical maintenance logs before physical control integration.'
    };
  }

  getMetrics() {
    return {
      ready: this.ready,
      schemaVersion: this.artifact?.schemaVersion || '3.0.0',
      task: this.artifact?.modelType || 'MultiModelHazardAndAnomalySuite',
      horizonMinutes: 10,
      modelCount: ALL_MODEL_NAMES.length,
      models: this.metrics,
      baselines: this.baselines,
      tasks: this.artifact?.tasks || {
        hazardForecasting10m: SUPERVISED_MODEL_NAMES.concat(['Ensemble']),
        anomalyDetection: ANOMALY_MODEL_NAMES,
        faultClassification: ['Decision Tree', 'Deterministic Attributor']
      },
      candidateEvaluationReport: this.artifact?.candidateEvaluationReport || null,
      ensembleDefinition: this.artifact?.ensembleDefinition || {
        method: 'unweighted_average',
        constituents: [
          'Logistic Regression',
          'Sparse Regression (L1)',
          'Decision Tree',
          'Random Forest',
          'Gradient Boosting'
        ]
      },
      trainingProvenance: this.artifact?.trainingProvenance || {
        type: 'SYNTHETIC_DATASET',
        isFieldValidated: false,
        sampleCount: 5000,
        split: '80% train / 20% held-out test'
      },
      rulDisclaimer: 'Remaining Useful Life (RUL) estimation is a future capability requiring empirical run-to-failure degradation curves. Current predictions reflect 10-minute hazard probability, not asset remaining life.'
    };
  }
}

const model = new PredictiveModelSuite();

module.exports = {
  model,
  FEATURES,
  extractFeatures,
  MODEL_NAMES: ALL_MODEL_NAMES,
  SUPERVISED_MODEL_NAMES,
  ANOMALY_MODEL_NAMES
};
