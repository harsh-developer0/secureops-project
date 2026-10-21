'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeInstance } = require('./helpers');

let t;
before(async () => { t = await makeInstance(); });
after(async () => { await t.cleanup(); });

test('pipeline for a safe release passes every stage and permits deployment', async () => {
  const { status, json } = await t.call('POST', '/api/pipeline/run', { version: '1.0.0' });
  assert.equal(status, 200);
  const run = json.run;
  assert.equal(run.status, 'passed');
  assert.equal(run.deployPermitted, true);
  assert.deepEqual(run.stages.map((s) => s.key), ['validate', 'tests', 'security', 'gate', 'record']);
  assert.ok(['passed', 'warning'].includes(run.stages[2].status));
  assert.equal(run.stages[0].status, 'passed');
  assert.equal(run.stages[1].status, 'passed');
  assert.ok(run.stages[1].logs.some((l) => l.startsWith('PASS')));
});

test('release gate blocks the unsafe fixture release (hard-coded fake key + debug mode)', async () => {
  const { json } = await t.call('POST', '/api/pipeline/run', { version: '1.2.0' });
  const run = json.run;
  assert.equal(run.status, 'failed');
  assert.equal(run.deployPermitted, false);
  assert.equal(run.stages.find((s) => s.key === 'security').status, 'failed');
  assert.equal(run.stages.find((s) => s.key === 'gate').status, 'failed');
  // the credential-like value must never be displayed
  assert.ok(!JSON.stringify(json).includes('DEMO-FAKE-KEY'));
});

test('pipeline fails validation (and skips later stages) for a broken manifest', async () => {
  const fs = require('fs'), path = require('path');
  fs.writeFileSync(path.join(t.releasesDir, '2.0.0.json'), JSON.stringify({ version: '2.0.0', products: [] }));
  const { json } = await t.call('POST', '/api/pipeline/run', { version: '2.0.0' });
  assert.equal(json.run.stages[0].status, 'failed');
  assert.equal(json.run.stages[1].status, 'skipped');
  assert.equal(json.run.deployPermitted, false);
});

test('standalone security check reports checks, severities and blocking', async () => {
  const bad = (await t.call('POST', '/api/security/run', { version: '1.2.0' })).json.security;
  assert.equal(bad.blocked, true);
  const sec01 = bad.checks.find((c) => c.id === 'SEC-01');
  assert.equal(sec01.status, 'fail'); assert.equal(sec01.severity, 'high'); assert.equal(sec01.blocksDeployment, true);
  const good = (await t.call('POST', '/api/security/run', { version: '1.1.0' })).json.security;
  assert.equal(good.blocked, false);
  assert.equal(good.checks.find((c) => c.id === 'SEC-05').status, 'skipped');
});

test('results persist across a restart', async () => {
  const { makeInstance: mk } = require('./helpers');
  await t.inst.stop();
  const again = await mk({ dataFile: t.dataFile });
  const state = (await again.call('GET', '/api/state')).json;
  assert.ok(state.pipelineRuns.length >= 3);
  assert.ok(state.latestSecurity);
  await again.inst.stop();
  t.info = await t.inst.start(); // restart original so after() can clean up
});
