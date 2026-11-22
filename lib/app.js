'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const disposition = require('content-disposition');
const { loadConfig } = require('./config');
const { createStorage } = require('./storage');
const { createAuth, publicKey, fail, cleanPath, displayName, retention, hash, equal } = require('./security');
const { uploadHandler } = require('./upload');
const { filenameFilter } = require('./filenames');
function createApplication(config = loadConfig()) {
  const safeName = filenameFilter(config);
  const store = createStorage(config), { db } = store, auth = createAuth(db, config), app = express();
  app.disable('x-powered-by'); app.set('case sensitive routing', true); app.set('strict routing', true);
  app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], sandbox: [], frameAncestors: ["'none'"] } } }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const origin = req.headers.origin;
    if (config.corsOrigins.includes('*')) res.set('Access-Control-Allow-Origin', '*');
    else if (origin && config.corsOrigins.includes(origin)) { res.set('Access-Control-Allow-Origin', origin); res.vary('Origin'); }
    res.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PATCH,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,Range,If-Range,If-None-Match,If-Modified-Since,X-Retention-Enabled,X-Retention-Days,X-Retention-Duration,X-Retention-Unit,X-File-Visibility');
    res.set('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Content-Disposition,ETag,Last-Modified,Accept-Ranges');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  function metadata(f) {
    const route = f.publicPath.startsWith('api/') ? `api/files/${f.id}/content` : f.publicPath;
    return { id: f.id, path: f.publicPath, url: config.baseUrl ? `${config.baseUrl}/${route}` : `/${route}`, originalName: safeName(f.originalName || 'download'), urlStyle: f.layout === 'folder' ? 'folder' : 'legacy', size: f.size, mime: f.mime, ownerId: f.ownerId, visibility: f.visibility, createdAt: f.createdAt, uploadedAt: f.createdAt, expiresAt: f.expiresAt, retentionDuration: f.retentionDuration, retentionPolicy: f.retentionPolicy, retentionDisabled: f.expiresAt === null, modifiedAt: f.modifiedAt };
  }
  function diagnosticFail(code, status, message) {
    const error = new Error(message); error.status = status; error.diagnosticCode = code; throw error;
  }
  // Never include paths, bearer credentials, or request URLs in diagnostics.
  function credentialFailure(id) {
    const row = typeof id === 'string' && db.prepare('SELECT revokedAt,expiresAt FROM api_keys WHERE id=?').get(id);
    return row?.revokedAt ? 1004 : row?.expiresAt && row.expiresAt <= Date.now() ? 1003 : 1002;
  }
  function active(file) {
    if (!file || file.state !== 'active') diagnosticFail(1001, 404, 'file not found');
    if (file.expiresAt !== null && file.expiresAt <= Date.now()) diagnosticFail(1005, 404, 'file not found');
    return file;
  }
  function byPath(relative) {
    const trailingSlash = typeof relative === 'string' && relative.endsWith('/');
    const canonical = cleanPath(trailingSlash ? relative.slice(0, -1) : relative);
    const file = active(db.prepare('SELECT * FROM files WHERE publicPath=?').get(canonical));
    if (trailingSlash && file.layout !== 'folder') fail(404, 'file not found');
    return file;
  }
  const byId = id => active(db.prepare('SELECT * FROM files WHERE id=?').get(id));
  const fresh = f => byId(f.id);
  function managed(req, scope, f) { const key = auth.authenticate(req); auth.requireFile(key, scope, f); return key; }
  app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() }));
  app.get('/health/ready', (req, res) => {
    try {
      db.prepare('SELECT 1').get(); fs.accessSync(store.root, fs.constants.R_OK | fs.constants.W_OK);
      if (db.prepare('SELECT 1 FROM operations LIMIT 1').get()) return res.status(503).json({ status: 'not_ready', database: 'ok', storage: 'recovery_pending' });
      res.json({ status: 'ready', database: 'ok', storage: 'ok' });
    } catch { res.status(503).json({ status: 'not_ready', database: 'unknown', storage: 'error' }); }
  });
  for (const route of ['/', '/example-upload.html']) app.get(route, (req, res) => {
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: http:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.sendFile(path.join(__dirname, '..', 'example-upload.html'));
  });
  app.get('/api/config', (req, res) => {
    const key = auth.authenticate(req);
    res.json({ defaultRetentionMs: config.defaultRetentionMs, minRetentionMs: key.owner ? 60000 : config.minRetentionMs,
      permanentAllowed: key.owner || config.allowPermanent, signedMaxSeconds: config.signedMaxSeconds, defaultVisibility: config.defaultVisibility });
  });
  app.post('/upload', uploadHandler(store, auth, config, metadata));
  app.post('/api/keys', (req, res) => res.status(201).json(auth.createKey(auth.authenticate(req), req.body || {})));
  app.get('/api/keys', (req, res) => {
    const key = auth.authenticate(req); auth.requireScope(key, 'keys:manage');
    const rows = key.owner ? db.prepare('SELECT * FROM api_keys ORDER BY createdAt DESC LIMIT 1000').all() : db.prepare('SELECT * FROM api_keys WHERE createdBy=? ORDER BY createdAt DESC LIMIT 1000').all(key.id);
    res.json({ keys: rows.map(k => publicKey({ ...k, scopes: JSON.parse(k.scopes), fileIds: JSON.parse(k.fileIds) })) });
  });
  app.delete('/api/keys/:id', (req, res) => {
    const key = auth.authenticate(req); auth.requireScope(key, 'keys:manage');
    const target = db.prepare('SELECT * FROM api_keys WHERE id=?').get(req.params.id);
    if (!target) fail(404, 'key not found');
    if (!key.owner && target.createdBy !== key.id && target.id !== key.id) fail(403, 'permission denied');
    db.prepare(`WITH RECURSIVE descendants(id) AS (SELECT id FROM api_keys WHERE id=? UNION SELECT k.id FROM api_keys k JOIN descendants d ON k.createdBy=d.id)
      UPDATE api_keys SET revokedAt=? WHERE id IN (SELECT id FROM descendants)`).run(target.id, Date.now());
    res.json({ success: true });
  });
  app.get('/api/files', (req, res) => {
    const key = auth.authenticate(req); auth.requireScope(key, 'files:read');
    const folder = req.query.folder === undefined ? null : cleanPath(req.query.folder, true);
    const limit = Number(req.query.limit || 100), after = req.query.after || '';
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || typeof after !== 'string') fail(400, 'invalid pagination');
    const files = []; let cursor = after, more = false;
    // Bounded pages from SQLite; authorization is also applied to metadata and folder listings.
    while (files.length <= limit) {
      const batch = db.prepare("SELECT * FROM files WHERE state='active' AND (expiresAt IS NULL OR expiresAt>?) AND id>? ORDER BY id LIMIT 500").all(Date.now(), cursor);
      if (!batch.length) break;
      for (const f of batch) {
        cursor = f.id;
        if (auth.can(key, 'files:read', f) && (folder === null || path.posix.dirname(f.publicPath).replace(/^\.$/, '') === folder)) files.push(metadata(f));
        if (files.length > limit) { more = true; break; }
      }
      if (more || batch.length < 500) break;
    }
    const page = files.slice(0, limit);
    res.json({ files: page, folders: [...new Set(page.map(f => path.posix.dirname(f.path).replace(/^\.$/, '')))], next: more ? page.at(-1).id : null });
  });
  app.get('/api/files/:id', (req, res) => { const f = byId(req.params.id); managed(req, 'files:read', f); res.json(metadata(f)); });
  function setRetention(req, res, f, body) {
    const key = managed(req, 'files:write', f), p = retention(body, config, key);
    const expiresAt = p.duration === null ? null : f.createdAt + p.duration;
    db.prepare('UPDATE files SET expiresAt=?,retentionDuration=?,retentionPolicy=?,retentionOverride=?,retentionDays=?,modifiedAt=?,accessVersion=accessVersion+1 WHERE id=?').run(expiresAt, p.duration, p.policy, p.duration === null ? 0 : 1, p.duration === null ? null : p.duration / 86400000, Date.now(), f.id);
    res.json({ success: true, file: f.id, retention: { enabled: p.duration !== null, duration: p.duration, days: p.duration === null ? null : p.duration / 86400000, expiresAt } });
  }
  app.post(/^\/retention\/(.+)$/, (req, res) => setRetention(req, res, byPath(req.params[0]), req.body || {}));
  app.post('/api/files/:id/retention', (req, res) => setRetention(req, res, byId(req.params.id), req.body || {}));
  app.patch('/api/files/:id', (req, res) => {
    const f = byId(req.params.id); managed(req, 'files:write', f);
    const body = req.body || {};
    if (Object.keys(body).some(k => !['visibility', 'originalName'].includes(k)) || !Object.keys(body).length) fail(400, 'only visibility and originalName can be changed');
    const visibility = body.visibility ?? f.visibility, name = body.originalName === undefined ? f.originalName : safeName(body.originalName);
    if (!['public', 'protected'].includes(visibility)) fail(400, 'invalid visibility');
    db.transaction(() => {
      db.prepare('UPDATE files SET visibility=?,originalName=?,modifiedAt=?,accessVersion=accessVersion+1,shareVersion=shareVersion+? WHERE id=?').run(visibility, name, Date.now(), visibility !== f.visibility ? 1 : 0, f.id);
      if (visibility !== f.visibility) db.prepare("UPDATE api_keys SET revokedAt=? WHERE purpose='file' AND fileIds=? AND revokedAt IS NULL").run(Date.now(), JSON.stringify([f.id]));
    })();
    res.json(metadata(fresh(f)));
  });
  function move(req, res, f) {
    const key = managed(req, 'files:write', f), folder = cleanPath(req.body?.path, true);
    const directory = key.owner ? folder : path.posix.join('unverified', 'file', key.userId, folder);
    const destination = f.layout === 'folder' ? path.posix.join(directory, f.id, path.posix.basename(f.storagePath)) : path.posix.join(directory, path.posix.basename(f.storagePath));
    if (!auth.restricted(key, { ...f, storagePath: destination })) fail(403, 'destination is outside credential restrictions');
    store.move(f, destination);
    const result = fresh(f);
    res.json({ success: true, filename: f.id, path: result.publicPath, url: metadata(result).url });
  }
  app.post(/^\/path\/(.+)$/, (req, res) => move(req, res, byPath(req.params[0])));
  app.post('/api/files/:id/move', (req, res) => move(req, res, byId(req.params.id)));
  function remove(req, res, f) { managed(req, 'files:delete', f); store.remove(f); res.json({ success: true }); }
  app.delete(/^\/delete\/(.+)$/, (req, res) => remove(req, res, byPath(req.params[0])));
  app.delete('/api/files/:id', (req, res) => remove(req, res, byId(req.params.id)));
  app.post('/api/files/:id/revoke-links', (req, res) => {
    const f = byId(req.params.id); managed(req, 'files:write', f);
    db.prepare('UPDATE files SET accessVersion=accessVersion+1 WHERE id=?').run(f.id);
    res.json({ success: true });
  });
  function signature(payload, issuer) {
    return crypto.createHmac('sha256', store.signingKey).update(payload).update(issuer === 'bootstrap' ? hash(config.ownerKey) : '').digest('base64url');
  }
  function issueLink(req, res, f) {
    const actor = managed(req, 'files:read', f), body = req.body || {};
    if (body.kind !== undefined && !['view', 'temporary'].includes(body.kind)) fail(400, 'invalid link kind');
    if (body.kind === 'view') return issueViewLink(req, res, f, actor, body);
    if (body.keyId !== undefined) fail(400, 'keyId requires a View Link');
    const seconds = body.expiresIn ?? Math.min(300, config.signedMaxSeconds);
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > config.signedMaxSeconds) fail(400, 'invalid link lifetime');
    if (body.download !== undefined && typeof body.download !== 'boolean') fail(400, 'download must be boolean');
    if (body.createAccessKey !== undefined && typeof body.createAccessKey !== 'boolean') fail(400, 'createAccessKey must be boolean');
    const accessKey = body.createAccessKey ? auth.createFileKey(actor, f, { expiresAt: body.accessKeyExpiresAt }) : null;
    const key = accessKey ? auth.byId(accessKey.id) : actor;
    const expiresAt = Math.min(Date.now() + seconds * 1000, key.expiresAt || Infinity, f.expiresAt || Infinity);
    const issuer = key.owner ? 'bootstrap' : key.id;
    const payload = Buffer.from(JSON.stringify({ id: f.id, version: f.accessVersion, issuer, expiresAt, download: body.download === true })).toString('base64url');
    const token = payload + '.' + signature(payload, issuer);
    res.json({ kind: 'temporary', url: `${metadata(f).url}?token=${token}`, expiresAt, download: body.download === true, ...(accessKey ? { accessKey } : {}) });
  }
  function issueViewLink(req, res, f, actor, body) {
    if (body.expiresIn !== undefined) fail(400, 'View Links inherit key expiration; omit expiresIn');
    if (body.download !== undefined && typeof body.download !== 'boolean') fail(400, 'download must be boolean');
    if (body.createAccessKey !== undefined && typeof body.createAccessKey !== 'boolean') fail(400, 'createAccessKey must be boolean');
    if (body.createAccessKey && body.keyId !== undefined) fail(400, 'choose a key or create one');
    if (f.visibility !== 'protected') fail(400, 'View Links require a protected file');
    const count = db.prepare('SELECT COUNT(*) AS n FROM view_links v JOIN api_keys k ON k.id=v.keyId WHERE v.fileId=? AND v.version=? AND k.fileVersion=? AND v.revokedAt IS NULL AND k.revokedAt IS NULL AND (v.expiresAt IS NULL OR v.expiresAt>?) AND (k.expiresAt IS NULL OR k.expiresAt>?)').get(f.id, f.accessVersion, f.shareVersion, Date.now(), Date.now()).n;
    if (count >= 100) fail(409, 'file has 100 active View Links; revoke unused links first');
    const accessKey = body.createAccessKey ? auth.createFileKey(actor, f, { expiresAt: body.accessKeyExpiresAt }) : null;
    let key = accessKey ? auth.byId(accessKey.id) : actor;
    if (body.keyId !== undefined) {
      auth.requireFile(actor, 'files:write', f);
      if (typeof body.keyId !== 'string') fail(400, 'invalid keyId');
      key = auth.byId(body.keyId);
    }
    if (!key || key.purpose !== 'file' || key.fileIds[0] !== f.id) fail(400, 'a valid access key for this file is required');
    auth.requireFile(key, 'files:read', f);
    const end = Math.min(key.expiresAt || Infinity, actor.expiresAt || Infinity, f.expiresAt || Infinity);
    const expiresAt = Number.isFinite(end) ? end : null;
    const id = crypto.randomUUID(), token = 'view_' + crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO view_links (id,tokenHash,fileId,keyId,version,createdAt,expiresAt,download) VALUES (?,?,?,?,?,?,?,?)').run(id, hash(token), f.id, key.id, f.accessVersion, Date.now(), expiresAt, body.download === true ? 1 : 0);
    res.json({ id, kind: 'view', url: `${metadata(f).url}?token=${token}`, expiresAt, keyId: key.id, download: body.download === true, ...(accessKey ? { accessKey } : {}) });
  }
  app.get('/api/files/:id/view-links', (req, res) => {
    const f = byId(req.params.id); managed(req, 'files:read', f); managed(req, 'files:write', f);
    const links = db.prepare('SELECT id,keyId,createdAt,expiresAt,revokedAt,version FROM view_links WHERE fileId=? ORDER BY createdAt DESC LIMIT 1000').all(f.id);
    res.json({ links: links.map(link => {
      const key = auth.byId(link.keyId);
      const end = Math.min(link.expiresAt || Infinity, f.expiresAt || Infinity, key?.expiresAt || Infinity);
      return { id: link.id, keyId: link.keyId, createdAt: link.createdAt, expiresAt: Number.isFinite(end) ? end : null, revokedAt: link.revokedAt,
        status: link.revokedAt || link.version !== f.accessVersion ? 'revoked' : link.expiresAt && link.expiresAt <= Date.now() ? 'expired' : !key ? (credentialFailure(link.keyId) === 1003 ? 'expired' : 'revoked') : 'active' };
    }) });
  });
  app.delete('/api/files/:id/view-links/:linkId', (req, res) => {
    const f = byId(req.params.id); managed(req, 'files:read', f); managed(req, 'files:write', f);
    const result = db.prepare('UPDATE view_links SET revokedAt=? WHERE id=? AND fileId=?').run(Date.now(), req.params.linkId, f.id);
    if (!result.changes) fail(404, 'View Link not found');
    res.json({ success: true });
  });
  app.post('/api/files/:id/links', (req, res) => issueLink(req, res, byId(req.params.id)));
  app.post('/api/access-links', (req, res) => {
    const relative = req.body?.path;
    const match = typeof relative === 'string' && /^api\/files\/([a-zA-Z0-9._-]{1,128})\/content$/.exec(relative);
    issueLink(req, res, match ? byId(match[1]) : byPath(relative));
  });
  app.post('/api/files/:id/access-keys', (req, res) => {
    const f = byId(req.params.id), actor = managed(req, 'files:write', f);
    res.status(201).json(auth.createFileKey(actor, f, req.body || {}));
  });
  app.get('/api/files/:id/access-keys', (req, res) => {
    const f = byId(req.params.id); managed(req, 'files:write', f); managed(req, 'files:read', f);
    const keys = db.prepare("SELECT * FROM api_keys WHERE purpose='file' AND fileIds=? ORDER BY createdAt DESC LIMIT 1000").all(JSON.stringify([f.id]));
    res.json({ keys: keys.map(k => publicKey({ ...k, expiresAt: k.expiresAt === null ? f.expiresAt : f.expiresAt === null ? k.expiresAt : Math.min(k.expiresAt, f.expiresAt), scopes: JSON.parse(k.scopes), fileIds: JSON.parse(k.fileIds) })) });
  });
  app.delete('/api/files/:id/access-keys/:keyId', (req, res) => {
    const f = byId(req.params.id); managed(req, 'files:write', f); managed(req, 'files:read', f);
    const changed = db.prepare("UPDATE api_keys SET revokedAt=? WHERE id=? AND purpose='file' AND fileIds=?").run(Date.now(), req.params.keyId, JSON.stringify([f.id]));
    if (!changed.changes) fail(404, 'file access key not found');
    res.json({ success: true });
  });
  app.post('/api/files/:id/revoke-access', (req, res) => {
    const f = byId(req.params.id); managed(req, 'files:write', f); managed(req, 'files:read', f);
    db.transaction(() => {
      db.prepare('UPDATE files SET shareVersion=shareVersion+1,accessVersion=accessVersion+1 WHERE id=?').run(f.id);
      db.prepare("UPDATE api_keys SET revokedAt=? WHERE purpose='file' AND fileIds=? AND revokedAt IS NULL").run(Date.now(), JSON.stringify([f.id]));
    })();
    res.json({ success: true });
  });
  function signedAccess(req, f) {
    const token = req.query.token;
    if (typeof token !== 'string' || token.length > 2048) fail(401, 'invalid download link');
    if (token.startsWith('view_')) {
      const link = db.prepare('SELECT * FROM view_links WHERE tokenHash=?').get(hash(token));
      if (!link || link.fileId !== f.id) diagnosticFail(1002, 401, 'invalid link');
      if (link.revokedAt || link.version !== f.accessVersion) diagnosticFail(1004, 401, 'revoked link');
      if (link.expiresAt !== null && link.expiresAt <= Date.now()) diagnosticFail(1003, 401, 'expired link');
      const issuer = auth.byId(link.keyId);
      if (!issuer) diagnosticFail(credentialFailure(link.keyId), 401, 'invalid or expired credential');
      auth.requireFile(issuer, 'files:read', f);
      return { ...link, download: link.download === 1 };
    }
    const [payload, sig, extra] = token.split('.');
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { fail(401, 'invalid download link'); }
    if (!data || typeof sig !== 'string' || extra !== undefined || !equal(signature(payload, data.issuer), sig) || data.id !== f.id || !Number.isSafeInteger(data.expiresAt)) diagnosticFail(1002, 401, 'invalid download link');
    if (data.version !== f.accessVersion) diagnosticFail(1004, 401, 'revoked download link');
    if (data.expiresAt <= Date.now()) diagnosticFail(1003, 401, 'expired download link');
    const issuer = data.issuer === 'bootstrap' ? auth.byId(`bootstrap:${hash(config.ownerKey)}`) : auth.byId(data.issuer);
    if (!issuer) diagnosticFail(credentialFailure(data.issuer), 403, 'permission denied');
    auth.requireFile(issuer, 'files:read', f);
    return data;
  }
  const inlineTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'text/plain']);
  function serveFile(req, res, next) {
    let fd;
    req.fileContent = true;
    try {
      const f = req.params.id ? byId(req.params.id) : byPath(req.params[0]);
      let signed;
      if (req.query.token !== undefined) signed = signedAccess(req, f);
      else if (f.visibility === 'protected') {
        managed(req, 'files:read', f);
      }
      const protectedResponse = f.visibility === 'protected' || Boolean(signed) || Boolean(req.headers.authorization);
      const disk = store.disk(f.storagePath);
      fd = fs.openSync(disk, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) fail(404, 'file not found');
      const etag = `"${f.id}-${f.accessVersion}-${stat.size}-${Math.trunc(stat.mtimeMs)}-${hash(safeName(f.originalName || 'download')).slice(0, 12)}"`;
      const lastModified = new Date(Math.max(f.modifiedAt || 0, stat.mtimeMs)).toUTCString();
      res.set({ 'Content-Type': f.mime || 'application/octet-stream', 'Content-Disposition': disposition(safeName(f.originalName || 'download'), { type: signed?.download || req.query.download === '1' || !inlineTypes.has(f.mime) ? 'attachment' : 'inline' }), 'Accept-Ranges': 'bytes', 'ETag': etag, 'Last-Modified': lastModified });
      // Native media documents need to load their own URL. Do not sandbox
      // recognized binary media; script execution still remains disallowed.
      // Active/unknown documents retain the global sandbox and attachment policy.
      if (inlineTypes.has(f.mime) && /^(image|audio|video)\//.test(f.mime)) {
        res.set('Content-Security-Policy', "default-src 'none'; script-src 'none'; media-src 'self' blob:; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      }

      // Revalidate mutable public URLs on every request; expiration and privacy changes remain enforceable.
      res.set('Cache-Control', protectedResponse ? 'private, no-store' : `public, max-age=0, s-maxage=0, must-revalidate`);
      const noneMatch = req.headers['if-none-match'];
      const notModified = noneMatch ? noneMatch.split(',').some(e => e.trim() === '*' || e.trim().replace(/^W\//, '') === etag) : req.headers['if-modified-since'] && Date.parse(req.headers['if-modified-since']) >= Date.parse(lastModified);
      if (notModified) { fs.closeSync(fd); fd = undefined; return res.status(304).end(); }
      let start = 0, end = stat.size - 1, partial = false;
      let range = req.headers.range;
      if (range && req.headers['if-range']) {
        const ifRange = req.headers['if-range'];
        if (ifRange !== etag && (!Number.isFinite(Date.parse(ifRange)) || Date.parse(ifRange) < Date.parse(lastModified))) range = null;
      }
      if (range && req.method !== 'HEAD' && range.startsWith('bytes=')) {
        // Multipart byte ranges are deliberately ignored with a complete 200 response.
        if (!range.includes(',')) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!m || (!m[1] && !m[2])) { res.set('Content-Range', `bytes */${stat.size}`); fs.closeSync(fd); fd = undefined; return res.status(416).end(); }
          if (!m[1]) { const suffix = Number(m[2]); start = Math.max(0, stat.size - suffix); }
          else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), stat.size - 1); }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || stat.size === 0 || start > end || start >= stat.size || (!m[1] && Number(m[2]) === 0)) {
            res.set('Content-Range', `bytes */${stat.size}`); fs.closeSync(fd); fd = undefined; return res.status(416).end();
          }
          partial = true;
        }
      }
      res.set('Content-Length', String(partial ? end - start + 1 : stat.size));
      if (partial) res.status(206).set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      if (req.method === 'HEAD' || stat.size === 0) { fs.closeSync(fd); fd = undefined; return res.end(); }
      const stream = fs.createReadStream(disk, { fd, autoClose: true, start, end }); fd = undefined;
      stream.once('error', err => { if (res.headersSent) res.destroy(); else next(err); });
      res.once('close', () => stream.destroy());
      stream.pipe(res);
    } catch (err) { if (fd !== undefined) fs.closeSync(fd); next(err); }
  }
  app.get('/api/files/:id/content', serveFile);
  app.get(/^\/(.+)$/, serveFile);
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return res.destroy();
    const status = err.status || (err.code === 'ENOENT' ? 404 : (err.code === 'ENOSPC' || err.code === 'EDQUOT' ? 507 : 500));
    if (status >= 500) console.error('[request] failed', err.code || err.name || 'error');
    res.set('Cache-Control', 'private, no-store');
    if (req.fileContent && status < 500) {
      let code = err.diagnosticCode || (err.code === 'ENOENT' ? 1001 : 1002);
      const match = /^Bearer ([^\s]{1,512})$/i.exec(req.headers.authorization || '');
      const digest = match && hash(match[1]);
      const row = digest && db.prepare('SELECT id FROM api_keys WHERE keyHash=?').get(digest);
      const knownCredential = digest && (equal(digest, hash(config.ownerKey)) || row);
      if (!err.diagnosticCode && row && status === 401) code = credentialFailure(row.id);
      console.warn('[file-access]', JSON.stringify({ code }));
      // Only recognized bearer clients retain programmatic authentication errors.
      // An arbitrary Authorization header must not become a file-existence probe.
      if (!knownCredential || req.headers.accept?.includes('text/html')) {
        res.removeHeader('WWW-Authenticate');
        if (req.headers.accept?.includes('text/html')) {
          res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
          return res.status(404).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>File Not Found</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08090c;color:#f4f6fb;font:16px/1.6 system-ui;padding:24px}main{width:min(100%,480px);padding:32px;border:1px solid #232733;border-radius:16px;background:#101218}h1{font-size:28px;line-height:1.2}p{color:#a5adbf}small{color:#9097a8}</style></head><body><main><h1>File Not Found</h1><p>The requested file could not be found or is unavailable.</p><small>Error Code: 1001</small></main></body></html>`);
        }
        return res.status(404).json({ error: 'The requested file could not be found or is unavailable.', code: 1001 });
      }
    }
    if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="MUIZI CDN"');
    res.status(status).json({ error: err.status && status < 500 && !err.type ? err.message : status === 404 ? 'file not found' : status === 507 ? 'insufficient storage' : status < 500 ? 'invalid request' : 'request failed' });
  });
  const timer = setInterval(() => { try { store.cleanup(); } catch (err) { console.error('[cleanup] failed', err.code || err.name); } }, config.cleanupMs);
  timer.unref();
  function close() { clearInterval(timer); db.close(); }
  return { app, store, auth, close, config };
}
module.exports = { createApplication };
