const express = require('express');
const { requireAuth } = require('../middleware/auth');
const db = require('../config/db');
const { THRESHOLDS } = require('../services/riskEngine');
const { model: mlModel } = require('../services/mlPredictor');

const router = express.Router();
const CHANNELS = [
  { key: 'alignmentMm', label: 'Belt alignment', unit: 'mm', min: -120, max: 120, thresholdKey: 'alignment', calibration: 'NOT_CONFIGURED' },
  { key: 'vibrationMms', label: 'Vibration RMS', unit: 'mm/s', min: 0, max: 40, thresholdKey: 'vibration', calibration: 'NOT_CONFIGURED' },
  { key: 'tensionPct', label: 'Belt tension', unit: '%', min: 0, max: 110, thresholdKey: 'tension', calibration: 'NOT_CONFIGURED' },
  { key: 'slipPct', label: 'Drive slip', unit: '%', min: 0, max: 50, thresholdKey: 'slip', calibration: 'NOT_CONFIGURED' },
  { key: 'loadPct', label: 'Material load', unit: '%', min: 0, max: 150, thresholdKey: 'load', calibration: 'NOT_CONFIGURED' },
  { key: 'tempC', label: 'Motor temperature', unit: '°C', min: -20, max: 150, thresholdKey: 'temp', calibration: 'NOT_CONFIGURED' }
];

router.get('/sensor-health', requireAuth, (req, res) => {
  const now = Date.now();
  const sensors = [];
  for (const zone of db.getZones()) {
    const readings = db.getReadings(zone.id, 1);
    const latest = readings[0] || null;
    const ageMs = latest?.ts ? Math.max(0, now - Number(latest.ts)) : null;
    for (const channel of CHANNELS) {
      const value = latest?.[channel.key];
      const missing = value === null || value === undefined || !Number.isFinite(Number(value));
      const stale = ageMs === null || ageMs > 10000;
      const outOfRange = !missing && (Number(value) < channel.min || Number(value) > channel.max);
      const threshold = THRESHOLDS[channel.thresholdKey];
      const status = missing ? 'MISSING' : stale ? 'STALE' : outOfRange ? 'OUT_OF_RANGE' : 'ONLINE';
      sensors.push({
        id: `${zone.id}:${channel.key}`, zoneId: zone.id, zoneName: zone.name,
        channel: channel.key, label: channel.label, unit: channel.unit,
        value: missing ? null : Number(value), lastSeen: latest?.ts ? new Date(latest.ts).toISOString() : null,
        ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000), status,
        missing, stale, outOfRange, communicationStatus: latest ? (stale ? 'NO_RECENT_TELEMETRY' : 'REPORTING') : 'NO_DATA',
        calibrationStatus: channel.calibration, validRange: { min: channel.min, max: channel.max },
        warningThreshold: threshold ? threshold.warn : null, criticalThreshold: threshold ? threshold.crit : null
      });
    }
  }
  const counts = sensors.reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {});
  const dataQualityIncidents = [];
  for (const zone of db.getZones()) {
    const history = db.getReadings(zone.id, 500).slice().sort((a, b) => Number(a.ts) - Number(b.ts));
    for (let i = 0; i < history.length; i++) {
      const r = history[i];
      if (i > 0 && Number(r.ts) - Number(history[i - 1].ts) > 10000) dataQualityIncidents.push({ at: new Date((Number(history[i - 1].ts) || now) + 10000).toISOString(), zoneId: zone.id, zoneName: zone.name, channel: 'telemetry', type: 'STALE_GAP', detail: `Telemetry gap of ${Math.round((Number(r.ts) - Number(history[i - 1].ts)) / 1000)} seconds`, severity: 'WARNING' });
      for (const ch of CHANNELS) {
        const v = r[ch.key];
        if (v === null || v === undefined || !Number.isFinite(Number(v))) dataQualityIncidents.push({ at: new Date(Number(r.ts) || now).toISOString(), zoneId: zone.id, zoneName: zone.name, channel: ch.key, type: 'MISSING_VALUE', detail: `${ch.label} value missing or non-numeric`, severity: 'WARNING' });
        else if (Number(v) < ch.min || Number(v) > ch.max) dataQualityIncidents.push({ at: new Date(Number(r.ts) || now).toISOString(), zoneId: zone.id, zoneName: zone.name, channel: ch.key, type: 'OUT_OF_RANGE', detail: `${ch.label} value ${v} outside ${ch.min}–${ch.max} ${ch.unit}`, severity: 'CRITICAL' });
      }
    }
  }
  dataQualityIncidents.sort((a,b)=>new Date(b.at)-new Date(a.at));
  const healthy = sensors.filter(s => s.status === 'ONLINE').length;
  res.json({ generatedAt: new Date(now).toISOString(), staleAfterSeconds: 10, total: sensors.length, healthy, healthPercent: sensors.length ? Math.round(healthy / sensors.length * 100) : 0, counts, sensors, dataQualityIncidents: dataQualityIncidents.slice(0, 100), calibrationNotice: 'Calibration dates and calibration certificates are not configured in this prototype; NOT_CONFIGURED is reported honestly rather than assumed calibrated.' });
});

