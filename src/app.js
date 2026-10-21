'use strict';
const path = require('path');
const express = require('express');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { listen, close } = require('./http');
const { readRelease, listVersions, VERSION_RE } = require('./releases');
const { createShopApp } = require('./shop/app');
const { runPipeline } = require('./pipeline');
const { runSecurityChecks, recordSecurity } = require('./security');
const ops = require('./ops');
const { HttpError } = ops;

function createSecureOps(overrides = {}) {
  const config = loadConfig(overrides);
  const store = new Store(config.dataFile);
  const ctx = { config, store, shopPort: config.shopPort, busy: null };
  let dashboardServer = null, shopServer = null;

  // ----- sample shopping app (what SecureOps manages) -----
  const shopApp = createShopApp(() => ({
    release: readRelease(config.releasesDir, store.db.state.activeVersion).manifest,
    failure: store.db.state.failure,
  }));

  // ----- dashboard -----
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: '10kb' }));
  // Basic CSRF protection: reject cross-origin browser POSTs.
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && origin !== 'http://' + req.headers.host) {
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const needVersion = (body) => {
    const v = body && body.version;
    if (typeof v !== 'string' || !VERSION_RE.test(v)) throw new HttpError(400, 'A valid version such as "1.0.0" is required.');
    if (!readRelease(config.releasesDir, v).exists) throw new HttpError(404, 'Release ' + v + ' does not exist.');
    return v;
  };

  app.get('/api/ping', (req, res) => res.json({ ok: true }));

  app.get('/api/state', (req, res) => {
    const db = store.db, s = db.state;
    const releases = listVersions(config.releasesDir).map((v) => {
      const m = readRelease(config.releasesDir, v).manifest;
      const run = db.pipelineRuns.find((r) => r.version === v);
      return {
        version: v, notes: m ? m.notes : 'Invalid manifest', active: v === s.activeVersion,
        gate: run ? { runId: run.id, status: run.status, deployPermitted: run.deployPermitted, time: run.finishedAt } : null,
      };
    });
    const lastDeploy = db.deployments.find((d) => d.result === 'success' && d.version === s.activeVersion);
    res.json({
      connected: true, busy: ctx.busy,
      activeVersion: s.activeVersion, activeSince: lastDeploy ? lastDeploy.time : null,
      failure: s.failure, canRollback: s.stack.length > 0, rollbackTarget: s.stack.length ? s.stack[s.stack.length - 1] : null,
      liveUrl: 'http://' + config.host + ':' + ctx.shopPort + '/',
      releases,
      pipelineRuns: db.pipelineRuns.slice(0, 10),
      latestSecurity: db.securityChecks[0] || null,
      healthChecks: db.healthChecks.slice(0, 20),
      deployments: db.deployments.slice(0, 20),
      incidents: db.incidents.slice(0, 20),
      events: db.events.slice(0, 15),
    });
  });

  app.post('/api/pipeline/run', wrap((req, res) => {
    const version = needVersion(req.body);
    return ops.exclusive(ctx, 'pipeline', async () => {
      const run = await runPipeline(ctx, version);
      res.json({ run });
    });
  }));

  app.post('/api/security/run', wrap((req, res) => {
    const version = needVersion(req.body);
    return ops.exclusive(ctx, 'security check', async () => {
      const rel = readRelease(config.releasesDir, version);
      if (!rel.manifest) throw new HttpError(422, 'Release ' + version + ' manifest is invalid: ' + rel.error);
      const result = await runSecurityChecks(ctx, version, rel.manifest);
      const record = recordSecurity(ctx, version, result, null);
      ops.addEvent(ctx, 'security', 'Security check for ' + version + ': ' + (result.blocked ? 'deployment BLOCKED' : 'no blocking issues'));
      res.json({ security: record });
    });
  }));

  app.post('/api/deploy', wrap((req, res) => {
    const version = needVersion(req.body);
    return ops.exclusive(ctx, 'deployment', async () => res.json({ deployment: await ops.deploy(ctx, version) }));
  }));

  app.post('/api/health/check', wrap((req, res) =>
    ops.exclusive(ctx, 'health check', async () => res.json({ check: await ops.checkHealth(ctx, 'manual') }))));

  app.post('/api/failure/simulate', wrap((req, res) =>
    ops.exclusive(ctx, 'failure simulation', async () => res.json(await ops.simulateFailure(ctx)))));

  app.post('/api/rollback', wrap((req, res) =>
    ops.exclusive(ctx, 'rollback', async () => res.json({ deployment: await ops.rollback(ctx) }))));

  app.post('/api/reset', wrap((req, res) =>
    ops.exclusive(ctx, 'reset', async () => { ops.resetDemo(ctx); res.json({ ok: true }); })));

  app.use(express.static(path.join(config.root, 'public', 'dashboard'), { etag: false, maxAge: 0 }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route' }));
  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500 && !(err instanceof HttpError)) console.error(err);
    const safe = err instanceof HttpError || status < 500;
    res.status(status).json({ error: safe ? err.message : 'Internal server error' });
  });

  async function start() {
    try {
      shopServer = await listen(shopApp, config.shopPort, config.host);
      ctx.shopPort = shopServer.address().port;
      dashboardServer = await listen(app, config.dashboardPort, config.host);
    } catch (err) {
      await stop();
      throw err;
    }
    return {
      dashboardUrl: 'http://' + config.host + ':' + dashboardServer.address().port,
      shopUrl: 'http://' + config.host + ':' + ctx.shopPort,
    };
  }

  async function stop() {
    await close(dashboardServer);
    await close(shopServer);
    dashboardServer = shopServer = null;
  }

  return { config, ctx, store, start, stop };
}

module.exports = { createSecureOps };
