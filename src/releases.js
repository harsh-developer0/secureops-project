'use strict';
const fs = require('fs');
const path = require('path');

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function cmp(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// Returns { exists, manifest, error }. `version` MUST match VERSION_RE (prevents path traversal).
function readRelease(dir, version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return { exists: false, manifest: null, error: 'invalid version string' };
  const file = path.join(dir, version + '.json');
  if (!fs.existsSync(file)) return { exists: false, manifest: null, error: 'release file not found' };
  try {
    return { exists: true, manifest: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (e) {
    return { exists: true, manifest: null, error: 'release file is not valid JSON' };
  }
}

function listVersions(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d+\.\d+\.\d+\.json$/.test(f)).map((f) => f.slice(0, -5)).sort(cmp);
}

function validateManifest(m, expectedVersion) {
  const problems = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (m.version !== expectedVersion) problems.push('manifest version "' + m.version + '" does not match file name ' + expectedVersion);
  if (typeof m.storeName !== 'string' || !m.storeName.trim() || m.storeName.length > 60) problems.push('storeName must be a non-empty string (max 60 chars)');
  if (!m.theme || !HEX_RE.test(m.theme.accent || '')) problems.push('theme.accent must be a #RRGGBB colour');
  if (!m.config || typeof m.config !== 'object') problems.push('config object is missing');
  if (!Array.isArray(m.products) || m.products.length < 1 || m.products.length > 24) {
    problems.push('products must be an array of 1-24 items');
  } else {
    const seen = new Set();
    m.products.forEach((p, i) => {
      const tag = 'products[' + i + ']';
      if (!p || typeof p !== 'object') return problems.push(tag + ' is not an object');
      if (!/^[a-z0-9-]{1,32}$/.test(p.id || '')) problems.push(tag + '.id is invalid');
      if (seen.has(p.id)) problems.push(tag + '.id is duplicated');
      seen.add(p.id);
      if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80) problems.push(tag + '.name is invalid');
      if (!Number.isInteger(p.priceCents) || p.priceCents < 1 || p.priceCents > 1000000) problems.push(tag + '.priceCents must be a positive integer');
      if (!HEX_RE.test(p.color || '')) problems.push(tag + '.color must be a #RRGGBB colour');
      if (typeof p.icon !== 'string' || !p.icon || p.icon.length > 8) problems.push(tag + '.icon is invalid');
    });
  }
  return problems;
}

module.exports = { VERSION_RE, readRelease, listVersions, validateManifest };
