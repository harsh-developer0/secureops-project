'use strict';
const http = require('http');

function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    const onError = (err) => { err.port = err.port || port; reject(err); };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      server.on('error', (e) => console.error('Server error: ' + e.message));
      resolve(server);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
    if (server.closeAllConnections) server.closeAllConnections();
  });
}

// Real HTTP GET with timing. Never throws; resolves {ok:false,error} on network problems.
function getJson(host, port, pathname, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const elapsed = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10;
    const req = http.get(
      { host, port, path: pathname, agent: false, timeout: timeoutMs, headers: { Connection: 'close' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', (e) => resolve({ ok: false, error: e.message, ms: elapsed() }));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
          resolve({ ok: true, status: res.statusCode, headers: res.headers, text, json, ms: elapsed() });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out after ' + timeoutMs + ' ms')));
    req.on('error', (e) => resolve({ ok: false, error: (e.code ? e.code + ': ' : '') + e.message, ms: elapsed() }));
  });
}

module.exports = { listen, close, getJson };
