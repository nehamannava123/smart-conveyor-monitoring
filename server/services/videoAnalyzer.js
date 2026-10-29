
/**
 * Video Inspection module.
 *
 * 1. Extracts video frames using FFmpeg.
 * 2. Detects belt edges using grayscale column-brightness gradients.
 * 3. Calculates lateral drift relative to the clip's median centerline.
 * 4. Estimates vibration from differences between consecutive frames.
 * 5. Scores risk per frame and for the overall clip.
 * 6. Returns representative frames for dashboard display.
 *
 * Note: These are classical computer-vision estimates, not calibrated
 * physical measurements of conveyor alignment or vibration.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuid } = require('uuid');
const sharp = require('sharp');

const FRAME_RATE = Number(process.env.VIDEO_FRAME_RATE || 2);
const MAX_FRAMES = Number(process.env.VIDEO_MAX_FRAMES || 40);

function ffmpegAvailable() {
  return new Promise((resolve) => {
    let proc;

    try {
      proc = spawn('ffmpeg', ['-version'], { windowsHide: true });
    } catch {
      resolve(false);
      return;
    }

    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
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

    const proc = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(
        new Error(`ffmpeg process timed out after ${timeoutMs / 1000} seconds`)
      );
    }, timeoutMs);

    proc.stderr.on('data', (data) => {
      stderr += data.toString();

      // Keep diagnostic output bounded for long videos.
      if (stderr.length > 12000) {
        stderr = stderr.slice(-8000);
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not start ffmpeg: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(
          new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-400)}`)
        );
        return;
      }

      const files = fs.readdirSync(outDir)
        .filter((file) => /^frame-\d+\.jpg$/i.test(file))
        .sort();

      resolve(files.map((file) => path.join(outDir, file)));
    });
  });
}

// Analyze one frame using Sharp grayscale pixel data.
async function analyzeFrame(framePath) {
  const { data, info } = await sharp(framePath)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels;

  const bandTop = Math.floor(height * 0.4);
  const bandBottom = Math.floor(height * 0.65);
  const bandHeight = bandBottom - bandTop;

  if (width < 3 || bandHeight < 1 || channels < 1) {
    throw new Error(`Invalid frame dimensions: ${width}x${height}`);
  }

  // Average grayscale brightness for each column in the inspection band.
  const colBrightness = new Array(width).fill(0);

  for (let x = 0; x < width; x++) {
    let sum = 0;

    for (let y = bandTop; y < bandBottom; y++) {
      const pixelIndex = (y * width + x) * channels;
      sum += data[pixelIndex];
    }

    colBrightness[x] = sum / bandHeight;
  }

  // Gradient magnitude between adjacent columns.
  const gradient = new Array(width).fill(0);

  for (let x = 1; x < width; x++) {
    gradient[x] = Math.abs(
      colBrightness[x] - colBrightness[x - 1]
    );
  }

  // Strongest gradient in each half is treated as a belt edge.
  const mid = Math.floor(width / 2);

  let leftEdge = 0;
  let leftStrength = -1;

  for (let x = 1; x < mid; x++) {
    if (gradient[x] > leftStrength) {
      leftStrength = gradient[x];
      leftEdge = x;
    }
  }

  let rightEdge = width - 1;
  let rightStrength = -1;

  for (let x = mid; x < width - 1; x++) {
    if (gradient[x] > rightStrength) {
      rightStrength = gradient[x];
      rightEdge = x;
    }
  }

  const centerlinePx = (leftEdge + rightEdge) / 2;

  return {
    width,
    height,
    centerlinePx,
    leftEdge,
    rightEdge,
    bandTop,
    bandBottom,
    colBrightness
  };
}

function frameDiff(bandA, bandB) {
  const n = Math.min(bandA.length, bandB.length);

  if (n === 0) return 0;

  let sum = 0;

  for (let i = 0; i < n; i++) {
    sum += Math.abs(bandA[i] - bandB[i]);
  }

  return sum / n;
}

function bandScore(value, warnAt, critAt) {
  if (value <= warnAt) {
    return (value / warnAt) * 40;
  }

  if (value <= critAt) {
    return 40 + ((value - warnAt) / (critAt - warnAt)) * 40;
  }

  return Math.min(100, 80 + ((value - critAt) / critAt) * 40);
}

function scoreClip(frameMetrics) {
  if (!frameMetrics.length) {
    throw new Error('No frame metrics available to score.');
  }

  const centerlines = frameMetrics.map((frame) => frame.centerlinePx);
  const sortedCenterlines = [...centerlines].sort((a, b) => a - b);
  const median = sortedCenterlines[
    Math.floor(sortedCenterlines.length / 2)
  ];

  const widths = frameMetrics.map((frame) => frame.width);
  const avgWidth = widths.reduce((a, b) => a + b, 0) / widths.length;

  let worst = null;

  const scored = frameMetrics.map((frame, i) => {
    const driftPx = frame.centerlinePx - median;
    const driftPct = avgWidth > 0
      ? (Math.abs(driftPx) / avgWidth) * 100
      : 0;

    const vibration = i > 0
      ? frameDiff(
          frameMetrics[i - 1].colBrightness,
          frame.colBrightness
        )
      : 0;

    const alignmentScore = bandScore(driftPct, 4, 9);
    const vibrationScore = bandScore(vibration, 8, 16);

    const score = Math.round(
      Math.min(
        100,
        alignmentScore * 0.65 + vibrationScore * 0.35
      )
    );

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

    if (!worst || score > worst.score) {
      worst = { ...entry };
    }

    return entry;
  });

  const overallScore = Math.round(
    scored.reduce((sum, frame) => sum + frame.score, 0) /
      scored.length
  );

  const peakScore = Math.max(...scored.map((frame) => frame.score));

  let overallLevel = 'NORMAL';
  if (peakScore >= 70) overallLevel = 'CRITICAL';
  else if (peakScore >= 40) overallLevel = 'WARNING';

  return {
    perFrame: scored,
    overallScore,
    peakScore,
    overallLevel,
    worstFrameIndex: worst?.frameIndex ?? 0,
    medianCenterlinePx: median
  };
}

async function analyzeVideo(videoPath) {
  if (!(await ffmpegAvailable())) {
    const err = new Error(
      'ffmpeg was not found on this system. Install FFmpeg and ensure it is on your PATH.'
    );
    err.code = 'FFMPEG_MISSING';
    throw err;
  }

  const workDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hillguard-video-')
  );

  try {
    const framePaths = await extractFrames(videoPath, workDir);

    if (framePaths.length < 2) {
      const err = new Error(
        'Could not extract enough frames from this video (need at least 2). Try a longer or higher-quality clip.'
      );
      err.code = 'NOT_ENOUGH_FRAMES';
      throw err;
    }

    const frameMetrics = [];

    for (const framePath of framePaths) {
      frameMetrics.push(await analyzeFrame(framePath));
    }

    const result = scoreClip(frameMetrics);

    // Include first, worst-risk, middle and last frames.
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
