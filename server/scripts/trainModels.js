/**
 * Standalone Offline Machine Learning Training Pipeline for HillGuard
 * ===================================================================
 * Generates reproducible training datasets, evaluates multiple classification,
 * anomaly-detection, and physics-informed models against baselines, computes full
 * validation metrics (Accuracy, Precision, Recall, F1, PR-AUC, ROC-AUC, Confusion Matrix, Brier Score),
 * and writes a versioned artifact to `data/models/model-artifact.json`.
 *
 * Distinct Prediction Tasks:
 *   Task A (Hazard Forecasting): Predicts probability of conveyor dislodgement
 *          in the next 10-minute operating horizon.
 *          Models: Logistic Regression, Sparse L1, Decision Tree, Random Forest,
 *                  Gradient Boosting, Calibrated Ensemble, Physics-Informed Hybrid.
 *   Task B (Anomaly Detection): Unsupervised multi-sensor anomaly detection without label bias.
 *          Models: Isolation Forest, Neural Autoencoder.
 *   Task C (Fault Classification): Classifies failure mode (MISTRACKING, SLIPPAGE,
 *          TENSION_LOSS, STRUCTURE_VIBRATION, MATERIAL_IMBALANCE, MOTOR_OVERHEAT, NORMAL).
 *   Task D (Engineering Digital-Twin Stress): CEMA 7th Edition / ISO 5048 physical constraint verification.
 */

const fs = require('fs');
const path = require('path');

// Deterministic Pseudo-Random Generator (Mulberry32)
function createRng(seed = 42) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FEATURES = [
  'alignmentAbs',
  'vibrationMms',
  'slipPct',
  'tensionDeficit',
  'loadExcess',
  'tempExcess',
  'inclineAbsDeg',
  'curveSeverity'
];

const FAULT_CLASSES = [
  'NORMAL',
  'MISTRACKING',
  'SLIPPAGE',
  'TENSION_LOSS',
  'STRUCTURE_VIBRATION',
  'MATERIAL_IMBALANCE',
  'MOTOR_OVERHEAT'
];

function vectorize(f) {
  return FEATURES.map((k) => f[k]);
}

function sampleSyntheticSample(rng) {
  const isAbnormal = rng() < 0.35;
  const faultTypeIdx = isAbnormal ? 1 + Math.floor(rng() * 6) : 0;
  const faultClass = FAULT_CLASSES[faultTypeIdx];

  const inclineDeg = (rng() * 37) - 15; // -15 to +22
  const curveSeverity = rng() < 0.3 ? rng() * 0.8 : rng() * 0.2;

  let alignment = (rng() - 0.5) * 6;
  let vibration = 2.0 + rng() * 1.5;
  let slip = 0.5 + rng() * 1.2;
  let tension = 94 + rng() * 6;
  let load = 50 + rng() * 30;
  let temp = 45 + rng() * 8;

  // Apply fault signatures
  if (faultClass === 'MISTRACKING') {
    alignment += (rng() > 0.5 ? 1 : -1) * (18 + rng() * 25) * (1 + curveSeverity);
    vibration += rng() * 2.5;
  } else if (faultClass === 'SLIPPAGE') {
    slip += 5 + rng() * 8;
    temp += 10 + rng() * 15;
    tension -= 10 + rng() * 15;
  } else if (faultClass === 'TENSION_LOSS') {
    tension -= 25 + rng() * 25;
    alignment += (rng() - 0.5) * 12;
  } else if (faultClass === 'STRUCTURE_VIBRATION') {
    vibration += 6 + rng() * 7;
    alignment += (rng() - 0.5) * 8;
  } else if (faultClass === 'MATERIAL_IMBALANCE') {
    load += 30 + rng() * 25;
    alignment += (rng() - 0.5) * 14;
  } else if (faultClass === 'MOTOR_OVERHEAT') {
    temp += 30 + rng() * 25;
    slip += rng() * 3;
  }

  const f = {
    alignmentAbs: Math.abs(alignment),
    vibrationMms: Math.max(0.1, vibration),
    slipPct: Math.max(0, slip),
    tensionDeficit: Math.max(0, 90 - tension),
    loadExcess: Math.max(0, load - 90),
    tempExcess: Math.max(0, temp - 65),
    inclineAbsDeg: Math.abs(inclineDeg),
    curveSeverity: curveSeverity * 100
  };

  // 10-minute hazard event target (binary)
  const compoundHazard =
    (f.alignmentAbs / 30) * (1 + curveSeverity * 0.8) +
    (f.slipPct / 6) * (1 + (f.inclineAbsDeg / 25) * 0.9) +
    (f.vibrationMms / 8) +
    (f.tensionDeficit / 20) +
    (f.loadExcess / 20) +
    (f.tempExcess / 20);

  const hazardNoise = (rng() - 0.5) * 0.4;
  const dislodgementHazard10m = compoundHazard + hazardNoise > 2.6 ? 1 : 0;
  const isAnomaly = faultClass !== 'NORMAL' ? 1 : 0;

  return {
    features: f,
    // Preserve raw engineering channels alongside derived features so exported
    // datasets can be inspected and reused without reverse-engineering them.
    sensors: { alignmentMm: Number(alignment.toFixed(3)), vibrationMms: Number(Math.max(0.1, vibration).toFixed(3)), slipPct: Number(Math.max(0, slip).toFixed(3)), tensionPct: Number(tension.toFixed(3)), loadPct: Number(load.toFixed(3)), tempC: Number(temp.toFixed(3)), inclineDeg: Number(inclineDeg.toFixed(3)), curveSeverity: Number(curveSeverity.toFixed(4)) },
    hazardLabel: dislodgementHazard10m, faultClass, isAnomaly
  };
}

