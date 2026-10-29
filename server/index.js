require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const db = require('./config/db');
const { ZONES, buildInitialZoneState } = require('./models/zones');
const { seedUsersIfEmpty, verifyToken } = require('./services/authService');
const { seedAssetsIfEmpty } = require('./services/assetService');
const simulator = require('./services/simulator');
const { computeRisk } = require('./services/riskEngine');
const { evaluateAutomation } = require('./services/automation');
const { model: mlModel } = require('./services/mlPredictor');

const authRoutes = require('./routes/auth');
const auditRoutes = require('./routes/audit');
const aiRoutes = require('./routes/ai');
const makeZonesRouter = require('./routes/zones');
const makeAlertsRouter = require('./routes/alerts');
const makeVideoRouter = require('./routes/video');
const makePushRouter = require('./routes/push');
const makeAssetsRouter = require('./routes/assets');
const makeWorkOrdersRouter = require('./routes/workOrders');
const makeReportsRouter = require('./routes/reports');
const makeTwinRouter = require('./routes/twin');
const operationsRouter = require('./routes/operations');

const PORT = process.env.PORT || 4000;
const SIM_TICK_MS = Number(process.env.SIM_TICK_MS || 2000);

// ---------- bootstrap data ----------
seedUsersIfEmpty();
if (db.getZones().length === 0) {
  db.setZones(buildInitialZoneState());
  console.log(`[boot] Seeded ${ZONES.length} conveyor zones across the hilly-terrain route.`);
}
seedAssetsIfEmpty();
mlModel.loadArtifact();

// ---------- app / server / socket.io ----------
const app = express();
const server = http.createServer(app);

// Environment-configured CORS allowlist
const corsOriginEnv = process.env.CORS_ORIGIN;
// Same-origin is the secure default. Set CORS_ORIGIN explicitly only when a
// separately hosted frontend must call this API.
const corsOrigins = corsOriginEnv ? corsOriginEnv.split(',').map((s) => s.trim()).filter(Boolean) : false;

const io = new Server(server, {
  cors: {
    origin: corsOrigins,
    methods: ['GET', 'POST']
  }
});

// Production Security Headers with strict Content Security Policy
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://cdnjs.cloudflare.com'
        ],
        scriptSrcAttr: ["'none'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com'
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: []
      }
    }
  })
);

app.use(cors({ origin: corsOrigins }));
app.use(express.json({ limit: '2mb' }));

// Global API rate limit
app.use(
  '/api/',
  rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use(express.static(path.join(__dirname, '..', 'public')));

// Audit logging for state-changing operations
app.use('/api', (req, res, next) => {
  const method = req.method.toUpperCase();
  const authHeader = req.headers.authorization || '';
  if (!req.user && authHeader.startsWith('Bearer ')) {
    try {
      req.user = verifyToken(authHeader.slice(7));
    } catch (_) {}
  }
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || req.path === '/auth/login' || req.path.startsWith('/audit')) {
    return next();
  }
  const latestAuditBefore = db.getAudit(1)[0]?.id || null;
  res.on('finish', () => {
    if (!req.user) return;
    // Routes with domain-specific audit records should not receive a duplicate
    // generic record. Mutations without a dedicated audit record still get one.
    const latestAuditAfter = db.getAudit(1)[0]?.id || null;
    if (latestAuditAfter === latestAuditBefore) {
      const action = `${method} /api${req.path}`;
      const zoneMatch = req.path.match(/\/(?:zones|what-if|analyze|assets|work-orders|twin)\/([^/]+)/i);
      db.addAudit({
        id: require('uuid').v4(),
        at: new Date().toISOString(),
        actor: req.user.username || 'User',
        action,
        zoneId: zoneMatch ? decodeURIComponent(zoneMatch[1]) : null,
        detail: `${method} request completed with HTTP ${res.statusCode}${res.statusCode >= 400 ? ' (request failed)' : ''}`
      });
    }
    io.emit('audit:updated');
  });
  next();
});

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/what-if', (req, res, next) => {
  req.url = '/what-if' + req.url;
  aiRoutes(req, res, next);
});
app.use('/api/models', (req, res, next) => {
  req.url = '/models' + req.url;
  aiRoutes(req, res, next);
});
app.use('/api/zones', makeZonesRouter(io));
app.use('/api/alerts', makeAlertsRouter(io));
app.use('/api/video', makeVideoRouter(io));
app.use('/api/push', makePushRouter());
app.use('/api/assets', makeAssetsRouter(io));
app.use('/api/work-orders', makeWorkOrdersRouter(io));
app.use('/api/reports', makeReportsRouter());
app.use('/api/twin', makeTwinRouter(io));
app.use('/api/operations', operationsRouter);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
    zonesCount: db.getZones().length,
    assetsCount: db.getAssets().length,
    workOrdersCount: db.getWorkOrders().length,
    scenariosCount: db.getScenarios().length,
    mlModelReady: mlModel.ready,
    storageHealthy: true
  });
});

