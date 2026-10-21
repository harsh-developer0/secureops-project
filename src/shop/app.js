'use strict';
const path = require('path');
const express = require('express');
const { listen, close } = require('../http');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public', 'shop');
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// getRuntime() -> { release: manifest|null, failure: { active: boolean } }
function createShopApp(getRuntime) {
  const app = express();
  app.disable('x-powered-by');
  const startedAt = Date.now();

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    next();
  });

  app.get('/health', (req, res) => {
    const rt = getRuntime();
    res.set('Cache-Control', 'no-store');
    if (!rt.release) return res.status(503).json({ status: 'unhealthy', reason: 'Release manifest could not be loaded', simulated: false });
    if (rt.failure && rt.failure.active) {
      return res.status(503).json({ status: 'unhealthy', version: rt.release.version, reason: 'Simulated failure flag is active', simulated: true });
    }
    res.json({ status: 'healthy', version: rt.release.version, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
  });

  app.get('/api/products', (req, res) => {
    const { release } = getRuntime();
    res.set('Cache-Control', 'no-store');
    if (!release) return res.status(503).json({ error: 'Release unavailable' });
    res.json({
      version: release.version,
      storeName: release.storeName,
      banner: release.banner || '',
      accent: release.theme.accent,
      products: release.products.map((p) => ({ id: p.id, name: p.name, priceCents: p.priceCents })),
    });
  });

  app.get('/img/:id.svg', (req, res) => {
    const { release } = getRuntime();
    const p = release && release.products.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).type('text/plain').send('Not found');
    const color = HEX_RE.test(p.color) ? p.color : '#2563eb';
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" role="img" aria-label="' + xml(p.name) + '">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.35"/></linearGradient></defs>' +
      '<rect width="400" height="300" fill="' + color + '"/><circle cx="340" cy="40" r="110" fill="#fff" fill-opacity="0.14"/>' +
      '<circle cx="50" cy="290" r="90" fill="#fff" fill-opacity="0.10"/><rect width="400" height="300" fill="url(#g)"/>' +
      '<text x="200" y="180" font-size="110" text-anchor="middle">' + xml(p.icon) + '</text></svg>';
    res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' }).send(svg);
  });

  app.get('/cart.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'cart.js')));
  app.use(express.static(PUBLIC_DIR, { etag: false, maxAge: 0 }));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

// Starts a standalone shop instance for a fixed release (used by pipeline tests and security checks).
async function startShop({ release, failureActive = false, host = '127.0.0.1', port = 0 }) {
  const app = createShopApp(() => ({ release, failure: { active: failureActive } }));
  const server = await listen(app, port, host);
  return { port: server.address().port, close: () => close(server) };
}

module.exports = { createShopApp, startShop };
