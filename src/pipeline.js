'use strict';
// A real, local pipeline: validate -> test -> security -> release gate -> record.
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const { readRelease, validateManifest } = require('./releases');
const { startShop } = require('./shop/app');
const { getJson } = require('./http');
const cart = require('./shop/cart');
const { runSecurityChecks, recordSecurity } = require('./security');

async function execStage(run, key, name, fn) {
  const stage = { key, name, status: 'running', logs: [], durationMs: 0 };
  run.stages.push(stage);
  const t0 = Date.now();
  const log = (m) => stage.logs.push(m);
  try {
    const r = await fn(log);
    stage.status = r.status || (r.ok ? 'passed' : 'failed');
    stage.data = r.data;
  } catch (e) {
    stage.status = 'failed';
    log('ERROR: ' + e.message);
  }
  stage.durationMs = Date.now() - t0;
  return stage;
}

function skipped(run, key, name, why) {
  run.stages.push({ key, name, status: 'skipped', logs: ['Skipped: ' + why], durationMs: 0 });
}

async function validateStage(ctx, version, log) {
  const { config } = ctx;
  let ok = true;
  const required = ['package.json', 'server.js', 'public/dashboard/index.html', 'public/shop/index.html', 'src/shop/cart.js'];
  for (const f of required) {
    const there = fs.existsSync(path.join(config.root, f));
    log((there ? 'OK      ' : 'MISSING ') + f);
    ok = ok && there;
  }
  const rel = readRelease(config.releasesDir, version);
  let manifest = null;
  if (!rel.manifest) {
    log('MISSING/INVALID releases/' + version + '.json (' + rel.error + ')');
    ok = false;
  } else {
    manifest = rel.manifest;
    const problems = validateManifest(manifest, version);
    if (problems.length) { problems.forEach((p) => log('INVALID manifest: ' + p)); ok = false; }
    else log('OK      release manifest ' + version + ' is valid (' + manifest.products.length + ' products)');
  }
  for (const [name, p] of [['dashboard port', config.dashboardPort], ['shop port', config.shopPort]]) {
    const good = Number.isInteger(p) && p >= 0 && p <= 65535;
    log((good ? 'OK      ' : 'INVALID ') + 'configuration: ' + name + ' = ' + p);
    ok = ok && good;
  }
  try {
    fs.accessSync(path.dirname(config.dataFile), fs.constants.W_OK);
    log('OK      data directory is writable');
  } catch (e) { log('INVALID data directory is not writable'); ok = false; }
  return { ok, data: { manifest } };
}

async function testStage(ctx, manifest, log) {
  const { host } = ctx.config;
  let passed = 0, failed = 0;
  const check = async (name, fn) => {
    try { await fn(); passed++; log('PASS ' + name); }
    catch (e) { failed++; log('FAIL ' + name + ' - ' + e.message); }
  };
  const shop = await startShop({ release: manifest });
  const down = await startShop({ release: manifest, failureActive: true });
  try {
    await check('GET /health returns 200 and "healthy"', async () => {
      const r = await getJson(host, shop.port, '/health');
      assert.ok(r.ok, r.error); assert.equal(r.status, 200); assert.equal(r.json.status, 'healthy');
      assert.equal(r.json.version, manifest.version);
    });
    await check('failure flag makes /health return 503', async () => {
      const r = await getJson(host, down.port, '/health');
      assert.equal(r.status, 503); assert.equal(r.json.status, 'unhealthy');
    });
    await check('GET /api/products matches the release manifest', async () => {
      const r = await getJson(host, shop.port, '/api/products');
      assert.equal(r.status, 200); assert.equal(r.json.products.length, manifest.products.length);
      r.json.products.forEach((p) => assert.ok(Number.isInteger(p.priceCents) && p.priceCents > 0, 'bad price for ' + p.id));
    });
    await check('home page is served as HTML', async () => {
      const r = await getJson(host, shop.port, '/');
      assert.equal(r.status, 200); assert.match(r.text, /<html/i);
    });
    await check('product image endpoint returns SVG', async () => {
      const r = await getJson(host, shop.port, '/img/' + manifest.products[0].id + '.svg');
      assert.equal(r.status, 200); assert.match(r.headers['content-type'], /image\/svg\+xml/);
    });
    await check('cart: count and total are correct', async () => {
      const ps = manifest.products.map((p) => ({ id: p.id, priceCents: p.priceCents }));
      let c = {};
      c = cart.addItem(c, ps[0].id, ps); c = cart.addItem(c, ps[0].id, ps);
      if (ps[1]) c = cart.addItem(c, ps[1].id, ps);
      assert.equal(cart.count(c), ps[1] ? 3 : 2);
      assert.equal(cart.totalCents(c, ps), ps[0].priceCents * 2 + (ps[1] ? ps[1].priceCents : 0));
    });
    await check('cart: unknown product is rejected', async () => {
      assert.throws(() => cart.addItem({}, 'does-not-exist', manifest.products), /Unknown product/);
    });
  } finally {
    await shop.close(); await down.close();
  }
  log(passed + ' passed, ' + failed + ' failed');
  return { ok: failed === 0 };
}

