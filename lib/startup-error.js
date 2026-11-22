'use strict';
// Only explicitly authored startup messages are safe to print. Never log an
// arbitrary parser/driver message: malformed keys.json can contain raw keys.
class StartupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StartupError';
    this.code = code;
  }
}
function startupDiagnostic(error) {
  if (error instanceof StartupError) return `[${error.code}] ${error.message}`;
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'UNEXPECTED_ERROR';
  const hints = {
    EACCES: 'The service user cannot access its database or storage. Check DATA_DIR ownership and permissions.',
    EPERM: 'The operating system denied a storage operation. Check file ownership and filesystem permissions.',
    ENOSPC: 'The filesystem is full. Free space before restarting.',
    EDQUOT: 'The filesystem quota is exhausted.',
    ENOENT: 'A required storage path is missing or has a missing parent.',
    ENOTDIR: 'A configured storage directory contains a path component that is a file.',
    SQLITE_CANTOPEN: 'SQLite could not open cdn.db. Check DATA_DIR and its directory permissions.',
    SQLITE_READONLY: 'SQLite is read-only. The service needs write access to the database and its parent directory.',
    SQLITE_BUSY: 'SQLite is locked. Stop other processes using this data directory.',
    SQLITE_CONSTRAINT_UNIQUE: 'Duplicate legacy storage paths prevent migration. Back up the database and resolve duplicate metadata before restarting.'
  };
  return `[${code}] ${hints[code] || 'Initialization failed in a dependency or storage operation. Check the database, configuration and filesystem. Raw error details were withheld to protect credentials.'}`;
}
module.exports = { StartupError, startupDiagnostic };
