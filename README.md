# MUIZI CDN

A self-hosted Node.js / Express CDN using SQLite, Busboy streaming uploads, local disk and FFmpeg. Existing nested URLs, `/upload`, `/delete/:path`, `/path/:path`, `/retention/:path`, and health routes are preserved. No frontend framework, cloud storage account or container is required.

## Documentation

- [Integration guide](MUIZI-CDN-INTEGRATION-GUIDE.md): API contracts and application examples.
- [Security policy](SECURITY.md): authorization, sharing, reporting, and deployment boundaries.
- [Upgrade guide](UPGRADE-2.1.md): preserve existing data and migrate older installations.
- [Verification](VERIFICATION.md): checks run for this repository update and their limits.
- [Changelog](CHANGELOG.md): implementation changes.

## Run

Use Node.js 22 or 24 LTS, npm, and a maintained FFmpeg installation on PATH. Native better-sqlite3 binaries are normally downloaded automatically; source builds require Python and a C/C++ build toolchain. FFmpeg is an OS dependency rather than a bundled binary. Set `CONVERT_MEDIA=false` to keep original media when FFmpeg is unavailable.

```sh
npm ci
cp .env.example .env  # New installations only; preserve an existing .env.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Put the generated value in .env as OWNER_API_KEY (at least 32 bytes).
# Set BASE_URL to your public HTTP(S) origin, or leave it empty for relative URLs.
npm start
```

On Windows PowerShell, use `Copy-Item .env.example .env` for a new installation. Run the application as an ordinary user with write access to its data directory; administrator privileges are not needed.

Open `http://127.0.0.1:3010/` for the improved existing `example-upload.html`. It supports progress, nested uploads, visibility, retention units, listing, display-name changes, distinct View Links and Temporary Access Links, per-file access keys and an independent protected-file reader. The key stays in memory and is never saved in browser storage. The last verified public CDN origin is remembered separately. On a separately hosted static panel, enter the backend origin in CDN URL and use Test CDN Connection; the frontend website does not implement /upload. Uploads check /health before sending the Bearer key or file. Selected-file downloads create short-lived signed links; the protected-file reader can create a key-lifetime View Link or a Temporary Access Link, so large files stream directly without buffering them in the page.

The default bind is loopback for Cloudflare Tunnel. For direct LAN binding, set HOST explicitly. An omitted BASE_URL returns relative URLs without trusting forwarded Host headers. Serve the CDN on a dedicated origin. All access must pass through this application, including at the reverse proxy. Public caching uses `max-age=0, s-maxage=0, must-revalidate`; protected responses, API responses and errors use `private, no-store`. Disable Cloudflare Cache Everything / edge TTL overrides on this hostname. The application does not use forwarded IP headers for trust decisions.

## API keys and ownership

The environment `OWNER_API_KEY` is the global owner and bootstrap administrator. Use it to create scoped random keys; creation returns the raw `key` once. SQLite stores only SHA-256 hashes. Keys are high-entropy random credentials; password stretching is not needed for these tokens. Key listing never returns hashes or raw values.

```sh
curl -X POST https://cdn.example.com/api/keys \
  -H "Authorization: Bearer $OWNER_API_KEY" -H 'Content-Type: application/json' \
  -d '{"userId":"alice","scopes":["files:upload","files:manage"],"expiresAt":1893456000000}'
```

All API timestamps are Unix milliseconds. `expiresAt` on keys is optional and must be in the future. `userId` uses letters, digits, `_` and `-`. New keys for the same user share ownership; possession of another user's file URL never grants management rights. Bootstrap-owner uploads belong to `owner`; a generated key for `owner` is an explicit administrator-granted delegation to that user.

| Scope | Permission |
| --- | --- |
| `files:upload` | Create files in the key's namespace (or any folder for the bootstrap owner). Does not grant read or management. |
| `files:read` | Read permitted protected content/metadata, list accessible files, and issue temporary links. A File Access Key can also issue its associated View Links. |
| `files:write` | Change own file visibility, display name, retention and location, and revoke its links. Combined with read, create/list/revoke read-only access keys for that file. |
| `files:delete` | Delete own files. |
| `files:manage` | Includes read, write and delete; does not include upload or key administration. |
| `keys:manage` | Create/list/revoke delegated keys within the administrator's existing scopes, ownership, restrictions and lifetime. |