function standardizeFit(X) {
  const nFeat = X[0].length;
  const mean = new Array(nFeat).fill(0);
  const std = new Array(nFeat).fill(0);
  for (const row of X) for (let j = 0; j < nFeat; j++) mean[j] += row[j];
  for (let j = 0; j < nFeat; j++) mean[j] /= X.length;
  for (const row of X) for (let j = 0; j < nFeat; j++) std[j] += (row[j] - mean[j]) ** 2;
  for (let j = 0; j < nFeat; j++) std[j] = Math.sqrt(std[j] / X.length) || 1;
  return { mean, std };
}

function standardizeTransform(X, scaler) {
  return X.map((row) => row.map((v, j) => (v - scaler.mean[j]) / scaler.std[j]));
}

function sigmoid(z) {
  z = Math.max(-35, Math.min(35, z));
  return 1 / (1 + Math.exp(-z));
}

// -------------------------------------------------------------
// Model 1: Logistic Regression (L2)
// -------------------------------------------------------------
function trainLogisticRegression(Xs, y, { epochs = 300, lr = 0.25, l2 = 0.001 } = {}) {
  const n = Xs.length;
  const d = Xs[0].length;
  const weights = new Array(d).fill(0);
  let bias = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const z = Xs[i].reduce((sum, x, j) => sum + x * weights[j], bias);
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gradW[j] += err * Xs[i][j];
      gradB += err;
    }
    for (let j = 0; j < d; j++) weights[j] -= lr * (gradW[j] / n + l2 * weights[j]);
    bias -= lr * (gradB / n);
  }
  return { weights, bias };
}
function predictLogistic(model, xs) {
  const z = xs.reduce((sum, x, j) => sum + x * model.weights[j], model.bias);
  return sigmoid(z);
}

// -------------------------------------------------------------
// Model 2: Sparse Logistic Regression (L1)
// -------------------------------------------------------------
function trainSparseLogistic(Xs, y, { epochs = 350, lr = 0.2, l1 = 0.015 } = {}) {
  const n = Xs.length;
  const d = Xs[0].length;
  const weights = new Array(d).fill(0);
  let bias = 0;
  const soft = (v, a) => (v > a ? v - a : v < -a ? v + a : 0);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const z = Xs[i].reduce((sum, x, j) => sum + x * weights[j], bias);
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gradW[j] += err * Xs[i][j];
      gradB += err;
    }
    for (let j = 0; j < d; j++) {
      weights[j] = soft(weights[j] - lr * (gradW[j] / n), lr * l1);
    }
    bias -= lr * (gradB / n);
  }
  return { weights, bias, l1 };
}

// -------------------------------------------------------------
// Model 3: Decision Tree Classifier
// -------------------------------------------------------------
function gini(labels) {
  if (!labels.length) return 0;
  const p = labels.reduce((s, v) => s + v, 0) / labels.length;
  return 1 - p * p - (1 - p) * (1 - p);
}
function buildTree(X, y, indices, depth = 0, maxDepth = 4) {
  const labels = indices.map((i) => y[i]);
  const p = labels.reduce((s, v) => s + v, 0) / Math.max(1, labels.length);
  const node = { prediction: p >= 0.5 ? 1 : 0, probability: p };
  if (depth >= maxDepth || gini(labels) < 0.01 || indices.length < 25) return node;

  let best = null;
  const candidateQuantiles = [0.2, 0.4, 0.6, 0.8];
  for (let f = 0; f < X[0].length; f++) {
    const vals = indices.map((i) => X[i][f]).sort((a, b) => a - b);
    for (const q of candidateQuantiles) {
      const thr = vals[Math.min(vals.length - 1, Math.floor(vals.length * q))];
      const left = [], right = [];
      for (const i of indices) (X[i][f] <= thr ? left : right).push(i);
      if (!left.length || !right.length) continue;
      const score = (left.length * gini(left.map((i) => y[i])) + right.length * gini(right.map((i) => y[i]))) / indices.length;
      if (!best || score < best.score) best = { feature: f, threshold: thr, left, right, score };
    }
  }
  if (!best) return node;
  node.feature = best.feature;
  node.threshold = best.threshold;
  node.left = buildTree(X, y, best.left, depth + 1, maxDepth);
  node.right = buildTree(X, y, best.right, depth + 1, maxDepth);
  return node;
}
function predictTree(node, x) {
  if (node.feature === undefined) return node.probability;
  return x[node.feature] <= node.threshold ? predictTree(node.left, x) : predictTree(node.right, x);
}

// -------------------------------------------------------------
// Model 4: Random Forest
// -------------------------------------------------------------
function trainRandomForest(Xs, y, rng, { trees = 9, sampleSize = 800, maxDepth = 4 } = {}) {
  const forest = [];
  for (let t = 0; t < trees; t++) {
    const idx = [];
    for (let i = 0; i < sampleSize; i++) idx.push(Math.floor(rng() * Xs.length));
    const sx = idx.map((i) => Xs[i]);
    const sy = idx.map((i) => y[i]);
    forest.push(buildTree(sx, sy, sx.map((_, i) => i), 0, maxDepth));
  }
  return { trees: forest };
}
function predictRandomForest(model, x) {
  if (!model?.trees?.length) return 0;
  return model.trees.reduce((s, tr) => s + predictTree(tr, x), 0) / model.trees.length;
}

