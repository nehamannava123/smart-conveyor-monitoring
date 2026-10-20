const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { JsonStore } = require('../server/config/db');

test('persistence - atomic writes and data survival', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-test-db-'));
  const dbPath = path.join(tmpDir, 'test-db.json');
  const bakPath = path.join(tmpDir, 'test-db.json.bak');

  try {
    const store1 = new JsonStore(dbPath, bakPath);
    store1.addUser({ id: 't1', username: 'testuser', role: 'OPERATOR' });
    store1.addAlert({ id: 'a1', level: 'WARNING', message: 'Test alert' });
    store1.flushSync();

    assert.ok(fs.existsSync(dbPath), 'Primary db file should exist');

    // Load with new instance to test survival
    const store2 = new JsonStore(dbPath, bakPath);
    const user = store2.findUserByUsername('testuser');
    assert.ok(user, 'User should survive restart');
    assert.equal(user.role, 'OPERATOR');

    const alerts = store2.getAlerts();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].id, 'a1');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('persistence - recovery from backup when primary file is corrupted', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-test-corrupt-'));
  const dbPath = path.join(tmpDir, 'test-db.json');
  const bakPath = path.join(tmpDir, 'test-db.json.bak');

  try {
    const store1 = new JsonStore(dbPath, bakPath);
    store1.addUser({ id: 'u-persist', username: 'persisted_user', role: 'ADMIN' });
    store1.flushSync();

    // Trigger backup creation by doing a second update
    store1.addAlert({ id: 'a-persist', level: 'CRITICAL', message: 'Before crash' });
    store1.flushSync();

    assert.ok(fs.existsSync(bakPath), 'Backup file should have been created');

    // Simulate unexpected catastrophic corruption of primary file (e.g. truncated JSON)
    fs.writeFileSync(dbPath, '{ "corrupted": [unparseable-data...', 'utf8');

    // Reopen store
    const store2 = new JsonStore(dbPath, bakPath);
    const user = store2.findUserByUsername('persisted_user');
    assert.ok(user, 'Should successfully recover user from backup file when primary is corrupted');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
