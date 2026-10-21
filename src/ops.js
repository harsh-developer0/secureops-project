'use strict';
// Operations: health checks + incidents, deploy, simulate failure, rollback, reset.
const { readRelease, validateManifest } = require('./releases');
const { getJson } = require('./http');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function addEvent(ctx, type, message, simulated = false) {
  ctx.store.push('events', { id: ctx.store.nextId('evt'), time: new Date().toISOString(), type, message, simulated });
}

// Only one mutating operation at a time, so state can never be corrupted by overlapping clicks.
async function exclusive(ctx, label, fn) {
  if (ctx.busy) throw new HttpError(409, 'Another operation is running (' + ctx.busy + '). Please wait a moment and try again.');
  ctx.busy = label;
  try { return await fn(); } finally { ctx.busy = null; }
}

async function checkHealth(ctx, trigger = 'manual', resolutionNote) {
  const { store, config } = ctx;
  const probe = await getJson(config.host, ctx.shopPort, '/health');
  const healthy = !!(probe.ok && probe.status === 200 && probe.json && probe.json.status === 'healthy');
  const rec = {
    id: store.nextId('hc'),
    time: new Date().toISOString(),
    status: healthy ? 'healthy' : 'unhealthy',
    responseMs: probe.ms == null ? null : probe.ms,
    statusCode: probe.ok ? probe.status : null,
    version: (probe.json && probe.json.version) || store.db.state.activeVersion,
    simulated: !!(probe.json && probe.json.simulated),
    error: healthy ? null : (probe.error || (probe.json && probe.json.reason) || 'HTTP ' + probe.status),
    trigger,
  };
  store.push('healthChecks', rec);

  const open = store.db.incidents.find((i) => i.status === 'open');
  if (!healthy) {
    if (!open) {
      store.push('incidents', {
        id: store.nextId('inc'),
        title: rec.simulated ? 'Simulated failure: health endpoint reports unhealthy' : 'Application health check failed',
        detail: rec.error, severity: 'high', status: 'open', simulated: rec.simulated,
        version: rec.version, openedAt: rec.time, failedChecks: 1, resolvedAt: null, resolution: null,
      });
      addEvent(ctx, 'incident', 'Incident opened: ' + rec.error, rec.simulated);
    } else {
      open.failedChecks += 1;
      store.save();
    }
  } else if (open) {
    open.status = 'resolved';
    open.resolvedAt = rec.time;
    open.resolution = resolutionNote || 'Recovery verified by a passing health check';
    store.save();
    addEvent(ctx, 'incident', 'Incident ' + open.id + ' resolved: ' + open.resolution);
  }
  return rec;
}

async function deploy(ctx, version) {
  const { store, config } = ctx;
  const state = store.db.state;
  const rel = readRelease(config.releasesDir, version);
  if (!rel.manifest) throw new HttpError(404, 'Release ' + version + ' is missing or invalid.');
  if (version === state.activeVersion) throw new HttpError(409, 'Version ' + version + ' is already active.');

  const run = store.db.pipelineRuns.find((r) => r.version === version);
  if (!run) throw new HttpError(409, 'Run the pipeline for ' + version + ' first. Deployment requires a passing release gate.');
  if (!run.deployPermitted) throw new HttpError(409, 'Release gate BLOCKED version ' + version + ' (pipeline ' + run.id + ' failed). Fix the problems and re-run the pipeline.');

  const previous = state.activeVersion;
  const prevStack = state.stack.slice();
  const prevFailure = Object.assign({}, state.failure);
  state.stack.push(previous);
  state.activeVersion = version;
  state.failure = { active: false, since: null }; // a fresh deployment starts with no injected failure
  store.save();

  const hc = await checkHealth(ctx, 'post-deploy', 'Recovered after deploying ' + version);
  const ok = hc.status === 'healthy';
  const dep = {
    id: store.nextId('dep'), type: 'deploy', version, previousVersion: previous, time: new Date().toISOString(),
    result: ok ? 'success' : 'failed', health: hc.status, pipelineRunId: run.id, responseMs: hc.responseMs,
    note: ok ? 'Deployed after passing release gate' : 'Post-deploy health check failed; previous version restored automatically',
  };
  if (!ok) {
    state.activeVersion = previous; state.stack = prevStack; state.failure = prevFailure; store.save();
  }
  store.push('deployments', dep);
  addEvent(ctx, 'deploy', ok ? 'Deployed ' + version + ' (was ' + previous + ')' : 'Deploy of ' + version + ' FAILED health check; restored ' + previous);
  if (!ok) {
    await checkHealth(ctx, 'post-deploy-revert', 'Recovered after automatic revert to ' + previous);
    throw new HttpError(500, 'Deployment of ' + version + ' failed its health check. ' + previous + ' was restored.');
  }
  return dep;
}

async function simulateFailure(ctx) {
  const { store } = ctx;
  const f = store.db.state.failure;
  if (f.active) return { alreadyActive: true, since: f.since };
  store.db.state.failure = { active: true, since: new Date().toISOString() };
  store.save();
  addEvent(ctx, 'failure', 'SIMULATED failure injected: the health endpoint of version ' + store.db.state.activeVersion + ' now returns 503', true);
  return { alreadyActive: false, since: store.db.state.failure.since };
}

async function rollback(ctx) {
  const { store, config } = ctx;
  const state = store.db.state;
  if (!state.stack.length) throw new HttpError(409, 'There is no previous version to roll back to.');
  const from = state.activeVersion;
  const target = state.stack[state.stack.length - 1];

  const fail = (message) => {
    store.push('deployments', {
      id: store.nextId('dep'), type: 'rollback', version: target, previousVersion: from, time: new Date().toISOString(),
      result: 'failed', health: 'not-checked', pipelineRunId: null, responseMs: null, note: message,
    });
    addEvent(ctx, 'rollback', 'Rollback to ' + target + ' FAILED: ' + message);
    return new HttpError(500, 'Rollback to ' + target + ' failed: ' + message);
  };

  const rel = readRelease(config.releasesDir, target);
  if (!rel.manifest) throw fail('release ' + target + ' is ' + rel.error);
  const problems = validateManifest(rel.manifest, target);
  if (problems.length) throw fail('release manifest invalid (' + problems[0] + ')');

  const prevFailure = Object.assign({}, state.failure);
  state.stack.pop();
  state.activeVersion = target;
  state.failure = { active: false, since: null };
  store.save();

  const hc = await checkHealth(ctx, 'post-rollback', 'Recovery verified after rollback ' + from + ' -> ' + target);
  if (hc.status !== 'healthy') {
    state.activeVersion = from; state.stack.push(target); state.failure = prevFailure; store.save();
    throw fail('health check after rollback failed (' + hc.error + '); previous state kept');
  }
  const dep = store.push('deployments', {
    id: store.nextId('dep'), type: 'rollback', version: target, previousVersion: from, time: new Date().toISOString(),
    result: 'success', health: 'healthy', pipelineRunId: null, responseMs: hc.responseMs,
    note: 'Restored ' + target + '; injected failure cleared; health verified',
  });
  addEvent(ctx, 'rollback', 'Rolled back ' + from + ' -> ' + target + '; recovery verified');
  return dep;
}

function resetDemo(ctx) {
  ctx.store.reset();
  addEvent(ctx, 'reset', 'Demo reset to the initial state');
}

module.exports = { HttpError, exclusive, checkHealth, deploy, simulateFailure, rollback, resetDemo, addEvent };