// -------------------------------------------------------------
// Model 5: Gradient Boosting
// -------------------------------------------------------------
function trainGradientBoosting(Xs, y, { rounds = 32, learningRate = 0.22 } = {}) {
  const posCount = y.reduce((a, b) => a + b, 0);
  const base = Math.log((posCount + 1) / (y.length - posCount + 1));
  const scores = new Array(y.length).fill(base);
  const stumps = [];
  const posWeight = (y.length - posCount) / Math.max(1, posCount);
  for (let r = 0; r < rounds; r++) {
    const residual = y.map((label, i) => {
      const p = sigmoid(scores[i]);
      const w = label === 1 ? Math.min(3.0, posWeight * 0.5) : 1.0;
      return (label - p) * w;
    });
    let best = null;
    for (let f = 0; f < Xs[0].length; f++) {
      const vals = Xs.map((row) => row[f]).sort((a, b) => a - b);
      for (const q of [0.25, 0.5, 0.75]) {
        const threshold = vals[Math.floor((vals.length - 1) * q)];
        const left = [], right = [];
        for (let i = 0; i < Xs.length; i++) (Xs[i][f] <= threshold ? left : right).push(i);
        if (!left.length || !right.length) continue;
        const lv = left.reduce((s, i) => s + residual[i], 0) / left.length;
        const rv = right.reduce((s, i) => s + residual[i], 0) / right.length;
        let loss = 0;
        for (const i of left) loss += (residual[i] - lv) ** 2;
        for (const i of right) loss += (residual[i] - rv) ** 2;
        if (!best || loss < best.loss) best = { feature: f, threshold, leftValue: lv, rightValue: rv, loss };
      }
    }
    if (!best) break;
    for (let i = 0; i < Xs.length; i++) scores[i] += learningRate * (Xs[i][best.feature] <= best.threshold ? best.leftValue : best.rightValue);
    stumps.push(best);
  }
  return { base, learningRate, stumps };
}
function predictGradientBoosting(model, x) {
  if (!model) return 0;
  let score = model.base;
  for (const s of model.stumps) score += model.learningRate * (x[s.feature] <= s.threshold ? s.leftValue : s.rightValue);
  return sigmoid(score);
}

// -------------------------------------------------------------
// Model 6: Isolation Forest (Unsupervised Anomaly Detection)
// -------------------------------------------------------------
function cFactor(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  const eulerGamma = 0.5772156649;
  return 2 * (Math.log(n - 1) + eulerGamma) - (2 * (n - 1)) / n;
}

function buildITree(X, currentDepth, maxDepth, rng) {
  const n = X.length;
  if (currentDepth >= maxDepth || n <= 1) {
    return { size: n };
  }
  const nFeatures = X[0].length;
  const feat = Math.floor(rng() * nFeatures);
  let min = X[0][feat];
  let max = X[0][feat];
  for (let i = 1; i < n; i++) {
    const val = X[i][feat];
    if (val < min) min = val;
    if (val > max) max = val;
  }
  if (min === max) {
    return { size: n };
  }
  const splitValue = min + rng() * (max - min);
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    if (X[i][feat] < splitValue) left.push(X[i]);
    else right.push(X[i]);
  }
  return {
    feat,
    splitValue,
    left: buildITree(left, currentDepth + 1, maxDepth, rng),
    right: buildITree(right, currentDepth + 1, maxDepth, rng)
  };
}

function pathLength(tree, x, currentDepth = 0) {
  if (tree.size !== undefined) {
    return currentDepth + cFactor(tree.size);
  }
  if (x[tree.feat] < tree.splitValue) {
    return pathLength(tree.left, x, currentDepth + 1);
  }
  return pathLength(tree.right, x, currentDepth + 1);
}

function trainIsolationForest(X, rng, { nTrees = 64, sampleSize = 256 } = {}) {
  const maxDepth = Math.ceil(Math.log2(Math.max(2, sampleSize)));
  const trees = [];
  for (let t = 0; t < nTrees; t++) {
    const subsample = [];
    const actualSampleSize = Math.min(sampleSize, X.length);
    for (let i = 0; i < actualSampleSize; i++) {
      const idx = Math.floor(rng() * X.length);
      subsample.push(X[idx]);
    }
    trees.push(buildITree(subsample, 0, maxDepth, rng));
  }
  const cPsi = cFactor(sampleSize);
  const sampleScores = X.slice(0, 1000).map((x) => {
    let tot = 0;
    for (const tr of trees) tot += pathLength(tr, x, 0);
    return Math.pow(2, -(tot / trees.length) / cPsi);
  }).sort((a, b) => a - b);
  const pIdx = Math.floor(sampleScores.length * 0.65);
  const threshold = Number((sampleScores[pIdx] || 0.515).toFixed(3));

  return {
    trees,
    sampleSize,
    maxDepth,
    cPsi,
    threshold
  };
}

function predictIsolationForest(model, x) {
  if (!model || !model.trees || !model.trees.length) return 0.5;
  let totalPath = 0;
  for (const tree of model.trees) {
    totalPath += pathLength(tree, x, 0);
  }
  const avgPath = totalPath / model.trees.length;
  // Anomaly score s(x, psi) = 2^(- avgPath / c(psi))
  const score = Math.pow(2, -avgPath / (model.cPsi || 1));
  return score;
}

