# MUIZI CDN 2.1.1 repository verification

Verified on November 21, 2026 (America/New_York) for the import of `muizi-cdn-v2.1.1-improved.zip` into `ziggy-mc/muizi-cdn`.

Source archive SHA-256: `56db834f1916840773344d2b72d42764218f316df3553209bf5fbc1c7994e599`.

The uploaded backend and panel are retained. Repository follow-ups clarify documentation, replace the tracked `.env` with an ignored private configuration plus `.env.example`, and make one browser-test wait tolerate the link's loading state.

## Results

| Check | Result |
| --- | --- |
| `npm ci` | Passed with the supplied lockfile. |
| `npm run check` | Passed. |
| `npm test` | 57 passed; zero failed or skipped. |
| `npm run test:browser` | Passed in local Chromium, including all four requested widths. |
| `npm audit --omit=dev` | Zero known production dependency vulnerabilities reported at verification time. |
| `git diff --check` | Passed. |

Runtime: Node.js 24.22.1, npm 11.9.0, Chromium 156.0.8078.79, FFmpeg 7.1.5 on Debian Linux. Node.js 22 is declared by the package but was not separately exercised in this run.

## Server coverage

- Public/protected uploads, default/custom retention, normal-account permanence enabled/disabled, and the existing bootstrap-owner retention override.
- File Access Keys with explicit expiry, null/omitted expiry bounded by the file/issuer, and permanent keys when permitted.
- View Links following key lifetime, remaining valid beyond five minutes, permanent links after one simulated year, individual revocation, key/global revocation, and file deletion/expiration.
- Temporary Access Links expiring at their own boundary, bounded by the file and issuing authorization; existing signed-link API behavior is preserved.
- Hashed token persistence, secret-free listings, owning-manager authorization, cross-file restrictions, active-link limits, and idempotent schema creation.
- Matching public missing/unauthorized/invalid/expired/revoked content responses, HEAD and range/conditional handling, and distinct server-only diagnostic codes without credential logging.
- Existing ownership/delegation, folders, legacy URLs and key/database migrations, interrupted-operation recovery, uploads/quotas/capacity/MIME limits, symlinks/collisions, filenames, health, startup, and FFmpeg conversion regressions.

Expiry tests use controlled server time; no real multi-day wait was performed. Failure-injection tests intentionally produce database/filesystem error logs.

## Browser coverage

The Chromium script exercises upload progress/results/copy, file listing and selection, blank-lifetime key creation, View Link creation from a selected key, paired key/View Link creation, individual link revocation, and recipient access without an owner key.

It also checks separate recipient Temporary Access Links, streamed downloads with sanitized names, global revocation, privacy/metadata updates, health/readiness indicators, a separately hosted static panel, origin persistence without key persistence, and native protected video playback/seeking.

Normal-account default/permanent upload controls and the move/retention/delete workflow are exercised through the UI.

Expanded management sections and generic error pages are checked at 375, 430, 768, and 1440 pixels. The script asserts no document overflow, visible control containment, minimum touch-target height, and no page JavaScript errors.

An initial browser run exposed a test predicate reading an absent anchor during a legitimate loading state. The predicate now guards that state; the complete workflow passed on rerun.

## Limits and deployment

These checks use temporary databases/storage and loopback HTTP. They do not validate a live production database migration, external credentials, deployed TLS/CORS, Cloudflare cache overrides, systemd/PM2 services, Discord previews, sustained production load, physical devices, Safari, Firefox, or an independent security audit.

Keep one service process per private local data directory. Follow [UPGRADE-2.1.md](UPGRADE-2.1.md), preserve deployment data/configuration, and make a consistent backup before migration. Protected responses/errors must remain private, no-store through the reverse proxy. Previously authorized streams may finish after expiry/revocation, and downloaded/external cached copies cannot be recalled.

## Reproduce

```sh
npm ci
npm run check
npm test
npm audit --omit=dev
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
```

The browser script uses the dev-only `playwright-core` package plus separately installed Chromium and FFmpeg. Production dependency installation is `npm ci --omit=dev`.
