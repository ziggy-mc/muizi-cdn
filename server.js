'use strict';
require('dotenv').config({ path: require('node:path').join(__dirname, '.env'), quiet: true });
const { startupDiagnostic } = require('./lib/startup-error');
const { createApplication } = require('./lib/app');
if (require.main === module) {
  try {
    process.umask(0o077);
    const service = createApplication();
    const server = service.app.listen(service.config.port, service.config.host, () => console.log(`MUIZI CDN listening on ${service.config.host}:${service.config.port}`));
    server.requestTimeout = service.config.uploadTimeoutMs;
    server.headersTimeout = Math.min(60000, service.config.uploadTimeoutMs);
    server.on('error', err => { console.error('[server] startup failed', err.code || err.name); service.close(); process.exitCode = 1; });
    let stopping = false;
    const shutdown = () => {
      if (stopping) return; stopping = true;
      server.close(() => { service.close(); process.exit(0); });
      setTimeout(() => process.exit(1), 30000).unref();
    };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } catch (err) { console.error('[startup] initialization failed', startupDiagnostic(err)); process.exitCode = 1; }
}
module.exports = { createApplication };
