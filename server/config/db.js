/**
 * HillGuard hardened persistence layer.
 *
 * Implements atomic writes (write-to-temp + rename), automated backup snapshotting
 * (db.json.bak), corruption recovery, and immediate flush for critical data
 * (audit records, work orders, alert changes).
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', '..', 'data', 'db.json');
const BAK_FILE = path.join(__dirname, '..', '..', 'data', 'db.json.bak');
const MAX_HISTORY_PER_ZONE = 500; // rolling window cap per zone
const MAX_ALERTS = 1000;
const MAX_AUDIT = 1000;
const MAX_WORK_ORDERS = 1000;

function defaultData() {
  return {
    users: [],
    zones: [],
    assets: [],
    workOrders: [],
    readings: {}, // zoneId -> [reading,...] capped
    alerts: [],
    auditLog: [],
    pushSubscriptions: [],
    scenarios: []
  };
}

class JsonStore {
  constructor(file, bakFile = BAK_FILE) {
    this.file = file;
    this.bakFile = bakFile;
    this._dirty = false;
    this._isWriting = false;
    this._load();
    this._flushTimer = setInterval(() => this._flush(), 2000);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        this.data = JSON.parse(raw);
      } else if (fs.existsSync(this.bakFile)) {
        console.warn('[db] Primary store missing; recovering from backup snapshot.');
        const raw = fs.readFileSync(this.bakFile, 'utf8');
        this.data = JSON.parse(raw);
        this._dirty = true;
      } else {
        this.data = defaultData();
        this._dirty = true;
      }
      this._migrate();
    } catch (e) {
      console.error('[db] Error loading primary store:', e.message);
      if (fs.existsSync(this.bakFile)) {
        try {
          console.warn('[db] Recovering data from backup snapshot...');
          const rawBak = fs.readFileSync(this.bakFile, 'utf8');
          this.data = JSON.parse(rawBak);
          this._migrate();
          this._dirty = true;
          this.flushSync();
          return;
        } catch (bakErr) {
          console.error('[db] Backup recovery failed:', bakErr.message);
        }
      }
      this.data = defaultData();
      this._dirty = true;
      this.flushSync();
    }
  }

  _migrate() {
    if (!this.data || typeof this.data !== 'object') this.data = defaultData();
    if (!Array.isArray(this.data.users)) this.data.users = [];
    if (!Array.isArray(this.data.zones)) this.data.zones = [];
    if (!Array.isArray(this.data.assets)) this.data.assets = [];
    if (!Array.isArray(this.data.workOrders)) this.data.workOrders = [];
    if (!this.data.readings || typeof this.data.readings !== 'object') this.data.readings = {};
    if (!Array.isArray(this.data.alerts)) this.data.alerts = [];
    if (!Array.isArray(this.data.auditLog)) this.data.auditLog = [];
    if (!Array.isArray(this.data.pushSubscriptions)) this.data.pushSubscriptions = [];
    if (!Array.isArray(this.data.scenarios)) this.data.scenarios = [];
  }

  _writeAtomic() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const json = JSON.stringify(this.data, null, 2);

    fs.writeFileSync(tmp, json, 'utf8');
    // If target exists, update backup first
    if (fs.existsSync(this.file)) {
      try {
        fs.copyFileSync(this.file, this.bakFile);
      } catch (_) {}
    }
    // Retry loop for Windows EPERM / EBUSY locks
    let retries = 5;
    while (retries > 0) {
      try {
        fs.renameSync(tmp, this.file);
        return;
      } catch (renameErr) {
        if (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY') {
          try {
            fs.copyFileSync(tmp, this.file);
            try { fs.unlinkSync(tmp); } catch (_) {}
            return;
          } catch (copyErr) {
            retries--;
            if (retries === 0) {
              try { fs.unlinkSync(tmp); } catch (_) {}
              throw copyErr;
            }
            const waitTill = Date.now() + 20;
            while (Date.now() < waitTill) {}
          }
        } else {
          try { fs.unlinkSync(tmp); } catch (_) {}
          throw renameErr;
        }
      }
    }
  }

  _flush() {
    if (!this._dirty || this._isWriting) return;
    this._isWriting = true;
    try {
      this._writeAtomic();
      this._dirty = false;
    } catch (e) {
      console.error('[db] failed to persist store:', e.message);
    } finally {
      this._isWriting = false;
    }
  }

  flushSync() {
    this._isWriting = true;
    try {
      this._writeAtomic();
      this._dirty = false;
    } catch (e) {
      console.error('[db] synchronous flush failed:', e.message);
    } finally {
      this._isWriting = false;
    }
  }

  touch() {
    this._dirty = true;
  }

  // ---------- Users ----------
  getUsers() {
    return this.data.users;
  }
  findUserByUsername(username) {
    if (!username) return null;
    const norm = String(username).trim().toLowerCase();
    return this.data.users.find((u) => u.username.toLowerCase() === norm);
  }
  addUser(user) {
    this.data.users.push(user);
    this.touch();
    this.flushSync();
    return user;
  }
  updateUser(id, patch) {
    const u = this.data.users.find((x) => x.id === id);
    if (!u) return null;
    Object.assign(u, patch);
    this.touch();
    this.flushSync();
    return u;
  }

  // ---------- Zones ----------
  getZones() {
    return this.data.zones;
  }
  setZones(zones) {
    this.data.zones = zones;
    this.touch();
    this.flushSync();
  }
  getZone(id) {
    return this.data.zones.find((z) => z.id === id);
  }
  updateZone(id, patch) {
    const z = this.getZone(id);
    if (!z) return null;
    Object.assign(z, patch);
    this.touch();
    return z;
  }

  // ---------- Assets (Equipment Registry) ----------
  getAssets(zoneId = null) {
    if (zoneId) return this.data.assets.filter((a) => a.zoneId === zoneId);
    return this.data.assets;
  }
  getAsset(id) {
    return this.data.assets.find((a) => a.id === id);
  }
  setAssets(assets) {
    this.data.assets = assets;
    this.touch();
    this.flushSync();
  }
  addAsset(asset) {
    this.data.assets.push(asset);
    this.touch();
    this.flushSync();
    return asset;
  }
  updateAsset(id, patch) {
    const a = this.getAsset(id);
    if (!a) return null;
    Object.assign(a, patch);
    this.touch();
    this.flushSync();
    return a;
  }

  // ---------- Work Orders ----------
  getWorkOrders({ status, zoneId, assetId, limit = 200 } = {}) {
    let list = this.data.workOrders;
    if (status) list = list.filter((w) => w.status === status);
    if (zoneId) list = list.filter((w) => w.zoneId === zoneId);
    if (assetId) list = list.filter((w) => w.assetId === assetId);
    return list.slice(0, limit);
  }
  getWorkOrder(id) {
    return this.data.workOrders.find((w) => w.id === id);
  }
  addWorkOrder(order) {
    this.data.workOrders.unshift(order);
    if (this.data.workOrders.length > MAX_WORK_ORDERS) this.data.workOrders.pop();
    this.touch();
    this.flushSync();
    return order;
  }
  updateWorkOrder(id, patch) {
    const w = this.getWorkOrder(id);
    if (!w) return null;
    Object.assign(w, patch);
    this.touch();
    this.flushSync();
    return w;
  }

  // ---------- Readings (time series, capped ring buffer per zone) ----------
  addReading(zoneId, reading) {
    if (!this.data.readings[zoneId]) this.data.readings[zoneId] = [];
    const arr = this.data.readings[zoneId];
    arr.push(reading);
    if (arr.length > MAX_HISTORY_PER_ZONE) arr.shift();
    this.touch();
  }
  getReadings(zoneId, limit = 100) {
    const arr = this.data.readings[zoneId] || [];
    return arr.slice(Math.max(0, arr.length - limit));
  }

  // ---------- Alerts ----------
  addAlert(alert) {
    this.data.alerts.unshift(alert);
    if (this.data.alerts.length > MAX_ALERTS) this.data.alerts.pop();
    this.touch();
    this.flushSync();
    return alert;
  }
  getAlerts({ status, zoneId, limit = 200 } = {}) {
    let list = this.data.alerts;
    if (status) list = list.filter((a) => a.status === status);
    if (zoneId) list = list.filter((a) => a.zoneId === zoneId);
    return list.slice(0, limit);
  }
  getAlert(id) {
    return this.data.alerts.find((a) => a.id === id);
  }
  updateAlert(id, patch) {
    const a = this.getAlert(id);
    if (!a) return null;
    Object.assign(a, patch);
    this.touch();
    this.flushSync();
    return a;
  }

  // ---------- Audit log ----------
  addAudit(entry) {
    this.data.auditLog.unshift(entry);
    if (this.data.auditLog.length > MAX_AUDIT) this.data.auditLog.pop();
    this.touch();
    this.flushSync();
    return entry;
  }
  getAudit(limit = 300) {
    return this.data.auditLog.slice(0, limit);
  }

  // ---------- Push subscriptions ----------
  addPushSubscription(username, subscription) {
    this.data.pushSubscriptions = this.data.pushSubscriptions.filter(
      (s) => s.subscription.endpoint !== subscription.endpoint
    );
    const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, username, subscription, addedAt: Date.now() };
    this.data.pushSubscriptions.push(entry);
    this.touch();
    return entry;
  }
  removePushSubscriptionByEndpoint(endpoint) {
    const before = this.data.pushSubscriptions.length;
    this.data.pushSubscriptions = this.data.pushSubscriptions.filter(
      (s) => s.subscription.endpoint !== endpoint
    );
    this.touch();
    return before !== this.data.pushSubscriptions.length;
  }
  getPushSubscriptions() {
    return this.data.pushSubscriptions;
  }

  // ---------- Digital Twin Scenarios ----------
  getScenarios() {
    return this.data.scenarios || [];
  }
  getScenario(id) {
    return (this.data.scenarios || []).find((s) => s.id === id);
  }
  saveScenario(scenario) {
    if (!this.data.scenarios) this.data.scenarios = [];
    const idx = this.data.scenarios.findIndex((s) => s.id === scenario.id);
    if (idx >= 0) {
      this.data.scenarios[idx] = scenario;
    } else {
      this.data.scenarios.unshift(scenario);
      if (this.data.scenarios.length > 200) this.data.scenarios.pop();
    }
    this.touch();
    this.flushSync();
    return scenario;
  }
  deleteScenario(id) {
    if (!this.data.scenarios) return false;
    const initial = this.data.scenarios.length;
    this.data.scenarios = this.data.scenarios.filter((s) => s.id !== id);
    if (this.data.scenarios.length !== initial) {
      this.touch();
      this.flushSync();
      return true;
    }
    return false;
  }
}

module.exports = new JsonStore(DB_FILE, BAK_FILE);
module.exports.JsonStore = JsonStore;
module.exports.defaultData = defaultData;
