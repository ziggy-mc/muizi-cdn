'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { loadConfig } = require('../lib/config');
const { createApplication } = require('../lib/app');
const { createStorage } = require('../lib/storage');
const owner = crypto.randomBytes(32).toString('hex');
let svc, server, base, dir, alice, bob;
const bearer = key => ({ Authorization: `Bearer ${key}` });
async function request(url, { key = owner, body, method = 'GET', headers = {} } = {}) {
  const res = await fetch(base + url, { method, headers: { ...(key ? bearer(key) : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return res;
}
async function makeKey(body) {
  const res = await request('/api/keys', { method: 'POST', body });
  assert.equal(res.status, 201, await res.clone().text()); return res.json();
}
async function upload({ key = alice.key, content = '0123456789', filename = 'test.txt', folder = 'a/b', visibility = 'public', headers = {} } = {}) {
  const form = new FormData();
  // Deliberately send path after file to catch the original finalization race.
  form.append('file', new Blob([content], { type: 'text/html' }), filename);
  form.append('path', folder); form.append('visibility', visibility);
  const res = await fetch(base + '/upload', { method: 'POST', headers: { ...bearer(key), ...headers }, body: form });
  return { res, data: await res.json() };
}
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muizi-test-'));
  svc = createApplication(loadConfig({ OWNER_API_KEY: owner, DATA_DIR: dir, UPLOAD_URL_STYLE: 'legacy', MAX_UPLOAD_BYTES: '1048576', CLEANUP_INTERVAL_SECONDS: '3600' }));
  server = svc.app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
  alice = await makeKey({ userId: 'alice', scopes: ['files:upload', 'files:manage'] });
  bob = await makeKey({ userId: 'bob', scopes: ['files:upload', 'files:manage'] });
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); svc.close(); fs.rmSync(dir, { recursive: true, force: true }); });
test('ordinary uploads get the default policy, detected MIME and nested namespace', async () => {
  const { res, data } = await upload(); assert.equal(res.status, 200, JSON.stringify(data));
  assert.match(data.path, /^unverified\/file\/alice\/a\/b\/[a-f0-9-]+\.txt$/);
  assert.equal(data.file.mime, 'text/plain'); assert.equal(data.file.retentionPolicy, 'default');
  assert.equal(data.file.expiresAt - data.file.createdAt, 7 * 86400000);
  assert.equal((await request('/' + data.path, { key: null })).status, 200);
  assert.equal(fs.readdirSync(svc.store.temp).length, 0);
});
test('all mutations enforce ownership including legacy routes and exact paths', async () => {
  const { data: f } = await upload({ visibility: 'protected' });
  const attempts = [
    ['/delete/' + f.path, 'DELETE'], ['/path/' + f.path, 'POST', { path: 'stolen' }],
    ['/retention/' + f.path, 'POST', { days: 2, enabled: true }],
    ['/api/files/' + f.filename, 'PATCH', { visibility: 'public' }],
    ['/api/files/' + f.filename + '/links', 'POST', {}]
  ];
  for (const [url, method, body] of attempts) assert.equal((await request(url, { key: bob.key, method, body })).status, 403, url);
  assert.equal((await request('/' + f.path, { key: bob.key })).status, 403);
  assert.equal((await request('/' + f.path, { key: null })).status, 404);
  const ok = await request('/' + f.path, { key: alice.key }); assert.equal(ok.status, 200); assert.equal(await ok.text(), '0123456789'); assert.match(ok.headers.get('cache-control'), /no-store/);
  assert.equal((await request('/alias/' + path.basename(f.path), { key: owner })).status, 404);
});
test('read-only explicit file grants cannot upload or modify, and directory grants respect boundaries', async () => {
  const { data: f } = await upload({ visibility: 'protected' });
  const reader = await makeKey({ userId: 'guest', role: 'read', fileIds: [f.filename] });
  assert.equal((await request('/' + f.path, { key: reader.key, method: 'HEAD' })).status, 200);
  assert.equal((await upload({ key: reader.key })).res.status, 403);
  assert.equal((await request('/delete/' + f.path, { key: reader.key, method: 'DELETE' })).status, 403);
  const scoped = await makeKey({ userId: 'guest', role: 'read', directory: 'unverified/file/alice/a/b' });
  assert.equal((await request('/' + f.path, { key: scoped.key })).status, 200);
  const outside = await upload({ folder: 'a/b-other', visibility: 'protected' });
  assert.equal((await request('/' + outside.data.path, { key: scoped.key })).status, 403);
});
test('keys are hashed, expiration enforced, listing contains no credentials', async () => {
  const row = svc.store.db.prepare('SELECT * FROM api_keys WHERE id=?').get(alice.id);
  assert.notEqual(row.keyHash, alice.key); assert.equal(row.keyHash.length, 64);
  const listing = await (await request('/api/keys')).text(); assert.ok(!listing.includes(alice.key)); assert.ok(!listing.includes(row.keyHash));
  const key = await makeKey({ userId: 'expired', role: 'read', expiresAt: Date.now() + 5000 });
  svc.store.db.prepare('UPDATE api_keys SET expiresAt=? WHERE id=?').run(Date.now() - 1, key.id);
  assert.equal((await request('/api/files', { key: key.key })).status, 401);
  assert.equal((await request('/api/keys', { key: alice.key })).status, 403);
});
test('restricted administrators cannot widen grants or read another namespace by delegation', async () => {
  const admin = await makeKey({ userId: 'alice', role: 'admin' });
  const foreign = await upload({ key: bob.key, visibility: 'protected' });
  for (const body of [{ role: 'read', directory: 'unverified/file/bob' }, { role: 'read', fileIds: [foreign.data.filename] }, { role: 'admin' }, { role: 'upload', userId: 'bob' }]) {
    assert.equal((await request('/api/keys', { key: admin.key, method: 'POST', body })).status, 403);
  }
  const restricted = await makeKey({ userId: 'alice', role: 'admin', directory: 'unverified/file/alice/a', expiresAt: Date.now() + 60000 });
  assert.equal((await request('/api/keys', { key: restricted.key, method: 'POST', body: { role: 'read' } })).status, 403);
});
test('signed links authenticate before ranges and conditions, bind versions, issuer and disposition', async () => {
  const { data: f } = await upload({ visibility: 'protected' });
  const response = await request(`/api/files/${f.filename}/links`, { key: alice.key, method: 'POST', body: { download: true, expiresIn: 60 } });
  assert.equal(response.status, 200); const { url } = await response.json(); assert.ok(!url.includes(alice.key));
  const get = await request(url, { key: null }); assert.equal(get.status, 200); assert.match(get.headers.get('content-disposition'), /^attachment/);
  assert.equal((await request(url, { key: null, method: 'HEAD' })).status, 200);
  assert.equal((await request(url + 'x', { key: null, headers: { Range: 'bytes=0-1' } })).status, 404);
  await request(`/api/files/${f.filename}/revoke-links`, { key: alice.key, method: 'POST', body: {} });
  assert.equal((await request(url, { key: null })).status, 404);
  const link2 = await (await request(`/api/files/${f.filename}/links`, { key: alice.key, method: 'POST', body: {} })).json();
  await request(`/api/files/${f.filename}`, { key: alice.key, method: 'PATCH', body: { visibility: 'public' } });
  assert.equal((await request(link2.url, { key: null })).status, 404);
  const temp = await makeKey({ userId: 'alice', role: 'read' });
  const link3 = await (await request(`/api/files/${f.filename}/links`, { key: temp.key, method: 'POST', body: {} })).json();
  await request('/api/keys/' + temp.id, { method: 'DELETE' });
  assert.equal((await request(link3.url, { key: null })).status, 404);
});
test('serving supports HEAD, ranges, suffixes, bounds and conditional requests', async () => {
  const { data: f } = await upload(); const url = '/' + f.path;
  const get = await request(url, { key: null }); const etag = get.headers.get('etag');
  assert.match(get.headers.get('cache-control'), /must-revalidate/); assert.equal(get.headers.get('content-length'), '10');
  const head = await request(url, { key: null, method: 'HEAD', headers: { Range: 'bytes=0-2' } }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
  for (const [range, expected] of [['bytes=2-4', '234'], ['bytes=-3', '789'], ['bytes=8-99', '89'], ['bytes=3-', '3456789'], ['bytes=-999', '0123456789']]) {
    const res = await request(url, { key: null, headers: { Range: range } }); assert.equal(res.status, 206, range); assert.equal(await res.text(), expected);
  }
  for (const range of ['bytes=10-', 'bytes=-0', 'bytes=4-2', 'bytes=-', 'bytes=nope']) { const res = await request(url, { key: null, headers: { Range: range } }); assert.equal(res.status, 416); assert.equal(res.headers.get('content-range'), 'bytes */10'); }
  assert.equal((await request(url, { key: null, headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await request(url, { key: null, headers: { Range: 'bytes=1-2', 'If-Range': '"old"' } })).status, 200);
  assert.equal((await request(url, { key: null, headers: { Range: 'bytes=0-1,5-7' } })).status, 200);
});
test('privacy and expiration checks precede conditional responses and cleanup', async () => {
  const { data: f } = await upload(); const url = '/' + f.path;
  const etag = (await request(url, { key: null })).headers.get('etag');
  await request(`/api/files/${f.filename}`, { key: alice.key, method: 'PATCH', body: { visibility: 'protected' } });
  assert.equal((await request(url, { key: null, headers: { 'If-None-Match': etag } })).status, 404);
  svc.store.db.prepare('UPDATE files SET expiresAt=? WHERE id=?').run(Date.now() - 1, f.filename);
  assert.equal((await request(url, { headers: { 'If-None-Match': etag } })).status, 404);
  assert.ok(fs.existsSync(path.join(svc.store.root, f.path))); svc.store.cleanup();
  assert.ok(!fs.existsSync(path.join(svc.store.root, f.path)));
});
test('retention supports units and permanent restrictions with backward-compatible headers', async () => {
  assert.equal((await upload({ headers: { 'X-Retention-Duration': '1', 'X-Retention-Unit': 'hours' } })).res.status, 403);
  assert.equal((await upload({ headers: { 'X-Retention-Enabled': 'false' } })).res.status, 403);
  const day = await upload({ headers: { 'X-Retention-Days': '2' } }); assert.equal(day.data.file.retentionDuration, 2 * 86400000);
  const minute = await upload({ key: owner, headers: { 'X-Retention-Duration': '2', 'X-Retention-Unit': 'minutes' } }); assert.equal(minute.data.file.retentionDuration, 120000);
  const forever = await upload({ key: owner, headers: { 'X-Retention-Enabled': 'false' } }); assert.equal(forever.data.file.expiresAt, null);
  const res = await request('/retention/' + day.data.path, { key: alice.key, method: 'POST', body: { duration: 2, unit: 'weeks' } }); assert.equal(res.status, 200); assert.equal((await res.json()).retention.expiresAt, day.data.file.createdAt + 14 * 86400000);
});
test('moves preserve metadata, reject collision and prune only empty ancestors', async () => {
  const { data: f } = await upload({ folder: 'unique/deep/end' });
  const destFolder = 'moved/deep';
  const collision = path.join(svc.store.root, 'unverified/file/alice', destFolder, path.basename(f.path));
  fs.mkdirSync(path.dirname(collision), { recursive: true }); fs.writeFileSync(collision, 'unrelated');
  assert.equal((await request('/path/' + f.path, { key: alice.key, method: 'POST', body: { path: destFolder } })).status, 409);
  assert.equal(fs.readFileSync(collision, 'utf8'), 'unrelated'); assert.ok(fs.existsSync(path.join(svc.store.root, f.path)));
  fs.unlinkSync(collision);
  const moved = await (await request('/path/' + f.path, { key: alice.key, method: 'POST', body: { path: destFolder } })).json();
  assert.equal((await request('/' + f.path, { key: null })).status, 404); assert.equal((await request('/' + moved.path, { key: null })).status, 200);
  assert.ok(!fs.existsSync(path.join(svc.store.root, 'unverified/file/alice/unique')));
  const parent = path.dirname(path.join(svc.store.root, moved.path)); fs.writeFileSync(path.join(parent, 'unrelated'), 'keep');
  assert.equal((await request('/delete/' + moved.path, { key: alice.key, method: 'DELETE' })).status, 200);
  assert.ok(fs.existsSync(parent)); assert.ok(fs.existsSync(svc.store.root));
});
test('path traversal, unmanaged files and symlink aliases cannot expose data', async () => {
  const { data: f } = await upload({ visibility: 'protected', folder: 'symlink/target' });
  fs.writeFileSync(path.join(svc.store.root, 'unmanaged.txt'), 'do not expose');
  assert.equal((await request('/unmanaged.txt', { key: null })).status, 404);
  assert.equal((await upload({ folder: '../escape' })).res.status, 400);
  assert.equal((await request('/%252e%252e/anything', { key: null })).status, 404);
  const disk = path.join(svc.store.root, f.path), real = disk + '.real'; fs.renameSync(disk, real); fs.symlinkSync(real, disk);
  assert.equal((await request('/' + f.path, { key: alice.key })).status, 403);
  fs.unlinkSync(disk); fs.renameSync(real, disk);
  const directory = path.dirname(disk), moved = directory + '-real'; fs.renameSync(directory, moved); fs.symlinkSync(moved, directory);
  assert.equal((await request('/' + f.path, { key: alice.key })).status, 403);
  fs.unlinkSync(directory); fs.renameSync(moved, directory);
});
test('HTML/SVG and malicious names are attachment-only with a sandbox', async () => {
  for (const filename of ['test.html', 'test.svg']) {
    const { data: f } = await upload({ filename, content: '<script>alert(1)</script>' });
    const res = await request('/' + f.path, { key: null });
    assert.match(res.headers.get('content-disposition'), /^attachment/); assert.match(res.headers.get('content-security-policy'), /sandbox/); assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
  const { data: f } = await upload();
  const renamed = await request('/api/files/' + f.filename, { key: alice.key, method: 'PATCH', body: { originalName: 'bad\r\nX-Evil: yes.txt' } }); assert.equal(renamed.status, 200);
  const res = await request('/' + f.path, { key: null }); assert.equal(res.headers.get('x-evil'), null);
});
test('invalid, excessive and aborted multipart uploads leave no records or temporary files', async () => {
  const before = svc.store.db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
  assert.equal((await request('/upload', { key: alice.key, method: 'POST', body: {} })).status, 400);
  const huge = await upload({ content: Buffer.alloc(1048577) }); assert.equal(huge.res.status, 413);
  const form = new FormData(); form.append('file', new Blob(['a']), 'a.txt'); form.append('file', new Blob(['b']), 'b.txt');
  assert.equal((await fetch(base + '/upload', { method: 'POST', headers: bearer(alice.key), body: form })).status, 400);
  const bad = await fetch(base + '/upload', { method: 'POST', headers: { ...bearer(alice.key), 'Content-Type': 'multipart/form-data; boundary=x' }, body: '--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nincomplete' }); assert.equal(bad.status, 400);
  await new Promise(resolve => {
    const req = http.request(base + '/upload', { method: 'POST', headers: { ...bearer(alice.key), 'Content-Type': 'multipart/form-data; boundary=x' } });
    req.on('error', () => resolve()); req.write('--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nincomplete'); setTimeout(() => req.destroy(), 30);
  });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(svc.store.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, before);
  assert.equal(fs.readdirSync(svc.store.temp).length, 0);
});
test('lists and metadata do not leak another user; pagination and folder listing work', async () => {
  const { data: f } = await upload({ visibility: 'protected' });
  const list = await (await request('/api/files?limit=1', { key: alice.key })).json(); assert.equal(list.files.length, 1); assert.ok(list.next);
  const second = await (await request('/api/files?limit=1&after=' + list.next, { key: alice.key })).json(); assert.notEqual(second.files[0].id, list.files[0].id);
  const bobList = await (await request('/api/files', { key: bob.key })).json(); assert.ok(!bobList.files.some(file => file.id === f.filename));
  assert.equal((await request('/api/files/' + f.filename, { key: bob.key })).status, 403);
});
test('legacy SQLite and plaintext keys migrate once, preserving public paths and ownership', () => {
  const Database = require('better-sqlite3'), legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muizi-legacy-'));
  try {
    const db = new Database(path.join(legacyDir, 'cdn.db'));
    db.exec('CREATE TABLE files(id TEXT PRIMARY KEY, originalName TEXT,size INTEGER,mime TEXT,uploadedAt INTEGER,retentionOverride INTEGER,retentionDays INTEGER,storagePath TEXT)');
    db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?,?)').run('old', 'old.txt', 3, 'text/plain', Date.now(), 1, 2, 'unverified/file/legacy/a/old.txt'); db.close();
    fs.mkdirSync(path.join(legacyDir, 'uploads/unverified/file/legacy/a'), { recursive: true }); fs.writeFileSync(path.join(legacyDir, 'uploads/unverified/file/legacy/a/old.txt'), 'old');
    const key = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(path.join(legacyDir, 'keys.json'), JSON.stringify({ keys: [{ key, userId: 'legacy' }] }));
    const config = loadConfig({ OWNER_API_KEY: owner, DATA_DIR: legacyDir });
    let store = createStorage(config); const row = store.db.prepare('SELECT * FROM files').get(); assert.equal(row.ownerId, 'legacy'); assert.equal(row.expiresAt, row.createdAt + 2 * 86400000); assert.equal(row.visibility, 'public');
    assert.ok(!fs.existsSync(path.join(legacyDir, 'keys.json'))); assert.notEqual(store.db.prepare('SELECT * FROM api_keys').get().keyHash, key); store.db.close();
    store = createStorage(config); assert.equal(store.db.prepare('SELECT COUNT(*) n FROM api_keys').get().n, 1); store.db.close();
  } finally { fs.rmSync(legacyDir, { recursive: true, force: true }); }
});
test('journal recovery finishes interrupted upload/move/delete and cleans stale temp files', async () => {
  const { data: f } = await upload({ folder: 'recover/a' });
  const old = path.join(svc.store.root, f.path), newPath = 'recovery/' + path.basename(f.path), dest = path.join(svc.store.root, newPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.linkSync(old, dest);
  svc.store.db.prepare("UPDATE files SET state='moving' WHERE id=?").run(f.filename);
  svc.store.db.prepare("INSERT INTO operations VALUES (?,'move',?,?,NULL)").run(f.filename, f.path, newPath);
  svc.store.recover(); assert.ok(!fs.existsSync(old)); assert.equal(svc.store.db.prepare('SELECT storagePath FROM files WHERE id=?').get(f.filename).storagePath, newPath);
  svc.store.db.prepare("UPDATE files SET state='deleting' WHERE id=?").run(f.filename);
  svc.store.db.prepare("INSERT INTO operations VALUES (?,'delete',?,NULL,NULL)").run(f.filename, newPath); fs.unlinkSync(dest);
  const stale = path.join(svc.store.temp, 'stale.upload'); fs.writeFileSync(stale, 'old'); fs.utimesSync(stale, new Date(0), new Date(0));
  svc.store.cleanup(); assert.equal(svc.store.db.prepare('SELECT 1 FROM files WHERE id=?').get(f.filename), undefined); assert.ok(!fs.existsSync(stale));
  const pending = await upload({ folder: 'pending' }); const record = svc.store.db.prepare('SELECT * FROM files WHERE id=?').get(pending.data.filename);
  const tempName = crypto.randomUUID() + '.upload'; fs.linkSync(path.join(svc.store.root, record.storagePath), path.join(svc.store.temp, tempName)); fs.unlinkSync(path.join(svc.store.root, record.storagePath));
  svc.store.db.prepare("UPDATE files SET state='pending' WHERE id=?").run(record.id); svc.store.db.prepare("INSERT INTO operations VALUES (?,'upload',NULL,?,?)").run(record.id, record.storagePath, tempName);
  svc.store.recover(); assert.ok(fs.existsSync(path.join(svc.store.root, record.storagePath))); assert.equal(svc.store.db.prepare('SELECT state FROM files WHERE id=?').get(record.id).state, 'active');
});
test('FFmpeg conversion produces stored output size and MIME', async t => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { t.skip('ffmpeg unavailable'); return; }
  const wav = path.join(dir, 'tone.wav');
  const result = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1', wav]); assert.equal(result.status, 0);
  const { res, data } = await upload({ content: fs.readFileSync(wav), filename: 'tone.wav' }); assert.equal(res.status, 200, JSON.stringify(data)); assert.equal(data.file.mime, 'audio/mpeg'); assert.match(data.path, /\.mp3$/); assert.equal(data.file.size, fs.statSync(path.join(svc.store.root, data.path)).size);
});
test('storage and database failures keep recoverable intents and never expose pending bytes', async () => {
  const originalLink = fs.linkSync;
  let failed = false;
  fs.linkSync = (...args) => {
    if (!failed && args[1].startsWith(svc.store.root)) { failed = true; throw Object.assign(new Error('simulated storage error'), { code: 'EIO' }); }
    return originalLink(...args);
  };
  let attempted;
  try { attempted = await upload({ folder: 'failure/disk' }); } finally { fs.linkSync = originalLink; }
  assert.equal(attempted.res.status, 500);
  let op = svc.store.db.prepare("SELECT * FROM operations WHERE kind='upload'").get(); assert.ok(op);
  assert.equal((await request('/' + op.newPath, { key: null })).status, 404);
  svc.store.recover(); assert.equal((await request('/' + op.newPath, { key: null })).status, 200);
  const prepare = svc.store.db.prepare;
  failed = false;
  svc.store.db.prepare = function(sql, ...args) {
    if (!failed && sql.startsWith("UPDATE files SET state='active',storagePath=")) { failed = true; return { run() { throw Object.assign(new Error('simulated SQLite failure'), { code: 'SQLITE_IOERR' }); } }; }
    return prepare.call(this, sql, ...args);
  };
  try { attempted = await upload({ folder: 'failure/database' }); } finally { svc.store.db.prepare = prepare; }
  assert.equal(attempted.res.status, 500);
  op = svc.store.db.prepare("SELECT * FROM operations WHERE kind='upload'").get(); assert.ok(op); assert.ok(fs.existsSync(path.join(svc.store.root, op.newPath)));
  assert.equal((await request('/' + op.newPath, { key: null })).status, 404); svc.store.recover();
  assert.equal((await request('/' + op.newPath, { key: null })).status, 200);
  const originalUnlink = fs.unlinkSync;
  failed = false;
  fs.unlinkSync = (...args) => {
    if (!failed && args[0] === path.join(svc.store.root, op.newPath)) { failed = true; throw Object.assign(new Error('simulated deletion error'), { code: 'EACCES' }); }
    return originalUnlink(...args);
  };
  try { assert.equal((await request('/delete/' + op.newPath, { key: alice.key, method: 'DELETE' })).status, 500); } finally { fs.unlinkSync = originalUnlink; }
  assert.equal((await request('/' + op.newPath, { key: null })).status, 404);
  svc.store.cleanup(); assert.equal(svc.store.db.prepare('SELECT 1 FROM operations LIMIT 1').get(), undefined);
  assert.equal(fs.readdirSync(svc.store.temp).length, 0);
});
test('disk-space failures return 507 and do not persist files', async () => {
  const { Writable } = require('node:stream');
  const original = fs.createWriteStream;
  fs.createWriteStream = () => new Writable({ write(chunk, encoding, callback) { callback(Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' })); } });
  let result;
  try { result = await upload(); } finally { fs.createWriteStream = original; }
  assert.equal(result.res.status, 507, JSON.stringify(result.data));
  assert.equal(fs.readdirSync(svc.store.temp).length, 0);
});
test('startup recovery handles a committed move whose destination was not durable', () => {
  const { dataDir, ...rest } = svc.config;
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'muizi-restart-'));
  try {
    let storage = createStorage({ ...rest, dataDir: local });
    const tempName = 'test.upload'; fs.writeFileSync(path.join(storage.temp, tempName), 'content');
    storage.finalize({ id: 'restart-id', originalName: 'test.txt', size: 7, mime: 'text/plain', storagePath: 'old/file.txt', ownerId: 'alice', visibility: 'protected', createdAt: Date.now(), expiresAt: null, retentionDuration: null, retentionPolicy: 'permanent', retentionOverride: 0, retentionDays: null }, tempName);
    storage.db.prepare("UPDATE files SET storagePath='new/file.txt' WHERE id='restart-id'").run();
    storage.db.prepare("INSERT INTO operations VALUES ('restart-id','move','old/file.txt','new/file.txt',NULL)").run();
    storage.db.close();
    storage = createStorage({ ...rest, dataDir: local });
    assert.equal(fs.readFileSync(path.join(storage.root, 'new/file.txt'), 'utf8'), 'content'); assert.ok(!fs.existsSync(path.join(storage.root, 'old/file.txt')));
    assert.equal(storage.db.prepare('SELECT 1 FROM operations').get(), undefined); storage.db.close();
  } finally { fs.rmSync(local, { recursive: true, force: true }); }
});
test('quotas, detected MIME allowlists and upload capacity are enforced', async () => {
  const previousQuota = svc.config.maxUserBytes, previousMime = svc.config.allowedMime, previousConcurrency = svc.config.maxConcurrentUploads;
  const used = svc.store.db.prepare('SELECT SUM(size) AS n FROM files WHERE ownerId=?').get('alice').n;
  try {
    svc.config.maxUserBytes = used + 9;
    assert.equal((await upload()).res.status, 413);
    svc.config.maxUserBytes = 0;
    svc.config.allowedMime = ['image/png'];
    assert.equal((await upload()).res.status, 415);
    svc.config.allowedMime = [];
    svc.config.maxConcurrentUploads = 1;
    let responseResolve;
    const response = new Promise(resolve => { responseResolve = resolve; });
    const req = http.request(base + '/upload', { method: 'POST', headers: { ...bearer(alice.key), 'Content-Type': 'multipart/form-data; boundary=capacity' } }, res => { res.resume(); res.on('end', () => responseResolve(res.statusCode)); });
    req.on('error', () => responseResolve(0));
    req.write('--capacity\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nwaiting');
    await new Promise(resolve => setTimeout(resolve, 30));
    const second = await upload(); assert.equal(second.res.status, 503); assert.equal(second.res.headers.get('retry-after'), '5');
    req.end('\r\n--capacity--\r\n'); assert.equal(await response, 200);
  } finally {
    svc.config.maxUserBytes = previousQuota; svc.config.allowedMime = previousMime; svc.config.maxConcurrentUploads = previousConcurrency;
  }
});
test('signed link expiry, key expiry and deletion are enforced without waiting for cleanup', async () => {
  const { data: f } = await upload({ visibility: 'protected' });
  const key = await makeKey({ userId: 'alice', role: 'read', expiresAt: Date.now() + 60000 });
  const link = await (await request(`/api/files/${f.filename}/links`, { key: key.key, method: 'POST', body: { expiresIn: 1 } })).json();
  const originalNow = Date.now;
  try { Date.now = () => link.expiresAt + 1; assert.equal((await request(link.url, { key: null })).status, 404); }
  finally { Date.now = originalNow; }
  const link2 = await (await request(`/api/files/${f.filename}/links`, { key: key.key, method: 'POST', body: {} })).json();
  svc.store.db.prepare('UPDATE api_keys SET expiresAt=? WHERE id=?').run(Date.now() - 1, key.id);
  assert.equal((await request(link2.url, { key: null })).status, 404);
  const link3 = await (await request(`/api/files/${f.filename}/links`, { method: 'POST', body: {} })).json();
  await request(`/api/files/${f.filename}`, { key: alice.key, method: 'DELETE' });
  assert.equal((await request(link3.url, { key: null })).status, 404);
});
test('unscoped administrators cannot invent cross-owner read grants inside their own namespace', async () => {
  const { data: f } = await upload({ key: owner, visibility: 'protected', folder: 'unverified/file/alice/admin-private' });
  const admin = await makeKey({ userId: 'alice', role: 'admin' });
  const child = await (await request('/api/keys', { key: admin.key, method: 'POST', body: { role: 'read', directory: 'unverified/file/alice' } })).json();
  assert.equal(child.crossOwnerRead, false);
  assert.equal((await request('/' + f.path, { key: child.key })).status, 403);
  const direct = await makeKey({ userId: 'alice', role: 'read', directory: 'unverified/file/alice' });
  assert.equal(direct.crossOwnerRead, true);
  assert.equal((await request('/' + f.path, { key: direct.key })).status, 200);
});
test('video conversion preserves MP4 playback and byte-range seeking', async t => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { t.skip('ffmpeg unavailable'); return; }
  const mov = path.join(dir, 'video.mov');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=0.2', '-c:v', 'libx264', '-an', '-f', 'mov', mov]);
  assert.equal(made.status, 0);
  const { res, data } = await upload({ content: fs.readFileSync(mov), filename: 'clip.mov' });
  assert.equal(res.status, 200, JSON.stringify(data)); assert.equal(data.file.mime, 'video/mp4'); assert.match(data.path, /\.mp4$/);
  const range = await request('/' + data.path, { key: null, headers: { Range: 'bytes=0-31' } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32); assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.match(range.headers.get('content-security-policy'), /media-src 'self'/);
  assert.doesNotMatch(range.headers.get('content-security-policy'), /(?:^|;)\s*sandbox(?:;|$)/);
});
test('malformed legacy migration rolls back and startup logs never contain raw credentials', () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'muizi-bad-keys-'));
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(path.join(local, 'keys.json'), '{"keys":[{"key":"' + secret + '"},');
    const result = spawnSync(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, OWNER_API_KEY: owner, DATA_DIR: local }, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.ok(!result.stdout.includes(secret)); assert.ok(!result.stderr.includes(secret)); assert.match(result.stderr, /initialization failed/);
    assert.ok(fs.existsSync(path.join(local, 'keys.json')));
    const Database = require('better-sqlite3'); const db = new Database(path.join(local, 'cdn.db'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n, 0); db.close();
  } finally { fs.rmSync(local, { recursive: true, force: true }); }
});
test('ID content access shares protection and supports folders colliding with API routes', async () => {
  const { data: f } = await upload({ key: owner, folder: 'api/files', visibility: 'protected' });
  assert.match(f.url, /^\/api\/files\/[a-f0-9-]+\/content$/);
  assert.equal((await request(f.url, { key: null })).status, 404);
  assert.equal((await request(f.url, { key: bob.key })).status, 403);
  assert.equal((await request(f.url)).status, 200);
  const signed = await (await request(`/api/files/${f.filename}/links`, { method: 'POST', body: {} })).json();
  assert.equal((await request(signed.url, { key: null })).status, 200);
});