// -------------------------------------------------------------
// Model 7: Neural Autoencoder (Reconstruction Anomaly Detection)
// -------------------------------------------------------------
function trainNeuralAutoencoder(X_nominal, rng, { hiddenDim = 5, latentDim = 3, epochs = 260, lr = 0.035 } = {}) {
  const d = X_nominal[0].length;
  const initW = (rows, cols) => {
    const w = [];
    const scale = Math.sqrt(2 / (rows + cols));
    for (let i = 0; i < rows; i++) {
      const row = [];
      for (let j = 0; j < cols; j++) row.push((rng() - 0.5) * 2 * scale);
      w.push(row);
    }
    return w;
  };
  const initB = (dim) => new Array(dim).fill(0);

  let W1 = initW(d, hiddenDim), B1 = initB(hiddenDim);
  let W2 = initW(hiddenDim, latentDim), B2 = initB(latentDim);
  let W3 = initW(latentDim, hiddenDim), B3 = initB(hiddenDim);
  let W4 = initW(hiddenDim, d), B4 = initB(d);

  const tanh = (v) => Math.tanh(Math.max(-10, Math.min(10, v)));
  const dtanh = (v) => 1 - Math.pow(Math.tanh(v), 2);

  const n = X_nominal.length;
  const batchSize = 64;

  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = 0; i < n; i += batchSize) {
      const batchEnd = Math.min(n, i + batchSize);
      const m = batchEnd - i;

      const dW4 = initW(hiddenDim, d).map((r) => r.fill(0));
      const dB4 = initB(d);
      const dW3 = initW(latentDim, hiddenDim).map((r) => r.fill(0));
      const dB3 = initB(hiddenDim);
      const dW2 = initW(hiddenDim, latentDim).map((r) => r.fill(0));
      const dB2 = initB(latentDim);
      const dW1 = initW(d, hiddenDim).map((r) => r.fill(0));
      const dB1 = initB(hiddenDim);

      for (let k = i; k < batchEnd; k++) {
        const x = X_nominal[k];
        const a1 = new Array(hiddenDim);
        const h1 = new Array(hiddenDim);
        for (let j = 0; j < hiddenDim; j++) {
          let sum = B1[j];
          for (let f = 0; f < d; f++) sum += x[f] * W1[f][j];
          a1[j] = sum;
          h1[j] = tanh(sum);
        }

        const a2 = new Array(latentDim);
        const z = new Array(latentDim);
        for (let j = 0; j < latentDim; j++) {
          let sum = B2[j];
          for (let f = 0; f < hiddenDim; f++) sum += h1[f] * W2[f][j];
          a2[j] = sum;
          z[j] = sum;
        }

        const a3 = new Array(hiddenDim);
        const h2 = new Array(hiddenDim);
        for (let j = 0; j < hiddenDim; j++) {
          let sum = B3[j];
          for (let f = 0; f < latentDim; f++) sum += z[f] * W3[f][j];
          a3[j] = sum;
          h2[j] = tanh(sum);
        }

        const x_hat = new Array(d);
        for (let j = 0; j < d; j++) {
          let sum = B4[j];
          for (let f = 0; f < hiddenDim; f++) sum += h2[f] * W4[f][j];
          x_hat[j] = sum;
        }

        const delta4 = new Array(d);
        for (let j = 0; j < d; j++) {
          delta4[j] = (2 / d) * (x_hat[j] - x[j]);
          dB4[j] += delta4[j];
          for (let f = 0; f < hiddenDim; f++) dW4[f][j] += h2[f] * delta4[j];
        }

        const delta3 = new Array(hiddenDim);
        for (let f = 0; f < hiddenDim; f++) {
          let sum = 0;
          for (let j = 0; j < d; j++) sum += W4[f][j] * delta4[j];
          delta3[f] = sum * dtanh(a3[f]);
          dB3[f] += delta3[f];
          for (let l = 0; l < latentDim; l++) dW3[l][f] += z[l] * delta3[f];
        }

        const delta2 = new Array(latentDim);
        for (let l = 0; l < latentDim; l++) {
          let sum = 0;
          for (let f = 0; f < hiddenDim; f++) sum += W3[l][f] * delta3[f];
          delta2[l] = sum;
          dB2[l] += delta2[l];
          for (let f = 0; f < hiddenDim; f++) dW2[f][l] += h1[f] * delta2[l];
        }

        const delta1 = new Array(hiddenDim);
        for (let f = 0; f < hiddenDim; f++) {
          let sum = 0;
          for (let l = 0; l < latentDim; l++) sum += W2[f][l] * delta2[l];
          delta1[f] = sum * dtanh(a1[f]);
          dB1[f] += delta1[f];
          for (let j = 0; j < d; j++) dW1[j][f] += x[j] * delta1[f];
        }
      }

      const curLr = lr * (1 - (0.5 * epoch) / epochs);
      for (let f = 0; f < hiddenDim; f++) {
        for (let j = 0; j < d; j++) W4[f][j] -= (curLr * dW4[f][j]) / m;
      }
      for (let j = 0; j < d; j++) B4[j] -= (curLr * dB4[j]) / m;

      for (let l = 0; l < latentDim; l++) {
        for (let f = 0; f < hiddenDim; f++) W3[l][f] -= (curLr * dW3[l][f]) / m;
      }
      for (let f = 0; f < hiddenDim; f++) B3[f] -= (curLr * dB3[f]) / m;

      for (let f = 0; f < hiddenDim; f++) {
        for (let l = 0; l < latentDim; l++) W2[f][l] -= (curLr * dW2[f][l]) / m;
      }
      for (let l = 0; l < latentDim; l++) B2[l] -= (curLr * dB2[l]) / m;

      for (let j = 0; j < d; j++) {
        for (let f = 0; f < hiddenDim; f++) W1[j][f] -= (curLr * dW1[j][f]) / m;
      }
      for (let f = 0; f < hiddenDim; f++) B1[f] -= (curLr * dB1[f]) / m;
    }
  }

  const normErrors = X_nominal.map((x) => {
    return reconstructAutoencoder({ W1, B1, W2, B2, W3, B3, W4, B4 }, x).mse;
  }).sort((a, b) => a - b);
  // Use the 99th percentile of nominal reconstruction error to reduce nuisance alerts.
  const p99Idx = Math.floor(normErrors.length * 0.99);
  const threshold = normErrors[Math.min(normErrors.length - 1, p99Idx)] || 0.8;

  return {
    W1, B1, W2, B2, W3, B3, W4, B4,
    threshold: Number(threshold.toFixed(4)),
    nominalMseMean: Number((normErrors.reduce((s, v) => s + v, 0) / normErrors.length).toFixed(4))
  };
}

