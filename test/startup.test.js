'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { loadConfig } = require('../lib/config');
const { createStorage } = require('../lib/storage');
const { startupDiagnostic } = require('../lib/startup-error');
const ownerKey = crypto.randomBytes(32).toString('hex');
test('configuration errors identify the variable without revealing its value', () => {
  for (const [env, expected] of [
    [{}, 'OWNER_API_KEY_INVALID'],
    [{ OWNER_API_KEY: ownerKey, BASE_URL: ownerKey }, 'BASE_URL_INVALID'],
    [{ OWNER_API_KEY: ownerKey, PORT: ownerKey }, 'CONFIG_NUMBER_INVALID'],
    [{ OWNER_API_KEY: ownerKey, DEFAULT_VISIBILITY: ownerKey }, 'VISIBILITY_INVALID']
  ]) {
    assert.throws(() => loadConfig(env), error => {
      const report = startupDiagnostic(error);
      assert.ok(report.includes(expected)); assert.ok(!report.includes(ownerKey)); return true;
    });
  }
  assert.ok(!startupDiagnostic(new Error(ownerKey)).includes(ownerKey));
});
test('legacy migration diagnoses invalid entries without exposing credential data', () => {
  for (const data of ['{"keys":[{"key":"' + ownerKey + '"},', JSON.stringify({ keys: [{ key: ownerKey }] }), 'null', JSON.stringify({ keys: [null] })]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muizi-startup-'));
    try {
      fs.writeFileSync(path.join(dir, 'keys.json'), data);
      assert.throws(() => createStorage(loadConfig({ OWNER_API_KEY: ownerKey, DATA_DIR: dir })), error => {
        const report = startupDiagnostic(error);
        assert.match(report, /LEGACY_/); assert.ok(!report.includes(ownerKey)); return true;
      });
      assert.ok(fs.existsSync(path.join(dir, 'keys.json')));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
test('server loads its adjacent .env when launched from another working directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muizi-pm2-'));
  let child;
  try {
    const app = path.join(dir, 'app'); fs.mkdirSync(app);
    fs.copyFileSync(path.join(__dirname, '..', 'server.js'), path.join(app, 'server.js'));
    fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(app, 'lib'), { recursive: true });
    fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(app, 'node_modules'), 'junction');
    fs.writeFileSync(path.join(app, '.env'), `OWNER_API_KEY=${ownerKey}\nPORT=0\nHOST=127.0.0.1\n`);
    const env = { ...process.env };
    for (const name of ['OWNER_API_KEY', 'DATA_DIR', 'BASE_URL', 'PORT', 'HOST']) delete env[name];
    child = spawn(process.execPath, [path.join(app, 'server.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const outcome = await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Server startup timed out')); }, 5000);
      child.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes('MUIZI CDN listening')) { clearTimeout(timeout); resolve(output); } });
      child.stderr.on('data', chunk => { output += chunk.toString(); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); if (code !== 0) reject(new Error('Server failed to start')); });
    });
    assert.ok(!outcome.includes(ownerKey));
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }); child = null;
  } finally { if (child) child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});