Instead of `scopes`, creation accepts `role`: `upload`, `read`, `management`, or `admin`. `admin` includes all listed scopes but is still bound to its user for file modification; only the environment bootstrap owner has global ownership. Generated administrators cannot delegate `keys:manage` (only the bootstrap owner can create administrators), change user, widen scope, or outlive their own key. They can list/revoke their own descendants and revoke themselves. Revocation cascades to descendants.

Optional creation restrictions: `directory` is a canonical full storage-directory prefix, `fileIds` is a list of IDs. If both are provided both must match. Boundaries are component-based (`a/b` does not grant `a/b-other`). File-restricted keys cannot create new files. Directory-restricted uploaders must upload within the granted namespace subtree. An explicit read grant created by the bootstrap owner can delegate protected reading across users (`crossOwnerRead` in key metadata). Generated administrators preserve that grant only within inherited restrictions; creating a directory restriction cannot invent permission to read another owner's files, even inside the administrator's usual namespace. Write/delete always require ownership even with explicit restrictions. An unscoped generated administrator cannot delegate read access outside its own namespace or to inaccessible IDs.

* `POST /api/keys` — create; `GET /api/keys` — list up to 1000 with status metadata; `DELETE /api/keys/:id` — revoke.
* Authorization is `Authorization: Bearer KEY`; permanent keys are never accepted in query strings.
* Public content needs no key. Listing and metadata always need read permission, even for public files.

## Upload and retention

```sh
curl https://cdn.example.com/upload -H "Authorization: Bearer $UPLOAD_KEY" \
  -H 'X-Retention-Duration: 48' -H 'X-Retention-Unit: hours' \
  -F 'file=@photo.png' -F 'path=images/avatars' -F 'visibility=protected'
```

Upload accepts exactly one `file` plus optional `path` and `visibility` fields, in any order. Visibility is `public` or `protected`; `X-File-Visibility` is also supported (multipart field takes precedence). The default is public unless DEFAULT_VISIBILITY changes it. Unknown/duplicate fields and malformed multipart are rejected. New public URLs are `unverified/file/USER/FOLDER/UUID` for normal users or `FOLDER/UUID` for the bootstrap owner. No extension is needed in the URL: Content-Type comes from the detected file. On disk, each new file is stored as `FOLDER/UUID/content.ext` inside its generated UUID directory. Responses expose the public logical path, never the internal content path. A trailing slash on a folder URL works too. Existing `UUID.ext` URLs retain their exact paths. Set UPLOAD_URL_STYLE=legacy only if you want future uploads to use the older layout as well; existing files do not need conversion. Paths accept nested ASCII letters/digits/`._-` with no empty segments, traversal, percent signs, backslashes or symlinks. IDs are server-generated. User filenames are sanitized display names, never storage identities.

MIME is detected from content, not the multipart MIME claim; unknown formats use application/octet-stream and `.bin`. UTF-8-looking `.txt`, `.csv` and `.json` use text/plain. Known media retains a content-derived extension; MOV/MKV are remuxed/transcoded to MP4 and supported audio is converted to MP3 when enabled. Metadata records the final output size and MIME. Only configured safe raster images, audio/video and text/plain render inline. Everything else, including HTML/SVG/PDF, downloads with a safe Content-Disposition. Configure the narrow `inlineTypes` set in lib/app.js if needed, keeping active document types excluded.

Missing retention headers use the configured default (7 days); this works for ordinary upload keys. Supported headers:

* `X-Retention-Days: N` — legacy whole days.
* `X-Retention-Duration: N` and `X-Retention-Unit: minutes|hours|days|weeks` — positive whole units.
* `X-Retention-Enabled: false` — permanent; owner only unless ALLOW_PERMANENT=true. Omit the duration headers when using it.

Minimum retention defaults to 24 hours for non-owners; administrators can lower MIN_RETENTION_MINUTES. The bootstrap owner can override the minimum and permanence restriction. Existing legacy permanent files remain permanent. Retention changes are measured from the original creation time, so reducing retention may expire a file immediately. Files expire at expiresAt before physical cleanup. Metadata includes createdAt, expiresAt, retentionDuration (milliseconds), retentionPolicy and retentionDisabled.

## Files and folders

