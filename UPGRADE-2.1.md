# Upgrade to MUIZI CDN 2.1

1. Stop the existing process: `pm2 stop ecdn`.
2. Back up the existing database and storage together while stopped, including the environment, signing key and any not-yet-migrated keys.json. Keep this operator backup private.
3. Replace the project source files from this ZIP, preserving your existing .env and data directory. Do not switch to an empty DATA_DIR to make an upgrade appear to succeed.
4. Run `npm ci --omit=dev` in the project folder. No new production dependencies were added.
5. The new defaults apply without adding environment variables. Optional controls are UPLOAD_URL_STYLE=folder, FILENAME_REDACT_WORDS and FILENAME_REDACTION_TEXT. If you want future uploads to retain UUID.ext URLs, set UPLOAD_URL_STYLE=legacy. Existing file URLs are preserved in either case.
6. Restart: `pm2 restart ecdn --update-env`. Check `pm2 logs ecdn --lines 30`, then the local/public health endpoints.

The additive schema migration backfills public paths from existing storage paths. Existing file bytes, URLs, ownership, visibility, retention, general API keys and signing.key are preserved. Existing signed-link validation remains supported. New file keys are hashed in SQLite; no plaintext keys.json is created. Restore the entire operator backup to roll back schema/data, rather than mixing an old executable with a newer live database.

Use the improved example-upload.html included in this ZIP both on the CDN and on any separate panel host you maintain. Refresh its browser cache after replacing it. See README.md for sharing steps, API details, filename filtering and the limits of browser/Discord cache invalidation.
