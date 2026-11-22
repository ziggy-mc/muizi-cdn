## Unreleased — file management and protected browser access

- Reorganize the responsive control panel, retention selection, selected-file operations, health feedback, and destructive confirmations.
- Add hashed-token View Links tied to File Access Key expiration, including permanent access and individual revocation. Preserve temporary signed-link APIs and limits.
- Conceal public content authorization failures behind matching 404 responses/public code 1001, with internal diagnostic codes in server logs.
- Add an idempotent View Link table and authenticated UI policy endpoint; no new dependencies or environment variables.
- Extend server lifecycle and Chromium workflow/layout coverage.

# 2.1.1

* Fixed native video playback blocked by the file response CSP. Recognized binary media now permits same-origin media/images without a sandbox; scripts remain blocked and active document downloads retain their sandbox.
* Added a CDN connection test and a credential-free backend health check before uploading. A separately hosted static frontend no longer silently receives POST /upload and the API key when it has no CDN backend.
* Remember only the verified backend origin between visits. API/file keys remain in memory.
* Added real Chromium video playback/seeking and separate frontend upload/persistence regressions. HTTP suite: 45 passed.

# 2.1.0

* New uploads default to extensionless folder URLs backed by generated UUID directories. Existing extension-based URLs remain unchanged; serving, moves, cleanup and crash recovery support both layouts.
* Download names retain sanitized original/display filenames, with configurable whole-word profanity/slur redaction. Older records are filtered on output too.
* Added per-file hashed read-only keys, optional paired share-link/key generation, individual/all-share revocation, inherited restrictions and expiration enforcement.
* Simplified the existing panel's protected-file workflow and added a recipient reader that needs only a file URL and its key. Downloads use signed links and stream without buffering in the page.
* Added safe browser help for missing authorization and expanded HTTP/browser regression coverage. Startup diagnostics from the previous follow-up remain included.

# 2.0.0

* Fixed cross-user deletion, disk-only public serving, expired-file access and default non-owner upload rejection.
* Added persistent ownership and visibility, scoped hashed credentials with expiry/revocation/delegation restrictions, and revocable temporary signed links.
* Added explicit retention timestamps and minute/hour/day/week policies, safe startup cleanup and recursive empty-directory pruning.
* Added journaled upload/move/delete recovery, collision protection, MIME sniffing, abort/limit handling, upload concurrency/quotas and bounded media conversion.
* Added authorized listing/metadata, display-name changes, GET/HEAD/range/conditional streaming and restrictive protected caching.
* Improved the existing example panel; added a locked dependency manifest, integration tests, environment template and systemd/Cloudflare examples. Removed the archived .env from distribution.

Compatibility: existing legacy API routes and namespaces remain. Retention now defaults to seven days (configurable) for new uploads; existing permanent records remain permanent. Only explicitly indexed metadata can be served. Filenames/extensions now follow detected content. Ownership and scope are enforced on every management route. Public caching requires revalidation; active documents default to attachment. Legacy keys migrate to hashes with per-user file permissions, not global administration. FFmpeg is supplied by the host OS or FFMPEG_PATH.

## Startup diagnostics follow-up

* Load the project-adjacent .env regardless of PM2 working directory, preserving explicitly supplied process environment overrides.
* Report safe, specific configuration, migration and storage startup errors; malformed legacy key JSON still cannot leak credential fragments.
* Add regression coverage for safe diagnostics, malformed/null migration records and launching from a different working directory (29 tests total).