| Endpoint | Behavior |
| --- | --- |
| `GET /api/files?folder=FULL_FOLDER&limit=100&after=ID` | Accessible files and folders represented on that page; folder filters direct children. Limit 1–500; follow `next` for later pages. Omit folder for all accessible files. Empty folders are not persisted. |
| `GET /api/files/:id` | Read metadata. |
| `GET/HEAD /api/files/:id/content` | Stream content through the same public/protected authorization layer. Returned URLs use this route for legacy files under reserved `api/` paths. |
| `PATCH /api/files/:id` | `{ "visibility":"protected", "originalName":"photo.png" }`; either field may be omitted. |
| `POST /api/files/:id/move` | `{ "path":"images/new" }`; path is relative to the user's namespace, or storage root for bootstrap owner. Empty string moves to namespace root. |
| `POST /api/files/:id/retention` | `{ "duration":2, "unit":"weeks" }` or `{ "enabled":false }`. Legacy `{ "enabled":true, "days":2 }` works. |
| `DELETE /api/files/:id` | Delete own file. |
| `POST /api/files/:id/links` | `{ "expiresIn":300, "download":true }`; optional download-only signed link. Default 300 seconds, capped by configuration, file expiration and key expiration. |
| `POST /api/files/:id/revoke-links` | Immediately invalidate all links for that file. |

Legacy routes accept the **exact full storage path**, not a filename/ID alias: `DELETE /delete/FULL_PATH`, `POST /path/FULL_PATH` with `{path}`, and `POST /retention/FULL_PATH` with the retention body above. Visibility, filename and retention changes and moves invalidate existing signed links. Keys can read public files anonymously, but management always checks ownership and scope. Management API clients receive 401 for authentication failures and 403 for insufficient permission. Public content failures use a uniform 404; recognized bearer clients retain programmatic credential errors. Collisions return 409. Responses expose logical CDN paths, never absolute filesystem paths.

## Protected downloads and streaming

Use `GET /FULL_PATH` or `HEAD /FULL_PATH` with a scoped bearer credential. Unauthenticated missing, expired, unauthorized, invalid-link and revoked-link content requests return the same 404 response, public code 1001, and `private, no-store`. HTML browsers receive a responsive **File Not Found** page; JSON clients receive a generic message. Unrecognized Authorization headers do not bypass this concealment. Recognized bearer JSON clients retain credential/permission 401/403 errors; management authentication errors remain programmatic. These client errors are not the generic anonymous browser response.

For browser sharing, choose a View Link (random token stored only as a SHA-256 hash) or a Temporary Access Link (existing signed-token format). Both authorize only GET/HEAD for one file/access version and revalidate the associated credential on every request. Revocation and deletion apply before range/conditional handling. Metadata, retention, visibility and move versioning remain in effect. Download-only links always send attachment disposition. Rotating `signing.key` invalidates temporary signed links; stored View Links are revoked through their link/key/file controls.

Secure server logs record `[file-access] {"code":...}` without paths, tokens or keys: 1001 missing file, 1002 missing/invalid authorization, 1003 expired credential/link, 1004 revoked credential/link, 1005 expired file. These diagnostic distinctions never appear in public response bodies or headers.

`?download=1` forces attachment on either public or authenticated requests. Content is streamed without loading full files into memory. GET supports single byte ranges (including suffix and open-ended ranges), 206, 416 with `Content-Range: bytes */SIZE`, If-Range, ETag/If-None-Match, Last-Modified/If-Modified-Since, Content-Length and safe disposition. Multi-range requests fall back to a complete 200 response. HEAD returns full representation headers and ignores Range, as required for non-GET requests. Authorization and expiration run before range/conditional evaluation, including 304 responses.

## Opening and sharing protected files

The owner bootstrap key can read all private files. An authorized account can manage its own files. A file-only key reads exactly one file: it has no upload, write, delete or key-administration permissions.

In the panel:

1. Connect using your owner/account key, upload a Protected file, and select it under **Manage and share files**.
2. **Create File Access Key** uses the optional lifetime in hours. Intentionally blank means until file/issuer expiration; a permanent file and non-expiring issuer permit a key valid until revoked. There is no implicit 24-hour UI fallback.
3. Select an active key and choose **Create View Link for Key**, or use **Create Key + View Link**. View Links inherit that key’s expiration, bounded by file and issuing account. The UI displays the actual expiry or **Permanent until revoked**. Individual View Links can be listed/revoked; their secrets cannot be retrieved.
4. **Create Temporary Link** has a separate lifetime in seconds, bounded by `SIGNED_URL_MAX_SECONDS`, file expiry and issuing credential. The legacy/default API action remains temporary.
5. A recipient with a file URL and File Access Key uses **Open a Protected File** without an account key. Choose key-lifetime View Link or separate Temporary Access Link. The key travels in an Authorization header, never in the generated URL.
6. **List File Keys** supports individual revocation, which also invalidates the key’s View Links. **Revoke All Browser Links** invalidates both link kinds but keeps keys active. **Revoke All Shared Access** revokes generated file keys and browser links.

