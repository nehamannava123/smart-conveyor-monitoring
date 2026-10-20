const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');

test('frontend integrity - command-center and sensor telemetry UI are present', () => {
  for (const id of [
    'dashboardOverview', 'kpiZones', 'kpiRunning', 'kpiElevated', 'kpiAlerts',
    'kpiTelemetry', 'sensorSnapshotGrid', 'sensorSampleTime', 'detailRiskScore', 'alignChart'
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `Missing required dashboard element: ${id}`);
  }
  assert.match(js, /function renderDashboardOverview\s*\(/);
  assert.match(js, /function renderSensorSnapshot\s*\(/);
});

test('frontend integrity - dynamic controls respect strict CSP event-handler policy', () => {
  assert.match(server, /scriptSrcAttr:\s*\["'none'"\]/);
  assert.doesNotMatch(html, /\bon(?:click|change|input|submit)\s*=\s*[\"']/i);
  assert.doesNotMatch(js, /\bon(?:click|change|input|submit)\s*=\s*[\"']/i);
  assert.match(js, /data-wo-status/);
  assert.match(js, /data-wo-checklist/);
  assert.match(js, /data-scenario-load/);
  assert.match(js, /data-scenario-delete/);
});


test('frontend integrity - persistent theme toggle and zone-aware digital twin are present', () => {
  assert.match(html, /id=["']themeToggle["']/);
  assert.match(js, /function applyTheme\s*\(/);
  assert.match(js, /localStorage\.setItem\('hg_theme'/);
  assert.match(html, /id=["']twinZoneSelect["']/);
  assert.match(js, /function applyZoneToTwinScenario\s*\(/);
  assert.match(js, /data-twin-zone/);
  assert.match(html, /twin-active-context/);
  assert.match(js, /zoneId: 'zone-e'/);
});
