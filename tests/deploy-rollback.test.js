'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeInstance } = require('./helpers');

let t;
before(async () => { t = await makeInstance(); });
after(async () => { await t.cleanup(); });
const state = async () => (await t.call('GET', '/api/state')).json;

test('deploy is refused without a pipeline run', async () => {
  const r = await t.call('POST', '/api/deploy', { version: '1.0.0' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /pipeline/i);
  assert.equal((await state()).activeVersion, '0.9.0');
});

test('deploy is refused when the release gate blocked the version', async () => {
  await t.call('POST', '/api/pipeline/run', { version: '1.2.0' });
  const r = await t.call('POST', '/api/deploy', { version: '1.2.0' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /BLOCKED/);
  assert.equal((await state()).activeVersion, '0.9.0');
});

test('rollback with no previous version is an honest error', async () => {
  const r = await t.call('POST', '/api/rollback');
  assert.equal(r.status, 409);
});

test('full scenario: pipeline -> deploy -> health -> failure -> incident -> rollback -> recovery', async () => {
  assert.equal((await t.call('POST', '/api/pipeline/run', { version: '1.0.0' })).json.run.deployPermitted, true);

  const dep = await t.call('POST', '/api/deploy', { version: '1.0.0' });
  assert.equal(dep.status, 200);
  assert.equal(dep.json.deployment.result, 'success');
  assert.equal(dep.json.deployment.health, 'healthy');
  assert.ok(dep.json.deployment.pipelineRunId);
  // the live shop really changed
  const live = await t.shopProducts();
  assert.equal(live.version, '1.0.0'); assert.equal(live.products.length, 6);

  const h1 = (await t.call('POST', '/api/health/check')).json.check;
  assert.equal(h1.status, 'healthy'); assert.ok(h1.responseMs >= 0); assert.equal(h1.version, '1.0.0');

  const sim = await t.call('POST', '/api/failure/simulate');
  assert.equal(sim.status, 200);
  const h2 = (await t.call('POST', '/api/health/check')).json.check;
  assert.equal(h2.status, 'unhealthy'); assert.equal(h2.statusCode, 503); assert.equal(h2.simulated, true);
  let s = await state();
  assert.equal(s.incidents.length, 1);
  assert.equal(s.incidents[0].status, 'open'); assert.equal(s.incidents[0].simulated, true);
  assert.equal(s.failure.active, true);

  const rb = await t.call('POST', '/api/rollback');
  assert.equal(rb.status, 200);
  assert.equal(rb.json.deployment.type, 'rollback');
  assert.equal(rb.json.deployment.version, '0.9.0');
  assert.equal(rb.json.deployment.health, 'healthy');
  s = await state();
  assert.equal(s.activeVersion, '0.9.0');
  assert.equal(s.failure.active, false);
  assert.equal(s.incidents[0].status, 'resolved');
  assert.equal(s.deployments[0].type, 'rollback');
  // the live shop really serves the restored release
  assert.equal((await t.shopProducts()).version, '0.9.0');

  const h3 = (await t.call('POST', '/api/health/check')).json.check;
  assert.equal(h3.status, 'healthy'); assert.equal(h3.version, '0.9.0');
});

test('rollback fails honestly when the previous release is missing (state unchanged)', async () => {
  await t.call('POST', '/api/pipeline/run', { version: '1.1.0' });
  assert.equal((await t.call('POST', '/api/deploy', { version: '1.1.0' })).status, 200);
  fs.unlinkSync(path.join(t.releasesDir, '0.9.0.json'));
  const r = await t.call('POST', '/api/rollback');
  assert.equal(r.status, 500);
  assert.match(r.json.error, /failed/i);
  const s = await state();
  assert.equal(s.activeVersion, '1.1.0');
  assert.equal(s.deployments[0].result, 'failed');
  assert.equal(s.deployments[0].type, 'rollback');
});

test('overlapping operations cannot corrupt state', async () => {
  await t.call('POST', '/api/reset');
  await t.call('POST', '/api/pipeline/run', { version: '1.0.0' });
  await t.call('POST', '/api/pipeline/run', { version: '1.1.0' }).catch(() => {});
  const results = await Promise.all([
    t.call('POST', '/api/deploy', { version: '1.0.0' }),
    t.call('POST', '/api/deploy', { version: '1.1.0' }),
    t.call('POST', '/api/rollback'),
  ]);
  results.forEach((r) => assert.ok([200, 409].includes(r.status), 'unexpected status ' + r.status));
  assert.ok(results.some((r) => r.status === 409), 'at least one overlapping call must be rejected');
  const s = await state();
  assert.equal(s.busy, null);
  assert.ok(['0.9.0', '1.0.0', '1.1.0'].includes(s.activeVersion));
});

test('reset restores the initial demonstration state', async () => {
  const r = await t.call('POST', '/api/reset');
  assert.equal(r.status, 200);
  const s = await state();
  assert.equal(s.activeVersion, '0.9.0');
  assert.equal(s.pipelineRuns.length, 0);
  assert.equal(s.incidents.length, 0);
  assert.equal(s.healthChecks.length, 0);
  assert.equal(s.failure.active, false);
  assert.equal(s.deployments.length, 1);
});

test('health check reports unhealthy when the shop is unreachable', async () => {
  await t.call('POST', '/api/reset');
  t.inst.ctx.shopPort = 1; // nothing listens here
  const c = (await t.call('POST', '/api/health/check')).json.check;
  assert.equal(c.status, 'unhealthy');
  assert.equal(c.simulated, false);
  assert.ok(c.error);
  t.inst.ctx.shopPort = Number(new URL(t.info.shopUrl).port);
});