The panel loads account-specific retention rules from authenticated `GET /api/config`. Upload retention explicitly distinguishes server default, custom duration, and permitted permanence. The existing owner override of `ALLOW_PERMANENT=false` is preserved.

File-only keys are random, persisted as SHA-256 hashes in SQLite and shown only at creation. `keys.json` remains a one-time legacy import format; this release never writes new plaintext keys there. These are file-sharing grants, so an owning file manager with both files:read and files:write can issue them without global keys:manage. Upload-only/read-only credentials cannot mint these grants. At most 100 simultaneously valid file keys per file are allowed; revoke unused ones when needed.

| Endpoint | Behavior |
| --- | --- |
| `POST /api/files/:id/access-keys` | Create a file-only key; optional `{ "expiresAt": UNIX_MILLISECONDS }`. Omitted/null expiry is bounded by issuer/file expiry; a permanent file with a non-expiring issuer can receive a non-expiring key. |
| `GET /api/files/:id/access-keys` | List file key IDs, restrictions, expiry and revocation metadata without raw keys/hashes. |
| `DELETE /api/files/:id/access-keys/:keyId` | Revoke one file key and links it issued. |
| `POST /api/files/:id/revoke-access` | Revoke all generated file keys and links; authorized owner/account credentials retain normal access. |
| `POST /api/files/:id/links` | Add `"createAccessKey":true` to return `accessKey` alongside the signed URL. Optional `accessKeyExpiresAt` is separate from short-lived `expiresIn`. |
| `POST /api/access-links` | With a valid bearer credential, send `{ "path":"images/UUID", "download":false }` to create a temporary browser link without knowing the file ID. Works with legacy paths too. |
| `GET /api/config` | Authenticated UI policy: default/minimum retention, permitted permanence, default visibility, temporary-link maximum. No secrets. |
| `GET /api/files/:id/view-links` | Owning manager lists IDs, effective expirations and statuses, without tokens/hashes. |
| `DELETE /api/files/:id/view-links/:linkId` | Owning manager revokes one View Link without revoking its key. |

For a View Link, send `{"kind":"view"}` to either link-creation endpoint with the File Access Key as bearer. A manager can instead use `{"kind":"view","keyId":"FILE_KEY_ID"}` or `{"kind":"view","createAccessKey":true,"accessKeyExpiresAt":null}`. Do not supply `expiresIn` for View Links. The response includes `id`, `kind`, `url`, `keyId`, `expiresAt` (milliseconds or null), and `download`. For temporary links use `kind:"temporary"` or omit `kind`; existing clients and signed URLs remain compatible. At most 100 active View Links per file are allowed.

Startup adds the `view_links` table/index idempotently. No existing file/key records or disk layouts are replaced. Preserve `.env`, `cdn.db`, `uploads/`, `signing.key`, and any legacy migration inputs when updating source. No new environment variables or dependencies are needed. `SIGNED_URL_MAX_SECONDS` continues to cap temporary links only.


File keys follow the file ID through renaming and moving; inherited issuer directory restrictions still apply after a move. Changing visibility invalidates file keys to prevent old shares from surviving a later public/protected transition. Deletion, key expiry, file expiry and issuer-key revocation invalidate access immediately. Updating a display name, retention, or path invalidates old temporary links, while unrevoked file keys remain subject to their original expiry and the current file policy.

## Download names and redaction

URLs do not determine downloaded filenames. Content-Disposition uses the original uploaded display name, or a later authorized display-name change, after sanitization and word redaction. The default conservative English profanity/slur list lives in lib/filenames.js. Matching ignores case, normalizes common full-width characters and uses whole-word boundaries, so innocent substrings such as “Scunthorpe” or “cocktail” are not automatically changed. It does not attempt full semantic, multilingual or obfuscation detection.

Set FILENAME_REDACT_WORDS to a comma-separated replacement list; explicitly setting it to an empty value disables word redaction. FILENAME_REDACTION_TEXT defaults to `redacted`; an empty replacement removes matching words. Redaction applies to uploads, display-name changes, metadata and downloaded filenames, including old records without rewriting their bytes or URLs. Unsafe characters, path components and Windows reserved device names are also sanitized. Header and metadata caches revalidate when the effective download name changes.