router.get('/incident/:id', requireAuth, (req, res) => {
  const alert = db.getAlert(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Incident not found' });
  const zone = db.getZone(alert.zoneId);
  const all = db.getReadings(alert.zoneId, 500).slice().sort((a, b) => Number(a.ts) - Number(b.ts));
  const eventTs = new Date(alert.createdAt).getTime();
  const snapshotTs = Number(alert.snapshot?.ts || eventTs);
  const nearestIndex = all.reduce((best, r, i) => Math.abs(Number(r.ts) - snapshotTs) < Math.abs(Number(all[best]?.ts || 0) - snapshotTs) ? i : best, 0);
  const start = Math.max(0, nearestIndex - 15), end = Math.min(all.length, nearestIndex + 16);
  const readings = all.slice(start, end).map(reading => ({ ...reading, risk: reading.riskSnapshot || null }));
  const workOrder = alert.workOrderId ? db.getWorkOrder(alert.workOrderId) : db.getWorkOrders({ zoneId: alert.zoneId, limit: 200 }).find(w => w.originatingAlertId === alert.id) || null;
  const currentRisk = { score: alert.score, level: alert.level, primaryCause: alert.cause, primaryCauseKey: alert.causeKey, contributors: alert.contributors || [], recommendedActions: alert.recommendedActions || [], thresholds: THRESHOLDS, evaluatedAt: alert.createdAt };
  const ml = zone && alert.snapshot ? mlModel.predict(zone, alert.snapshot) : null;
  res.json({ incident: alert, zone, readings, workOrder, latestReading: db.getReadings(alert.zoneId, 1)[0] || null, riskEvidence: currentRisk, modelPrediction: ml, diagnosisNotice: 'Probable causes and model outputs are advisory. Confirm the physical condition through inspection; synthetic evaluation is not field validation.' });
});

router.get('/history/:zoneId', requireAuth, (req, res) => {
  const zone = db.getZone(req.params.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });
  const from = req.query.from ? new Date(req.query.from).getTime() : 0;
  const to = req.query.to ? new Date(req.query.to).getTime() : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return res.status(400).json({ error: 'Invalid from/to date range' });
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 500));
  const readings = db.getReadings(zone.id, 500).filter(r => Number(r.ts) >= from && Number(r.ts) <= to).slice(-limit).map(r => ({ ...r, risk: r.riskSnapshot || null }));
  const alerts = db.getAlerts({ zoneId: zone.id, limit: 500 }).filter(a => { const t = new Date(a.createdAt).getTime(); return t >= from && t <= to; });
  res.json({ zoneId: zone.id, zoneName: zone.name, from: from || null, to, retentionLimit: 500, readings, alerts, replayAvailable: readings.length > 0, note: 'Historical replay is limited to the currently retained rolling buffer; older readings may no longer be available.' });
});

module.exports = router;