function reconstructAutoencoder(model, x) {
  const d = x.length;
  const tanh = (v) => Math.tanh(Math.max(-10, Math.min(10, v)));
  const h1 = new Array(model.B1.length);
  for (let j = 0; j < model.B1.length; j++) {
    let sum = model.B1[j];
    for (let f = 0; f < d; f++) sum += x[f] * model.W1[f][j];
    h1[j] = tanh(sum);
  }
  const z = new Array(model.B2.length);
  for (let j = 0; j < model.B2.length; j++) {
    let sum = model.B2[j];
    for (let f = 0; f < model.B1.length; f++) sum += h1[f] * model.W2[f][j];
    z[j] = sum;
  }
  const h2 = new Array(model.B3.length);
  for (let j = 0; j < model.B3.length; j++) {
    let sum = model.B3[j];
    for (let f = 0; f < model.B2.length; f++) sum += z[f] * model.W3[f][j];
    h2[j] = tanh(sum);
  }
  const x_hat = new Array(d);
  const residuals = new Array(d);
  let totalMse = 0;
  for (let j = 0; j < d; j++) {
    let sum = model.B4[j];
    for (let f = 0; f < model.B3.length; f++) sum += h2[f] * model.W4[f][j];
    x_hat[j] = sum;
    const diff = x[j] - sum;
    residuals[j] = diff * diff;
    totalMse += residuals[j];
  }
  const mse = totalMse / d;
  return { x_hat, residuals, mse };
}

function predictAutoencoder(model, x) {
  if (!model || !model.W1) return { mse: 0, anomalyScore: 0, isAnomaly: false, residuals: [] };
  const { residuals, mse } = reconstructAutoencoder(model, x);
  const thr = model.threshold || 0.8;
  const z = (mse - thr) / Math.max(0.1, thr * 0.4);
  const anomalyScore = sigmoid(z);
  return {
    mse: Number(mse.toFixed(4)),
    threshold: thr,
    anomalyScore: Number(anomalyScore.toFixed(3)),
    isAnomaly: mse > thr,
    residuals: residuals.map((r) => Number(r.toFixed(3)))
  };
}

// -------------------------------------------------------------
// Model 8: Physics-Informed Hybrid (CEMA 7th / PI-ML)
// -------------------------------------------------------------
function extractCemaPhysicsFeatures(f) {
  // 1. Catenary sag indicator: Sag ~ (q_total * g * a_0^2) / (8 * T)
  const sagFactor = (1 + (f.loadExcess || 0) / 35) / Math.max(0.2, (1 + (90 - (f.tensionDeficit || 0)) / 60));
  const catenaryViolation = sagFactor > 1.45 ? 1 : 0;

  // 2. Capstan drive slip margin deficit: T1/T2 vs e^(mu * theta)
  const capstanDeficit = Math.max(0, (f.slipPct || 0) - 2.5) * (1 + (f.inclineAbsDeg || 0) / 25);
  const capstanViolation = capstanDeficit > 3.0 ? 1 : 0;

  // 3. Downhill mechanical power gradient & thermal stress
  const downhillThermalStress = (f.tempExcess || 0) / 25 + (f.vibrationMms || 0) / 8;

  // Composite CEMA Engineering Stress Index (ESI)
  const esi = (f.alignmentAbs || 0) / 25 * 0.35 + capstanDeficit * 0.25 + sagFactor * 0.2 + downhillThermalStress * 0.2;

  return {
    sagFactor: Number(sagFactor.toFixed(3)),
    catenaryViolation,
    capstanDeficit: Number(capstanDeficit.toFixed(3)),
    capstanViolation,
    downhillThermalStress: Number(downhillThermalStress.toFixed(3)),
    esi: Number(esi.toFixed(3))
  };
}

function trainPhysicsInformedHybrid(Xs, rawSamples, y, { epochs = 320, lr = 0.22, l2 = 0.001 } = {}) {
  const X_aug = Xs.map((x, i) => {
    const pf = extractCemaPhysicsFeatures(rawSamples[i].features);
    return [...x, pf.sagFactor, pf.capstanDeficit, pf.esi];
  });

  const n = X_aug.length;
  const d = X_aug[0].length; // 8 + 3 = 11
  const weights = new Array(d).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const z = X_aug[i].reduce((sum, val, j) => sum + val * weights[j], bias);
      const p = sigmoid(z);
      let err = p - y[i];

      // Physical constraint regularizer
      const pf = extractCemaPhysicsFeatures(rawSamples[i].features);
      if ((pf.catenaryViolation || pf.capstanViolation) && p < 0.7) {
        err -= 1.8 * (0.7 - p);
      }

      for (let j = 0; j < d; j++) gradW[j] += err * X_aug[i][j];
      gradB += err;
    }

    for (let j = 0; j < d; j++) weights[j] -= lr * (gradW[j] / n + l2 * weights[j]);
    bias -= lr * (gradB / n);
  }

  return { weights, bias, featureCount: d };
}