## Embedding and deletion

New folder URLs serve file bytes directly, with the detected Content-Type and normal inline disposition for the existing safe image/audio/video allowlist. There is no directory index or HTML wrapper in front of a valid image. Public images can be fetched by external preview clients; protected images need a valid View Link or Temporary Access Link because preview clients cannot supply an owner/file key header. Download-only links send attachment disposition and are intended for downloading.

Discord controls whether it unfurls a URL and how long it caches previews. We verify the HTTP image/media responses, not a live Discord integration. Deleting or expiring a file makes future origin requests inaccessible and removes its content plus empty UUID/parent directories. It cannot erase bytes already loaded in a browser, saved by a recipient or cached externally. Removing unrelated directories is never needed to enforce retention.

## Configuration

See every supported current variable in [.env.example](.env.example). Legacy MAX_UPLOAD_SIZE_GB (default 25) and RETENTION_CHECK_INTERVAL_HOURS remain supported; MAX_UPLOAD_BYTES and CLEANUP_INTERVAL_SECONDS take precedence. Key controls include:

* DATA_DIR: persistent local directory containing cdn.db, uploads/, temp/, signing.key. Existing project-root data works without changing this variable.
* MAX_CONCURRENT_UPLOADS: accepted uploads/conversion queue bound (4); additional attempts receive 503 and Retry-After.
* MAX_USER_BYTES: optional finalized-file quota per user (0 disables); bootstrap owner bypasses it. Input and converted output each obey the upload limit; finalization serializes quota checks.
* ALLOWED_MIME_TYPES: optional comma-separated detected MIME allowlist; empty permits unknown files as safe downloads.
* UPLOAD_TIMEOUT_SECONDS and CONVERSION_TIMEOUT_SECONDS: wall-clock limits; aborted requests kill pending conversion and clean temporary files.
* TEMP_MAX_AGE_MINUTES: abandoned upload cleanup age; active and journal-referenced temps are retained.
* CORS_ORIGINS: `*` or a comma-separated exact origin list. CORS is a browser policy; bearer credentials and ownership remain the security boundary.

## Migration and recovery

Stop the old service first. Make an **operator-controlled encrypted/offline backup** of cdn.db (including WAL/SHM if not checkpointed), uploads/, keys.json and the environment before changing anything. Never commit or distribute that backup. This source tree includes `.env.example` with a blank key and ignores `.env`, databases, signing keys, plaintext legacy key files, and runtime uploads. The repository's previously tracked `.env` is removed from the current tree; this does not erase Git history. Rotate any real credentials previously committed or distributed, and preserve your private deployment configuration outside source control.

Schema additions are restartable and metadata backfill runs transactionally on first startup. Existing paths and public visibility are preserved. Legacy expiration is derived from uploadedAt/retentionDays; retentionOverride=0 stays permanent. Rows without verifiable ownership are assigned to the bootstrap-owner user. Established `unverified/file/USER/` paths retain that historical user; review these assumptions before reopening a legacy instance, since old installations did not store ownership explicitly. Rows without storagePath can recover an unambiguous top-level ID match; unmatched/ambiguous rows require operator repair and remain inaccessible. Disk files without database metadata are intentionally inaccessible and never blindly deleted.

Valid `keys.json` entries (`{keys:[{key,userId}]}`) are hashed into SQLite in one transaction. Their original token remains valid with upload/read/write/delete/manage scopes for their historical user, **without key administration**. Legacy owner flags are never trusted. A malformed entry or missing/unsafe userId stops startup without deleting keys.json; fix it offline or rotate through the bootstrap owner. After a successful commit the plaintext file is removed; no plaintext backup is created. If interrupted between commit/removal the unique hash prevents duplicates on retry. Use `/api/keys` to identify migrated IDs, create replacements, then revoke old ones. Backups/old copies still contain plaintext and must be retired securely. Filesystem deletion alone cannot guarantee physical erasure on SSDs/snapshots.

Uploads and moves use exclusive hard links rather than overwriting existing paths; temp and uploads must reside on the same local filesystem. SQLite records operation intent before filesystem changes. Only active rows can be served; interrupted upload/move/delete operations recover on startup and cleanup. A failed unlink leaves a hidden deletion intent for retry. Cleanup runs immediately on startup and periodically without overlap. Missing files are handled safely. Only empty ancestors are removed, never the storage root or unrelated data. A lingering journal makes readiness return 503; inspect code-only error logs, fix storage permissions/space/symlinks, then restart or await cleanup. There is no promise of an atomic transaction across SQLite and the filesystem; the journal provides recoverability. The uploaded file is fsynced before publication; backups and normal filesystem crash guarantees still matter for power-loss durability.

