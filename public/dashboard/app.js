(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (iso) { return iso ? new Date(iso).toLocaleString() : '—'; };
  var fmtTime = function (iso) { return iso ? new Date(iso).toLocaleTimeString() : '—'; };
  var badge = function (cls, text) { return '<span class="badge ' + cls + '">' + esc(text) + '</span>'; };

  var STATUS = { passed: ['ok', '✓ Passed'], failed: ['bad', '✗ Failed'], warning: ['warn', '! Warning'], skipped: ['neutral', '– Skipped'], running: ['neutral', '… Running'] };
  var CHECK = { pass: ['ok', '✓ Pass'], warn: ['warn', '! Warning'], fail: ['bad', '✗ Fail'], skipped: ['neutral', '– Not run'] };
  var stBadge = function (s) { var x = STATUS[s] || ['neutral', s]; return badge(x[0], x[1]); };

  var state = null, lastKey = '', local = false, selectedRun = null;

  function api(path, method, body) {
    return fetch(path, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined })
      .catch(function () { throw new Error('Cannot reach the SecureOps backend. Is "npm start" still running?'); })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
          return data;
        });
      });
  }

  function notify(kind, text) {
    var el = $('#msg');
    el.className = 'msg ' + kind;
    el.textContent = text;
    el.hidden = false;
  }

  function setConn(up) {
    $('#conn').className = 'conn ' + (up ? 'up' : 'down');
    $('#connText').textContent = up ? 'Backend connected' : 'Backend disconnected';
  }

  function refresh() {
    return api('/api/state').then(function (s) {
      setConn(true);
      var key = JSON.stringify(s);
      if (key !== lastKey || local) { lastKey = key; state = s; render(); }
      applyControls();
    }).catch(function () { setConn(false); });
  }

  // ---------- rendering ----------
  function render() {
    renderSummary(); renderVersionSelect(); renderPipeline(); renderSecurity();
    renderMonitoring(); renderDeployments(); renderIncidents(); renderEvents();
    $('#btnLive').href = state.liveUrl;
  }

  function renderSummary() {
    var run = state.pipelineRuns[0];
    $('#sumPipeline').innerHTML = run
      ? '<div class="big">' + stBadge(run.status) + '</div><div class="sub">v' + esc(run.version) + ' · ' + esc(fmtTime(run.finishedAt)) + '<br>Deployment ' + (run.deployPermitted ? 'permitted' : 'blocked') + '</div>'
      : '<div class="big">' + badge('neutral', 'Not run') + '</div><div class="sub">Click Run Pipeline</div>';

    var sec = state.latestSecurity;
    if (sec) {
      var txt = sec.blocked ? ['bad', '✗ Blocking issue'] : sec.summary.warn ? ['warn', '! Passed with warnings'] : ['ok', '✓ No blocking issues'];
      $('#sumSecurity').innerHTML = '<div class="big">' + badge(txt[0], txt[1]) + '</div><div class="sub">v' + esc(sec.version) + ' · ' + sec.summary.pass + ' pass, ' + sec.summary.warn + ' warn, ' + sec.summary.fail + ' fail</div>';
    } else $('#sumSecurity').innerHTML = '<div class="big">' + badge('neutral', 'Not run') + '</div><div class="sub">Click Run Security Check</div>';

    var h = state.healthChecks[0];
    var sim = state.failure.active ? ' ' + badge('sim', 'SIMULATED FAILURE ACTIVE') : '';
    $('#sumHealth').innerHTML = h
      ? '<div class="big">' + (h.status === 'healthy' ? badge('ok', '✓ Healthy') : badge('bad', '✗ Unhealthy')) + '</div><div class="sub">' + (h.responseMs != null ? esc(h.responseMs) + ' ms · ' : '') + esc(fmtTime(h.time)) + '</div>' + (sim ? '<div class="sub">' + sim + '</div>' : '')
      : '<div class="big">' + badge('neutral', 'Unknown') + '</div><div class="sub">Click Check Health</div>' + (sim ? '<div class="sub">' + sim + '</div>' : '');

    $('#sumVersion').innerHTML = '<div class="big">v' + esc(state.activeVersion) + '</div><div class="sub">Serving on ' + esc(state.liveUrl) + (state.activeSince ? '<br>since ' + esc(fmt(state.activeSince)) : '') + '</div>';
  }

  function renderVersionSelect() {
    var sel = $('#version'), keep = sel.value;
    sel.innerHTML = state.releases.map(function (r) {
      var g = r.gate ? (r.gate.deployPermitted ? 'gate passed' : 'gate BLOCKED') : 'pipeline not run';
      return '<option value="' + esc(r.version) + '">' + esc(r.version) + ' — ' + g + (r.active ? ' (active)' : '') + '</option>';
    }).join('');
    if (keep && state.releases.some(function (r) { return r.version === keep; })) sel.value = keep;
    else {
      var next = state.releases.filter(function (r) { return !r.active; })[0];
      sel.value = (next || state.releases[0]).version;
    }
    updateHint();
  }

  function updateHint() {
    if (!state) return;
    var r = state.releases.filter(function (x) { return x.version === $('#version').value; })[0];
    $('#versionHint').textContent = r ? 'Release ' + r.version + ': ' + r.notes : '';
  }

  function renderPipeline() {
    var runs = state.pipelineRuns;
    var run = runs.filter(function (r) { return r.id === selectedRun; })[0] || runs[0];
    var view = $('#pipelineView');
    if (!run) { view.innerHTML = '<p class="empty">No pipeline run yet. Select a version and click <b>Run Pipeline</b>.</p>'; }
    else {
      view.innerHTML = '<p class="sub">Run ' + esc(run.id) + ' · version ' + esc(run.version) + ' · ' + esc(fmt(run.finishedAt)) + ' · ' + esc(run.durationMs) + ' ms</p>' +
        '<ol class="stages">' + run.stages.map(function (s) {
          return '<li class="' + esc(s.status) + '"><b>' + esc(s.name) + '</b>' + stBadge(s.status) + '<div class="sub">' + esc(s.durationMs) + ' ms</div></li>';
        }).join('') + '</ol>' +
        run.stages.map(function (s) {
          return '<details' + (s.status === 'failed' || s.status === 'warning' ? ' open' : '') + '><summary>' + esc(s.name) + ' — logs</summary><pre class="log">' + esc(s.logs.join('\n')) + '</pre></details>';
        }).join('');
    }
    $('#runsTable tbody').innerHTML = runs.length ? runs.map(function (r) {
      return '<tr><td>' + esc(r.id) + '</td><td>' + esc(r.version) + '</td><td>' + stBadge(r.status) + '</td><td>' + esc(fmtTime(r.finishedAt)) + '</td><td><button type="button" class="btn ghost" data-run="' + esc(r.id) + '">View</button></td></tr>';
    }).join('') : '<tr><td colspan="5" class="empty">No runs yet.</td></tr>';
  }

  function renderSecurity() {
    var s = state.latestSecurity, v = $('#securityView');
    if (!s) { v.innerHTML = '<p class="empty">No security check yet. Click <b>Run Security Check</b>.</p>'; return; }
    v.innerHTML = '<p class="sub">Version ' + esc(s.version) + ' · ' + esc(fmt(s.time)) + (s.pipelineRunId ? ' · from pipeline ' + esc(s.pipelineRunId) : ' · standalone check') + '</p>' +
      '<p><b>Deployment blocked:</b> ' + (s.blocked ? badge('bad', 'YES') : badge('ok', 'NO')) + '</p>' +
      '<div class="scroll"><table><thead><tr><th>Check</th><th>Result</th><th>Severity</th><th>Explanation</th><th>Blocks</th></tr></thead><tbody>' +
      s.checks.map(function (c) {
        var r = CHECK[c.status] || ['neutral', c.status];
        return '<tr><td><b>' + esc(c.id) + '</b><br>' + esc(c.name) + '</td><td>' + badge(r[0], r[1]) + '</td><td>' + (c.severity === 'none' ? '—' : esc(c.severity)) + '</td><td>' + esc(c.explanation) +
          (c.findings.length ? '<ul>' + c.findings.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' : '') + '</td><td>' + (c.blocksDeployment ? badge('bad', 'Yes') : 'No') + '</td></tr>';
      }).join('') + '</tbody></table></div><p class="sub">' + esc(s.disclaimer) + '</p>';
  }

  function renderMonitoring() {
    var hs = state.healthChecks.slice().reverse();
    if (!hs.length) { $('#chart').innerHTML = '<p class="empty">No health checks yet. Click <b>Check Health</b>.</p>'; }
    else {
      var max = Math.max.apply(null, hs.map(function (h) { return h.responseMs || 0; }).concat([20]));
      var w = 400 / 20, bars = hs.map(function (h, i) {
        var ms = h.responseMs || 0, ht = Math.max(4, Math.round(ms / max * 80));
        return '<rect class="' + (h.status === 'healthy' ? 'bar-ok' : 'bar-bad') + '" x="' + (i * w + 2) + '" y="' + (95 - ht) + '" width="' + (w - 4) + '" height="' + ht + '" rx="2"><title>' + esc(h.status + ', ' + ms + ' ms, ' + fmtTime(h.time)) + '</title></rect>';
      }).join('');
      $('#chart').innerHTML = '<svg viewBox="0 0 400 100" preserveAspectRatio="none" role="img" aria-label="Response time of the last ' + hs.length + ' health checks">' + bars + '</svg><p class="sub">Response time (ms) of the last ' + hs.length + ' checks · red = unhealthy · tallest bar ' + max + ' ms</p>';
    }
    $('#healthTable tbody').innerHTML = state.healthChecks.length ? state.healthChecks.slice(0, 8).map(function (h) {
      return '<tr><td>' + esc(fmtTime(h.time)) + '</td><td>' + (h.status === 'healthy' ? badge('ok', '✓ Healthy') : badge('bad', '✗ Unhealthy') + (h.simulated ? ' ' + badge('sim', 'SIMULATED') : '')) +
        '</td><td>' + (h.responseMs != null ? esc(h.responseMs) + ' ms' : '—') + '</td><td>' + esc(h.version) + '</td><td>' + esc(h.trigger) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="empty">No checks yet.</td></tr>';
  }

  function renderDeployments() {
    var label = { deploy: 'Deploy', rollback: 'Rollback', initial: 'Initial' };
    $('#depTable tbody').innerHTML = state.deployments.map(function (d) {
      var h = d.health === 'healthy' ? badge('ok', 'Healthy') : d.health === 'unhealthy' ? badge('bad', 'Unhealthy') : badge('neutral', 'Not checked');
      return '<tr><td>' + esc(fmt(d.time)) + '</td><td>' + esc(label[d.type] || d.type) + '</td><td>' + (d.previousVersion ? esc(d.previousVersion) + ' → ' : '') + '<b>' + esc(d.version) + '</b></td><td>' +
        (d.result === 'success' ? badge('ok', '✓ Success') : badge('bad', '✗ Failed')) + '</td><td>' + h + '</td><td>' + esc(d.pipelineRunId || '—') + '</td></tr>';
    }).join('');
  }

  function renderIncidents() {
    $('#incidents').innerHTML = state.incidents.length ? state.incidents.map(function (i) {
      return '<div class="incident ' + (i.status === 'resolved' ? 'resolved' : '') + '"><b>' + esc(i.id) + '</b> ' + (i.status === 'open' ? badge('bad', 'OPEN') : badge('ok', 'RESOLVED')) + ' ' + (i.simulated ? badge('sim', 'SIMULATED') : badge('ok', 'REAL')) +
        '<br>' + esc(i.title) + '<br><span class="sub">Opened ' + esc(fmt(i.openedAt)) + ' · version ' + esc(i.version) + ' · ' + esc(i.failedChecks) + ' failed check(s)' +
        (i.resolvedAt ? '<br>Resolved ' + esc(fmt(i.resolvedAt)) + ' — ' + esc(i.resolution) : '') + '</span></div>';
    }).join('') : '<p class="empty">No incidents. An incident is opened automatically when a health check fails.</p>';
  }

  function renderEvents() {
    $('#events').innerHTML = state.events.map(function (e) {
      return '<li><time>' + esc(fmtTime(e.time)) + '</time>' + (e.simulated ? badge('sim', 'SIMULATED') + ' ' : '') + esc(e.message) + '</li>';
    }).join('');
  }

  function applyControls() {
    if (!state) return;
    var off = local || !!state.busy;
    var v = $('#version').value;
    $('#btnPipeline').disabled = off;
    $('#btnSecurity').disabled = off;
    $('#btnDeploy').disabled = off || v === state.activeVersion;
    $('#btnDeploy').title = v === state.activeVersion ? 'This version is already active' : '';
    $('#btnFail').disabled = off || state.failure.active;
    $('#btnFail').title = state.failure.active ? 'A simulated failure is already active' : '';
    $('#btnHealth').disabled = off;
    $('#btnRollback').disabled = off || !state.canRollback;
    $('#btnRollback').title = state.canRollback ? 'Restore version ' + state.rollbackTarget : 'No previous version to roll back to';
    $('#btnReset').disabled = off;
  }

  // ---------- actions ----------
  function run(btn, busyText, fn) {
    if (local) return;
    local = true; applyControls();
    var original = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span> ' + esc(busyText);
    notify('warn', busyText + '…');
    fn().then(function (r) { notify(r[0], r[1]); })
      .catch(function (e) { notify('err', e.message); })
      .then(function () { btn.textContent = original; local = false; return refresh(); });
  }
  var ver = function () { return $('#version').value; };

  $('#btnPipeline').onclick = function () {
    run(this, 'Running pipeline', function () {
      return api('/api/pipeline/run', 'POST', { version: ver() }).then(function (d) {
        selectedRun = d.run.id;
        return d.run.deployPermitted ? ['ok', 'Pipeline passed for ' + d.run.version + '. Deployment is permitted.'] : ['err', 'Pipeline FAILED for ' + d.run.version + '. The release gate blocked deployment. See the logs below.'];
      });
    });
  };
  $('#btnSecurity').onclick = function () {
    run(this, 'Running security check', function () {
      return api('/api/security/run', 'POST', { version: ver() }).then(function (d) {
        return d.security.blocked ? ['err', 'Security check found BLOCKING issues in ' + d.security.version + '. Deployment would be blocked.'] : ['ok', 'Security check finished for ' + d.security.version + ': no blocking issues.'];
      });
    });
  };
  $('#btnDeploy').onclick = function () {
    run(this, 'Deploying', function () {
      return api('/api/deploy', 'POST', { version: ver() }).then(function (d) {
        return ['ok', 'Deployed ' + d.deployment.version + '. Health: ' + d.deployment.health + (d.deployment.responseMs != null ? ' (' + d.deployment.responseMs + ' ms)' : '') + '.'];
      });
    });
  };
  $('#btnFail').onclick = function () {
    run(this, 'Injecting failure', function () {
      return api('/api/failure/simulate', 'POST').then(function () { return ['warn', 'SIMULATED failure injected. Click Check Health to see monitoring detect it.']; });
    });
  };
  $('#btnHealth').onclick = function () {
    run(this, 'Checking health', function () {
      return api('/api/health/check', 'POST').then(function (d) {
        var c = d.check;
        return c.status === 'healthy' ? ['ok', 'Application is HEALTHY (' + c.responseMs + ' ms, version ' + c.version + ').'] : ['err', 'Application is UNHEALTHY: ' + c.error + (c.simulated ? ' (simulated failure)' : '') + '. An incident has been recorded.'];
      });
    });
  };
  $('#btnRollback').onclick = function () {
    run(this, 'Rolling back', function () {
      return api('/api/rollback', 'POST').then(function (d) {
        return ['ok', 'Rollback complete: version ' + d.deployment.version + ' restored and health verified (' + d.deployment.responseMs + ' ms).'];
      });
    });
  };

  var dlg = $('#resetDialog');
  $('#btnReset').onclick = function () {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else if (window.confirm('Reset the demo? All history will be deleted.')) doReset();
  };
  $('#rdCancel').onclick = function () { dlg.close(); };
  $('#rdOk').onclick = function () { dlg.close(); doReset(); };
  function doReset() {
    run($('#btnReset'), 'Resetting', function () {
      return api('/api/reset', 'POST').then(function () { selectedRun = null; return ['ok', 'Demo reset. Baseline version 0.9.0 is active.']; });
    });
  }

  $('#version').onchange = function () { updateHint(); applyControls(); };
  $('#runsTable').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-run]');
    if (b) { selectedRun = b.getAttribute('data-run'); renderPipeline(); }
  });

  refresh();
  setInterval(function () { if (!local) refresh(); }, 5000);
})();
