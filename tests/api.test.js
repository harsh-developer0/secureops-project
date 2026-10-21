'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeInstance } = require('./helpers');

let t;
before(async () => { t = await makeInstance(); });
after(async () => { await t.cleanup(); });

test('GET /api/ping and /api/state return the initial demo state', async () => {
  assert.equal((await t.call('GET', '/api/ping')).json.ok, true);
  const { status, json } = await t.call('GET', '/api/state');
  assert.equal(status, 200);
  assert.equal(json.activeVersion, '0.9.0');
  assert.equal(json.failure.active, false);
  assert.equal(json.canRollback, false);
  assert.ok(json.releases.length >= 4);
  assert.equal(json.deployments[0].type, 'initial');
});

test('dashboard page and sample shop are both served', async () => {
  const dash = await fetch(t.info.dashboardUrl + '/');
  assert.equal(dash.status, 200);
  assert.match(await dash.text(), /SecureOps/);
  const shop = await fetch(t.info.shopUrl + '/');
  assert.equal(shop.status, 200);
  assert.match(await shop.text(), /Add to Cart|SecureShop/);
  const products = await t.shopProducts();
  assert.equal(products.version, '0.9.0');
  assert.equal(products.products.length, 4);
});

test('input validation rejects bad versions', async () => {
  assert.equal((await t.call('POST', '/api/pipeline/run', {})).status, 400);
  assert.equal((await t.call('POST', '/api/pipeline/run', { version: '../../etc/passwd' })).status, 400);
  assert.equal((await t.call('POST', '/api/deploy', { version: '9.9.9' })).status, 404);
  assert.equal((await t.call('POST', '/api/security/run', { version: 5 })).status, 400);
});

test('malformed JSON gets a 400 and unknown API routes a 404', async () => {
  const res = await fetch(t.info.dashboardUrl + '/api/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(res.status, 400);
  assert.equal((await t.call('GET', '/api/nope')).status, 404);
});

test('cross-origin POST requests are rejected', async () => {
  const res = await fetch(t.info.dashboardUrl + '/api/reset', { method: 'POST', headers: { Origin: 'http://evil.example' } });
  assert.equal(res.status, 403);
});

test('security headers are present on both apps', async () => {
  for (const url of [t.info.dashboardUrl, t.info.shopUrl]) {
    const r = await fetch(url + '/');
    assert.ok(r.headers.get('content-security-policy'));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-powered-by'), null);
  }
});