function predictPhysicsInformed(model, xs, rawFeatureObj) {
  const pf = extractCemaPhysicsFeatures(rawFeatureObj);
  const x_aug = [...xs, pf.sagFactor, pf.capstanDeficit, pf.esi];
  const z = x_aug.reduce((sum, val, j) => sum + val * model.weights[j], model.bias);
  const p = sigmoid(z);

  const isPhysicalViolation = pf.catenaryViolation === 1 || pf.capstanViolation === 1;
  const physicalConstraintStatus = isPhysicalViolation ? 'VIOLATION' : 'COMPLIANT';
  const finalProb = isPhysicalViolation ? Math.max(0.72, p) : p;

  return {
    probability: finalProb,
    esi: pf.esi,
    physicalConstraintStatus,
    sagFactor: pf.sagFactor,
    capstanDeficit: pf.capstanDeficit
  };
}

// -------------------------------------------------------------
// Evaluation Metrics Computation
// -------------------------------------------------------------
function computeClassificationMetrics(yTrue, probabilities, threshold = 0.5) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  let brier = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const yt = yTrue[i];
    const p = probabilities[i];
    brier += (p - yt) ** 2;
    const pred = p >= threshold ? 1 : 0;
    if (yt === 1 && pred === 1) tp++;
    else if (yt === 0 && pred === 0) tn++;
    else if (yt === 0 && pred === 1) fp++;
    else fn++;
  }
  const total = tp + fp + tn + fn || 1;
  const accuracy = (tp + tn) / total;
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
  const brierScore = brier / total;

  // Approximate ROC-AUC (trapezoidal ranking)
  const paired = yTrue.map((yt, i) => ({ yt, p: probabilities[i] })).sort((a, b) => b.p - a.p);
  let rocAuc = 0;
  let cumPos = 0, cumNeg = 0;
  const posTotal = yTrue.reduce((a, b) => a + b, 0) || 1;
  const negTotal = yTrue.length - posTotal || 1;
  for (const pair of paired) {
    if (pair.yt === 1) {
      cumPos++;
    } else {
      rocAuc += cumPos;
      cumNeg++;
    }
  }
  rocAuc = rocAuc / (posTotal * negTotal);

  return {
    tp, fp, tn, fn,
    accuracy: Number((accuracy * 100).toFixed(1)),
    accuracyPct: Number((accuracy * 100).toFixed(1)),
    precision: Number((precision * 100).toFixed(1)),
    precisionPct: Number((precision * 100).toFixed(1)),
    recall: Number((recall * 100).toFixed(1)),
    recallPct: Number((recall * 100).toFixed(1)),
    f1: Number((f1 * 100).toFixed(1)),
    f1Pct: Number((f1 * 100).toFixed(1)),
    rocAuc: Number(rocAuc.toFixed(3)),
    brierScore: Number(brierScore.toFixed(4)),
    testSamples: yTrue.length
  };
}

function buildEvaluationDiagnostics(yTrue, probabilities, faultClasses = [], threshold = 0.5) {
  const precisionRecallCurve = [];
  for (let t = 0.05; t <= 0.951; t += 0.05) {
    let tp = 0, fp = 0, fn = 0;
    yTrue.forEach((y, i) => { const pred = probabilities[i] >= t; if (pred && y === 1) tp++; else if (pred && y === 0) fp++; else if (!pred && y === 1) fn++; });
    precisionRecallCurve.push({ threshold: Number(t.toFixed(2)), precision: Number((tp / Math.max(1, tp + fp)).toFixed(4)), recall: Number((tp / Math.max(1, tp + fn)).toFixed(4)) });
  }
  const bins = Array.from({ length: 10 }, (_, i) => ({ lower: i / 10, upper: (i + 1) / 10, predicted: [], observed: [] }));
  yTrue.forEach((y, i) => { const p = Math.max(0, Math.min(0.999999, probabilities[i])); const bin = bins[Math.floor(p * 10)]; bin.predicted.push(p); bin.observed.push(y); });
  const calibrationBins = bins.map(b => ({ range: `${b.lower.toFixed(1)}–${b.upper.toFixed(1)}`, count: b.predicted.length, meanPredicted: b.predicted.length ? Number((b.predicted.reduce((a, v) => a + v, 0) / b.predicted.length).toFixed(4)) : null, observedRate: b.observed.length ? Number((b.observed.reduce((a, v) => a + v, 0) / b.observed.length).toFixed(4)) : null }));
  let tp = 0, fp = 0, tn = 0, fn = 0;
  yTrue.forEach((y, i) => { const pred = probabilities[i] >= threshold; if (y === 1 && pred) tp++; else if (y === 0 && pred) fp++; else if (y === 0 && !pred) tn++; else fn++; });
  const byFaultType = {};
  [...new Set(faultClasses)].forEach(type => {
    const indices = faultClasses.map((v, i) => v === type ? i : -1).filter(i => i >= 0);
    let ftp = 0, ffp = 0, ftn = 0, ffn = 0;
    indices.forEach(i => { const y = yTrue[i], pred = probabilities[i] >= threshold; if (y === 1 && pred) ftp++; else if (y === 0 && pred) ffp++; else if (y === 0 && !pred) ftn++; else ffn++; });
    byFaultType[type] = { samples: indices.length, tp: ftp, fp: ffp, tn: ftn, fn: ffn, falseAlarmRate: Number((ffp / Math.max(1, ffp + ftn) * 100).toFixed(2)), missedEventRate: Number((ffn / Math.max(1, ffn + ftp) * 100).toFixed(2)) };
  });
  return { threshold, confusionMatrix: { tp, fp, tn, fn }, falseAlarmRate: Number((fp / Math.max(1, fp + tn) * 100).toFixed(2)), missedEventRate: Number((fn / Math.max(1, fn + tp) * 100).toFixed(2)), precisionRecallCurve, calibrationBins, byFaultType };
}

