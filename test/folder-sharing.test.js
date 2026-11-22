'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createApplication } = require('../lib/app');
const { loadConfig } = require('../lib/config');
const { filenameFilter } = require('../lib/filenames');
const owner = crypto.randomBytes(32).toString('hex');
let service, server, base, dir, alice, bob;
async function req(url, { key = owner, method = 'GET', body, headers = {} } = {}) {
  return fetch(base + url, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
}
async function upload({ key = alice.key, filename = 'original photo.png', visibility = 'protected', folder = 'images/nested', content } = {}) {
  const data = new FormData();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcZkAAAAASUVORK5CYII=', 'base64');
  data.append('file', new Blob([content || png]), filename); data.append('path', folder); data.append('visibility', visibility);
  const response = await fetch(base + '/upload', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: data });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
}
async function createKey(body) {
  const response = await req('/api/keys', { method: 'POST', body }); assert.equal(response.status, 201); return response.json();
}
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muizi-folder-'));
  service = createApplication(loadConfig({ OWNER_API_KEY: owner, DATA_DIR: dir, MAX_UPLOAD_BYTES: '1048576' }));
  server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
  alice = await createKey({ userId: 'alice', scopes: ['files:upload', 'files:manage'] });
  bob = await createKey({ userId: 'bob', scopes: ['files:upload', 'files:manage'] });
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
test('default uploads have extensionless folder URLs, safe MIME and original download names', async () => {
  const file = await upload({ visibility: 'public' });
  assert.equal(file.file.urlStyle, 'folder'); assert.equal(path.posix.basename(file.path), file.filename); assert.equal(path.extname(file.path), '');
  const row = service.store.db.prepare('SELECT * FROM files WHERE id=?').get(file.filename);
  assert.equal(row.storagePath, file.path + '/content.png'); assert.ok(fs.statSync(path.join(service.store.root, file.path)).isDirectory());
  for (const suffix of ['', '/']) {
    const response = await req('/' + file.path + suffix, { key: null }); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png'); assert.match(response.headers.get('content-disposition'), /inline; filename="original photo.png"/);
  }
  const download = await req('/' + file.path + '?download=1', { key: null }); assert.match(download.headers.get('content-disposition'), /attachment; filename="original photo.png"/);
  assert.equal((await req('/' + row.storagePath, { key: null })).status, 404);
  const range = await req('/' + file.path, { key: null, headers: { Range: 'bytes=-8' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 8);
  assert.equal((await req('/' + file.path, { key: null, method: 'HEAD' })).status, 200);
});
test('old extension URLs and new folder URLs coexist in the same installation', async () => {
  service.config.uploadUrlStyle = 'legacy'; let old;
  try { old = await upload({ visibility: 'public' }); } finally { service.config.uploadUrlStyle = 'folder'; }
  const modern = await upload({ visibility: 'public' });
  assert.match(old.path, /\.png$/); assert.equal(modern.file.urlStyle, 'folder');
  for (const file of [old, modern]) {
    assert.equal((await req('/' + file.path, { key: null })).status, 200);
    const signed = await (await req(`/api/files/${file.filename}/links`, { key: alice.key, method: 'POST', body: {} })).json();
    assert.equal((await req(signed.url, { key: null })).status, 200);
  }
  assert.equal((await req('/' + old.path + '/', { key: null })).status, 404);
});
test('filename redaction covers upload, rename and legacy responses without substring false positives', async () => {
  const file = await upload({ filename: 'FUCK-holiday.png', visibility: 'public' });
  assert.equal(file.file.originalName, 'redacted-holiday.png'); assert.equal(service.store.db.prepare('SELECT originalName FROM files WHERE id=?').get(file.filename).originalName, 'redacted-holiday.png');
  const renamed = await req(`/api/files/${file.filename}`, { key: alice.key, method: 'PATCH', body: { originalName: 'shit_photo.png' } }); assert.equal((await renamed.json()).originalName, 'redacted_photo.png');
  service.store.db.prepare('UPDATE files SET originalName=? WHERE id=?').run('old-bullshit.png', file.filename);
  const meta = await (await req(`/api/files/${file.filename}`, { key: alice.key })).json(); assert.equal(meta.originalName, 'old-redacted.png');
  assert.match((await req('/' + file.path, { key: null })).headers.get('content-disposition'), /old-redacted.png/);
  const filter = filenameFilter(service.config);
  assert.equal(filter('Scunthorpe-assistant-cocktail.png'), 'Scunthorpe-assistant-cocktail.png');
  assert.equal(filter('ＦＵＣＫ-photo.png'), 'redacted-photo.png');
  assert.equal(filter('..／safe.png'), 'safe.png');
  const custom = filenameFilter({ filenameWords: ['secret', 'a+b'], filenameReplacement: 'hidden' });
  assert.equal(custom('secret-a+b-photo.png'), 'hidden-hidden-photo.png'); assert.equal(custom('secretion.png'), 'secretion.png');
});
test('protected folder URL conceals authorization from browsers and never leaks bytes through alternate paths', async () => {
  const file = await upload();
  const browser = await req('/' + file.path, { key: null, headers: { Accept: 'text/html' } }); assert.equal(browser.status, 404); assert.match(await browser.text(), /File Not Found/); assert.match(browser.headers.get('cache-control'), /no-store/);
  for (const suffix of ['', '/']) {
    assert.equal((await req('/' + file.path + suffix, { key: null })).status, 404);
    assert.equal((await req('/' + file.path + suffix, { key: bob.key })).status, 403);
    assert.equal((await req('/' + file.path + suffix)).status, 200);
  }
  assert.equal((await req(`/api/files/${file.filename}/content`, { key: null })).status, 404);
  const row = service.store.db.prepare('SELECT * FROM files WHERE id=?').get(file.filename);
  assert.equal((await req('/' + row.storagePath, { key: null })).status, 404);
});
test('file managers create hashed read-only keys and shared links restricted to exactly one file', async () => {
  const file = await upload(), other = await upload();
  const response = await req(`/api/files/${file.filename}/links`, { key: alice.key, method: 'POST', body: { createAccessKey: true, download: true, accessKeyExpiresAt: Date.now() + 60000 } }); assert.equal(response.status, 200);
  const share = await response.json(); const key = share.accessKey;
  assert.equal(key.purpose, 'file'); assert.deepEqual(key.scopes, ['files:read']); assert.deepEqual(key.fileIds, [file.filename]); assert.ok(!share.url.includes(key.key));
  const row = service.store.db.prepare('SELECT * FROM api_keys WHERE id=?').get(key.id); assert.notEqual(row.keyHash, key.key); assert.equal(row.fileVersion, 1);
  assert.equal((await req('/' + file.path, { key: key.key })).status, 200);
  assert.equal((await req('/' + other.path, { key: key.key })).status, 403);
  assert.equal((await req(`/api/files/${file.filename}`, { key: key.key, method: 'DELETE' })).status, 403);
  assert.equal((await req(`/api/files/${file.filename}/access-keys`, { key: key.key, method: 'POST', body: {} })).status, 403);
  assert.equal((await req('/api/keys', { key: key.key, method: 'POST', body: { userId: 'evil', role: 'admin' } })).status, 403);
  const files = await (await req('/api/files', { key: key.key })).json(); assert.deepEqual(files.files.map(f => f.id), [file.filename]);
  const list = await (await req(`/api/files/${file.filename}/access-keys`, { key: alice.key })).text(); assert.ok(!list.includes(key.key)); assert.ok(!list.includes(row.keyHash));
  const signed = await req(share.url + '&download=0', { key: null }); assert.equal(signed.status, 200); assert.match(signed.headers.get('content-disposition'), /^attachment/);
  const resolved = await req('/api/access-links', { key: key.key, method: 'POST', body: { path: file.path + '/' } }); assert.equal(resolved.status, 200);
  assert.equal((await req((await resolved.json()).url, { key: null })).status, 200);
  assert.equal((await req('/api/access-links', { key: key.key, method: 'POST', body: { path: other.path } })).status, 403);
  assert.equal((await req('/' + file.path + '?key=' + encodeURIComponent(key.key), { key: null })).status, 404);
});
test('file-specific keys cannot be minted for foreign files or by upload/read-only keys', async () => {
  const file = await upload();
  assert.equal((await req(`/api/files/${file.filename}/access-keys`, { key: bob.key, method: 'POST', body: {} })).status, 403);
  const uploadKey = await createKey({ userId: 'alice', role: 'upload' });
  assert.equal((await req(`/api/files/${file.filename}/access-keys`, { key: uploadKey.key, method: 'POST', body: {} })).status, 403);
  const readKey = await createKey({ userId: 'alice', role: 'read' });
  assert.equal((await req(`/api/files/${file.filename}/links`, { key: readKey.key, method: 'POST', body: { createAccessKey: true } })).status, 403);
  const publicFile = await upload({ visibility: 'public' });
  assert.equal((await req(`/api/files/${publicFile.filename}/access-keys`, { key: alice.key, method: 'POST', body: {} })).status, 400);
});
test('file keys survive safe moves and renames, but access revocation invalidates keys and links immediately', async () => {
  const file = await upload({ folder: 'move-empty/deep' });
  const share = await (await req(`/api/files/${file.filename}/links`, { key: alice.key, method: 'POST', body: { createAccessKey: true } })).json();
  const move = await req(`/api/files/${file.filename}/move`, { key: alice.key, method: 'POST', body: { path: 'moved/here' } }); assert.equal(move.status, 200);
  const moved = await move.json(); assert.equal(path.posix.basename(moved.path), file.filename); assert.equal(path.extname(moved.path), '');
  assert.ok(!fs.existsSync(path.join(service.store.root, 'unverified/file/alice/move-empty')));
  assert.equal((await req('/' + file.path, { key: share.accessKey.key })).status, 404);
  assert.equal((await req('/' + moved.path, { key: share.accessKey.key })).status, 200);
  assert.equal((await req(share.url, { key: null })).status, 404);
  await req(`/api/files/${file.filename}`, { key: alice.key, method: 'PATCH', body: { originalName: 'renamed.png' } });
  assert.equal((await req('/' + moved.path, { key: share.accessKey.key })).status, 200);
  const link = await (await req('/api/access-links', { key: share.accessKey.key, method: 'POST', body: { path: moved.path } })).json();
  await req(`/api/files/${file.filename}/revoke-access`, { key: alice.key, method: 'POST', body: {} });
  assert.equal((await req('/' + moved.path, { key: share.accessKey.key })).status, 401); assert.equal((await req(link.url, { key: null })).status, 404);
  assert.equal((await req('/' + moved.path)).status, 200); assert.equal((await req('/' + moved.path, { key: alice.key })).status, 200);
});
test('single-key, parent-key and visibility revocation enforce file key lifecycle', async () => {
  const file = await upload();
  const key1 = await (await req(`/api/files/${file.filename}/access-keys`, { key: alice.key, method: 'POST', body: {} })).json();
  const key2 = await (await req(`/api/files/${file.filename}/access-keys`, { key: alice.key, method: 'POST', body: {} })).json();
  assert.equal((await req(`/api/files/${file.filename}/access-keys/${key1.id}`, { key: alice.key, method: 'DELETE' })).status, 200);
  assert.equal((await req('/' + file.path, { key: key1.key })).status, 401); assert.equal((await req('/' + file.path, { key: key2.key })).status, 200);
  await req(`/api/files/${file.filename}`, { key: alice.key, method: 'PATCH', body: { visibility: 'public' } });
  await req(`/api/files/${file.filename}`, { key: alice.key, method: 'PATCH', body: { visibility: 'protected' } });
  assert.equal((await req('/' + file.path, { key: key2.key })).status, 401);
  const parent = await createKey({ userId: 'alice', role: 'management' });
  const child = await (await req(`/api/files/${file.filename}/access-keys`, { key: parent.key, method: 'POST', body: {} })).json();
  await req(`/api/keys/${parent.id}`, { method: 'DELETE' });
  assert.equal((await req('/' + file.path, { key: child.key })).status, 401);
});
test('folder expiration deletes only managed content and prunes empty UUID folders', async () => {
  const file = await upload({ folder: 'expire-empty/deep' });
  const access = await (await req(`/api/files/${file.filename}/access-keys`, { key: alice.key, method: 'POST', body: {} })).json();
  service.store.db.prepare('UPDATE files SET expiresAt=? WHERE id=?').run(Date.now() - 1, file.filename);
  assert.equal((await req('/' + file.path)).status, 404); service.store.cleanup();
  assert.ok(!fs.existsSync(path.join(service.store.root, 'unverified/file/alice/expire-empty')));
  assert.equal(service.auth.byId(access.id), null);
  const other = await upload({ folder: 'preserve/parent' });
  fs.writeFileSync(path.join(service.store.root, other.path, 'unrelated.txt'), 'keep');
  await req(`/api/files/${other.filename}`, { key: alice.key, method: 'DELETE' });
  assert.ok(fs.existsSync(path.join(service.store.root, other.path, 'unrelated.txt')));
});
test('folder move recovery updates public and storage paths together', async () => {
  const file = await upload({ folder: 'recovery/source' });
  const row = service.store.db.prepare('SELECT * FROM files WHERE id=?').get(file.filename);
  const newStorage = `unverified/file/alice/recovered/${file.filename}/content.png`;
  const dest = path.join(service.store.root, newStorage);
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.linkSync(path.join(service.store.root, row.storagePath), dest);
  service.store.db.prepare("UPDATE files SET state='moving' WHERE id=?").run(file.filename);
  service.store.db.prepare("INSERT INTO operations VALUES (?,'move',?,?,NULL)").run(file.filename, row.storagePath, newStorage);
  service.store.recover();
  const updated = service.store.db.prepare('SELECT * FROM files WHERE id=?').get(file.filename);
  assert.equal(updated.publicPath, path.posix.dirname(newStorage)); assert.equal((await req('/' + updated.publicPath, { key: alice.key })).status, 200);
  assert.equal((await req('/' + file.path, { key: alice.key })).status, 404);
});
test('file access keys inherit issuer directory restrictions instead of widening on moves', async () => {
  const file = await upload({ folder: 'issuer-scope/sub' });
  const issuer = await createKey({ userId: 'alice', scopes: ['files:manage'], directory: 'unverified/file/alice/issuer-scope' });
  const key = await (await req(`/api/files/${file.filename}/access-keys`, { key: issuer.key, method: 'POST', body: {} })).json();
  assert.equal(key.directory, issuer.directory);
  const moved = await (await req(`/api/files/${file.filename}/move`, { method: 'POST', body: { path: 'owner-moved' } })).json();
  assert.equal((await req('/' + moved.path, { key: key.key })).status, 403);
  assert.equal((await req('/' + moved.path)).status, 200);
});
test('file key expiration is bounded by issuing credentials and file retention', async () => {
  const file = await upload(); const expiresAt = Date.now() + 60000;
  const issuer = await createKey({ userId: 'alice', role: 'management', expiresAt });
  const key = await (await req(`/api/files/${file.filename}/access-keys`, { key: issuer.key, method: 'POST', body: { expiresAt: Date.now() + 86400000 } })).json();
  assert.equal(key.expiresAt, expiresAt);
  service.store.db.prepare('UPDATE api_keys SET expiresAt=? WHERE id=?').run(Date.now() - 1, key.id);
  assert.equal((await req('/' + file.path, { key: key.key })).status, 401);
  assert.equal((await req('/api/access-links', { key: key.key, method: 'POST', body: { path: file.path } })).status, 401);
});
test('folder metadata exposes logical paths, not disk names, and listing uses the chosen parent folder', async () => {
  const file = await upload({ folder: 'listing/check' });
  const response = await req('/api/files?folder=' + encodeURIComponent('unverified/file/alice/listing/check'), { key: alice.key });
  const listing = await response.text(); assert.ok(!listing.includes('/content.png'));
  assert.ok(JSON.parse(listing).files.some(f => f.path === file.path));
  const filter = filenameFilter({ filenameWords: ['secret'], filenameReplacement: '' });
  assert.equal(filter('secret.png'), 'download.png');
  assert.doesNotThrow(() => filenameFilter(service.config)('a' + '🔥'.repeat(101) + '.png'));
});
test('upgrade backfills folder routing without changing v2 file URLs, API keys or signed links', async () => {
  const Database = require('better-sqlite3');
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'muizi-v2-upgrade-'));
  const id = crypto.randomUUID(), pathName = 'legacy/images/' + id + '.png';
  const token = crypto.randomBytes(32).toString('base64url'), signing = crypto.randomBytes(32), now = Date.now();
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  let upgraded, listener;
  try {
    fs.mkdirSync(path.join(local, 'uploads/legacy/images'), { recursive: true });
    fs.writeFileSync(path.join(local, 'uploads', pathName), 'legacy bytes'); fs.writeFileSync(path.join(local, 'signing.key'), signing);
    const old = new Database(path.join(local, 'cdn.db'));
    old.exec(`CREATE TABLE files(id TEXT PRIMARY KEY,originalName TEXT,size INTEGER,mime TEXT,uploadedAt INTEGER,retentionOverride INTEGER,retentionDays INTEGER,storagePath TEXT,ownerId TEXT,visibility TEXT,createdAt INTEGER,expiresAt INTEGER,retentionDuration INTEGER,retentionPolicy TEXT,accessVersion INTEGER,state TEXT,modifiedAt INTEGER);
      CREATE TABLE settings(name TEXT PRIMARY KEY,value TEXT);
      INSERT INTO settings VALUES ('metadata-v2','1');
      CREATE TABLE api_keys(id TEXT PRIMARY KEY,keyHash TEXT UNIQUE,userId TEXT,scopes TEXT,directory TEXT,fileIds TEXT,createdAt INTEGER,expiresAt INTEGER,revokedAt INTEGER,createdBy TEXT,crossOwnerRead INTEGER);`);
    old.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 'legacy.png', 12, 'image/png', now, 1, 7, pathName, 'alice', 'protected', now, now + 7 * 86400000, 7 * 86400000, 'custom', 3, 'active', now);
    old.prepare('INSERT INTO api_keys VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('old-key-id', hash(token), 'guest', '["files:read"]', null, JSON.stringify([id]), now, null, null, 'legacy-administrator', 1); old.close();
    const payload = Buffer.from(JSON.stringify({ id, version: 3, issuer: 'bootstrap', expiresAt: now + 60000, download: false })).toString('base64url');
    const sig = crypto.createHmac('sha256', signing).update(payload).update(hash(owner)).digest('base64url');
    upgraded = createApplication(loadConfig({ OWNER_API_KEY: owner, DATA_DIR: local })); listener = upgraded.app.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const localBase = `http://127.0.0.1:${listener.address().port}`;
    const row = upgraded.store.db.prepare('SELECT * FROM files WHERE id=?').get(id);
    assert.equal(row.ownerId, 'alice'); assert.equal(row.publicPath, pathName); assert.equal(row.layout, 'legacy'); assert.equal(row.accessVersion, 3);
    const read = await fetch(localBase + '/' + pathName, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(read.status, 200); assert.equal(await read.text(), 'legacy bytes');
    assert.equal((await fetch(localBase + '/' + pathName + '?token=' + payload + '.' + sig)).status, 200);
    assert.equal(upgraded.store.db.prepare('SELECT purpose FROM api_keys WHERE id=?').get('old-key-id').purpose, 'api');
    const form = new FormData(); form.append('file', new Blob(['new text']), 'new.txt');
    const response = await fetch(localBase + '/upload', { method: 'POST', headers: { Authorization: `Bearer ${owner}` }, body: form }); assert.equal(response.status, 200);
    const modern = await response.json(); assert.equal(path.extname(modern.path), ''); assert.equal(modern.file.urlStyle, 'folder');
  } finally {
    if (listener) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
    if (upgraded) upgraded.close(); fs.rmSync(local, { recursive: true, force: true });
  }
});
test('folder move collisions and symlinked UUID folders cannot overwrite or expose content', async () => {
  const file = await upload({ folder: 'collision/source' });
  const destination = `unverified/file/alice/collision/dest/${file.filename}/content.png`;
  fs.mkdirSync(path.dirname(path.join(service.store.root, destination)), { recursive: true });
  fs.writeFileSync(path.join(service.store.root, destination), 'unrelated');
  assert.equal((await req(`/api/files/${file.filename}/move`, { key: alice.key, method: 'POST', body: { path: 'collision/dest' } })).status, 409);
  assert.equal(fs.readFileSync(path.join(service.store.root, destination), 'utf8'), 'unrelated');
  assert.equal((await req('/' + file.path, { key: alice.key })).status, 200);
  const real = path.join(service.store.root, file.path), moved = real + '-real';
  fs.renameSync(real, moved); fs.symlinkSync(moved, real, 'junction');
  try { assert.equal((await req('/' + file.path)).status, 403); }
  finally { fs.unlinkSync(real); fs.renameSync(moved, real); }
});
test('recognized binary media allows native rendering while active content remains sandboxed', async () => {
  const file = await upload({ visibility: 'public' });
  const image = await req('/' + file.path, { key: null });
  const policy = image.headers.get('content-security-policy');
  assert.match(policy, /script-src 'none'/); assert.match(policy, /img-src 'self'/); assert.match(policy, /media-src 'self'/); assert.doesNotMatch(policy, /(?:^|;)\s*sandbox(?:;|$)/);
  const etag = image.headers.get('etag');
  const conditional = await req('/' + file.path, { key: null, headers: { 'If-None-Match': etag } }); assert.equal(conditional.status, 304); assert.equal(conditional.headers.get('content-security-policy'), policy);
  const active = await upload({ filename: 'active.html', content: '<script>alert(1)</script>', visibility: 'public' });
  const html = await req('/' + active.path, { key: null }); assert.match(html.headers.get('content-security-policy'), /sandbox/); assert.match(html.headers.get('content-disposition'), /^attachment/);
});
