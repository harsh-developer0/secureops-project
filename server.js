'use strict';
const { createSecureOps } = require('./src/app');

const app = createSecureOps();

app.start()
  .then(({ dashboardUrl, shopUrl }) => {
    console.log('SecureOps is running.');
    console.log('  Dashboard : ' + dashboardUrl);
    console.log('  Shop app  : ' + shopUrl);
    console.log('Press Ctrl+C to stop.');
  })
  .catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('Port ' + err.port + ' is already in use. Close the other program or choose another port, e.g.:');
      console.error('  $env:DASHBOARD_PORT=3001; $env:SHOP_PORT=4001; npm start');
    } else {
      console.error('Failed to start SecureOps: ' + err.message);
    }
    process.exit(1);
  });

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log('\n' + signal + ' received - shutting down...');
  try { await app.stop(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
