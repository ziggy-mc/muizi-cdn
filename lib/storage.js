'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { StartupError } = require('./startup-error');
const { cleanPath, hash, fail, SCOPES } = require('./security');
function createStorage(config) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(config.dataDir).isSymbolicLink()) throw new StartupError('DATA_DIR_SYMLINK', 'DATA_DIR cannot be a symlink');
  const root = path.join(config.dataDir, 'uploads'), temp = path.join(config.dataDir, 'temp');
  for (const dir of [root, temp]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new StartupError('STORAGE_SYMLINK', 'uploads and temp must be real directories, not symlinks');
  }
  const dbPath = path.join(config.dataDir, 'cdn.db');
  if (fs.existsSync(dbPath) && fs.lstatSync(dbPath).isSymbolicLink()) throw new StartupError('DATABASE_SYMLINK', 'cdn.db cannot be a symlink');
  const db = new Database(dbPath);
  fs.chmodSync(dbPath, 0o600);
  db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, originalName TEXT, size INTEGER, mime TEXT, uploadedAt INTEGER,
    retentionOverride INTEGER, retentionDays INTEGER, storagePath TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, keyHash TEXT UNIQUE NOT NULL, userId TEXT NOT NULL, scopes TEXT NOT NULL,
    directory TEXT, fileIds TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL,
    expiresAt INTEGER, revokedAt INTEGER, createdBy TEXT, crossOwnerRead INTEGER NOT NULL DEFAULT 0, purpose TEXT NOT NULL DEFAULT 'api', fileVersion INTEGER
  );
  CREATE TABLE IF NOT EXISTS view_links (
    id TEXT PRIMARY KEY, tokenHash TEXT UNIQUE NOT NULL, fileId TEXT NOT NULL,
    keyId TEXT NOT NULL, version INTEGER NOT NULL, createdAt INTEGER NOT NULL,
    expiresAt INTEGER, revokedAt INTEGER, download INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS view_links_file ON view_links(fileId);
  CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, oldPath TEXT, newPath TEXT, tempName TEXT);
  CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(api_keys)').all().some(c => c.name === 'crossOwnerRead')) db.exec('ALTER TABLE api_keys ADD COLUMN crossOwnerRead INTEGER NOT NULL DEFAULT 0');
  const keyColumns = db.prepare('PRAGMA table_info(api_keys)').all().map(c => c.name);
  if (!keyColumns.includes('purpose')) db.exec("ALTER TABLE api_keys ADD COLUMN purpose TEXT NOT NULL DEFAULT 'api'");
  if (!keyColumns.includes('fileVersion')) db.exec('ALTER TABLE api_keys ADD COLUMN fileVersion INTEGER');
  const additions = { publicPath: 'TEXT', layout: "TEXT NOT NULL DEFAULT 'legacy'", shareVersion: 'INTEGER NOT NULL DEFAULT 1', retentionOverride: 'INTEGER', retentionDays: 'INTEGER', storagePath: "TEXT DEFAULT ''", ownerId: "TEXT NOT NULL DEFAULT 'owner'", visibility: "TEXT NOT NULL DEFAULT 'public'", createdAt: 'INTEGER', expiresAt: 'INTEGER', retentionDuration: 'INTEGER', retentionPolicy: "TEXT NOT NULL DEFAULT 'legacy'", accessVersion: 'INTEGER NOT NULL DEFAULT 1', state: "TEXT NOT NULL DEFAULT 'active'", modifiedAt: 'INTEGER' };
  const columns = db.prepare('PRAGMA table_info(files)').all().map(c => c.name);
  db.transaction(() => {
    for (const [name, type] of Object.entries(additions)) if (!columns.includes(name)) db.exec(`ALTER TABLE files ADD COLUMN ${name} ${type}`);
    if (!db.prepare("SELECT 1 FROM settings WHERE name='metadata-v2'").get()) {
      for (const f of db.prepare('SELECT * FROM files').all()) {
        let storagePath = f.storagePath;
        if (!storagePath) {
          const matches = fs.readdirSync(root).filter(n => path.parse(n).name === f.id && fs.lstatSync(path.join(root, n)).isFile());
          if (matches.length === 1) storagePath = matches[0];
        }
        const m = /^unverified\/file\/([a-zA-Z0-9_-]+)\//.exec(storagePath || '');
        const duration = f.retentionOverride === 0 ? null : (f.retentionDays > 0 ? f.retentionDays * 86400000 : null);
        db.prepare('UPDATE files SET storagePath=?, ownerId=?, createdAt=?, modifiedAt=?, expiresAt=?, retentionDuration=? WHERE id=?').run(storagePath || '', m ? m[1] : 'owner', f.uploadedAt || Date.now(), f.uploadedAt || Date.now(), duration ? (f.uploadedAt || Date.now()) + duration : null, duration, f.id);
      }
      db.prepare("INSERT INTO settings VALUES ('metadata-v2','1')").run();
    }
  })();
  db.prepare("UPDATE files SET publicPath=storagePath WHERE publicPath IS NULL").run();
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS files_public_path ON files(publicPath) WHERE publicPath != ''; CREATE UNIQUE INDEX IF NOT EXISTS files_path ON files(storagePath) WHERE storagePath != ''; CREATE INDEX IF NOT EXISTS files_expiry ON files(expiresAt); CREATE INDEX IF NOT EXISTS files_owner ON files(ownerId);");
  function disk(relative, { mkdir = false, missing = false } = {}) {
    cleanPath(relative);
    let current = root;
    const parts = relative.split('/');
    if (fs.lstatSync(root).isSymbolicLink()) fail(403, 'unsafe storage path');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      if (mkdir && i < parts.length - 1 && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()) || (i === parts.length - 1 && !stat.isFile())) fail(403, 'unsafe storage path');
      } catch (err) { if (err.code !== 'ENOENT' || !missing) throw err; }
    }
    return current;
  }
  function prune(relative) {
    let dir = path.posix.dirname(relative);
    while (dir !== '.') {
      try { fs.rmdirSync(path.dirname(disk(dir + '/.prune-check', { missing: true }))); }
      catch (err) {
        if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(err.code)) console.error('[storage] directory cleanup failed', err.code || 'unsafe-path');
        break;
      }
      dir = path.posix.dirname(dir);
    }
  }
  const removeMissing = p => { try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
  function sameFile(a, b) {
    const x = fs.lstatSync(a), y = fs.lstatSync(b);
    return x.isFile() && y.isFile() && x.dev === y.dev && x.ino === y.ino;
  }
  function recoverOne(op) {
    const f = db.prepare('SELECT * FROM files WHERE id=?').get(op.id);
    if (op.kind === 'delete') {
      removeMissing(disk(op.oldPath, { missing: true }));
      db.transaction(() => { db.prepare("UPDATE api_keys SET revokedAt=? WHERE purpose='file' AND fileIds=? AND revokedAt IS NULL").run(Date.now(), JSON.stringify([op.id])); db.prepare('DELETE FROM view_links WHERE fileId=?').run(op.id); db.prepare('DELETE FROM files WHERE id=?').run(op.id); db.prepare('DELETE FROM operations WHERE id=?').run(op.id); })();
      prune(op.oldPath); return;
    }
    const from = op.kind === 'upload' ? path.join(temp, path.basename(op.tempName)) : disk(op.oldPath, { missing: true });
    const to = disk(op.newPath, { mkdir: true, missing: true });
    if (f.state !== 'active' || f.storagePath !== op.newPath || !fs.existsSync(to)) {
      try { fs.linkSync(from, to); }
      catch (err) { if (err.code !== 'EEXIST' || !sameFile(from, to)) throw err; }
      db.prepare("UPDATE files SET state='active',storagePath=?,publicPath=?,modifiedAt=? WHERE id=?").run(op.newPath, f.layout === 'folder' ? path.posix.dirname(op.newPath) : op.newPath, Date.now(), op.id);
    }
    removeMissing(from);
    db.prepare('DELETE FROM operations WHERE id=?').run(op.id);
    if (op.oldPath) prune(op.oldPath);
  }
  function recover() {
    for (const op of db.prepare('SELECT * FROM operations').all()) {
      try { recoverOne(op); }
      catch (err) {
        if (op.kind === 'move' && err.code === 'EEXIST') {
          db.transaction(() => { db.prepare("UPDATE files SET state='active' WHERE id=?").run(op.id); db.prepare('DELETE FROM operations WHERE id=?').run(op.id); })();
        } else if (op.kind === 'upload' && ['ENOENT', 'EEXIST'].includes(err.code)) {
          db.transaction(() => { db.prepare('DELETE FROM view_links WHERE fileId=?').run(op.id); db.prepare('DELETE FROM files WHERE id=?').run(op.id); db.prepare('DELETE FROM operations WHERE id=?').run(op.id); })();
          removeMissing(path.join(temp, path.basename(op.tempName)));
          prune(op.newPath);
        } else console.error('[storage] recovery pending', op.id, err.code || 'unsafe-path');
      }
    }
  }
  function finalize(file, tempName) {
    const layout = file.layout || 'legacy';
    file = { ...file, layout, publicPath: layout === 'folder' ? path.posix.dirname(file.storagePath) : file.storagePath };
    db.transaction(() => {
      db.prepare(`INSERT INTO files (id,originalName,size,mime,uploadedAt,retentionOverride,retentionDays,storagePath,ownerId,visibility,createdAt,expiresAt,retentionDuration,retentionPolicy,accessVersion,state,modifiedAt,publicPath,layout)
        VALUES (@id,@originalName,@size,@mime,@createdAt,@retentionOverride,@retentionDays,@storagePath,@ownerId,@visibility,@createdAt,@expiresAt,@retentionDuration,@retentionPolicy,1,'pending',@createdAt,@publicPath,@layout)`).run(file);
      db.prepare("INSERT INTO operations VALUES (?,'upload',NULL,?,?)").run(file.id, file.storagePath, tempName);
    })();
    recoverOne(db.prepare('SELECT * FROM operations WHERE id=?').get(file.id));
  }
  function move(file, destination) {
    if (file.storagePath === destination) return;
    disk(destination, { mkdir: true, missing: true });
    db.transaction(() => {
      db.prepare("UPDATE files SET state='moving',accessVersion=accessVersion+1 WHERE id=?").run(file.id);
      db.prepare("INSERT INTO operations VALUES (?,'move',?,?,NULL)").run(file.id, file.storagePath, destination);
    })();
    try { recoverOne(db.prepare('SELECT * FROM operations WHERE id=?').get(file.id)); }
    catch (err) { recover(); if (err.code === 'EEXIST') fail(409, 'destination exists'); throw err; }
  }
  function remove(file) {
    db.transaction(() => {
      db.prepare("UPDATE files SET state='deleting' WHERE id=?").run(file.id);
      db.prepare("INSERT OR REPLACE INTO operations VALUES (?,'delete',?,NULL,NULL)").run(file.id, file.storagePath);
    })();
    recoverOne(db.prepare('SELECT * FROM operations WHERE id=?').get(file.id));
  }
  function migrateKeys() {
    const filename = path.join(config.dataDir, 'keys.json');
    if (!fs.existsSync(filename)) return;
    if (!fs.lstatSync(filename).isFile()) throw new StartupError('LEGACY_KEYS_TYPE', 'keys.json must be a regular file');
    const input = fs.readFileSync(filename, 'utf8');
    let legacy;
    try { legacy = JSON.parse(input); } catch { throw new StartupError('LEGACY_KEYS_JSON_INVALID', 'keys.json is not valid JSON; migration stopped without deleting it. Fix it offline without sharing raw keys.'); }
    if (!legacy || !Array.isArray(legacy.keys)) throw new StartupError('LEGACY_KEYS_FORMAT', 'keys.json must contain an object with a keys array; migration stopped without deleting it');
    db.transaction(() => {
      for (const key of legacy.keys) {
        if (!key || typeof key.key !== 'string' || !key.key || !/^[a-zA-Z0-9_-]{1,80}$/.test(String(key.userId || ''))) throw new StartupError('LEGACY_KEY_INVALID', 'Each legacy keys.json entry needs a non-empty key and a userId using 1-80 letters, numbers, _ or -. Migration stopped without deleting keys.json');
        db.prepare('INSERT OR IGNORE INTO api_keys (id,keyHash,userId,scopes,fileIds,createdAt,createdBy) VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(), hash(key.key), String(key.userId), JSON.stringify(SCOPES.filter(s => s !== 'keys:manage')), '[]', Date.now(), 'legacy-migration');
      }
    })();
    fs.unlinkSync(filename);
  }
  migrateKeys();
  const secretPath = path.join(config.dataDir, 'signing.key');
  if (!fs.existsSync(secretPath)) fs.writeFileSync(secretPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  if (!fs.lstatSync(secretPath).isFile()) throw new StartupError('SIGNING_KEY_TYPE', 'signing.key must be a regular file');
  fs.chmodSync(secretPath, 0o600);
  const signingKey = fs.readFileSync(secretPath);
  if (signingKey.length < 32) throw new StartupError('SIGNING_KEY_INVALID', 'signing.key contains fewer than 32 bytes; restore a valid signing key from backup or rotate it offline, which invalidates existing signed links');
  const activeTemps = new Set();
  let cleaning = false;
  function cleanup() {
    if (cleaning) return;
    cleaning = true;
    try {
      recover();
      for (const file of db.prepare("SELECT * FROM files WHERE state='active' AND expiresAt IS NOT NULL AND expiresAt<=?").all(Date.now())) {
        try { remove(file); } catch (err) { console.error('[retention] cleanup pending', file.id, err.code || 'unsafe-path'); }
      }
      const journalTemps = new Set(db.prepare('SELECT tempName FROM operations WHERE tempName IS NOT NULL').all().map(o => o.tempName));
      for (const name of fs.readdirSync(temp)) {
        if (activeTemps.has(name) || journalTemps.has(name)) continue;
        const p = path.join(temp, name), stat = fs.lstatSync(p);
        if (stat.isFile() && stat.mtimeMs < Date.now() - config.tempMaxAgeMs) removeMissing(p);
      }
    } finally { cleaning = false; }
  }
  cleanup();
  return { db, root, temp, disk, prune, finalize, move, remove, cleanup, recover, signingKey, activeTemps };
}
module.exports = { createStorage };
