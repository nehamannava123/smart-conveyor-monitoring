const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuid } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const db = require('../config/db');
const videoAnalyzer = require('../services/videoAnalyzer');
const { generateVideoInsight } = require('../services/localInsights');

const UPLOAD_DIR = path.join(os.tmpdir(), 'hillguard-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Max 50 MB upload limit
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Generate an unguessable filename in temporary directory
    const safeExt = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
    cb(null, `upload-${Date.now()}-${uuid()}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const okExt = /\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(file.originalname || '');
    if (!file.mimetype.startsWith('video/') && !okExt) {
      return cb(new Error('Only video files (mp4, mov, m4v, avi, mkv, webm) are accepted'));
    }
    cb(null, true);
  }
});

function verifyVideoMagicBytes(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(16);
  const bytesRead = fs.readSync(fd, buffer, 0, 16, 0);
  fs.closeSync(fd);

  if (bytesRead < 8) return false;

  // EBML header for WebM / MKV
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return true;
  }
  // RIFF .... AVI
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'AVI ') {
    return true;
  }
  // MP4 / MOV / M4V (ftyp or moov at offset 4)
  const tag = buffer.toString('ascii', 4, 8);
  if (tag === 'ftyp' || tag === 'moov' || tag === 'wide' || tag === 'mdat' || tag === 'free') {
    return true;
  }
  return false;
}

let activeAnalyses = 0;
const MAX_CONCURRENT_ANALYSES = 1;

module.exports = function videoRouter(io) {
  const router = express.Router();

  router.get('/ai-status', requireAuth, (req, res) => {
    res.json({ configured: true, mode: 'local-computer-vision' });
  });

  router.post('/analyze', requireAuth, (req, res) => {
    if (activeAnalyses >= MAX_CONCURRENT_ANALYSES) {
      return res.status(429).json({
        error: 'Video analysis pipeline is currently busy. Please wait for the current inspection to finish.'
      });
    }

    upload.single('video')(req, res, async (uploadErr) => {
      if (uploadErr) {
        return res.status(400).json({ error: uploadErr.message });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No video file uploaded (field name must be "video")' });
      }

      const filePath = req.file.path;

      // Validate magic bytes
      try {
        if (!verifyVideoMagicBytes(filePath)) {
          fs.unlink(filePath, () => {});
          return res.status(400).json({
            error: 'Invalid or unsupported video file format. The file content does not match a recognized video header.'
          });
        }
      } catch (err) {
        fs.unlink(filePath, () => {});
        return res.status(400).json({ error: 'Failed to inspect uploaded file' });
      }

      activeAnalyses++;

      // Scope Socket.IO events to user's private channel
      const userRoom = `user:${req.user.id || req.user.username}`;
      const emit = (stage, detail) => {
        io.to(userRoom).emit('video:progress', { stage, detail, at: new Date().toISOString() });
      };

      try {
        emit('UPLOAD_RECEIVED', `Received "${req.file.originalname}" (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);

        emit('EXTRACTING_FRAMES', 'Sampling frames from the clip with ffmpeg...');
        const cvResult = await videoAnalyzer.analyzeVideo(filePath);

        emit('CV_SCORED', `Analyzed ${cvResult.frameCount} frames — overall risk ${cvResult.overallScore}/100 (${cvResult.overallLevel}).`);

        emit('GENERATING_INSIGHT', 'Composing diagnosis from the computer-vision metrics...');
        const insight = generateVideoInsight(cvResult);
        emit('INSIGHT_DONE', 'Diagnosis ready.');

        db.addAudit({
          id: uuid(),
          at: new Date().toISOString(),
          actor: req.user.username,
          action: 'VIDEO_INSPECTION',
          zoneId: null,
          detail: `Uploaded video analyzed: ${cvResult.frameCount} frames, risk ${cvResult.overallScore}/100 (${cvResult.overallLevel})`
        });

        const result = { ...cvResult, ai: insight };
        emit('COMPLETE', 'Analysis complete.');
        io.to(userRoom).emit('video:result', result);
        res.json(result);
      } catch (err) {
        const status = err.code === 'FFMPEG_MISSING' || err.code === 'NOT_ENOUGH_FRAMES' ? 400 : 500;
        emit('ERROR', err.message);
        res.status(status).json({ error: err.message, code: err.code || 'ANALYSIS_ERROR' });
      } finally {
        activeAnalyses--;
        fs.unlink(filePath, () => {});
      }
    });
  });

  return router;
};