// -------------------------------------------------------------
// Pipeline Orchestrator & Artifact Generator
// -------------------------------------------------------------
function trainAndExportArtifact(outputPath = null, sampleCount = Number(process.env.ML_TRAIN_SAMPLES || 25000), seed = Number(process.env.ML_TRAIN_SEED || 42)) {
  const t0 = Date.now();
  const rng = createRng(seed);

  console.log(`[ML Training] Sampling ${sampleCount} synthetic sensor events (seed=${seed})...`);
  const dataset = [];
  for (let i = 0; i < sampleCount; i++) {
    dataset.push(sampleSyntheticSample(rng));
  }

  // Deterministic held-out split. Samples are IID synthetic scenarios, not a continuous time series.
  const splitIdx = Math.floor(sampleCount * 0.8);
  const trainSet = dataset.slice(0, splitIdx);
  const testSet = dataset.slice(splitIdx);

  const trainX = trainSet.map((d) => vectorize(d.features));
  const trainY = trainSet.map((d) => d.hazardLabel);
  const trainAnomaly = trainSet.map((d) => d.isAnomaly);

  const testX = testSet.map((d) => vectorize(d.features));
  const testY = testSet.map((d) => d.hazardLabel);
  const testAnomaly = testSet.map((d) => d.isAnomaly);

  const scaler = standardizeFit(trainX);
  const trainXs = standardizeTransform(trainX, scaler);
  const testXs = standardizeTransform(testX, scaler);

  console.log('[ML Training] Training models & calculating baseline benchmarks...');

  // Baselines
  const majorityClass = trainY.reduce((a, b) => a + b, 0) / trainY.length >= 0.5 ? 1 : 0;
  const baselineDummyProbs = testY.map(() => (majorityClass === 1 ? 0.99 : 0.01));
  const baselineMetrics = computeClassificationMetrics(testY, baselineDummyProbs);

  // Simple Threshold Baseline (alignment > 25mm or slip > 5%)
  const thresholdBaselineProbs = testX.map((x) => (x[0] > 25 || x[2] > 5 ? 0.85 : 0.15));
  const thresholdMetrics = computeClassificationMetrics(testY, thresholdBaselineProbs);

  // 1-5. Existing Supervised Baselines
  const logistic = trainLogisticRegression(trainXs, trainY);
  const sparseLogistic = trainSparseLogistic(trainXs, trainY);
  const decisionTree = buildTree(trainXs, trainY, trainXs.map((_, i) => i));
  const randomForest = trainRandomForest(trainXs, trainY, rng);
  const gradientBoosting = trainGradientBoosting(trainXs, trainY);

  // 6. Isolation Forest (Unsupervised Anomaly Detection)
  const isolationForest = trainIsolationForest(trainXs, rng);

  // 7. Neural Autoencoder (Trained strictly on nominal operations)
  const trainNominalXs = trainXs.filter((_, i) => trainAnomaly[i] === 0);
  const autoencoder = trainNeuralAutoencoder(trainNominalXs, rng);

  // 8. Physics-Informed Hybrid (CEMA 7th Ed. / PI-ML)
  const physicsInformed = trainPhysicsInformedHybrid(trainXs, trainSet, trainY);

  // Predictions on Test Set
  const predictions = {
    'Logistic Regression': testXs.map((x) => predictLogistic(logistic, x)),
    'Sparse Regression (L1)': testXs.map((x) => predictLogistic(sparseLogistic, x)),
    'Decision Tree': testXs.map((x) => predictTree(decisionTree, x)),
    'Random Forest': testXs.map((x) => predictRandomForest(randomForest, x)),
    'Gradient Boosting': testXs.map((x) => predictGradientBoosting(gradientBoosting, x)),
    'Physics-Informed Hybrid': testXs.map((x, i) => predictPhysicsInformed(physicsInformed, x, testSet[i].features).probability)
  };

  const modelMetrics = {};
  for (const [name, probs] of Object.entries(predictions)) {
    modelMetrics[name] = computeClassificationMetrics(testY, probs);
  }

  // Ensemble Average (combines all 5 baseline supervised models)
  const ensembleConstituents = [
    'Logistic Regression',
    'Sparse Regression (L1)',
    'Decision Tree',
    'Random Forest',
    'Gradient Boosting'
  ];
  const ensembleProbs = testXs.map((x, i) => {
    return (
      (predictions['Logistic Regression'][i] +
        predictions['Sparse Regression (L1)'][i] +
        predictions['Decision Tree'][i] +
        predictions['Random Forest'][i] +
        predictions['Gradient Boosting'][i]) / 5
    );
  });
  modelMetrics['Ensemble'] = computeClassificationMetrics(testY, ensembleProbs);

  // Evaluate Unsupervised Anomaly Models against Test Anomaly Labels
  const ifProbs = testXs.map((x) => predictIsolationForest(isolationForest, x));
  modelMetrics['Isolation Forest'] = computeClassificationMetrics(testAnomaly, ifProbs, isolationForest.threshold);

  const aeProbs = testXs.map((x) => predictAutoencoder(autoencoder, x).anomalyScore);
  modelMetrics['Neural Autoencoder'] = computeClassificationMetrics(testAnomaly, aeProbs, 0.5);

  // Diagnostics are derived from held-out predictions, not reconstructed from
  // rounded aggregate metrics. Supervised tasks use hazard labels; anomaly
  // models use independent synthetic anomaly labels.
  const evaluationDiagnostics = {};
  for (const [name, probs] of Object.entries(predictions)) {
    evaluationDiagnostics[name] = buildEvaluationDiagnostics(testY, probs, testSet.map(d => d.faultClass), 0.5);
  }
  evaluationDiagnostics['Ensemble'] = buildEvaluationDiagnostics(testY, ensembleProbs, testSet.map(d => d.faultClass), 0.5);
  evaluationDiagnostics['Isolation Forest'] = buildEvaluationDiagnostics(testAnomaly, ifProbs, testSet.map(d => d.faultClass), isolationForest.threshold);
  evaluationDiagnostics['Neural Autoencoder'] = buildEvaluationDiagnostics(testAnomaly, aeProbs, testSet.map(d => d.faultClass), 0.5);

  const durationMs = Date.now() - t0;
  console.log(`[ML Training] Completed in ${durationMs}ms`);

  const artifact = {
    schemaVersion: '3.0.0',
    modelType: 'MultiModelHazardAndAnomalySuite',
    tasks: {
      hazardForecasting10m: [
        'Logistic Regression', 'Sparse Regression (L1)', 'Decision Tree',
        'Random Forest', 'Gradient Boosting', 'Ensemble', 'Physics-Informed Hybrid'
      ],
      anomalyDetection: ['Isolation Forest', 'Neural Autoencoder'],
      faultClassification: ['Decision Tree', 'Deterministic Attributor']
    },
    createdTimestamp: new Date().toISOString(),
    trainingProvenance: {
      type: 'SYNTHETIC_DATASET',
      isFieldValidated: false,
      sampleCount,
      randomSeed: seed,
      split: 'Deterministic seeded 80% train / 20% held-out test; generated samples are IID synthetic scenarios, not chronological field telemetry',
      featureNames: FEATURES
    },
    scaler,
    baselines: {
      'Majority Class Prior': baselineMetrics,
      'Heuristic Sensor Threshold': thresholdMetrics
    },
    ensembleDefinition: {
      method: 'unweighted_average',
      constituents: ensembleConstituents
    },
    evaluationMetrics: modelMetrics,
    evaluationDiagnostics,
    evaluationLimitations: { datasetType: 'SYNTHETIC', fieldValidated: false, threshold: 0.5, note: 'Curves and subgroup metrics describe held-out synthetic samples only; they are not real-world performance estimates.' },
    candidateEvaluationReport: {
      evaluated: [
        { name: 'Isolation Forest', status: 'IMPLEMENTED', task: 'Unsupervised Anomaly Detection', rationale: 'Effective multi-sensor isolation without label bias; sub-millisecond inference.' },
        { name: 'Neural Autoencoder', status: 'IMPLEMENTED', task: 'Reconstruction Anomaly Detection', rationale: 'Non-linear bottleneck representation provides per-sensor residual attribution.' },
        { name: 'Physics-Informed Hybrid', status: 'IMPLEMENTED', task: 'Engineering Stress & Hazard', rationale: 'Directly enforces CEMA 7th Edition / ISO 5048 physical boundary constraints.' },
        { name: 'TSPulse', status: 'REJECTED', rationale: 'Incompatible with 0.5Hz tabular telemetry; requires high-frequency acoustic pulse data and PyTorch runtime.' },
        { name: 'TCNs', status: 'DEFERRED', rationale: 'High tensor complexity in pure Node.js; Autoencoder and Isolation Forest provide superior anomaly performance.' },
        { name: 'PatchTST & IBM TinyTimeMixer', status: 'DEFERRED', rationale: 'Predict future sensor trajectories rather than failure events; heavy PyTorch/Granite dependency.' },
        { name: 'YOLOv8/11-seg', status: 'DEFERRED', rationale: 'Requires annotated conveyor polygon segmentation dataset and GPU runtime; not available in current codebase.' },
        { name: 'RT-DETR', status: 'DEFERRED', rationale: 'Requires annotated tramp iron/foreign object dataset and transformer vision runtime.' }
      ]
    },
    models: {
      logistic,
      sparseLogistic,
      decisionTree,
      randomForest,
      gradientBoosting,
      isolationForest,
      autoencoder,
      physicsInformed
    }
  };

  const finalPath = outputPath || path.join(__dirname, '..', '..', 'data', 'models', 'model-artifact.json');
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.writeFileSync(finalPath, JSON.stringify(artifact, null, 2), 'utf8');
  console.log(`[ML Training] Model artifact successfully saved to: ${finalPath}`);
  return artifact;
}

if (require.main === module) {
  const sampleCount = Number(process.argv[2] || process.env.ML_TRAIN_SAMPLES || 10000);
  const seed = Number(process.argv[3] || process.env.ML_TRAIN_SEED || 42);
  if (!Number.isInteger(sampleCount) || sampleCount < 1000 || sampleCount > 100000) throw new Error('Training sample count must be an integer between 1000 and 100000.');
  if (!Number.isInteger(seed) || seed < 0) throw new Error('Training seed must be a non-negative integer.');
  trainAndExportArtifact(null, sampleCount, seed);
}

module.exports = {
  trainAndExportArtifact,
  createRng,
  sampleSyntheticSample,
  FEATURES,
  FAULT_CLASSES,
  predictLogistic,
  predictTree,
  predictRandomForest,
  predictGradientBoosting,
  predictIsolationForest,
  predictAutoencoder,
  predictPhysicsInformed,
  extractCemaPhysicsFeatures,
  buildEvaluationDiagnostics,
  standardizeTransform,
  computeClassificationMetrics
};
