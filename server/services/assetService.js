/**
 * HillGuard Asset Registry Service
 * =================================
 * Manages industrial conveyor assets (motors, pulleys, belts, idler sets, sensors).
 * Tracks equipment specifications, operating parameters, and maintenance history.
 */

const { v4: uuid } = require('uuid');
const db = require('../config/db');

const INITIAL_ASSETS = [
  {
    id: 'asset-mot-01',
    zoneId: 'zone-b',
    zoneName: 'Zone B - Steep Climb',
    name: 'Primary Incline Drive Motor M-101',
    type: 'MOTOR',
    serialNumber: 'MOT-ABB-450KW-9821',
    manufacturer: 'ABB Heavy Industrial',
    ratedCapacity: '450 kW / 600 HP',
    installDate: '2023-04-12',
    status: 'OPERATIONAL',
    healthScore: 88,
    operatingHours: 14280,
    serviceIntervalHours: 4000,
    lastServiceDate: '2026-06-15',
    specifications: { voltage: '4160V', fullLoadAmps: '74A', coolingType: 'TEFC', ipRating: 'IP66' },
    maintenanceHistory: [
      { date: '2026-06-15', type: 'ROUTINE_INSPECTION', technician: 'operator', notes: 'Bearing re-lubricated with synthetic polyurea grease. Insulation resistance >100MΩ.' }
    ]
  },
  {
    id: 'asset-takeup-01',
    zoneId: 'zone-e',
    zoneName: 'Zone E - Valley Discharge',
    name: 'Gravity Take-Up Winch & Carriage TU-501',
    type: 'TAKE_UP',
    serialNumber: 'GTU-MARTIN-12T',
    manufacturer: 'Martin Sprocket & Gear',
    ratedCapacity: '12 Metric Ton Counterweight',
    installDate: '2022-11-20',
    status: 'OPERATIONAL',
    healthScore: 82,
    operatingHours: 19540,
    serviceIntervalHours: 2500,
    lastServiceDate: '2026-04-10',
    specifications: { travelDistanceM: 4.5, currentTravelPct: 62, sheaveDiameterMm: 600 },
    maintenanceHistory: [
      { date: '2026-04-10', type: 'CABLE_INSPECTION', technician: 'operator', notes: 'Wire rope inspected for broken strands; guides lubricated.' }
    ]
  },
  {
    id: 'asset-train-01',
    zoneId: 'zone-c',
    zoneName: 'Zone C - Switchback Curve',
    name: 'Curved Training Idler Bank TI-301..308',
    type: 'IDLERS',
    serialNumber: 'TRN-PROK-CEMA-E',
    manufacturer: 'PROK Conveyor Components',
    ratedCapacity: 'CEMA E Heavy Duty 35-deg',
    installDate: '2024-01-18',
    status: 'OPERATIONAL',
    healthScore: 76,
    operatingHours: 9800,
    serviceIntervalHours: 2000,
    lastServiceDate: '2026-07-02',
    specifications: { troughAngleDeg: 35, rollDiameterMm: 178, bearingType: '6308-2RS' },
    maintenanceHistory: [
      { date: '2026-07-02', type: 'ALIGNMENT_CHECK', technician: 'operator', notes: 'Re-centered guide rollers following switchback curvature survey.' }
    ]
  },
  {
    id: 'asset-truss-01',
    zoneId: 'zone-d',
    zoneName: 'Zone D - Ridge Descent',
    name: 'Ridge Structural Truss & Anchors TR-401',
    type: 'STRUCTURE',
    serialNumber: 'STR-CAT-TRUSS-400',
    manufacturer: 'Superior Industries',
    ratedCapacity: 'Wind Rating 140 km/h / Live Load 850 kg/m',
    installDate: '2022-09-05',
    status: 'OPERATIONAL',
    healthScore: 91,
    operatingHours: 22100,
    serviceIntervalHours: 8000,
    lastServiceDate: '2025-10-14',
    specifications: { spanLengthM: 36, expansionJoints: 4 },
    maintenanceHistory: [
      { date: '2025-10-14', type: 'STRUCTURAL_SURVEY', technician: 'admin', notes: 'Torqued high-strength anchor bolts; no structural fatigue detected.' }
    ]
  },
  {
    id: 'asset-chute-01',
    zoneId: 'zone-a',
    zoneName: 'Zone A - Foothill Approach',
    name: 'Centering Loading Chute & Skirtboard LC-101',
    type: 'CHUTE',
    serialNumber: 'CHT-BENETECH-MAXFLOW',
    manufacturer: 'Benetech Transfer Solutions',
    ratedCapacity: '3500 Metric TPH Peak Feed',
    installDate: '2023-08-30',
    status: 'OPERATIONAL',
    healthScore: 84,
    operatingHours: 12400,
    serviceIntervalHours: 1500,
    lastServiceDate: '2026-08-20',
    specifications: { wearLinerType: 'Chromium Carbide Overlay', skirtLengthM: 12 },
    maintenanceHistory: [
      { date: '2026-08-20', type: 'LINER_REPLACEMENT', technician: 'operator', notes: 'Replaced impact zone wear tiles; adjusted polyurethane skirt seals.' }
    ]
  }
];

function seedAssetsIfEmpty() {
  if (db.getAssets().length === 0) {
    db.setAssets(INITIAL_ASSETS);
    console.log(`[assets] Seeded ${INITIAL_ASSETS.length} conveyor infrastructure assets.`);
  }
}

function getAllAssets(filterZone = null) {
  seedAssetsIfEmpty();
  return db.getAssets(filterZone);
}

function getAssetById(id) {
  seedAssetsIfEmpty();
  return db.getAsset(id);
}

function createAsset(data, createdBy) {
  seedAssetsIfEmpty();
  const asset = {
    id: data.id || `asset-${uuid().slice(0, 8)}`,
    zoneId: data.zoneId,
    zoneName: data.zoneName || data.zoneId,
    name: data.name,
    type: data.type || 'EQUIPMENT',
    serialNumber: data.serialNumber || 'N/A',
    manufacturer: data.manufacturer || 'Standard',
    ratedCapacity: data.ratedCapacity || 'Rated',
    installDate: data.installDate || new Date().toISOString().slice(0, 10),
    status: data.status || 'OPERATIONAL',
    healthScore: Number(data.healthScore ?? 100),
    operatingHours: Number(data.operatingHours ?? 0),
    serviceIntervalHours: Number(data.serviceIntervalHours ?? 2000),
    lastServiceDate: data.lastServiceDate || new Date().toISOString().slice(0, 10),
    specifications: data.specifications || {},
    maintenanceHistory: [],
    createdBy,
    createdAt: new Date().toISOString()
  };
  db.addAsset(asset);
  return asset;
}

function addMaintenanceRecord(assetId, record, actor) {
  const asset = getAssetById(assetId);
  if (!asset) return null;
  if (!Array.isArray(asset.maintenanceHistory)) asset.maintenanceHistory = [];
  const entry = {
    id: uuid(),
    date: new Date().toISOString().slice(0, 10),
    type: record.type || 'SERVICE',
    technician: actor || 'operator',
    notes: record.notes || 'Routine maintenance performed',
    timestamp: new Date().toISOString()
  };
  asset.maintenanceHistory.unshift(entry);
  asset.lastServiceDate = entry.date;
  db.updateAsset(asset.id, {
    maintenanceHistory: asset.maintenanceHistory,
    lastServiceDate: asset.lastServiceDate
  });
  return entry;
}

module.exports = {
  seedAssetsIfEmpty,
  getAllAssets,
  getAssetById,
  createAsset,
  addMaintenanceRecord
};
