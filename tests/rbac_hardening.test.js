const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app } = require('../server/index');
const { issueToken } = require('../server/services/authService');
const db = require('../server/config/db');

let srv, base;
test.before(async () => {
  await new Promise((r) => { srv = http.createServer(app); srv.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${srv.address().port}`; r(); }); });
});
test.after(() => new Promise((r) => srv.close(r)));

const hdr = (role) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${issueToken({ id: role, username: role.toLowerCase(), role })}` });

test('VIEWER cannot save/delete twin scenarios or send test push', async () => {
  let r = await fetch(`${base}/api/twin/scenarios`, { method: 'POST', headers: hdr('VIEWER'), body: JSON.stringify({ name: 'x', params: {} }) });
  assert.equal(r.status, 403);
  r = await fetch(`${base}/api/twin/scenarios/abc`, { method: 'DELETE', headers: hdr('VIEWER') });
  assert.equal(r.status, 403);
  r = await fetch(`${base}/api/push/test`, { method: 'POST', headers: hdr('VIEWER') });
  assert.equal(r.status, 403);
});

test('OPERATOR gets 400 (not 500) for invalid scenario params', async () => {
  const r = await fetch(`${base}/api/twin/scenarios`, { method: 'POST', headers: hdr('OPERATOR'), body: JSON.stringify({ name: 'bad', params: { beltSpeed: 'abc' } }) });
  assert.ok([201, 400].includes(r.status), `unexpected ${r.status}`);
});

test('CSV export neutralises formula injection', async () => {
  const wo = db.getWorkOrders({ limit: 1 })[0];
  if (wo) { const orig = wo.title; wo.title = '=HYPERLINK("http://x")'; 
    const r = await fetch(`${base}/api/reports/export/work-orders.csv`, { headers: hdr('VIEWER') });
    const t = await r.text(); wo.title = orig;
    assert.ok(!t.includes(',"=HYPERLINK'), 'formula must be prefixed');
    assert.ok(t.includes(`"'=HYPERLINK`));
  }
});
