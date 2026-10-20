/**
 * HillGuard Reporting & Operational Analytics Router
 * ==================================================
 * Provides aggregated operational metrics, maintenance backlog summaries,
 * and structured CSV export endpoints for compliance and auditing.
 */

const express = require('express');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { model: mlModel } = require('../services/mlPredictor');

module.exports = function reportsRouter() {
  const router = express.Router();

  router.get('/summary', requireAuth, (req, res) => {
    const alerts = db.getAlerts({ limit: 1000 });
    const workOrders = db.getWorkOrders({ limit: 1000 });
    const zones = db.getZones();
    const assets = db.getAssets();

    // Alert metrics
    const totalAlerts = alerts.length;
    const criticalAlerts = alerts.filter((a) => a.level === 'CRITICAL').length;
    const warningAlerts = alerts.filter((a) => a.level === 'WARNING').length;
    const resolvedAlerts = alerts.filter((a) => a.status === 'RESOLVED');

    // Calculate approximate MTTR (Mean Time to Resolution)
    let totalResolutionTimeMs = 0;
    let resolvedCount = 0;
    for (const a of resolvedAlerts) {
      if (a.createdAt && a.resolvedAt) {
        const diff = new Date(a.resolvedAt).getTime() - new Date(a.createdAt).getTime();
        if (diff > 0) {
          totalResolutionTimeMs += diff;
          resolvedCount++;
        }
      }
    }
    const mttrMinutes = resolvedCount > 0 ? Math.round(totalResolutionTimeMs / (resolvedCount * 60000)) : null;

    // Fault distribution by cause
    const causeCounts = {};
    for (const a of alerts) {
      const cause = a.cause || 'Unknown';
      causeCounts[cause] = (causeCounts[cause] || 0) + 1;
    }

    // Work order backlog
    const woByStatus = {
      OPEN: workOrders.filter((w) => w.status === 'OPEN').length,
      ASSIGNED: workOrders.filter((w) => w.status === 'ASSIGNED').length,
      IN_PROGRESS: workOrders.filter((w) => w.status === 'IN_PROGRESS').length,
      AWAITING_PARTS: workOrders.filter((w) => w.status === 'AWAITING_PARTS').length,
      RESOLVED: workOrders.filter((w) => w.status === 'RESOLVED').length,
      CLOSED: workOrders.filter((w) => w.status === 'CLOSED').length
    };

    // Sensor telemetry health per zone
    const sensorHealth = zones.map((z) => {
      const readings = db.getReadings(z.id, 50);
      const quality = mlModel.checkDataQuality(readings[readings.length - 1]);
      return {
        zoneId: z.id,
        zoneName: z.name,
        readingsCount: readings.length,
        status: z.status,
        sensorQuality: quality.ok ? 'HEALTHY' : 'DEGRADED',
        qualityWarnings: quality.warnings
      };
    });

    res.json({
      generatedAt: new Date().toISOString(),
      systemStatus: {
        totalZones: zones.length,
        totalAssets: assets.length,
        activeAutoStops: zones.filter((z) => z.status === 'AUTO_STOPPED').length
      },
      alertMetrics: {
        total: totalAlerts,
        critical: criticalAlerts,
        warning: warningAlerts,
        open: alerts.filter((a) => a.status === 'OPEN').length,
        acknowledged: alerts.filter((a) => a.status === 'ACKNOWLEDGED').length,
        resolved: resolvedAlerts.length,
        mttrMinutes
      },
      faultDistribution: causeCounts,
      workOrderBacklog: {
        total: workOrders.length,
        byStatus: woByStatus,
        active: woByStatus.OPEN + woByStatus.ASSIGNED + woByStatus.IN_PROGRESS + woByStatus.AWAITING_PARTS
      },
      sensorHealth,
      mlModelStatus: mlModel.getMetrics()
    });
  });

  // CSV Export: Alerts
  router.get('/export/alerts.csv', requireAuth, (req, res) => {
    const alerts = db.getAlerts({ limit: 1000 });
    const headers = ['ID', 'CreatedAt', 'ZoneID', 'ZoneName', 'Level', 'Cause', 'Score', 'Status', 'AcknowledgedBy', 'ResolvedBy', 'WorkOrderID'];
    const rows = alerts.map((a) => [
      `"${a.id}"`,
      `"${a.createdAt || ''}"`,
      `"${a.zoneId || ''}"`,
      `"${(a.zoneName || '').replace(/"/g, '""')}"`,
      `"${a.level || ''}"`,
      `"${(a.cause || '').replace(/"/g, '""')}"`,
      a.score ?? 0,
      `"${a.status || ''}"`,
      `"${a.acknowledgedBy || ''}"`,
      `"${a.resolvedBy || ''}"`,
      `"${a.workOrderId || ''}"`
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="HillGuard-Alerts-${Date.now()}.csv"`);
    res.send(csv);
  });

  // CSV Export: Work Orders
  router.get('/export/work-orders.csv', requireAuth, (req, res) => {
    const workOrders = db.getWorkOrders({ limit: 1000 });
    const headers = ['ID', 'CreatedAt', 'ZoneID', 'ZoneName', 'Title', 'Priority', 'Status', 'AssignedTechnician', 'OriginatingAlertID', 'ResolvedAt', 'ClosedAt'];
    const rows = workOrders.map((w) => [
      `"${w.id}"`,
      `"${w.createdAt || ''}"`,
      `"${w.zoneId || ''}"`,
      `"${(w.zoneName || '').replace(/"/g, '""')}"`,
      `"${(w.title || '').replace(/"/g, '""')}"`,
      `"${w.priority || ''}"`,
      `"${w.status || ''}"`,
      `"${w.assignedTechnician || ''}"`,
      `"${w.originatingAlertId || ''}"`,
      `"${w.resolvedAt || ''}"`,
      `"${w.closedAt || ''}"`
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="HillGuard-WorkOrders-${Date.now()}.csv"`);
    res.send(csv);
  });

  return router;
};
