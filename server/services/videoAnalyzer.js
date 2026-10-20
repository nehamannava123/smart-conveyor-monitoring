/**
 * Video Inspection module.
 * ---------------------------------------------------------------------
 * Lets an operator upload a short clip of the conveyor (e.g. a phone video
 * taken while walking the line, or a fixed CCTV clip) and get the same
 * kind of risk assessment the live sensors produce - but derived directly
 * from the footage using classical computer-vision techniques:
 *
 *  1. FRAME EXTRACTION: ffmpeg samples the clip at a fixed rate (default
 *     2 frames/sec) into JPEG frames on disk.
 *  2. BELT-EDGE DETECTION: each frame is converted to greyscale; within a
 *     horizontal inspection band (the middle portion of the frame, where
 *     the belt runs) we compute a per-column brightness profile and find
 *     the strongest left/right gradient (edge) pairs - the belt's visible
 *     edges against the background/idler frame. The midpoint between the
 *     detected edges is the belt centerline for that frame.
 *  3. LATERAL DRIFT: centerline position is tracked frame-to-frame. Drift
 *     of the centerline away from the frame's own baseline (the median
 *     centerline across the whole clip) is a direct visual proxy for
 *     mistracking - the same physical phenomenon the alignment sensor
 *     measures on the live system.
 *  4. VIBRATION PROXY: mean absolute pixel difference between consecutive
 *     frames (within the inspection band) approximates visible shake/
 *     judder - a proxy for the vibration sensor channel.
 *  5. These two derived channels are fed into a simplified version of the
 *     same risk-scoring approach used for live sensors (see riskEngine.js)
 *     to produce a 0-100 risk score per frame and an overall clip verdict.
 *  6. Optionally, a handful of representative frames (worst-risk + first/
 *     middle/last) are sent to the Claude API's vision capability for a
 *     genuine visual second opinion in plain English.
 *
 * This is real, working image analysis (not a mock) - it genuinely reads
 * pixel data out of the uploaded video and computes numbers from it. It
 * is a simpler, transparent classical-CV baseline; a production system
 * would likely add a trained object-detector for the belt edges, but this
 * approach requires no model download/training and works immediately.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuid } = require('uuid');
const { Jimp, intToRGBA } = require('jimp');

const FRAME_RATE = Number(process.env.VIDEO_FRAME_RATE || 2); // frames sampled per second
const MAX_FRAMES = Number(process.env.VIDEO_MAX_FRAMES || 40); // cap total frames analyzed

function ffmpegAvailable() {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

function extractFrames(videoPath, outDir, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const pattern = path.join(outDir, 'frame-%04d.jpg');
    const args = [
      '-y',
      '-i', videoPath,
      '-vf', `fps=${FRAME_RATE},scale=480:-2`,
      '-frames:v', String(MAX_FRAMES),
      '-q:v', '4',
      pattern
    ];
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg process timed out after 45 seconds'));
    }, timeoutMs);

    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg not available: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-400)}`));
      const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.jpg')).sort();
      resolve(files.map((f) => path.join(outDir, f)));
    });
  });
}

// Analyze one greyscale frame: return { centerlinePx, bandPixels } for the
// horizontal inspection band using a column-brightness gradient edge scan.
async function analyzeFrame(framePath) {
  const img = await Jimp.read(framePath);
  img.greyscale();
  const w = img.width;
  const h = img.height;

  const bandTop = Math.floor(h * 0.4);
  const bandBottom = Math.floor(h * 0.65);
  const bandHeight = bandBottom - bandTop;

  // column-average brightness within the band
  const colBrightness = new Array(w).fill(0);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = bandTop; y < bandBottom; y++) {
      const { r, g, b } = intToRGBA(img.getPixelColor(x, y));
      sum += (r + g + b) / 3;
    }
    colBrightness[x] = sum / bandHeight;
  }

  // gradient magnitude between adjacent columns -> edge strength
  const gradient = new Array(w).fill(0);
  for (let x = 1; x < w; x++) {
    gradient[x] = Math.abs(colBrightness[x] - colBrightness[x - 1]);
  }

  // strongest edge in the left half = left belt edge, strongest in the
  // right half = right belt edge
  const mid = Math.floor(w / 2);
  let leftEdge = 0, leftStrength = -1;
  for (let x = 1; x < mid; x++) {
    if (gradient[x] > leftStrength) { leftStrength = gradient[x]; leftEdge = x; }
  }
  let rightEdge = w - 1, rightStrength = -1;
  for (let x = mid; x < w - 1; x++) {
    if (gradient[x] > rightStrength) { rightStrength = gradient[x]; rightEdge = x; }
  }

  const centerlinePx = (leftEdge + rightEdge) / 2;

  return { width: w, height: h, centerlinePx, leftEdge, rightEdge, bandTop, bandBottom, colBrightness };
}

function frameDiff(bandA, bandB) {
  let sum = 0;
  const n = Math.min(bandA.length, bandB.length);
  for (let i = 0; i < n; i++) sum += Math.abs(bandA[i] - bandB[i]);
  return sum / n;
}

function bandScore(value, warnAt, critAt) {
  if (value <= warnAt) return (value / warnAt) * 40;
  if (value <= critAt) return 40 + ((value - warnAt) / (critAt - warnAt)) * 40;
  return Math.min(100, 80 + ((value - critAt) / critAt) * 40);
}

function scoreClip(frameMetrics) {
  const centerlines = frameMetrics.map((f) => f.centerlinePx);
  const median = [...centerlines].sort((a, b) => a - b)[Math.floor(centerlines.length / 2)];
  const widths = frameMetrics.map((f) => f.width);
  const avgWidth = widths.reduce((a, b) => a + b, 0) / widths.length;

  let worst = null;
  const scored = frameMetrics.map((f, i) => {
    const driftPx = f.centerlinePx - median;
    const driftPct = (Math.abs(driftPx) / avgWidth) * 100; // % of frame width
    const vibration = i > 0 ? frameDiff(frameMetrics[i - 1].colBrightness, f.colBrightness) : 0;

    const alignmentScore = bandScore(driftPct, 4, 9); // >4% drift = warning, >9% = critical territory
    const vibrationScore = bandScore(vibration, 8, 16);
    const score = Math.round(Math.min(100, alignmentScore * 0.65 + vibrationScore * 0.35));

    let level = 'NORMAL';
    if (score >= 70) level = 'CRITICAL';
    else if (score >= 40) level = 'WARNING';

    const entry = {
      frameIndex: i,
      driftPx: Number(driftPx.toFixed(1)),
      driftPct: Number(driftPct.toFixed(2)),
      vibration: Number(vibration.toFixed(2)),
      score,
      level
    };
    if (!worst || score > worst.score) worst = { ...entry };
    return entry;
  });

  const overallScore = Math.round(scored.reduce((a, b) => a + b.score, 0) / scored.length);
  const peakScore = Math.max(...scored.map((s) => s.score));
  let overallLevel = 'NORMAL';
  if (peakScore >= 70) overallLevel = 'CRITICAL';
  else if (peakScore >= 40) overallLevel = 'WARNING';

  return { perFrame: scored, overallScore, peakScore, overallLevel, worstFrameIndex: worst?.frameIndex ?? 0, medianCenterlinePx: median };
}

async function analyzeVideo(videoPath) {
  const available = await ffmpegAvailable();
  if (!available) {
    const err = new Error(
      'ffmpeg was not found on this system. Video analysis requires ffmpeg to be installed and on your PATH ' +
      '(e.g. "sudo apt install ffmpeg", "brew install ffmpeg", or download from ffmpeg.org for Windows).'
    );
    err.code = 'FFMPEG_MISSING';
    throw err;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hillguard-video-'));
  try {
    const framePaths = await extractFrames(videoPath, workDir);
    if (framePaths.length < 2) {
      const err = new Error('Could not extract enough frames from this video (need at least 2). Try a longer or higher-quality clip.');
      err.code = 'NOT_ENOUGH_FRAMES';
      throw err;
    }

    const frameMetrics = [];
    for (const fp of framePaths) {
      const m = await analyzeFrame(fp);
      frameMetrics.push(m);
    }

    const result = scoreClip(frameMetrics);

    // Keep a small set of representative frame files (as base64 thumbnails)
    // for the dashboard + optional AI vision step: first, worst, middle, last.
    const pickIdx = Array.from(new Set([
      0,
      result.worstFrameIndex,
      Math.floor(framePaths.length / 2),
      framePaths.length - 1
    ])).sort((a, b) => a - b);

    const thumbnails = pickIdx.map((i) => ({
      frameIndex: i,
      base64: fs.readFileSync(framePaths[i]).toString('base64'),
      ...result.perFrame[i]
    }));

    return {
      id: uuid(),
      analyzedAt: new Date().toISOString(),
      frameCount: framePaths.length,
      frameRate: FRAME_RATE,
      overallScore: result.overallScore,
      peakScore: result.peakScore,
      overallLevel: result.overallLevel,
      perFrame: result.perFrame,
      thumbnails
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = {
  analyzeVideo,
  ffmpegAvailable,
  extractFrames,
  scoreClip,
  bandScore,
  analyzeFrame
};
