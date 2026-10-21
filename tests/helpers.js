'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSecureOps } = require('../src/app');

// Starts an isolated SecureOps instance (temp database, temp copy of releases, random free ports).
async function makeInstance(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureops-test-'));
  const releasesDir = path.join(dir, 'releases');
  fs.cpSync(path.join(__dirname, '..', 'releases'), releasesDir, { recursive: true });
  const dataFile = opts.dataFile || path.join(dir, 'db.json');
  const inst = createSecureOps({ dashboardPort: 0, shopPort: 0, dataFile, releasesDir });
  const info = await inst.start();

  async function call(method, url, body) {
    const res = await fetch(info.dashboardUrl + url, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* no body */ }
    return { status: res.status, json };
  }
  return {
    inst, dir, releasesDir, dataFile, info, call,
    async shopProducts() { return (await (await fetch(info.shopUrl + '/api/products')).json()); },
    async cleanup() { await inst.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

module.exports = { makeInstance };
