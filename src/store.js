'use strict';
// Simple persistent JSON store with atomic writes (write temp file, then rename).
const fs = require('fs');
const path = require('path');

const CAPS = { pipelineRuns: 50, securityChecks: 50, healthChecks: 200, deployments: 100, incidents: 100, events: 100 };
const INITIAL_VERSION = '0.9.0';

function seed() {
  const now = new Date().toISOString();
  return {
    schema: 1,
    counters: { dep: 1, evt: 1 },
    state: { activeVersion: INITIAL_VERSION, stack: [], failure: { active: false, since: null } },
    pipelineRuns: [],
    securityChecks: [],
    healthChecks: [],
    deployments: [{
      id: 'dep-0001', type: 'initial', version: INITIAL_VERSION, previousVersion: null, time: now,
      result: 'success', health: 'not-checked', pipelineRunId: null, responseMs: null,
      note: 'Baseline release (seeded demo state)',
    }],
    incidents: [],
    events: [{ id: 'evt-0001', time: now, type: 'init', message: 'Demo initialised with baseline release ' + INITIAL_VERSION, simulated: false }],
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.db = null;
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || !parsed.state || typeof parsed.state.activeVersion !== 'string') {
          throw new Error('unexpected file structure');
        }
        const base = seed();
        for (const k of Object.keys(CAPS)) if (!Array.isArray(parsed[k])) parsed[k] = base[k];
        if (!Array.isArray(parsed.state.stack)) parsed.state.stack = [];
        if (!parsed.state.failure) parsed.state.failure = { active: false, since: null };
        parsed.counters = parsed.counters || base.counters;
        this.db = parsed;
        return;
      } catch (err) {
        const backup = this.file + '.corrupt-' + Date.now();
        try { fs.renameSync(this.file, backup); } catch (e) { /* ignore */ }
        console.warn('Database file was unreadable (' + err.message + '). Backed up to ' + backup + ' and re-initialised.');
      }
    }
    this.db = seed();
    this.save();
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  nextId(prefix) {
    this.db.counters[prefix] = (this.db.counters[prefix] || 0) + 1;
    return prefix + '-' + String(this.db.counters[prefix]).padStart(4, '0');
  }

  // Newest first, capped. Saves immediately.
  push(listName, item) {
    const list = this.db[listName];
    list.unshift(item);
    if (list.length > CAPS[listName]) list.length = CAPS[listName];
    this.save();
    return item;
  }

  reset() {
    this.db = seed();
    this.save();
  }
}

module.exports = { Store, INITIAL_VERSION };
