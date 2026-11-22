'use strict';
const path = require('node:path');
const { StartupError } = require('./startup-error');
const { DEFAULT_REDACT_WORDS } = require('./filenames');
function loadConfig(env = process.env) {
  function number(name, fallback, min = 0) {
    const n = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < min) throw new StartupError('CONFIG_NUMBER_INVALID', `${name} must be a whole number greater than or equal to ${min}`);
    return n;
  }
  const ownerKey = env.OWNER_API_KEY;
  if (!ownerKey || Buffer.byteLength(ownerKey) < 32) throw new StartupError('OWNER_API_KEY_INVALID', 'OWNER_API_KEY is missing or shorter than 32 bytes. Set it in the project .env or PM2 environment.');
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..'));
  const baseUrl = (env.BASE_URL || '').replace(/\/$/, '');
  if (baseUrl) {
    let u;
    try { u = new URL(baseUrl); } catch { throw new StartupError('BASE_URL_INVALID', 'BASE_URL must be an HTTP(S) origin, for example https://cdn.example.com'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new StartupError('BASE_URL_INVALID', 'BASE_URL must be an HTTP(S) origin with no path, credentials, query or fragment');
  }
  const defaultVisibility = env.DEFAULT_VISIBILITY || 'public';
  if (!['public', 'protected'].includes(defaultVisibility)) throw new StartupError('VISIBILITY_INVALID', 'DEFAULT_VISIBILITY must be public or protected');
  const defaultRetentionMs = number('DEFAULT_RETENTION_MINUTES', 7 * 24 * 60, 1) * 60000;
  const minRetentionMs = number('MIN_RETENTION_MINUTES', 24 * 60, 1) * 60000;
  if (defaultRetentionMs < minRetentionMs) throw new StartupError('RETENTION_INVALID', 'DEFAULT_RETENTION_MINUTES must be at least MIN_RETENTION_MINUTES');
  const maxUploadBytes = env.MAX_UPLOAD_BYTES !== undefined ? number('MAX_UPLOAD_BYTES', 0, 1) : Number(env.MAX_UPLOAD_SIZE_GB || 25) * 1024 ** 3;
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) throw new StartupError('UPLOAD_LIMIT_INVALID', 'MAX_UPLOAD_BYTES or MAX_UPLOAD_SIZE_GB must specify a positive whole number of bytes');
  const uploadUrlStyle = env.UPLOAD_URL_STYLE || 'folder';
  if (!['folder', 'legacy'].includes(uploadUrlStyle)) throw new StartupError('UPLOAD_URL_STYLE_INVALID', 'UPLOAD_URL_STYLE must be folder or legacy');
  const filenameWords = env.FILENAME_REDACT_WORDS === undefined ? [...DEFAULT_REDACT_WORDS] : env.FILENAME_REDACT_WORDS.split(',').map(w => w.trim()).filter(Boolean);
  const filenameReplacement = env.FILENAME_REDACTION_TEXT ?? 'redacted';
  if (filenameWords.length > 100 || filenameWords.some(w => w.length > 80) || filenameReplacement.length > 32 || /[\x00-\x1f\x7f/\\<>:"|?*]/.test(filenameReplacement)) throw new StartupError('FILENAME_FILTER_INVALID', 'Filename filter supports at most 100 words of 80 characters and a safe replacement up to 32 characters');
  return {
    uploadUrlStyle, filenameWords, filenameReplacement,
    dataDir, ownerKey, baseUrl, defaultVisibility, defaultRetentionMs, minRetentionMs,
    allowPermanent: env.ALLOW_PERMANENT === 'true', maxUploadBytes,
    port: number('PORT', 3010), host: env.HOST || '127.0.0.1',
    cleanupMs: env.CLEANUP_INTERVAL_SECONDS !== undefined ? number('CLEANUP_INTERVAL_SECONDS', 3600, 1) * 1000 : number('RETENTION_CHECK_INTERVAL_HOURS', 1, 1) * 3600000,
    tempMaxAgeMs: number('TEMP_MAX_AGE_MINUTES', 1440, 1) * 60000,
    maxConcurrentUploads: number('MAX_CONCURRENT_UPLOADS', 4, 1),
    uploadTimeoutMs: number('UPLOAD_TIMEOUT_SECONDS', 3600, 1) * 1000,
    conversionTimeoutMs: number('CONVERSION_TIMEOUT_SECONDS', 900, 1) * 1000,
    maxUserBytes: number('MAX_USER_BYTES', 0),
    signedMaxSeconds: number('SIGNED_URL_MAX_SECONDS', 900, 1),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg', convertMedia: env.CONVERT_MEDIA !== 'false',
    allowedMime: (env.ALLOWED_MIME_TYPES || '').split(',').map(s => s.trim()).filter(Boolean),
    corsOrigins: (env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean)
  };
}
module.exports = { loadConfig };