Run **one process per data directory**, not multiple replicas or Node cluster. Keep the data tree and its ancestors private to the service OS user. SQLite metadata and bytes must be backed up consistently while stopped, or via an operator-managed snapshot. Rotating/removing signing.key invalidates outstanding Temporary Access Links; stored View Links must be revoked through their individual link, associated key, or file controls. The signing key is generated locally with 0600 permissions. Rollback requires restoring the complete pre-migration backup rather than running old insecure code against the migrated database.

## Deployment

The service runs unprivileged. A Linux/systemd example is included in `deploy/muizi-cdn.service`; adjust paths for your Node installation. Install code and `npm ci --omit=dev` in `/opt/muizi-cdn`, create a dedicated `muizi` system user, and place a populated environment file at `/etc/muizi-cdn.env` with owner root, group muizi and mode 0640. The unit creates `/var/lib/muizi-cdn` owned by that user. Install FFmpeg using your OS package manager. Copy the unit into systemd, reload units, then enable/start it. It includes filesystem and process restrictions plus an adjustable memory limit for media processing. Ensure data is stored outside deployment directories and survives upgrades. Linux service commands require operator/root access; the app itself does not.

`deploy/cloudflared.example.yml` routes a named Cloudflare Tunnel to loopback. Replace the tunnel ID, credentials-file path and hostname; keep credentials outside the repository. Cloudflare plan limits can be smaller than MAX_UPLOAD_BYTES; set the application limit accordingly. Use TLS publicly, allow the required API methods, disable shared caching overrides, and preserve Authorization, Range and conditional headers. Avoid request/body/query logging of credentials or signed tokens. No Docker requirement is introduced.

Health endpoints: `/health` is liveness; `/health/ready` checks SQLite, writable storage and pending recovery. Termination drains HTTP requests for up to 30 seconds. Interrupted work is recovered on restart.

## Validation

```sh
npm ci
npm run check
npm test
npm audit --omit=dev
# Optional: install system Chromium, or set CHROMIUM_PATH to its executable.
npm run test:browser
```

Tests use isolated temporary databases/storage and a loopback HTTP server. They cover tenant isolation, scoped delegation, private access, signed-link invalidation, expiration before cleanup, migrations, journal recovery, ranges/conditions, collisions, symlinks, multipart size limits/abort handling, MIME safety and actual FFmpeg audio conversion when installed. The browser script uses the dev-only playwright-core package, an installed Chromium (no downloaded browser bundle), and FFmpeg for its media fixture. It exercises protected sharing/revocation, native video playback, file operations, policy controls, generic errors, and expanded layouts at 375, 430, 768, and 1440 pixels. See CHANGELOG.md for the security and compatibility changes.

## PM2 startup troubleshooting

The server loads `.env` next to `server.js`, independent of PM2's working directory. Environment variables already set by PM2 take precedence over `.env`; refresh the process environment after intentional changes with `pm2 restart ecdn --update-env`.

Startup logs include a safe diagnostic code and an actionable message. `OWNER_API_KEY_INVALID` means the bootstrap key is missing or shorter than 32 bytes; `BASE_URL_INVALID` means the URL must be an HTTP(S) origin; `LEGACY_KEYS_*` identifies offline key-migration input problems. Database and OS errors identify permissions, locks or disk-space problems. Raw parser/driver messages are withheld because they can include credential fragments. Do not enable arbitrary error/stack logging to debug malformed legacy key JSON.

Stop the process before applying updates (`pm2 stop ecdn`), preserve `.env` and the existing data directory, then restart and inspect the new startup line (`pm2 logs ecdn --lines 30`). PM2's “online” event alone does not mean application initialization succeeded; verify `/health` and `/health/ready` after startup.

## Native video playback headers

Recognized inline binary images/audio/video use a restrictive CSP that permits their own media/image resources (`media-src 'self' blob:` and `img-src 'self' data:`) and blocks scripts. These binary media responses are not placed in a CSP sandbox, which otherwise interferes with the browser's native video document. Active/unknown document types still download as attachments with the strict sandbox policy. After replacing server code, restart the service and open a fresh signed link in a new video tab.
