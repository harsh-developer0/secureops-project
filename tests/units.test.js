'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cart = require('../src/shop/cart');
const { Store } = require('../src/store');
const { validateManifest, readRelease } = require('../src/releases');

const products = [{ id: 'a', priceCents: 250 }, { id: 'b', priceCents: 1000 }];

test('cart add / remove / count / total', () => {
  let c = cart.addItem({}, 'a', products);
  c = cart.addItem(c, 'a', products);
  c = cart.addItem(c, 'b', products);
  assert.equal(cart.count(c), 3);
  assert.equal(cart.totalCents(c, products), 1500);
  c = cart.removeItem(c, 'a');
  assert.equal(cart.totalCents(c, products), 1250);
  c = cart.removeItem(cart.removeItem(c, 'a'), 'a');
  assert.equal(c.a, undefined);
  assert.equal(cart.formatPrice(1250), '$12.50');
  assert.throws(() => cart.addItem({}, 'zzz', products), /Unknown product/);
});

test('store recovers from a corrupt database file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureops-store-'));
  const file = path.join(dir, 'db.json');
  fs.writeFileSync(file, '{ not json');
  const s = new Store(file);
  assert.equal(s.db.state.activeVersion, '0.9.0');
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('release manifests: all shipped releases are valid and traversal is refused', () => {
  const dir = path.join(__dirname, '..', 'releases');
  for (const v of ['0.9.0', '1.0.0', '1.1.0', '1.2.0']) {
    const { manifest } = readRelease(dir, v);
    assert.deepEqual(validateManifest(manifest, v), [], v);
  }
  assert.equal(readRelease(dir, '../package').exists, false);
  assert.ok(validateManifest({ version: '1.0.0' }, '1.0.0').length > 0);
});
