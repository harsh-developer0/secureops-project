'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function port(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : fallback;
}

function loadConfig(overrides = {}) {
  return {
    root: ROOT,
    host: '127.0.0.1',
    dashboardPort: overrides.dashboardPort ?? port(process.env.DASHBOARD_PORT, 3000),
    shopPort: overrides.shopPort ?? port(process.env.SHOP_PORT, 4000),
    dataFile: overrides.dataFile || process.env.SECUREOPS_DATA_FILE || path.join(ROOT, 'data', 'secureops-db.json'),
    releasesDir: overrides.releasesDir || path.join(ROOT, 'releases'),
  };
}

module.exports = { loadConfig, ROOT };
