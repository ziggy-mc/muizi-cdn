'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function equal(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cleanPath(value, empty = false) {
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\\') || /[\x00-\x1f\x7f%?#]/.test(value) || value.startsWith('/') || value.endsWith('/')) {
    if (empty && value === '') return '';
    fail(400, 'invalid relative path');
  }
  if (empty && value === '') return '';
  if (!value || value.split('/').some(p => !/^[a-zA-Z0-9._-]{1,128}$/.test(p) || p === '.' || p === '..')) fail(400, 'invalid relative path');
  return value;
}
function displayName(value) {
  if (typeof value !== 'string') fail(400, 'invalid filename');
  const name = path.posix.basename(value.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200).trim();
  if (!name || name === '.' || name === '..') fail(400, 'invalid filename');
  return name;
}
const SCOPES = ['files:upload', 'files:read', 'files:write', 'files:delete', 'files:manage', 'keys:manage'];
const ROLES = {
  upload: ['files:upload'],
  management: ['files:read', 'files:write', 'files:delete', 'files:manage'],
  read: ['files:read'],
  admin: SCOPES
};
function createAuth(db, config) {
  const bootstrapHash = hash(config.ownerKey);
  function byId(id) {
    if (id === `bootstrap:${bootstrapHash}`) return { id, owner: true, scopes: SCOPES, userId: 'owner' };
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > ?)').get(id, Date.now());
    if (!row) return null;
    const key = { ...row, scopes: JSON.parse(row.scopes), fileIds: JSON.parse(row.fileIds), owner: false };
    if (key.purpose === 'file') {
      const file = key.fileIds.length === 1 && db.prepare("SELECT * FROM files WHERE id=? AND state='active' AND (expiresAt IS NULL OR expiresAt>?)").get(key.fileIds[0], Date.now());
      if (!file || file.shareVersion !== key.fileVersion) return null;
    }
    return key;
  }
  function authenticate(req, required = true) {
    const auth = req.headers.authorization;
    if (!auth) { if (required) fail(401, 'authorization required'); return null; }
    const m = /^Bearer ([^\s]{1,512})$/i.exec(auth);
    if (!m) fail(401, 'invalid authorization');
    const digest = hash(m[1]);
    if (equal(digest, bootstrapHash)) return byId(`bootstrap:${bootstrapHash}`);
    const row = db.prepare('SELECT id, keyHash FROM api_keys WHERE keyHash = ?').get(digest);
    const key = row && equal(row.keyHash, digest) && byId(row.id);
    if (!key) fail(401, 'invalid or expired credential');
    return key;
  }
  function has(key, scope) {
    return Boolean(key && (key.owner || key.scopes.includes(scope) || (key.scopes.includes('files:manage') && ['files:read', 'files:write', 'files:delete'].includes(scope))));
  }
  function restricted(key, file) {
    return (!key.directory || file.storagePath.startsWith(key.directory + '/')) && (!key.fileIds?.length || key.fileIds.includes(file.id));
  }
  function can(key, scope, file) {
    if (!has(key, scope)) return false;
    if (key.owner) return true;
    if (key.purpose === 'file' && (scope !== 'files:read' || key.fileIds.length !== 1 || key.fileIds[0] !== file.id || key.fileVersion !== file.shareVersion)) return false;
    if (!restricted(key, file)) return false;
    // Explicit read grants may delegate access to another user's file; writes always retain ownership.
    return file.ownerId === key.userId || (scope === 'files:read' && key.crossOwnerRead === 1 && Boolean(key.directory || key.fileIds.length));
  }
  function requireScope(key, scope) { if (!has(key, scope)) fail(403, 'permission denied'); }
  function requireFile(key, scope, file) { if (!can(key, scope, file)) fail(403, 'permission denied'); }
  function createKey(actor, body) {
    requireScope(actor, 'keys:manage');
    const scopes = body.scopes || ROLES[body.role || 'upload'];
    if (!Array.isArray(scopes) || !scopes.length || scopes.some(s => !SCOPES.includes(s))) fail(400, 'invalid scopes');
    if (!actor.owner && scopes.some(s => !has(actor, s) || s === 'keys:manage')) fail(403, 'cannot delegate these scopes');
    const userId = body.userId || (actor.owner ? null : actor.userId);
    if (typeof userId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(userId)) fail(400, 'userId required (letters, numbers, _ or -)');
    if (!actor.owner && userId !== actor.userId) fail(403, 'cannot delegate another user');
    const directory = body.directory == null ? null : cleanPath(body.directory);
    const fileIds = body.fileIds || [];
    if (!Array.isArray(fileIds) || fileIds.length > 100 || fileIds.some(v => typeof v !== 'string' || v.length > 128)) fail(400, 'invalid fileIds');
    if (!actor.owner && ((actor.directory && (!directory || !(directory === actor.directory || directory.startsWith(actor.directory + '/')))) || (actor.fileIds.length && (!fileIds.length || fileIds.some(id => !actor.fileIds.includes(id)))))) fail(403, 'cannot widen access restrictions');
    if (!actor.owner) {
      const namespace = `unverified/file/${actor.userId}`;
      if (!actor.directory && directory && directory !== namespace && !directory.startsWith(namespace + '/')) fail(403, 'cannot delegate another namespace');
      for (const id of fileIds) {
        const file = db.prepare('SELECT * FROM files WHERE id=?').get(id);
        if (!file || !can(actor, 'files:read', file)) fail(403, 'cannot delegate inaccessible files');
      }
    }
    const expiresAt = body.expiresAt ?? null;
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())) fail(400, 'expiresAt must be a future timestamp in milliseconds');
    if (!actor.owner && actor.expiresAt && (!expiresAt || expiresAt > actor.expiresAt)) fail(403, 'cannot outlive administrator credential');
    const token = 'mz_' + crypto.randomBytes(32).toString('base64url');
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO api_keys (id,keyHash,userId,scopes,directory,fileIds,createdAt,expiresAt,createdBy,crossOwnerRead) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, hash(token), userId, JSON.stringify([...new Set(scopes)]), directory, JSON.stringify(fileIds), Date.now(), expiresAt, actor.id, (directory || fileIds.length) && (actor.owner || actor.crossOwnerRead === 1) ? 1 : 0);
    return { ...publicKey(byId(id)), key: token };
  }
  function createFileKey(actor, file, input = {}) {
    requireFile(actor, 'files:read', file);
    requireFile(actor, 'files:write', file);
    if (file.visibility !== 'protected') fail(400, 'file access keys require a protected file');
    const requested = input.expiresAt ?? null;
    if (requested !== null && (!Number.isSafeInteger(requested) || requested <= Date.now())) fail(400, 'expiresAt must be a future timestamp in milliseconds');
    const expiresAt = Math.min(requested || Infinity, actor.expiresAt || Infinity, file.expiresAt || Infinity);
    if (expiresAt <= Date.now()) fail(401, 'file or issuing credential has expired');
    const id = crypto.randomUUID(), token = 'mz_file_' + crypto.randomBytes(32).toString('base64url');
    const count = db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE purpose='file' AND fileIds=? AND revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt>?) AND fileVersion=?").get(JSON.stringify([file.id]), Date.now(), file.shareVersion).n;
    if (count >= 100) fail(409, 'file has 100 active access keys; revoke unused keys first');
    db.prepare("INSERT INTO api_keys (id,keyHash,userId,scopes,fileIds,createdAt,expiresAt,createdBy,crossOwnerRead,purpose,fileVersion,directory) VALUES (?,?,?,?,?,?,?,?,1,'file',?,?)").run(id, hash(token), 'share_' + crypto.randomBytes(8).toString('hex'), JSON.stringify(['files:read']), JSON.stringify([file.id]), Date.now(), Number.isFinite(expiresAt) ? expiresAt : null, actor.id, file.shareVersion, actor.directory || null);
    return { ...publicKey(byId(id)), key: token };
  }
  return { createFileKey, authenticate, byId, has, can, restricted, requireScope, requireFile, createKey };
}
function publicKey(k) { return { id: k.id, userId: k.userId, scopes: k.scopes, directory: k.directory, fileIds: k.fileIds, createdAt: k.createdAt, expiresAt: k.expiresAt, revokedAt: k.revokedAt, crossOwnerRead: k.crossOwnerRead === 1, purpose: k.purpose || 'api' }; }
function retention(input, config, key, defaultPolicy = false) {
  if (defaultPolicy) return { duration: config.defaultRetentionMs, policy: 'default' };
  if (input.enabled === false || input.permanent === true) {
    if (!key.owner && !config.allowPermanent) fail(403, 'permanent storage requires owner authorization');
    return { duration: null, policy: 'permanent' };
  }
  const units = { minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000 };
  const unit = input.unit || 'days', value = Number(input.duration ?? input.days);
  if (!units[unit] || !Number.isSafeInteger(value) || value < 1 || !Number.isSafeInteger(value * units[unit]) || value * units[unit] > 100 * 365 * 86400000) fail(400, 'invalid retention duration or unit');
  const duration = value * units[unit];
  if (!key.owner && duration < config.minRetentionMs) fail(403, 'retention is below configured minimum');
  return { duration, policy: key.owner ? 'owner-override' : 'custom' };
}
function retentionHeaders(req, config, key) {
  const h = req.headers;
  if (h['x-retention-enabled'] !== undefined && !['true', 'false'].includes(h['x-retention-enabled'])) fail(400, 'X-Retention-Enabled must be true or false');
  if (h['x-retention-days'] !== undefined && h['x-retention-duration'] !== undefined) fail(400, 'use one retention duration header');
  if (h['x-retention-enabled'] === 'false') return retention({ enabled: false }, config, key);
  if (h['x-retention-days'] !== undefined) return retention({ days: h['x-retention-days'] }, config, key);
  if (h['x-retention-duration'] !== undefined) return retention({ duration: h['x-retention-duration'], unit: h['x-retention-unit'] || 'days' }, config, key);
  if (h['x-retention-unit'] !== undefined) fail(400, 'retention duration required');
  return retention({}, config, key, true);
}
module.exports = { HttpError, fail, hash, equal, cleanPath, displayName, SCOPES, ROLES, createAuth, publicKey, retention, retentionHeaders };
