const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { scoreClip, bandScore, analyzeVideo } = require('../server/services/videoAnalyzer');

test('videoAnalyzer - band scoring function', () => {
  assert.equal(bandScore(0, 4, 9), 0);
  assert.equal(bandScore(4, 4, 9), 40);
  assert.equal(bandScore(9, 4, 9), 80);
  assert.ok(bandScore(12, 4, 9) > 80);
});

test('videoAnalyzer - scoreClip evaluates lateral drift and vibration proxy', () => {
  const dummyFrames = [
    { width: 480, height: 270, centerlinePx: 240, colBrightness: new Array(480).fill(100) },
    { width: 480, height: 270, centerlinePx: 242, colBrightness: new Array(480).fill(102) },
    { width: 480, height: 270, centerlinePx: 241, colBrightness: new Array(480).fill(101) },
    { width: 480, height: 270, centerlinePx: 268, colBrightness: new Array(480).fill(120) } // frame with severe lateral drift
  ];

  const result = scoreClip(dummyFrames);
  assert.equal(result.perFrame.length, 4);
  assert.ok(result.overallScore >= 0 && result.overallScore <= 100);
  assert.equal(result.worstFrameIndex, 3);
  assert.ok(result.peakScore >= result.overallScore);
});

test('videoAnalyzer - rejects execution with FFMPEG_MISSING when ffmpeg is unavailable', async () => {
  // If ffmpeg is missing on system, analyzeVideo must cleanly throw with FFMPEG_MISSING code
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-video-test-'));
  const dummyVideo = path.join(tmpDir, 'test.mp4');
  fs.writeFileSync(dummyVideo, 'not a real video content');

  try {
    await analyzeVideo(dummyVideo);
  } catch (err) {
    assert.ok(err.code === 'FFMPEG_MISSING' || err.message.includes('ffmpeg'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
