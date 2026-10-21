'use strict';
// Basic LOCAL security checks. These are NOT a comprehensive security audit.
const fs = require('fs');
const path = require('path');
const { startShop } = require('./shop/app');
const { getJson } = require('./http');

const SECRET_RE = /(api[_-]?key|secret|passw(?:or)?d|token)[\w-]*["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i;
const AWS_RE = /AKIA[0-9A-Z]{16}/;
const BLOCKING = new Set(['high', 'critical']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|json|html|css)$/i.test(e.name)) out.push(p);
  }
  return out;
}

function scanText(text, label, findings) {
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes('secureops:allow')) return;
    const m = SECRET_RE.exec(line);
    if (m) findings.push(label + ':' + (i + 1) + ' possible hard-coded ' + m[1] + ' (value redacted)');
    else if (AWS_RE.test(line)) findings.push(label + ':' + (i + 1) + ' AWS-style access key pattern (value redacted)');
  });
}

function mk(id, name, status, severity, explanation, findings = []) {
  return { id, name, status, severity, explanation, findings, blocksDeployment: status === 'fail' && BLOCKING.has(severity) };
}

async function runSecurityChecks(ctx, version, manifest) {
  const { config } = ctx;
  const checks = [];

  // SEC-01 hard-coded secrets
  const findings = [];
  const files = [path.join(config.root, 'server.js'), path.join(config.root, 'package.json'),
    ...walk(path.join(config.root, 'src')), ...walk(path.join(config.root, 'public'))].filter((f) => fs.existsSync(f));
  for (const f of files) scanText(fs.readFileSync(f, 'utf8'), path.relative(config.root, f).split(path.sep).join('/'), findings);
  const relFile = path.join(config.releasesDir, version + '.json');
  if (fs.existsSync(relFile)) scanText(fs.readFileSync(relFile, 'utf8'), 'releases/' + version + '.json', findings);
  checks.push(findings.length
    ? mk('SEC-01', 'Hard-coded secret scan', 'fail', 'high',
        'Found ' + findings.length + ' value(s) that look like hard-coded credentials. Secrets must come from environment variables or a secret manager. (Demo fixtures use fake values.)', findings)
    : mk('SEC-01', 'Hard-coded secret scan', 'pass', 'none',
        'Scanned ' + (files.length + 1) + ' source/config files for credential-like assignments; none found.'));

  // SEC-02 unsafe release configuration
  const cfg = (manifest && manifest.config) || {};
  const unsafe = [];
  let sev = 'none';
  if (cfg.debug === true) { unsafe.push('config.debug is true (verbose errors / debug tooling in production)'); sev = 'high'; }
  if (cfg.allowInsecureCors === true) { unsafe.push('config.allowInsecureCors is true (any website could call the API)'); if (sev === 'none') sev = 'medium'; }
  checks.push(unsafe.length
    ? mk('SEC-02', 'Unsafe release configuration', 'fail', sev, 'The release manifest enables settings that are unsafe for production.', unsafe)
    : mk('SEC-02', 'Unsafe release configuration', 'pass', 'none', 'Debug mode and insecure CORS are both disabled in the release manifest.'));

  // SEC-03 HTTP security headers (real request to a temporary instance of this release)
  try {
    const shop = await startShop({ release: manifest });
    let r;
    try { r = await getJson(config.host, shop.port, '/'); } finally { await shop.close(); }
    if (!r.ok) throw new Error(r.error);
    const h = r.headers;
    const missing = [];
    if (!h['x-content-type-options']) missing.push('X-Content-Type-Options');
    if (!h['x-frame-options']) missing.push('X-Frame-Options');
    if (!h['content-security-policy']) missing.push('Content-Security-Policy');
    if (h['x-powered-by']) missing.push('X-Powered-By should be removed (reveals the framework)');
    checks.push(missing.length
      ? mk('SEC-03', 'HTTP security headers', 'warn', 'medium', 'Some recommended headers are missing or leaking information.', missing)
      : mk('SEC-03', 'HTTP security headers', 'pass', 'none', 'Real HTTP request to a test instance returned nosniff, frame protection and a Content-Security-Policy, and no X-Powered-By header.'));
  } catch (e) {
    checks.push(mk('SEC-03', 'HTTP security headers', 'fail', 'medium', 'Could not run the header check: ' + e.message));
  }

  // SEC-04 .gitignore protects secrets and local data
  const gi = path.join(config.root, '.gitignore');
  const text = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const need = ['node_modules', '.env', 'data'].filter((x) => !new RegExp('^' + x.replace('.', '\\.') + '(/|\\*)?$', 'm').test(text));
  checks.push(need.length
    ? mk('SEC-04', 'Repository hygiene (.gitignore)', 'warn', 'low', '.gitignore does not exclude everything it should.', need.map((n) => 'missing entry: ' + n))
    : mk('SEC-04', 'Repository hygiene (.gitignore)', 'pass', 'none', '.gitignore excludes node_modules, .env files and local data.'));

  // SEC-05 dependency audit - honestly reported as not run
  checks.push(mk('SEC-05', 'Dependency vulnerability audit', 'skipped', 'info',
    'Not run: "npm audit" needs internet access, and this demo works fully offline. Run it manually if required.'));

  const blocked = checks.some((c) => c.blocksDeployment);
  const summary = { pass: 0, warn: 0, fail: 0, skipped: 0 };
  checks.forEach((c) => { summary[c.status]++; });
  return { checks, blocked, summary };
}

function recordSecurity(ctx, version, result, pipelineRunId = null) {
  return ctx.store.push('securityChecks', {
    id: ctx.store.nextId('sec'), version, time: new Date().toISOString(), pipelineRunId,
    mode: 'real', checks: result.checks, blocked: result.blocked, summary: result.summary,
    disclaimer: 'Basic local checks only - not a comprehensive security audit.',
  });
}

module.exports = { runSecurityChecks, recordSecurity };
