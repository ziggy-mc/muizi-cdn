# CDN frontend and protected access changes

Implemented directly on the uploaded v2.1.1 source. Existing storage layouts, API-key records, authentication, upload limits, owner retention overrides and temporary signed links are preserved.

## Changes made

- Reorganized the existing dark control panel with section navigation, responsive file selection/details, grouped key/View Link/Temporary Access Link controls, local feedback, loading states and destructive confirmations. Move, retention and delete use the selected file and refresh its details. Health has distinct loading, ready and failure indicators.
- Upload retention explicitly supports configured defaults, custom durations and permitted permanence. The panel obtains policy through authenticated `GET /api/config`. Upload results show actual availability and preserve result information after copying a URL.
- Blank key lifetime sends explicit null and follows file/issuer expiry. Permanent files with a non-expiring issuer can have permanent keys. No 24-hour fallback is introduced.
- View Links use `kind: "view"`, inherit their associated File Access Key expiration, and can be permanent until revoked. A manager can select a key ID or create a key and View Link together; a recipient can use the file key directly in an Authorization header. Tokens contain 256 random bits; only SHA-256 hashes are persisted. Requests revalidate file state, access version and key authorization. Individual listing/revocation does not expose token values.
- Temporary Access Links retain the existing format, expiration limits and default API behavior, with an optional explicit `kind: "temporary"`. They cannot outlive their file or issuing credential. `revoke-links` now invalidates both browser-link kinds while retaining keys.
- Public missing/unauthorized/invalid/expired/revoked content requests share generic 404 HTML/JSON responses and public code 1001, including arbitrary unrecognized Authorization headers. Recognized bearer API clients retain programmatic authentication/permission errors. Protected responses and errors remain private, no-store; access checks precede conditional/range handling.
- Server-only diagnostic codes distinguish missing files (1001), missing/invalid authorization (1002), expired key/link (1003), revoked key/link (1004), and expired file (1005). Logs exclude paths and credentials.

## Important files modified

| File | Purpose |
| --- | --- |
| `example-upload.html` | Responsive UI, retention controls, selected-file workflows, distinct access methods, feedback and health. |
| `lib/app.js` | View Link issuance/validation/revocation, policy endpoint, generic public errors and server diagnostics. |
| `lib/storage.js` | Idempotent View Link table/index and deletion/recovery cleanup. |
| `test/access-lifecycle.test.js` | New expiry, permanence, revocation, disclosure, schema compatibility and active-link-limit coverage. |
| `test/service.test.js`, `test/folder-sharing.test.js` | Update public error assertions while retaining existing regression checks. |
| `scripts/browser-smoke.js` | User workflows, all four requested widths, touch targets, error pages, policy controls, file operations and native media playback. |
| `.env.example`, `README.md`, `SECURITY.md`, `MUIZI-CDN-INTEGRATION-GUIDE.md`, `CHANGELOG.md` | Clarified existing configuration, API usage, migration and security behavior. |

## Testing results

- `npm run check`: passed.
- `npm test`: 57 tests passed, zero failed/skipped. Includes legacy migration/recovery, file and folder management, upload limits, authorization, retention, health and affected serving behavior.
- `npm run test:browser`: passed in local Chromium with FFmpeg. Exercised protected upload, progress/results/copy, listing/selection, blank-lifetime key creation, selecting a key for a View Link, paired key/View Link creation, individual link revocation, recipient View/Temporary links without owner credentials, downloads, global revocation, metadata/privacy updates, healthy readiness, separately hosted frontend routing, key non-persistence, native protected video playback/seeking, normal-account default/permanent retention, move, retention update and delete.
- Browser layout checks passed at **375, 430, 768 and 1440 pixels**, with all management sections expanded: no document overflow or controls outside the viewport; visible inputs/selects/buttons met the tested touch height. Screenshots of populated mobile/desktop management and the generic error page were visually reviewed.
- Expiration boundaries, five-minute temporary expiry, View Links beyond five minutes and permanent View Links after one simulated year were tested using controlled server time, not real multi-day waits. Public response bodies/content headers were compared for missing, unauthorized, invalid, expired and revoked URLs, including HEAD and conditional/range requests. Diagnostic log codes were asserted.

## Configuration and deployment

- **No new dependencies or environment variables.** Existing configuration values are preserved. `.env.example` changes are comments only.
- Startup automatically adds `view_links` and its file index with `CREATE ... IF NOT EXISTS`; existing file/key records and stored bytes are not rewritten. Creation is idempotent and tested against existing data.
- Update source while preserving your deployment's `.env`, `cdn.db`/SQLite WAL state, `uploads/`, `signing.key`, and legacy migration inputs. Take a consistent backup before updating and restart the single service process.
- `SIGNED_URL_MAX_SECONDS` applies only to Temporary Access Links. The bootstrap owner's existing permanence/minimum override remains intact even when normal-account permanence is disabled.
- Earlier signed URLs and API calls without `kind` remain temporary and compatible. Metadata/retention/visibility changes and moves retain existing version invalidation behavior. `signing.key` rotation invalidates temporary signed links; stored View Links are revoked through their link/key/file controls.

## Known limitations

- Live production databases/storage, external credentials, Cloudflare/reverse-proxy caching rules, and deployed TLS/CORS were not available and were not tested. Browser validation used Chromium; Safari/Firefox and physical devices were not tested.
- Previously authorized streams may finish after revocation/expiration, and downloaded/external cached copies cannot be recalled. New requests enforce the current authorization state.
- At most 100 active View Links per file are permitted. Browser-link secrets are shown in creation results only and cannot be recovered from the metadata list. Existing safe-type rules still download active/unknown documents as attachments.
