'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const Busboy = require('busboy');
const { fail, HttpError, cleanPath, displayName, retentionHeaders } = require('./security');
const { identify, convert } = require('./media');
const { filenameFilter } = require('./filenames');
function uploadHandler(store, auth, config, metadata) {
  let active = 0;
  const safeName = filenameFilter(config);
  return async (req, res) => {
    const key = auth.authenticate(req);
    auth.requireScope(key, 'files:upload');
    if (key.fileIds?.length) fail(403, 'file-scoped credentials cannot create files');
    const policy = retentionHeaders(req, config, key);
    if (active >= config.maxConcurrentUploads) { res.set('Retry-After', '5'); fail(503, 'upload capacity reached'); }
    let parser;
    try { parser = Busboy({ headers: req.headers, limits: { files: 1, fields: 3, parts: 4, fileSize: config.maxUploadBytes, fieldSize: 1024, headerPairs: 100 } }); }
    catch { fail(400, 'invalid multipart request'); }
    active++;
    const controller = new AbortController(), temps = [];
    let responseData, failure, writeTask, fileInfo, fileSeen = false, folder = '', visibility = req.headers['x-file-visibility'] || config.defaultVisibility;
    const fields = new Set();
    const abort = () => { failure ||= new HttpError(408, 'upload interrupted'); controller.abort(); parser.destroy(failure); };
    const timer = setTimeout(abort, config.uploadTimeoutMs);
    const onClose = () => { if (!res.writableEnded) abort(); };
    req.once('aborted', abort); req.once('error', abort); res.once('close', onClose);
    const tempFile = suffix => {
      const name = crypto.randomUUID() + suffix;
      store.activeTemps.add(name); temps.push(name);
      return path.join(store.temp, name);
    };
    try {
      const completed = new Promise((resolve, reject) => {
        parser.on('field', (name, value, info) => {
          if (fields.has(name) || !['path', 'visibility'].includes(name) || info.valueTruncated || info.nameTruncated) { failure ||= new HttpError(400, 'invalid multipart field'); return; }
          fields.add(name);
          if (name === 'path') folder = value;
          else visibility = value;
        });
        parser.on('file', (field, file, info) => {
          if (fileSeen || field !== 'file' || !info.filename) { failure ||= new HttpError(400, 'one file field is required'); file.resume(); return; }
          fileSeen = true;
          try { fileInfo = { originalName: safeName(info.filename), input: tempFile('.upload') }; }
          catch (err) { failure ||= err; file.resume(); return; }
          file.on('limit', () => { failure ||= new HttpError(413, 'file exceeds upload limit'); });
          writeTask = pipeline(file, fs.createWriteStream(fileInfo.input, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
          // Attach rejection handling immediately; errors can precede parser completion.
          writeTask.catch(err => { failure ||= err; parser.destroy(err); });
        });
        for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => { failure ||= new HttpError(400, 'multipart limits exceeded'); });
        parser.once('error', reject); parser.once('close', resolve);
      });
      req.pipe(parser);
      try { await completed; } catch (err) { failure ||= err.status ? err : new HttpError(400, 'invalid or interrupted multipart request'); }
      if (writeTask) { try { await writeTask; } catch (err) { failure ||= err; } }
      if (failure) throw failure;
      if (!fileInfo) fail(400, 'file field required');
      cleanPath(folder, true);
      if (!['public', 'protected'].includes(visibility)) fail(400, 'visibility must be public or protected');
      let detected = await identify(fileInfo.input, fileInfo.originalName);
      if (config.allowedMime.length && !config.allowedMime.includes(detected.mime)) fail(415, 'file type is not allowed');
      const output = tempFile('.converted');
      const converted = await convert(config, fileInfo.input, output, detected, controller.signal);
      let source = fileInfo.input;
      if (converted) { detected = converted; source = output; }
      if (controller.signal.aborted || req.aborted) fail(408, 'upload interrupted');
      const id = crypto.randomUUID();
      const directory = key.owner ? folder : path.posix.join('unverified', 'file', key.userId, folder);
      const extension = detected.ext.replace(/[^a-z0-9]/gi, '');
      const storagePath = config.uploadUrlStyle === 'folder' ? path.posix.join(directory, id, 'content.' + extension) : path.posix.join(directory, id + '.' + extension);
      if (!auth.restricted(key, { id, storagePath })) fail(403, 'destination is outside credential restrictions');
      const currentKey = auth.byId(key.id);
      if (!currentKey || !auth.has(currentKey, 'files:upload')) fail(401, 'credential expired or revoked');
      const size = fs.statSync(source).size;
      if (size > config.maxUploadBytes) fail(413, 'converted file exceeds upload limit');
      const used = store.db.prepare('SELECT COALESCE(SUM(size),0) AS size FROM files WHERE ownerId=?').get(key.userId).size;
      if (!key.owner && config.maxUserBytes && used + size > config.maxUserBytes) fail(413, 'storage quota exceeded');
      // Flush the file before journaling and publishing its hard link.
      const fd = fs.openSync(source, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const now = Date.now();
      store.finalize({ id, layout: config.uploadUrlStyle, originalName: fileInfo.originalName, size, mime: detected.mime, storagePath, ownerId: key.userId, visibility, createdAt: now, expiresAt: policy.duration === null ? null : now + policy.duration, retentionDuration: policy.duration, retentionPolicy: policy.policy, retentionOverride: policy.duration === null ? 0 : 1, retentionDays: policy.duration === null ? null : policy.duration / 86400000 }, path.basename(source));
      const file = store.db.prepare('SELECT * FROM files WHERE id=?').get(id);
      responseData = { success: true, filename: id, path: file.publicPath, url: metadata(file).url, file: metadata(file) };
    } finally {
      clearTimeout(timer); req.removeListener('aborted', abort); req.removeListener('error', abort); res.removeListener('close', onClose);
      req.unpipe(parser);
      if (!parser.destroyed) parser.destroy();
      if (writeTask) await writeTask.catch(() => {});
      for (const name of temps) {
        store.activeTemps.delete(name);
        if (store.db.prepare('SELECT 1 FROM operations WHERE tempName=?').get(name)) continue;
        try { await fsp.unlink(path.join(store.temp, name)); } catch (err) { if (err.code !== 'ENOENT') console.error('[upload] temporary cleanup failed', err.code); }
      }
      active--;
    }
    res.status(200).json(responseData);
  };
}
module.exports = { uploadHandler };