app.use((err, req, res, next) => {
  console.error('[server error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------- Socket.IO Authentication & Scoped Channels ----------
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Unauthorized: missing token'));
  try {
    socket.user = verifyToken(token);
    next();
  } catch (e) {
    next(new Error('Unauthorized: invalid token'));
  }
});

io.on('connection', (socket) => {
  // Join user-specific scoped room for private video and personal events
  const userRoom = `user:${socket.user.sub || socket.user.username}`;
  socket.join(userRoom);

  const enrichedZones = db.getZones().map((z) => {
    let latest = db.getReadings(z.id, 1)[0] || null;
    if (!latest) {
      latest = simulator.tickZone(z);
    }
    const risk = computeRisk(z, latest);
    const ml = mlModel.predict(z, latest);
    return {
      ...z,
      latestReading: latest,
      latestRisk: risk,
      latestMl: ml,
      riskScore: risk?.score ?? 0,
      riskLevel: risk?.level ?? 'NORMAL'
    };
  });
  socket.emit('zones:snapshot', { zones: enrichedZones });

  socket.on('disconnect', () => {});
});

// ---------- Simulation + Risk + Automation Loop ----------
function runTick() {
  const results = simulator.tickAll();

  const payload = [];
  for (const { zone, reading } of results) {
    const risk = computeRisk(zone, reading);
    const ml = mlModel.predict(zone, reading);
    const { alert, autoStopTriggered } = evaluateAutomation(zone, risk, reading, io);

    payload.push({
      zoneId: zone.id,
      reading,
      risk,
      ml,
      status: zone.status,
      autoStopTriggered,
      newAlert: alert || null
    });
  }

  io.emit('telemetry:tick', { at: new Date().toISOString(), zones: payload });
}

let tickInterval = null;

function startSimulation() {
  if (!tickInterval) {
    tickInterval = setInterval(runTick, SIM_TICK_MS);
    setTimeout(runTick, 400);
  }
}

function stopSimulation() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

// Graceful Shutdown
function handleShutdown(signal) {
  console.log(`[server] Received ${signal}. Flushing storage and shutting down gracefully...`);
  stopSimulation();
  db.flushSync();
  server.close(() => {
    console.log('[server] Closed HTTP & WebSocket server.');
    process.exit(0);
  });
}
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

if (require.main === module) {
  startSimulation();
  server.listen(PORT, () => {
    console.log('==================================================');
    console.log('  HillGuard - Conveyor Dislodgement Prevention System');
    console.log(`  Server running at http://localhost:${PORT}`);
    if (process.env.NODE_ENV !== 'production') {
      console.log('  Demo logins (dev only): admin / operator / viewer');
    }
    console.log('==================================================');
  });
}

module.exports = { app, server, io, startSimulation, stopSimulation };
