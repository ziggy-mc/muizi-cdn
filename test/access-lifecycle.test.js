'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createApplication } = require('../lib/app');
const { createStorage } = require('../lib/storage');
const { loadConfig } = require('../lib/config');
const owner = crypto.randomBytes(32).toString('hex');
let svc, server, base, dir, manager, stranger;
async function request(route, { key = owner, method = 'GET', body, headers = {} } = {}) {
  return fetch(base + route, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
}
async function json(route, options) {
  const response = await request(route, options); assert.ok(response.ok, await response.clone().text()); return response.json();
}
async function upload({ visibility = 'protected', headers = {}, key = manager.key } = {}) {
  const data = new FormData(); data.append('file', new Blob(['lifecycle test bytes']), 'lifecycle.txt'); data.append('visibility', visibility);
  const response = await fetch(base + '/upload', { method: 'POST', headers: { Authorization: `Bearer ${key}`, ...headers }, body: data });
  return { response, data: await response.json() };
}
const keyFor = (file, body = { expiresAt: null }) => json(`/api/files/${file.filename}/access-keys`, { key: manager.key, method: 'POST', body });
const linkFor = (file, key, body = { kind: 'view' }) => json(`/api/files/${file.filename}/links`, { key: key.key, method: 'POST', body });
async function withClock(now, fn) { const original = Date.now; Date.now = () => now; try { await fn(); } finally { Date.now = original; } }
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muizi-lifecycle-'));
  svc = createApplication(loadConfig({ OWNER_API_KEY: owner, DATA_DIR: dir, CONVERT_MEDIA: 'false' }));
  server = svc.app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
  manager = await json('/api/keys', { method: 'POST', body: { userId: 'manager', scopes: ['files:upload', 'files:manage'] } });
  stranger = await json('/api/keys', { method: 'POST', body: { userId: 'stranger', role: 'management' } });
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); svc.close(); fs.rmSync(dir, { recursive: true, force: true }); });
test('default, custom, enabled/disabled permanent retention and authenticated policy discovery', async () => {
  const normal = await upload({ visibility: 'public' }); assert.equal(normal.response.status, 200); assert.equal(normal.data.file.retentionDuration, 7 * 86400000);
  const custom = await upload({ headers: { 'X-Retention-Duration': '2', 'X-Retention-Unit': 'days' } }); assert.equal(custom.data.file.retentionDuration, 2 * 86400000);
  const denied = await upload({ headers: { 'X-Retention-Enabled': 'false' } }); assert.equal(denied.response.status, 403);
  const cfg = await json('/api/config', { key: manager.key }); assert.equal(cfg.permanentAllowed, false); assert.equal(cfg.minRetentionMs, 86400000);
  assert.equal((await request('/api/config', { key: null })).status, 401);
  svc.config.allowPermanent = true;
  try { const permanent = await upload({ headers: { 'X-Retention-Enabled': 'false' } }); assert.equal(permanent.response.status, 200); assert.equal(permanent.data.file.expiresAt, null); assert.equal((await json('/api/config', { key: manager.key })).permanentAllowed, true); }
  finally { svc.config.allowPermanent = false; }
  // Preserve the existing owner's explicit permanent-retention override.
  assert.equal((await json('/api/config')).permanentAllowed, true);
});
test('blank key expiration follows file; View Link survives five minutes and temporary link does not', async () => {
  const { data: file } = await upload(); const key = await keyFor(file);
  assert.equal(key.expiresAt, file.file.expiresAt);
  assert.equal((await keyFor(file, {})).expiresAt, file.file.expiresAt);
  const view = await linkFor(file,key); const temporary = await linkFor(file,key,{ kind: 'temporary', expiresIn: 300 });
  assert.equal(view.expiresAt,key.expiresAt); assert.equal(view.kind,'view'); assert.equal(temporary.kind,'temporary');
  assert.ok(!view.url.includes(key.key)); assert.ok(!temporary.url.includes(key.key));
  assert.equal(await (await request(view.url,{key:null})).text(),'lifecycle test bytes');
  await withClock(temporary.expiresAt + 1, async () => {
    assert.equal((await request(view.url,{key:null})).status,200);
    assert.equal((await request(temporary.url,{key:null})).status,404);
  });
  await withClock(key.expiresAt, async () => {
    assert.equal((await request(view.url,{key:null})).status,404);
    assert.equal((await request('/' + file.path,{key:key.key})).status,404); // File expiry also applies.
  });
});
test('explicit key expiration caps both link kinds and remains enforced before cleanup', async () => {
  const { data: file } = await upload(); const end = Date.now() + 3 * 3600000;
  const key = await keyFor(file,{ expiresAt:end }); const view = await linkFor(file,key);
  assert.equal(view.expiresAt,end);
  const temp = await linkFor(file,key,{expiresIn:300}); assert.ok(temp.expiresAt < end);
  svc.store.db.prepare('UPDATE api_keys SET expiresAt=? WHERE id=?').run(Date.now() + 1000,key.id);
  const short = await linkFor(file,key,{expiresIn:300}); assert.ok(short.expiresAt <= Date.now() + 1000);
  await withClock(Date.now() + 1001,async () => {
    assert.equal((await request(view.url,{key:null})).status,404);
    assert.equal((await request(short.url,{key:null})).status,404);
    assert.equal((await request('/' + file.path,{key:key.key})).status,401);
  });
});
test('permanent file keys and View Links persist without being clamped to signed-link limits', async () => {
  svc.config.allowPermanent = true;
  try {
    const { data:file } = await upload({headers:{'X-Retention-Enabled':'false'}}); const key = await keyFor(file); const view = await linkFor(file,key);
    assert.equal(key.expiresAt,null); assert.equal(view.expiresAt,null);
    await withClock(Date.now() + 365 * 86400000,async () => assert.equal((await request(view.url,{key:null})).status,200));
    await request(`/api/files/${file.filename}/access-keys/${key.id}`,{key:manager.key,method:'DELETE'});
    assert.equal((await request(view.url,{key:null})).status,404);
  } finally { svc.config.allowPermanent = false; }
});
test('View Links store only hashes, list no secrets, and can be individually revoked', async () => {
  const { data:file } = await upload(); const key = await keyFor(file); const first = await linkFor(file,key); const second = await linkFor(file,key);
  const token = new URL(first.url,base).searchParams.get('token'); const row = svc.store.db.prepare('SELECT * FROM view_links WHERE id=?').get(first.id);
  assert.equal(row.tokenHash,crypto.createHash('sha256').update(token).digest('hex')); assert.ok(!JSON.stringify(row).includes(token));
  const listing = await json(`/api/files/${file.filename}/view-links`,{key:manager.key}); assert.equal(listing.links.length,2);
  assert.ok(!JSON.stringify(listing).includes(token)); assert.ok(!JSON.stringify(listing).includes(row.tokenHash));
  await request(`/api/files/${file.filename}/view-links/${first.id}`,{key:manager.key,method:'DELETE'});
  assert.equal((await request(first.url,{key:null})).status,404); assert.equal((await request(second.url,{key:null})).status,200);
  assert.equal((await request('/' + file.path,{key:key.key})).status,200);
  await request(`/api/files/${file.filename}/access-keys/${key.id}`,{key:manager.key,method:'DELETE'});
  assert.equal((await request(second.url,{key:null})).status,404);
  assert.equal((await request('/' + file.path,{key:key.key})).status,401);
});
test('managers can select a file key; foreign, read-only and cross-file issuance is rejected', async () => {
  const { data:file } = await upload(); const {data:other} = await upload(); const key = await keyFor(file);
  const route = `/api/files/${file.filename}/links`, body = {kind:'view',keyId:key.id};
  assert.equal((await request(route,{key:manager.key,method:'POST',body})).status,200);
  assert.equal((await request(route,{key:stranger.key,method:'POST',body})).status,403);
  assert.equal((await request(`/api/files/${other.filename}/links`,{key:manager.key,method:'POST',body})).status,400);
  const read = await json('/api/keys',{method:'POST',body:{userId:'reader',role:'read',fileIds:[file.filename]}});
  assert.equal((await request(route,{key:read.key,method:'POST',body})).status,403);
  assert.equal((await request(`/api/files/${file.filename}/view-links`,{key:read.key})).status,403);
  assert.equal((await request(route,{key:key.key,method:'POST',body:{kind:'view',expiresIn:300}})).status,400);
  assert.equal((await request(route,{key:manager.key,method:'POST',body:{kind:'view'}})).status,400);
  assert.equal((await request(route,{key:key.key,method:'POST',body:{expiresIn:901}})).status,400);
  const view = await linkFor(file,key);
  assert.equal((await request('/' + other.path + '?token=' + new URL(view.url,base).searchParams.get('token'),{key:null})).status,404);
});
test('all browser-link revocation leaves keys valid; shared-access revocation and deletion invalidate everything', async () => {
  const {data:file} = await upload(); const key = await keyFor(file); const view = await linkFor(file,key); const temp = await linkFor(file,key,{});
  await request(`/api/files/${file.filename}/revoke-links`,{key:manager.key,method:'POST',body:{}});
  for (const link of [view,temp]) assert.equal((await request(link.url,{key:null})).status,404);
  assert.equal((await request('/' + file.path,{key:key.key})).status,200);
  const renewed = await linkFor(file,key);
  await request(`/api/files/${file.filename}/revoke-access`,{key:manager.key,method:'POST',body:{}});
  assert.equal((await request(renewed.url,{key:null})).status,404);
  const next = await keyFor(file); const last = await linkFor(file,next);
  await request(`/api/files/${file.filename}`,{key:manager.key,method:'DELETE'});
  assert.equal((await request(last.url,{key:null})).status,404); assert.equal((await request('/api/files',{key:next.key})).status,401);
  assert.equal(svc.store.db.prepare('SELECT COUNT(*) AS n FROM view_links WHERE fileId=?').get(file.filename).n,0);
});
test('new View Links and key expiration stay bounded by file and issuing manager', async () => {
  const {data:file} = await upload(); const long = await keyFor(file,{expiresAt:Date.now() + 30 * 86400000}); assert.equal(long.expiresAt,file.file.expiresAt);
  const managerEnd = Date.now() + 3600000;
  const shortManager = await json('/api/keys',{method:'POST',body:{userId:'manager',role:'management',expiresAt:managerEnd}});
  const view = await json(`/api/files/${file.filename}/links`,{key:shortManager.key,method:'POST',body:{kind:'view',keyId:long.id}}); assert.equal(view.expiresAt,managerEnd);
  const issued = await json(`/api/files/${file.filename}/access-keys`,{key:shortManager.key,method:'POST',body:{expiresAt:null}}); assert.equal(issued.expiresAt,managerEnd);
  // Existing retention versioning deliberately invalidates all old browser links.
  await request(`/api/files/${file.filename}/retention`,{key:manager.key,method:'POST',body:{duration:2,unit:'days'}});
  assert.equal((await request(view.url,{key:null})).status,404);
  const updated = await linkFor(file,long); assert.ok(updated.expiresAt <= file.file.createdAt + 2 * 86400000);
});
test('public missing, unauthorized, invalid, expired and revoked URLs have matching responses and no caching bypass', async () => {
  const {data:file} = await upload(); const key = await keyFor(file); const view = await linkFor(file,key);
  const invalid = view.url + 'x';
  await request(`/api/files/${file.filename}/view-links/${view.id}`,{key:manager.key,method:'DELETE'});
  const short = await keyFor(file,{expiresAt:Date.now() + 1000}); const expired = await linkFor(file,short);
  await withClock(Date.now() + 1001,async () => {
    for (const accept of ['text/html','application/json']) {
      const routes = ['/missing-file','/' + file.path,invalid,view.url,expired.url,`/api/files/${crypto.randomUUID()}/content`];
      let baseline;
      for (const route of routes) {
        const res = await request(route,{key:null,headers:{Accept:accept,'If-None-Match':'*',Range:'bytes=0-1'}}); const body = await res.text();
        assert.equal(res.status,404); assert.match(res.headers.get('cache-control'),/no-store/); assert.equal(res.headers.get('www-authenticate'),null);
        assert.doesNotMatch(body,/protected|bearer|access key|temporary|100[2-5]/i);
        const signature = [body,res.headers.get('content-type'),res.headers.get('content-security-policy'),res.headers.get('etag')];
        if (!baseline) baseline = signature; else assert.deepEqual(signature,baseline);
        const head = await request(route,{key:null,method:'HEAD',headers:{Accept:accept}}); assert.equal(head.status,404); assert.equal(await head.text(),'');
        const fakeBearer = await request(route,{key:'made-up-credential',headers:{Accept:accept}}); assert.equal(fakeBearer.status,404); assert.equal(await fakeBearer.text(),body);
      }
    }
  });
});
test('internal diagnostic codes distinguish failures without logging paths or credentials', async () => {
  const {data:file} = await upload(); const key = await keyFor(file); const warnings = [], original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await request('/missing-internal-code',{key:null}); await request('/' + file.path,{key:null});
    const expired = await keyFor(file,{expiresAt:Date.now() + 1000});
    svc.store.db.prepare('UPDATE api_keys SET expiresAt=? WHERE id=?').run(Date.now() - 1,expired.id);
    await request('/' + file.path,{key:expired.key});
    await request(`/api/files/${file.filename}/access-keys/${key.id}`,{key:manager.key,method:'DELETE'}); await request('/' + file.path,{key:key.key});
    svc.store.db.prepare('UPDATE files SET expiresAt=? WHERE id=?').run(Date.now() - 1,file.filename); await request('/' + file.path,{key:null});
  } finally { console.warn = original; }
  assert.deepEqual(warnings.map(line => JSON.parse(line.slice('[file-access] '.length)).code),[1001,1002,1003,1004,1005]);
  assert.ok(!warnings.join('').includes(key.key)); assert.ok(!warnings.join('').includes(file.path));
});
test('additive schema creation is idempotent and keeps existing files, keys, and View Links', async () => {
  const {data:file} = await upload(); const key = await keyFor(file); const view = await linkFor(file,key);
  const store = createStorage(svc.config);
  try { assert.ok(store.db.prepare('SELECT 1 FROM files WHERE id=?').get(file.filename)); assert.ok(store.db.prepare('SELECT 1 FROM api_keys WHERE id=?').get(key.id)); assert.ok(store.db.prepare('SELECT 1 FROM view_links WHERE id=?').get(view.id)); }
  finally { store.db.close(); }
  assert.equal((await request(view.url,{key:null})).status,200);
});
test('active View Link limit excludes links whose underlying key was revoked', async () => {
  const {data:file} = await upload(); const key = await keyFor(file);
  for (let i = 0; i < 100; i++) await linkFor(file,key);
  assert.equal((await request(`/api/files/${file.filename}/links`,{key:key.key,method:'POST',body:{kind:'view'}})).status,409);
  await request(`/api/files/${file.filename}/access-keys/${key.id}`,{key:manager.key,method:'DELETE'});
  const replacement = await keyFor(file); assert.equal((await linkFor(file,replacement)).kind,'view');
});
