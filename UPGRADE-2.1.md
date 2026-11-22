# Upgrade to MUIZI CDN 2.1

1. Stop the existing service using your process manager, for example `pm2 stop ecdn`.
2. Back up the existing database and storage together while stopped, including the environment, signing key and any not-yet-migrated keys.json. Keep this operator backup private.
3. Replace the project source files from this ZIP, preserving your existing .env and data directory. Do not switch to an empty DATA_DIR to make an upgrade appear to succeed.
4. Run `npm ci --omit=dev` in the project folder. The repository now includes a package manifest and lockfile; install from them rather than using the older README's `npm init`/manual dependency commands. FFmpeg is provided by the host OS, not `ffmpeg-static`.
5. The new defaults apply without adding environment variables. Optional controls are UPLOAD_URL_STYLE=folder, FILENAME_REDACT_WORDS and FILENAME_REDACTION_TEXT. If you want future uploads to retain UUID.ext URLs, set UPLOAD_URL_STYLE=legacy. Existing file URLs are preserved in either case.
6. Preserve your existing private `.env`; new installations copy `.env.example` and set a random OWNER_API_KEY of at least 32 bytes. Port and host now default to 3010 and 127.0.0.1, so keep explicit settings when upgrading an existing listener. Never start a second process against the same DATA_DIR.
7. Restart: `pm2 restart ecdn --update-env`. Check `pm2 logs ecdn --lines 30`, then the local/public health endpoints.

The additive schema migration backfills public paths from existing storage paths. Existing file bytes, URLs, ownership, visibility, retention, general API keys and signing.key are preserved. Existing signed-link validation remains supported. New file keys are hashed in SQLite; no plaintext keys.json is created. Restore the entire operator backup to roll back schema/data, rather than mixing an old executable with a newer live database.

Use the improved example-upload.html included in this ZIP both on the CDN and on any separate panel host you maintain. Refresh its browser cache after replacing it. See README.md for sharing steps, API details, filename filtering and the limits of browser/Discord cache invalidation.

The View Link update also creates `view_links` and its index idempotently. File Access Keys with null expiration follow file/issuer limits; View Links inherit those limits and can be permanent until revoked. Temporary Access Links keep their configured maximum. `revoke-links` invalidates both browser-link kinds. Public content errors are generic 404 responses with code 1001.

If upgrading with Git from a revision that tracked `.env`, back up that file outside the checkout before updating. This tree removes it from source control and ignores future local copies. Removal does not erase old commits; rotate any real key previously published.
