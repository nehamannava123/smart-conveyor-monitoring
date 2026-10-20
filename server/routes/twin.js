/**
 * HillGuard Digital Twin API Routes
 * =================================
 * Provides conveyor assembly topology, physics scenario simulation,
 * baseline vs. modified comparisons, and persistent scenario experiment management.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const {
  PARAM_BOUNDS,
  FAULT_CONDITIONS,
  solveConveyorPhysics,
  compareScenarios
} = require('../services/twinPhysics');

function makeTwinRouter(io = null) {
  const router = express.Router();

  // Conveyor Assembly Topological Model
  const ASSEMBLY_MODEL = {
    system: 'Overland Downhill Regenerative Conveyor (Curve 4R)',
    totalLengthMeters: 3200,
    nominalCapacityTph: 2500,
    beltWidthMm: 1200,
    troughingAngleDeg: 35,
    components: [
      {
        id: 'comp-motor-a',
        tag: 'MTR-01A',
        name: 'Primary Variable Frequency Drive Motor',
        type: 'DRIVE_MOTOR',
        zoneId: 'zone-a',
        specs: { ratingKw: 550, voltageV: 690, rpm: 1485, bearingType: 'SKF 22320 Spherical Roller' },
        coordinates: { x: 50, y: 180, z: 20 }
      },
      {
        id: 'comp-pulley-head',
        tag: 'PLY-HD-01',
        name: 'Head Drive Pulley',
        type: 'DRIVE_PULLEY',
        zoneId: 'zone-a',
        specs: { diameterMm: 800, faceWidthMm: 1400, lagging: '12mm Ceramic Lagging' },
        coordinates: { x: 75, y: 175, z: 22 }
      },
      {
        id: 'comp-idlers-curve-b',
        tag: 'IDL-CRV-B',
        name: 'Transition Curved Idler Bank 1',
        type: 'TROUGHING_IDLER_BANK',
        zoneId: 'zone-b',
        specs: { rollDiaMm: 152, bearing: '6308-2RS', spacingM: 1.2, rollAngleDeg: 35 },
        coordinates: { x: 250, y: 160, z: 12 }
      },
      {
        id: 'comp-idlers-curve-c',
        tag: 'IDL-CRV-C',
        name: 'Severe Incline Curved Training Idlers',
        type: 'TRAINING_IDLER_BANK',
        zoneId: 'zone-c',
        specs: { rollDiaMm: 152, bearing: '6308-2RS', spacingM: 1.0, trainingMechanism: 'Pivoting Guide' },
        coordinates: { x: 450, y: 220, z: -15 }
      },
      {
        id: 'comp-takeup-winch',
        tag: 'TKP-WCH-01',
        name: 'Automated Hydraulic Take-Up Winch',
        type: 'TAKEUP_SYSTEM',
        zoneId: 'zone-d',
        specs: { strokeMeters: 4.5, nominalTensionKn: 80, carriageMassKg: 12000 },
        coordinates: { x: 650, y: 240, z: -35 }
      },
      {
        id: 'comp-truss-descent',
        tag: 'TRS-DSC-01',
        name: 'Downhill Overland Structural Truss',
        type: 'STRUCTURAL_TRUSS',
        zoneId: 'zone-e',
        specs: { spanMeters: 36, material: 'Hot-Dip Galvanized Structural Steel S355' },
        coordinates: { x: 800, y: 260, z: -60 }
      },
      {
        id: 'comp-pulley-tail',
        tag: 'PLY-TL-01',
        name: 'Tail Tension Pulley & Discharge Zone',
        type: 'TAIL_PULLEY',
        zoneId: 'zone-f',
        specs: { diameterMm: 630, faceWidthMm: 1400, bearing: 'SKF 22216' },
        coordinates: { x: 920, y: 280, z: -85 }
      }
    ],
    sensors: [
      { id: 'sns-opt-1', type: 'OPTICAL_ALIGNMENT', tag: 'OPT-01', zoneId: 'zone-a', channel: 'alignmentMm' },
      { id: 'sns-vib-1', type: 'TRI_AXIAL_VIB', tag: 'VIB-01', zoneId: 'zone-a', channel: 'vibrationMms' },
      { id: 'sns-opt-2', type: 'OPTICAL_ALIGNMENT', tag: 'OPT-02', zoneId: 'zone-b', channel: 'alignmentMm' },
      { id: 'sns-opt-3', type: 'OPTICAL_ALIGNMENT', tag: 'OPT-03', zoneId: 'zone-c', channel: 'alignmentMm' },
      { id: 'sns-vib-3', type: 'TRI_AXIAL_VIB', tag: 'VIB-03', zoneId: 'zone-c', channel: 'vibrationMms' },
      { id: 'sns-tkp-4', type: 'TENSION_LOADCELL', tag: 'TNS-04', zoneId: 'zone-d', channel: 'tensionPct' },
      { id: 'sns-spd-1', type: 'ENCODER_SPEED', tag: 'SPD-01', zoneId: 'zone-a', channel: 'slipPct' }
    ]
  };

  // GET /api/twin/assembly — returns 3D conveyor topology bound to live zone data
  router.get('/assembly', requireAuth, (req, res) => {
    const zones = db.getZones();
    const zoneMap = Object.fromEntries(zones.map((z) => [z.id, z]));

    // Bind current telemetry to components
    const componentsWithTelemetry = ASSEMBLY_MODEL.components.map((c) => {
      const z = zoneMap[c.zoneId] || {};
      const readings = db.getReadings(c.zoneId, 1);
      const latest = readings[0] || {};
      return {
        ...c,
        zoneName: z.name || c.zoneId,
        zoneStatus: z.status || 'NOMINAL',
        zoneRiskLevel: z.riskLevel || 'NORMAL',
        latestReading: latest,
        activeFault: z.activeFault || null
      };
    });

    res.json({
      assembly: {
        ...ASSEMBLY_MODEL,
        components: componentsWithTelemetry
      },
      parameterBounds: PARAM_BOUNDS,
      faultConditions: FAULT_CONDITIONS,
      updatedAt: new Date().toISOString()
    });
  });

  // POST /api/twin/simulate — run deterministic CEMA/ISO physics simulation for given params
  router.post('/simulate', requireAuth, (req, res) => {
    const params = req.body.params || req.body;
    const zoneId = req.body.zoneId || 'zone-c';
    const zone = db.getZone(zoneId) || null;

    try {
      const result = solveConveyorPhysics(params, zone);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: `Simulation failed: ${err.message}` });
    }
  });

  // POST /api/twin/compare — side-by-side comparison of baseline vs modified scenario
  router.post('/compare', requireAuth, (req, res) => {
    const { baseline, modified, zoneId } = req.body;
    if (!baseline || !modified) {
      return res.status(400).json({ error: 'Both baseline and modified parameters are required.' });
    }
    const zone = zoneId ? db.getZone(zoneId) : null;
    try {
      const result = compareScenarios(baseline, modified, zone);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: `Scenario comparison failed: ${err.message}` });
    }
  });

  // GET /api/twin/scenarios — list saved experiment records
  router.get('/scenarios', requireAuth, (req, res) => {
    res.json(db.getScenarios());
  });

  // POST /api/twin/scenarios — save an experiment scenario
  router.post('/scenarios', requireAuth, (req, res) => {
    const { name, notes, params, baselineParams } = req.body;
    if (!name || !params) {
      return res.status(400).json({ error: 'Scenario name and parameters are required.' });
    }

    const simulation = solveConveyorPhysics(params);
    let comparison = null;
    if (baselineParams) {
      comparison = compareScenarios(baselineParams, params);
    }

    const scenario = {
      id: uuidv4(),
      name: String(name).trim(),
      notes: notes || '',
      author: req.user?.username || 'engineer',
      createdAt: new Date().toISOString(),
      params: simulation.inputs,
      calculated: simulation.calculated,
      risk: simulation.risk,
      ml: simulation.ml,
      violations: simulation.violations,
      comparison: comparison?.deltas || null
    };

    db.saveScenario(scenario);
    res.status(201).json(scenario);
  });

  // DELETE /api/twin/scenarios/:id — delete a saved scenario
  router.delete('/scenarios/:id', requireAuth, (req, res) => {
    const ok = db.deleteScenario(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Scenario not found' });
    res.json({ message: 'Scenario deleted successfully' });
  });

  return router;
}

module.exports = makeTwinRouter;