async function runPipeline(ctx, version) {
  const { store } = ctx;
  const t0 = Date.now();
  const run = { id: store.nextId('run'), version, startedAt: new Date().toISOString(), mode: 'real', stages: [] };

  const validate = await execStage(run, 'validate', '1. Validate files & config', (log) => validateStage(ctx, version, log));
  const manifest = validate.data && validate.data.manifest;
  delete validate.data;
  const validOk = validate.status === 'passed';

  let tests = { status: 'skipped' }, security = { status: 'skipped' }, secResult = null;
  if (validOk) {
    tests = await execStage(run, 'tests', '2. Sample app tests', (log) => testStage(ctx, manifest, log));
    security = await execStage(run, 'security', '3. Security check', async (log) => {
      secResult = await runSecurityChecks(ctx, version, manifest);
      secResult.checks.forEach((c) => log(c.status.toUpperCase().padEnd(7) + c.id + ' ' + c.name + (c.severity !== 'none' ? ' [' + c.severity + ']' : '')));
      secResult.checks.forEach((c) => c.findings.forEach((f) => log('        - ' + f)));
      if (secResult.blocked) return { status: 'failed' };
      return { status: secResult.summary.warn || secResult.summary.fail ? 'warning' : 'passed' };
    });
  } else {
    skipped(run, 'tests', '2. Sample app tests', 'validation failed');
    skipped(run, 'security', '3. Security check', 'validation failed');
  }

  const testsOk = tests.status === 'passed';
  const secOk = security.status === 'passed' || security.status === 'warning';
  const permitted = validOk && testsOk && secOk;
  const gate = await execStage(run, 'gate', '4. Release gate', async (log) => {
    log('Validation: ' + (validOk ? 'passed' : 'FAILED'));
    log('Required tests: ' + (testsOk ? 'passed' : validOk ? 'FAILED' : 'not run'));
    log('Blocking security issues: ' + (secOk ? 'none' : validOk ? 'FOUND' : 'not checked'));
    log(permitted ? 'Deployment PERMITTED for version ' + version : 'Deployment BLOCKED for version ' + version);
    return { ok: permitted };
  });

  const record = await execStage(run, 'record', '5. Record results', async (log) => {
    if (secResult) recordSecurity(ctx, version, secResult, run.id);
    log('Results will be saved to ' + require('path').basename(ctx.config.dataFile));
    return { ok: true };
  });

  run.deployPermitted = permitted;
  run.status = permitted ? 'passed' : 'failed';
  run.finishedAt = new Date().toISOString();
  run.durationMs = Date.now() - t0;
  record.status = 'passed';
  store.push('pipelineRuns', run);
  store.push('events', { id: store.nextId('evt'), time: run.finishedAt, type: 'pipeline', message: 'Pipeline ' + run.id + ' for ' + version + ': ' + run.status + (permitted ? '' : ' (deployment blocked)'), simulated: false });
  return run;
}

module.exports = { runPipeline };
