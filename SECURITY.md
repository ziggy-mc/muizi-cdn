# Security Policy

## Reporting vulnerabilities

Use [GitHub private vulnerability reporting](https://github.com/ziggy-mc/muizi-cdn/security/advisories/new) when enabled. If that option is unavailable, contact the maintainer privately to arrange a secure reporting channel before sharing sensitive details. Do not post credentials, browser-link tokens, database files, private content, or exploit details in public issues.

## Version and validation scope

This policy describes the 2.1.1 source and View Link updates in this tree. Older repository tags predate these protections. Automated checks are recorded in [VERIFICATION.md](VERIFICATION.md); they do not establish a security percentage or replace an independent audit.

## Credentials and authorization

The environment bootstrap owner is the only global owner. Generated keys always retain their assigned user's write ownership; explicit file/directory grants can delegate read access. Hashes of random keys are stored in SQLite. The bootstrap key remains in the environment. Treat database backups, signing.key, and environment files as sensitive, even though generated raw keys are never stored.

`.env`, database/WAL files, signing keys, legacy plaintext key files, uploads, and operator backups are excluded from source control. Removing a previously tracked `.env` does not remove earlier commits or copies: rotate any real credential that was committed or distributed. Never reuse an example key as a production secret.

## Deployment boundaries

Use TLS, a separate CDN origin, an unprivileged OS user, and supported Node.js/FFmpeg releases. Do not mount uploads as an independent static directory or configure a proxy/CDN rule that bypasses the application. Protected responses and errors use no-store. Public responses require revalidation so privacy and retention changes take effect at the origin. Previously downloaded or externally cached copies cannot be recalled.

Paths are matched against persistent metadata before disk access; every path component rejects symlinks and final opens use O_NOFOLLOW where supported. The data directory and its ancestors must be writable only by the service operator. These checks do not sandbox a hostile local process that can replace directories concurrently or modify SQLite. Run exactly one service process per data directory, on a local filesystem supporting hard links. Do not use Node cluster, multiple replicas, network shares, or an independent file watcher that moves managed files. FFmpeg is serialized, has a wall-clock limit, and is restricted to file/pipe input protocols; use OS resource limits for untrusted media.

HTML, SVG, PDFs and unknown formats download as attachments by default; the narrow inline allowlist is defined in lib/app.js. File responses use nosniff. Recognized inline binary image/audio/video responses permit their own media/image resources without a CSP sandbox so the native browser player works, while script-src remains none. Active/unknown downloads retain the restrictive sandbox CSP. The control panel uses inline event handlers inherited from the existing example and a separate CSP. Host user web applications on a different origin, and never put secrets in URLs. Signed links are bearer credentials: avoid logging query strings in proxies, disable analytics on file URLs, and share links only with intended recipients.

## Sharing, expiration, and revocation

Rotate generated keys by creating replacements and revoking old IDs. Revocation immediately invalidates signed links issued by that key; administrator revocation also revokes descendants. File link revocation and file metadata/access changes invalidate existing links. Bootstrap-key rotation invalidates bootstrap-issued links, while signing.key rotation invalidates temporary signed links. Stored View Links use independent random tokens and are invalidated by their link/key/file controls. Revoked credentials do not undo the user's other valid credentials or already completed downloads. New requests enforce expiration; a stream already authorized may finish after expiration or revocation.

File-specific sharing grants require ownership plus both read and write permissions. They are fixed to one file ID and files:read, inherit issuer directory restrictions and expiration limits, and store only hashes in SQLite. They do not expose global key management. File keys are never accepted in query strings; the protected-file reader exchanges a Bearer credential for a key-lifetime View Link or a separate short-lived signed URL. Shared-link/key creation responses are no-store. New folder-layout content is served only at its metadata-backed public path or the authorized ID content endpoint, never at its internal content.ext disk location. Anonymous content errors and requests with unrecognized bearer credentials use a uniform 404 page/JSON response and public code 1001; missing, unauthorized, expired, and revoked-link responses match for the same representation. Recognized bearer JSON clients retain programmatic authentication/permission errors; this compatibility exception is not an anonymous existence guarantee. Internal numeric codes appear only in server logs. Recognized bearer clients retain programmatic credential errors. View Link tokens contain 256 random bits; only SHA-256 hashes are stored. Each request rechecks file state, access version and associated key validity. View Links support individual manager-authorized revocation.

## Display names and panel trust

Filename redaction is best-effort whole-word cleanup with configurable defaults. It is not a content moderation guarantee. Public media can be copied or cached by external preview services; deleting UUID folders cannot recall those copies.

The panel verifies the configured public /health endpoint before uploads and common API operations. Health probes omit credentials and redirects are rejected. This is a deployment check, not server authentication; only configure a trusted backend origin. Only that verified origin is saved in localStorage, never API or file keys. A static frontend origin without the API is rejected before sending an upload.
