/**
 * HillGuard Automation & Alerting Engine (Hardened)
 * ==================================================
 * Responsibilities:
 *   - Evaluates risk assessments from riskEngine.
 *   - Manages alert lifecycle: creation, deduplication, suppression windows, and escalation.
 *   - Evaluates software-simulated safety interlocks (AUTO_STOP).
 *
 * SAFETY MANDATE:
 *   Automated actions performed here are SOFTWARE SIMULATIONS. HillGuard is an advisory
 *   condition-monitoring and predictive-maintenance application. It does NOT replace
 *   certified industrial emergency-stop safety systems (SIL/PL rated safety relays,
 *   pull-cord switches, or fail-safe PLCs).
 */

const { v4: uuid } = require('uuid');
const db = require('../config/db');
const push = require('./push');

const AUTO_STOP_THRESHOLD = Number(process.env.AUTO_STOP_THRESHOLD_TICKS || 3);
const AUTO_STOP_ENABLED = String(process.env.AUTO_STOP_ENABLED || 'false').toLowerCase() === 'true';
const ALERT_REPEAT_TICKS = Number(process.env.ALERT_REPEAT_TICKS || 6); // increased default to avoid flapping
const ALERT_SCORE_INCREASE = Number(process.env.ALERT_SCORE_INCREASE || 12);

function raiseAlertIfNeeded(zone, risk, reading, io) {
  if (!risk || risk.level === 'NORMAL') {
    return null;
  }

  const openAlerts = db.getAlerts({
    zoneId: zone.id,
    status: 'OPEN',
    limit: 20
  }) || [];

  zone.alertTickCounter = Number(zone.alertTickCounter || 0) + 1;

  const severityAlerts = openAlerts.filter((alert) => alert.level === risk.level);
  const lastAlert = severityAlerts.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )[0];

  const causeChanged = lastAlert && lastAlert.causeKey !== risk.primaryCauseKey;
  const scoreIncreased = lastAlert && Number(risk.score) >= Number(lastAlert.score || 0) + ALERT_SCORE_INCREASE;
  const enoughTicks = !lastAlert || zone.alertTickCounter >= ALERT_REPEAT_TICKS;

  // Suppress duplicate alert if within window, unless cause or severity changed
  if (lastAlert && lastAlert.causeKey === risk.primaryCauseKey && !scoreIncreased && !causeChanged && !enoughTicks) {
    return null;
  }

  zone.alertTickCounter = 0;

  const alert = {
    id: uuid(),
    zoneId: zone.id,
    zoneName: zone.name,
    level: risk.level,
    cause: risk.primaryCause,
    causeKey: risk.primaryCauseKey,
    score: Number(risk.score),
    message: `${risk.level} risk on ${zone.name}: ${risk.primaryCause} (score ${risk.score}/100)`,
    status: 'OPEN',
    createdAt: new Date().toISOString(),
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolvedBy: null,
    resolvedAt: null,
    workOrderId: null,
    snapshot: reading,
    contributors: risk.contributors || [],
    recommendedActions: risk.recommendedActions || []
  };

  db.addAlert(alert);

  if (io) {
    io.emit('alert:new', alert);
  }

  push.notifyAll(push.alertToPushPayload(alert, zone.name)).catch((err) => {
    console.error('[push] Notification send failed:', err.message);
  });

  return alert;
}

function evaluateAutomation(zone, risk, reading, io) {
  if (!zone || !risk) {
    return { alert: null, autoStopTriggered: false };
  }

  if (risk.level === 'CRITICAL') {
    zone.consecutiveCritical = Number(zone.consecutiveCritical || 0) + 1;
  } else {
    zone.consecutiveCritical = 0;
  }

  const alert = raiseAlertIfNeeded(zone, risk, reading, io);
  let autoStopTriggered = false;

  // Evaluate Software-Simulated Emergency Stop
  if (AUTO_STOP_ENABLED && zone.consecutiveCritical >= AUTO_STOP_THRESHOLD && zone.status === 'RUNNING') {
    zone.status = 'AUTO_STOPPED';
    zone.lastAction = 'AUTO_STOP_SIMULATED';
    zone.lastActionBy = 'system:automation';
    zone.lastActionAt = new Date().toISOString();
    autoStopTriggered = true;

    const stopAlert = {
      id: uuid(),
      zoneId: zone.id,
      zoneName: zone.name,
      level: 'CRITICAL',
      cause: risk.primaryCause,
      causeKey: risk.primaryCauseKey,
      score: Number(risk.score),
      message:
        `[SIMULATED INTERVENTION] Auto-stop command issued on ${zone.name} after ` +
        `${AUTO_STOP_THRESHOLD} consecutive critical ticks (${risk.primaryCause}). Advisory software simulation only.`,
      status: 'OPEN',
      createdAt: new Date().toISOString(),
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedBy: null,
      resolvedAt: null,
      workOrderId: null,
      snapshot: reading,
      automated: true,
      isSimulationOnly: true,
      contributors: risk.contributors || [],
      recommendedActions: risk.recommendedActions || []
    };

    db.addAlert(stopAlert);

    db.addAudit({
      id: uuid(),
      at: new Date().toISOString(),
      actor: 'system:automation',
      action: 'SIMULATED_AUTO_STOP',
      zoneId: zone.id,
      detail: `Simulated auto-stop triggered after ${AUTO_STOP_THRESHOLD} critical readings. Primary cause: ${risk.primaryCause} (score ${risk.score})`
    });

    if (io) {
      io.emit('alert:new', stopAlert);
      io.emit('automation:action', {
        zoneId: zone.id,
        action: 'SIMULATED_AUTO_STOP',
        reason: risk.primaryCause,
        isSimulationOnly: true,
        at: zone.lastActionAt
      });
    }

    push.notifyAll(push.alertToPushPayload(stopAlert, zone.name)).catch(() => {});
  }

  db.updateZone(zone.id, {
    riskScore: Number(risk.score),
    riskLevel: risk.level,
    consecutiveCritical: zone.consecutiveCritical,
    status: zone.status,
    lastAction: zone.lastAction,
    lastActionBy: zone.lastActionBy,
    lastActionAt: zone.lastActionAt
  });

  return { alert, autoStopTriggered };
}

module.exports = {
  evaluateAutomation,
  raiseAlertIfNeeded,
  AUTO_STOP_THRESHOLD,
  AUTO_STOP_ENABLED,
  ALERT_REPEAT_TICKS,
  ALERT_SCORE_INCREASE
};