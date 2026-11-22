# MUIZI CDN — Integration and Behavior Reference

**Documented implementation:** MUIZI CDN 2.1.1 with key-lifetime View Links

**Reference date:** November 21, 2026

**Audience:** developers, operators, and AI-assisted development tools building applications that use an existing MUIZI CDN instance.

## Purpose of this document

This is a technical reference, not a development prompt, task assignment, executable instruction file, or authorization to change a system. It describes the existing service, its API, its operational behavior, and the constraints an integration needs to respect. The examples explain possible usage; their presence does not authorize executing requests, provisioning keys, migrating data, deploying software, or modifying the CDN.

This document can accompany the matching source archive, or be supplied on its own with a CDN backend URL and a separate application requirement. It is intended to provide enough API context to build a client without first reverse-engineering the server. It does not contain real credentials or grant access to any deployment.

The actual running version and operator configuration remain authoritative. A 2.1.0 installation updated with the separate 2.1.1 media/panel patch can retain its older package label while implementing the same fixes. The public health endpoint does not report a version or expose the operator's upload limits, retention settings, or secrets. A backend URL alone does not establish access permissions. Future versions may change this contract.

All hostnames, credentials in angle brackets, IDs, and response examples below are illustrative. Permanent credentials belong in a suitable secret store or an explicitly trusted user's in-memory client session, not in this document.

## 1. What MUIZI CDN is

MUIZI CDN is an open-source, self-hosted file hosting API. It accepts streamed uploads, keeps metadata in SQLite, stores file bytes on the host filesystem, and serves public or authorized protected content. It can be the file storage component of a personal drive, gallery, media library, download service, or another application.

The implementation uses Node.js, Express, JavaScript, better-sqlite3, Busboy, content-based file identification, and optional FFmpeg conversion. Its included control panel is a plain HTML/JavaScript page. No external identity provider, frontend framework, cloud object storage account, or Docker-only deployment is required.

“CDN” here describes the file serving service. The project does not automatically replicate files to a worldwide edge network. A Cloudflare Tunnel or reverse proxy can expose the service publicly, but it does not replace the application's ownership and authorization checks.

**New uploads expire after seven days by default.** This is configurable. A drive integration that needs long-term or permanent storage needs an explicit retention policy; it must not assume that an uploaded file will remain forever.

### Built-in features

- Public and protected files, with persistent ownership and visibility.
- Streamed, single-file multipart uploads into nested directories.
- Extensionless URLs for new folder-layout uploads and continued support for old extension-based URLs.
- File metadata, authorized listing, moves, display-name changes, deletion, and retention updates.
- Scoped API keys, per-file read-only keys, expiration, revocation, and temporary signed browser URLs.
- GET, HEAD, single byte ranges, conditional requests, and streamed responses.
- Configurable size limits, a per-user stored-byte quota, an upload concurrency bound, and optional detected-MIME allowlisting.
- Safe download filenames and configurable whole-word profanity/slur redaction.
- Startup and periodic cleanup, recoverable storage operations, and health endpoints.

### Features an application supplies separately

There is no built-in end-user registration/login system, password reset, social login, billing, full account management UI, audit API, or application session system. A CDN `userId` identifies ownership; it is not a login account.

There is no resumable/chunked upload protocol, batch upload API, direct overwrite of existing file bytes, version history, trash/restore API, full-text search, recursive directory mutation API, synchronization client, malware scanner, or end-to-end encryption scheme. Empty folders are not first-class persisted objects. A user-facing drive can add its own application database and workflows for those features while using this API for bytes and access control.

Protected storage is access-controlled, not automatically encrypted at rest. TLS protects transport when the deployment uses HTTPS. File owners and host operators still need appropriate backup and disk security.

## 2. Integration inputs and network layout

An application integration normally needs:

| Input | Meaning |
| --- | --- |
| Backend origin | The actual CDN API origin, such as `https://cdn.example.com`, with no path suffix. |
| Credential strategy | A server-side application credential, an appropriately scoped user credential, or a file-only read key. |
| Ownership mapping | How the application's trusted user identity maps to the CDN key's `userId`. |
| Visibility policy | Whether each upload should be public or protected. |
| Retention policy | Default duration, explicit duration, or permitted permanent storage. |
| Operator limits | Effective upload limits, quota, allowed MIME types, CORS origins, and tunnel/proxy limits. |

A separately hosted frontend, for example `https://drive.example.com`, does not implement the CDN API merely because it displays the upload panel. Requests go to `https://cdn.example.com/upload`, not `https://drive.example.com/upload`.

The included panel's **CDN URL** field identifies this backend origin. Version 2.1.1 provides **Test CDN Connection**, checks the public `/health` response before uploads, and remembers only the last verified public backend origin in browser storage. API keys and file keys remain in memory. A panel deployed separately needs the updated HTML on that host as well as updated backend code.

### Health and CORS

`GET /health` is unauthenticated liveness. A healthy response resembles:

```json
{"status":"ok","uptime":123.4,"timestamp":1800000000000}
```

`GET /health/ready` checks SQLite, read/write access to storage, and unresolved operation recovery. A ready response is:

```json
{"status":"ready","database":"ok","storage":"ok"}
```

It returns 503 if recovery is pending or a readiness check fails. Liveness does not mean that every file, media codec, upstream tunnel, or user credential is working.

The application answers OPTIONS preflight requests with 204 before bearer authentication. Supported CORS methods are GET, HEAD, POST, PATCH, DELETE, and OPTIONS. Supported request headers include Authorization, Content-Type, Range, conditional request headers, and the documented upload/retention headers. File length, range, disposition, ETag, Last-Modified, and Accept-Ranges headers are exposed to browser clients.

`CORS_ORIGINS` is either `*` or a comma-separated list of exact allowed origins. It is a browser access policy, not user authentication. Cookie authentication and `Access-Control-Allow-Credentials` are not provided by the CDN. A bearer-key browser client does not need `credentials: "include"`.

A reverse proxy must preserve the API methods, Authorization, Range, and conditional headers and allow OPTIONS through. A proxy-generated 502 may lack application CORS headers; restoring origin connectivity is then necessary before changing CORS can help. A successful OPTIONS response alone does not prove the requested API route exists.

## 3. File identity, URLs, and folders

### Stable identity versus changing location

The file ID is a server-generated UUID. It remains stable when the file is moved or its display name changes. A file's logical path and returned URL can change after a move. An application normally stores the stable ID and current metadata rather than treating a temporary link as a permanent identifier.

The upload response's legacy `filename` field contains the **ID**, not the human download filename. The human name is `file.originalName`.

### Default folder layout

A normal user's upload with `path=images/avatars` produces a logical path like:

```text
unverified/file/alice/images/avatars/4d2170ba-d995-4f2e-a2a7-26fda629c843
```

A bootstrap-owner upload with the same requested folder produces:

```text
images/avatars/4d2170ba-d995-4f2e-a2a7-26fda629c843
```

The UUID has no extension in the public URL. Internally the file sits inside its generated UUID directory, for example `UUID/content.png`. That internal location is not an alternate public serving URL. The metadata-backed public path or ID content endpoint is used for access.

A trailing slash on a folder-layout content URL is accepted. There is no directory index or listing page at the UUID URL: a successful request streams the actual file bytes.

The historical `unverified/file/USER` prefix is a namespace convention. It does not indicate that the file passed or failed a content verification process.

### Legacy layout

Existing URLs ending in `UUID.jpg`, `UUID.mp4`, or another extension retain their paths and continue to work. `UPLOAD_URL_STYLE=legacy` can also select that style for future uploads. Changing this setting does not move existing files. A trailing slash is not a supported alias for a legacy file URL.

Both layouts use the same metadata, visibility, ownership, retention, and signed-link checks. A file's extension is not its permission boundary.

### Returned URLs are authoritative

With a configured `BASE_URL`, responses contain absolute URLs. Without it, URLs are origin-relative and need resolving against the configured backend origin, not against a separately hosted frontend.

Logical paths beginning with the reserved `api/` prefix can receive an ID-based content URL to avoid route collisions. Clients therefore use the returned `url` rather than assuming every URL is `origin + "/" + path`.

Folder inputs are relative to the caller's namespace, or to storage root for the bootstrap owner. A normal user already assigned to `alice` supplies `images`, not `unverified/file/alice/images`, when uploading or moving. Folder **listing** and directory **key restrictions**, in contrast, use the full logical/storage namespace prefix.

Paths are case-sensitive and accept conservative ASCII letters, digits, `.`, `_`, and `-` in nonempty segments. Segments `.` and `..`, absolute paths, backslashes, percent signs, query/fragment characters, controls, and invalid segments are rejected. General path validation limits a path to 1024 characters and a segment to 128 characters; multipart fields are additionally byte-limited. Clients should keep paths comfortably below those bounds.

A friendly folder label containing spaces can live in the application's own database and map to a safe CDN path. The CDN does not turn arbitrary display labels into a separate folder object automatically.

## 4. Authentication, ownership, and permissions

Permanent credentials are supplied only as:

```http
Authorization: Bearer <ACCESS_KEY>
```

They are not accepted as `?key=`, `?apiKey=`, or another URL query parameter. The `token` parameter used in signed URLs is a separate short-lived signature token, not an API key.

Credentials are opaque strings. Clients do not infer authorization from their spelling or prefix; the server's scopes, ownership, restrictions, expiration, and revocation decide access.

### Credential types

| Type | Authority |
| --- | --- |
| Bootstrap owner key | Configured through `OWNER_API_KEY`; global file access and administration. It must contain at least 32 bytes. |
| General API key | Assigned `userId`, scopes, optional directory/file restrictions, optional expiry, and revocation state. |
| File-only key | Read-only access to one protected file, with inherited restrictions and bounded expiry. It can request a temporary link for that file. |
| Signed URL | Temporary GET/HEAD access to one file/version on behalf of a currently valid issuer. It grants no management API permission. |

New general and file-only keys are cryptographically random. SQLite stores SHA-256 hashes, not their raw values. Raw values are returned only when created. Listing keys does not reveal values or hashes. The environment owner key is not a generated SQLite key entry.

A file belongs to the `userId` of the uploading key, or `owner` for bootstrap-owner uploads. Two valid keys assigned to the same `userId` share ownership, subject to their scopes and restrictions. Knowing a path or file ID does not grant ownership.

### Scope definitions

| Scope | Meaning |
| --- | --- |
| `files:upload` | Create new files within the allowed namespace. Does not imply read, write, deletion, or key administration. |
| `files:read` | Read permitted protected bytes and metadata, list permitted files, and create temporary links. |
| `files:write` | Change owned-file visibility, display name, retention, and location; revoke temporary links. |
| `files:delete` | Delete owned files. |
| `files:manage` | Includes read, write, and delete. It does not include upload or `keys:manage`. |
| `keys:manage` | Create/list/revoke delegated general credentials within the administrator's own authority. |

Per-file sharing grants have a separate management rule: creating/listing/revoking file-only keys requires both `files:read` and `files:write` for that owned file. Global `keys:manage` is not required for this file-sharing operation. Upload-only and read-only keys cannot mint new file-only grants.

A useful user credential for a drive application has `files:upload` plus `files:manage`. A key with role `management` by itself cannot upload.

### Role shortcuts and restrictions

General key creation accepts `role` as a shortcut when `scopes` is omitted:

| Role | Scopes |
| --- | --- |
| `upload` | `files:upload` |
| `read` | `files:read` |
| `management` | `files:read`, `files:write`, `files:delete`, `files:manage` |
| `admin` | All supported scopes, including upload and key management. |

A generated `admin` key is still bound to its assigned user and restrictions for file modification. Only the environment bootstrap owner has global ownership. An explicit `scopes` array takes precedence over `role`.

A general key can have a `directory` prefix and/or `fileIds` array. Both restrictions apply when both are present. Prefix boundaries are component-based: `a/b` does not grant `a/b-other`. A file-ID-restricted key cannot create new uploads.

Explicit restricted read grants created by the bootstrap owner can read across users. This is reflected by `crossOwnerRead` in key metadata. Generated administrators cannot invent or widen that cross-owner grant. Write/delete still require ownership, even when explicit read restrictions are present.

A generated administrator cannot change the delegated user, grant scopes it lacks, widen inherited restrictions, outlive its own expiry, or delegate `keys:manage`. Only the bootstrap owner creates generated administrators. General-key listing for a generated administrator shows its direct creations; revoking an authorized direct child or itself also revokes further descendants. The bootstrap owner can administer all generated key records.

## 5. API conventions and response shapes

There is no `/v1` prefix in this implementation. API routes are rooted at the backend origin.

- Timestamps such as `createdAt`, `expiresAt`, and `modifiedAt` are Unix **milliseconds**.
- `retentionDuration` is milliseconds. `expiresIn` on temporary-link requests is **seconds**.
- JSON request bodies use `Content-Type: application/json` and have a 32 KB parser limit.
- Multipart uploads use FormData or a multipart-capable HTTP client; the client supplies the boundary.
- Most management successes use 200; new key creation uses 201; preflight uses 204.
- Errors normally use `{ "error": "description" }`. Public content failures return a uniform 404 with public code 1001 (HTML for browsers, generic JSON otherwise). Recognized bearer API clients retain programmatic credential errors.
- Missing, expired, or temporarily inactive files are unavailable to normal file operations. Clients do not assume that a known ID can be revived through the API after expiration.

### File metadata

An illustrative metadata response is:

```json
{
  "id": "4d2170ba-d995-4f2e-a2a7-26fda629c843",
  "path": "unverified/file/alice/photos/4d2170ba-d995-4f2e-a2a7-26fda629c843",
  "url": "https://cdn.example.com/unverified/file/alice/photos/4d2170ba-d995-4f2e-a2a7-26fda629c843",
  "originalName": "holiday.jpg",
  "urlStyle": "folder",
  "size": 1234567,
  "mime": "image/jpeg",
  "ownerId": "alice",
  "visibility": "protected",
  "createdAt": 1800000000000,
  "uploadedAt": 1800000000000,
  "expiresAt": 1800604800000,
  "retentionDuration": 604800000,
  "retentionPolicy": "default",
  "retentionDisabled": false,
  "modifiedAt": 1800000000000
}
```

`uploadedAt` mirrors creation time for compatibility. `size` and `mime` describe the finalized stored bytes, including conversion when enabled. `originalName` is the sanitized/redacted download display name. `urlStyle` is `folder` or `legacy`. Returned metadata never includes the absolute host filesystem location.

The policy label can be `default`, `custom`, `owner-override`, `permanent`, or `legacy` for migrated records. Permanent metadata has null expiry/duration and `retentionDisabled: true`. Applications should rely on these explicit values rather than guessing from a label or path.

### Key metadata

General/file key creation returns a key metadata object plus a creation-only `key` property. Metadata includes `id`, `userId`, `scopes`, `directory`, `fileIds`, `createdAt`, `expiresAt`, `revokedAt`, `crossOwnerRead`, and `purpose` (`api` or `file`). Depending on endpoint/state, null or omitted values may represent inapplicable metadata. No key hash is returned.

An access key is a bearer credential: anyone possessing it has its permitted access until it expires or is revoked. A key ID is not the raw access key.

## 6. Upload API

### `POST /upload`

Permission: `files:upload`; namespace and optional restrictions still apply.

Multipart fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `file` | Yes | Exactly one file with a filename. |
| `path` | No | Relative destination folder; omitted/empty means namespace root. |
| `visibility` | No | `public` or `protected`; otherwise server default. |

`X-File-Visibility` is also supported. The multipart `visibility` field takes precedence. Unknown/duplicate fields, excessive parts, malformed multipart, and extra file parts are rejected. Fields can appear before or after the file.

A shell example using a scoped credential already present in the operator's environment:

```bash
curl 'https://cdn.example.com/upload' \
  -H "Authorization: Bearer $CDN_USER_KEY" \
  -H 'X-Retention-Duration: 48' \
  -H 'X-Retention-Unit: hours' \
  -F 'file=@holiday.jpg' \
  -F 'path=photos' \
  -F 'visibility=protected'
```

Successful response:

```json
{
  "success": true,
  "filename": "4d2170ba-d995-4f2e-a2a7-26fda629c843",
  "path": "unverified/file/alice/photos/4d2170ba-d995-4f2e-a2a7-26fda629c843",
  "url": "https://cdn.example.com/unverified/file/alice/photos/4d2170ba-d995-4f2e-a2a7-26fda629c843",
  "file": {
    "id": "4d2170ba-d995-4f2e-a2a7-26fda629c843",
    "originalName": "holiday.jpg"
  }
}
```

The `file` object is abbreviated here; the actual response contains the full metadata shape from section 5. A protected upload does not automatically make its returned plain URL anonymously accessible. A later authorized request can create a browser link or file key. Upload-only credentials do not acquire read/management permission merely by uploading.

Upload completion includes finalization/conversion, not just receipt of request bytes. A progress bar reaching 100% transmitted bytes does not necessarily mean the server's response is ready. A retry after a lost response is not idempotent and can create another file; no idempotency-key or resume contract is implemented.

### Upload retention headers

| Header | Meaning |
| --- | --- |
| No retention headers | Use the configured default policy. |
| `X-Retention-Days: N` | Legacy positive whole-day duration. |
| `X-Retention-Duration: N` | Positive whole duration. |
| `X-Retention-Unit: minutes`, `hours`, `days`, or `weeks` | Unit for the duration header; defaults to days when omitted. |
| `X-Retention-Enabled: false` | Request permanent storage, subject to permission/policy. |

`X-Retention-Enabled` accepts `true` or `false`. A true value without duration uses the default. `X-Retention-Unit` without a duration is invalid. The two duration header forms must not be sent together. Clients choose one coherent retention request rather than sending contradictory disabled/duration values.

The default minimum for normal users is 24 hours. Lower limits are operator-configurable. The bootstrap owner can bypass the minimum and request permanence. Normal users can request permanence only when the operator enables it. Zero/negative durations are not an alternative spelling of permanent storage. Positive custom durations are capped at 100 × 365 days by the implementation.

### Upload processing and limits

Multipart bytes stream to private temporary files; partially uploaded bytes have no public managed URL. File type is identified from content rather than trusting the submitted MIME claim. Unknown content uses `application/octet-stream` and a `.bin` internal extension. A small UTF-8-looking text sample for `.txt`, `.csv`, and `.json` inputs can use `text/plain`; this is best-effort identification, not full content validation.

When conversion is enabled, recognized MOV/MKV inputs are remuxed to MP4 when possible or re-encoded with H.264/AAC as fallback. Supported non-MP3 audio formats can convert to MP3. Conversion is serialized, has a configurable timeout, and uses a host FFmpeg restricted to file/pipe protocols. Pre-existing MP4 files are not universally re-encoded: an MP4 MIME/container does not guarantee browser-compatible codecs.

The final stored type/size can differ from the input. Conversion does not promise to preserve the uploaded file's exact bytes. `CONVERT_MEDIA=false` is relevant when byte-for-byte original media storage is required. The download display name can retain its original extension even when media is converted; preview selection is based on returned `mime`, not just the display-name extension.

The configured maximum applies to input and finalized output size. The optional MIME allowlist and upload concurrency limit also apply to the bootstrap owner. Per-user finalized-byte quotas apply to normal users; the bootstrap owner bypasses that quota. Expired files can still count toward stored bytes until physical cleanup removes their metadata. There is no guarantee that accepting a particular input will fit every reverse proxy's independent upload/time limit.

## 7. Listing, metadata, and file management

All management endpoints require a valid bearer key even when the file itself is public. Public readability never implies permission to list metadata, move, rename, change visibility, or delete.

| Method and endpoint | Permission | Request / result |
| --- | --- | --- |
| `GET /api/files` | Read | Paginated accessible file metadata. |
| `GET /api/files/:id` | Read for that file | Full metadata object. |
| `GET /api/files/:id/content` | Same public/protected content rules as path URLs | Stream the file; HEAD also works. |
| `PATCH /api/files/:id` | Write + ownership | Change `visibility` and/or `originalName`; returns metadata. |
| `POST /api/files/:id/move` | Write + ownership | `{ "path":"new/folder" }`; returns `{success,filename,path,url}`. |
| `POST /api/files/:id/retention` | Write + ownership | Retention body described below. |
| `DELETE /api/files/:id` | Delete + ownership | Delete bytes/metadata; returns `{ "success":true }`. |

The environment bootstrap owner can manage every file. For generated credentials, both the requested scope and file ownership/restrictions must permit the operation. “Read” in the table includes an explicitly delegated restricted read grant where applicable.

### Listing behavior

Query parameters:

- `limit`: integer 1–500, default 100.
- `after`: the `next` cursor from the prior response.
- `folder`: optional full logical parent directory, such as `unverified/file/alice/photos`. `folder=` selects the full storage/logical root, not the caller's namespace root. A normal user's root uploads are listed with a folder such as `unverified/file/alice`.

A response has `files`, `folders`, and `next`. The cursor is an ID and ordering is lexicographic by ID, not upload date. `next: null` means there is no next page. Permissions are filtered by the server.

An exact `folder` filter returns direct file children, not a recursive subtree listing. Omitting the filter lists accessible files across folders. The `folders` array contains distinct parent directories represented by the returned page, not a complete directory tree. Empty directories are not persisted or listed. A drive application's complete virtual folder tree, display ordering, and empty folders need separate app state or a deliberately derived index.

### Display name and visibility

Example body for PATCH:

```json
{"visibility":"protected","originalName":"renamed-photo.jpg"}
```

Either field may be omitted, but at least one supported field is needed. Other patch properties, such as `ownerId`, `id`, `storagePath`, `size`, and arbitrary permissions, are not supported. Changing `originalName` changes the download display name, not the UUID or bytes.

A metadata PATCH invalidates current View Links and Temporary Access Links. An actual visibility transition also revokes generated file-only keys. Making a public file protected controls future origin requests; it cannot recall earlier public copies.

### Moving

The destination `path` is a folder, not a replacement file ID or filename. `{"path":""}` moves to namespace root. Normal users supply a path relative to their own namespace, and the destination must remain within credential restrictions. The bootstrap owner can choose storage-root-relative folders.

The UUID/layout is preserved. The response's new path and URL replace the old location in client state. The old path becomes unavailable after an actual move. No-op moves to the existing location need not invalidate links. An unrelated destination file is never silently overwritten; collisions produce 409. Display-name changes are separate from moving.

A bootstrap owner moving another user's file uses the bootstrap owner's storage-root interpretation, while file ownership remains unchanged. An integration should avoid mixing namespace-relative and root-relative path assumptions.

### Retention updates

Preferred body:

```json
{"duration":2,"unit":"weeks"}
```

Legacy body:

```json
{"enabled":true,"days":14}
```

Permanent request, when allowed:

```json
{"enabled":false}
```

`{"permanent":true}` is another supported permanent request. A unit omitted on an ordinary duration defaults to days. An update is measured from **the original creation time**, not from the update request. Thus `expiresAt = createdAt + duration`; reducing retention can expire a file immediately. Updating retention invalidates existing View Links and Temporary Access Links but does not expand existing file-key expiration limits.

The response contains `success`, `file` (ID), and `retention` with `enabled`, `duration` in milliseconds, `days` as a derived value, and `expiresAt`. Derived days can be fractional for hour/minute policies. Client logic should use explicit expiration/duration values rather than requiring integer `days`.

### Legacy management endpoints

These remain supported:

| Endpoint | Meaning |
| --- | --- |
| `DELETE /delete/FULL_LOGICAL_PATH` | Same ownership-checked deletion. |
| `POST /path/FULL_LOGICAL_PATH` | Move using the same `{path}` body. |
| `POST /retention/FULL_LOGICAL_PATH` | Same retention update rules. |

They require the exact stored public logical path, not just an ID, guessed filename, internal `content.ext` path, or arbitrary filesystem location. Paths in route segments are encoded segment by segment, preserving `/` separators. The ID endpoints are usually easier for an app to maintain through moves.

## 8. Public access, protected access, and browser links

### Content requests

`GET /FULL_LOGICAL_PATH` and `HEAD /FULL_LOGICAL_PATH` serve managed content. The ID content endpoint uses the same access layer.

- An unexpired active public file is readable anonymously.
- A protected file needs a permitted bearer credential or a valid signed URL.
- The bootstrap owner can read every protected file.
- A normal account key needs read permission and appropriate ownership/restrictions.
- A file-only key can read only its designated file.
- Unknown disk files and internal blob paths are not served directly.
- Expired/non-active/missing files are unavailable before any successful range/conditional response.

A normal browser address bar, image element, video element, or Discord preview fetch does not automatically add an Authorization header. A private file's ordinary URL therefore is not a ready-to-share browser URL. The supported browser mechanisms are a key-lifetime View Link and a separate Temporary Access Link.

A browser without valid authorization receives the same generic **File Not Found** 404 page/public code 1001 as a missing file, including for invalid, expired and revoked browser links. No public message discloses protection or internal diagnostic codes. The included **Open a Protected File** reader accepts a file URL and File Access Key, uses a bearer header, and can create a View Link or Temporary Access Link without the owner’s key.

### `POST /api/files/:id/links`

Permission: read access to that file. It also works for public files, though anonymous direct public access is already possible.

Request:

```json
{"expiresIn":300,"download":false}
```

`expiresIn` is a positive whole number of seconds. Default lifetime is the lesser of 300 seconds and the configured maximum. The normal configured maximum is 900 seconds. The returned expiry is further capped by file and issuing-key expiry.

Response:

```json
{
  "url":"https://cdn.example.com/photos/4d2170ba-d995-4f2e-a2a7-26fda629c843?token=<TEMPORARY_SIGNATURE_TOKEN>",
  "expiresAt":1800000300000,
  "download":false
}
```

The example expiry is illustrative. The actual `url` is an opaque server-generated result: clients use it unchanged rather than building or editing its signature.

The signature binds the file ID, current access version, issuer, expiry, and download-only behavior. It provides GET/HEAD content access only. The service re-checks the issuing credential's current validity and read permission on each request. An invalid `token` is rejected rather than silently falling back to public access.

`download:true` creates a download-only link; changing an unrelated query value cannot turn it into an inline link. On ordinary/public/bearer URLs, `?download=1` forces attachment. A permanent credential is never substituted for `token`.

### View Links (key-lifetime browser access)

The same `/api/files/:id/links` endpoint accepts `{"kind":"view"}` with a File Access Key as bearer. Owning managers with read/write permissions may send `{"kind":"view","keyId":"FILE_KEY_ID"}` or `{"kind":"view","createAccessKey":true,"accessKeyExpiresAt":null}`. Omit `expiresIn`: View Link expiration follows the associated key, bounded by the file and issuing account; null denotes permanent until revoked. The result adds `id`, `kind:"view"`, and `keyId` alongside `url`, `expiresAt` and `download`. Tokens contain 256 random bits and are stored only as SHA-256 hashes in the additive `view_links` table.

`GET /api/files/:id/view-links` lists link metadata/status without bearer secrets. `DELETE /api/files/:id/view-links/:linkId` revokes one link independently. Both require read/write access as the owning manager. At most 100 active View Links per file may exist. Requests revalidate the associated key and file, so key revocation/expiration and file deletion/expiration invalidate access immediately for new requests. Existing access-version changes still invalidate browser links.

Temporary links keep their existing signature format, lifetime limits and API defaults. `kind:"temporary"` is explicit; omitting kind is backward-compatible. `SIGNED_URL_MAX_SECONDS` caps only temporary links. Rotating `signing.key` invalidates temporary signed links; stored View Links use the link/key/file revocation controls.

`GET /api/config` is authenticated and exposes only UI policy: default/minimum retention, permitted permanence, temporary-link maximum and default visibility. The View Link extension requires no additional environment variables or dependencies beyond the 2.1.1 project. Startup creates the View Link table/index idempotently without rewriting existing data/storage.

### `POST /api/access-links`

This exchanges a known file path and valid bearer credential for a browser link without needing the file ID:

```json
{"path":"unverified/file/alice/photos/4d2170ba-d995-4f2e-a2a7-26fda629c843","download":false,"expiresIn":300}
```

The `path` is relative to storage root, with no leading slash, scheme, hostname, or query. Legacy extension-based paths also work, as do recognized ID content routes. The same read authorization applies. Omitted kind (or `kind:"temporary"`) uses temporary-link limits. With a File Access Key, `kind:"view"` instead inherits its expiration and omits `expiresIn`.

An app accepting a full pasted URL validates that it belongs to the configured CDN origin, extracts/decodes its pathname, and sends the logical relative path. It does not forward keys to whatever hostname a user happens to paste.

## 9. File-only access keys and sharing lifecycle

A file-only key is useful when a recipient needs access beyond a single short-lived URL but should have no account-wide power. It is fixed to one protected file, has `files:read` only, and can request key-lifetime View Links and separate short-lived links while valid.

A file manager requires ownership plus both read and write permission to issue these keys. A protected upload made by an upload-only key does not automatically return a read grant. The owner or an appropriately scoped manager can create one later.

| Method and endpoint | Behavior |
| --- | --- |
| `POST /api/files/:id/access-keys` | Create a file-only key; 201 with metadata and raw `key` once. |
| `GET /api/files/:id/access-keys` | List up to 1000 file-key records as `{keys:[...]}` without values/hashes. |
| `DELETE /api/files/:id/access-keys/:keyId` | Revoke one generated file key; 200 `{success:true}`. |
| `POST /api/files/:id/revoke-access` | Revoke all generated file keys and current browser links for the file. |
| `POST /api/files/:id/revoke-links` | Invalidate current View Links and Temporary Access Links without revoking file keys. Requires owned-file write permission. |

Creating/listing/deleting file keys and revoking all shared access require read and write for the file. Keys can only be created for protected files. There is a maximum of 100 simultaneously valid generated file keys per file.

Creation body optionally contains `expiresAt` as future Unix milliseconds. Omitted/null expiry is still capped by the file and issuer. With a permanent file and a non-expiring issuer it can produce a non-expiring key. The panel leaves the field blank by default and explicitly sends null; it never substitutes a 24-hour expiration for an intentionally blank field.

To create a paired temporary URL and file-only key, `/api/files/:id/links` accepts:

```json
{"expiresIn":300,"download":false,"createAccessKey":true}
```

It returns the usual link response plus `accessKey` metadata and its raw `key` once. Optional `accessKeyExpiresAt` controls the separate file-key expiration. The signed link is issued through that generated key; revoking it disables the associated link as well. A read-only key can create a temporary URL but cannot use `createAccessKey:true` to mint another key.

A file key follows its file ID through display-name changes and moves, but inherited issuer directory restrictions still apply. Moving outside such a restriction can prevent that key from reading the file. Expiry is bounded at creation and is not automatically extended when retention is extended.

### Revocation effects

| Event | Existing browser links | Generated file-only keys | Owner/account access |
| --- | --- | --- | --- |
| Rename, retention update, or actual move | Invalidated, or old path disappears | Remain subject to expiry/restrictions | Normal permissions remain. |
| Visibility transition | Invalidated | Revoked | Follows new visibility and normal permissions. |
| Revoke all browser links | Invalidated | Still usable to request fresh links | Normal permissions remain. |
| Revoke one file key | Links issued by that key fail | That key revoked | Other valid credentials remain. |
| Revoke all shared access | Invalidated | All generated file keys for file revoked | Normal owner/account access remains. |
| File expires or is deleted | Unavailable | Cannot access file | File unavailable through ordinary API/content routes. |
| Revoke general issuer key | That issuer and descendant-issued links fail | Descendant keys revoked | Other independent keys remain. |
| Rotate `signing.key` | Temporary signed links invalidated; stored View Links use link/key/file revocation | Raw file/API keys remain separate credentials | Normal permissions remain. |
| Rotate bootstrap owner key | Bootstrap-issued signatures invalidated | Existing generated keys are not automatically all revoked | Old bootstrap key stops authenticating. |

Revoking sharing does not make a public file private. Public content remains anonymously readable until visibility changes, expiration, or deletion. A request already authorized and streaming can finish after subsequent revocation/expiry; these controls govern new authorization decisions.

## 10. General API-key administration

These endpoints require `keys:manage`, with the bootstrap/global and generated-administrator limits described earlier.

| Method and endpoint | Behavior |
| --- | --- |
| `POST /api/keys` | Create a general credential; 201 with metadata and raw `key` once. |
| `GET /api/keys` | `{keys:[...]}`; up to 1000 records, newest creation first. No pagination cursor is implemented here. |
| `DELETE /api/keys/:id` | Revoke the permitted key and descendants; 200 `{success:true}`. |

Illustrative creation body for a complete per-user drive credential:

```json
{"userId":"alice","scopes":["files:upload","files:manage"]}
```

Optional creation properties include `expiresAt`, `directory`, and `fileIds`. `userId` uses 1–80 ASCII letters, digits, `_`, or `-`. The bootstrap owner supplies the target user. A generated administrator defaults to its own user and cannot change to another.

The creation response is an object, not a `{keys:...}` wrapper. `scopes` must be an explicit supported nonempty array when supplied. An omitted role/scopes defaults to the upload role. Supplying role `admin` does not turn a generated key into the global bootstrap owner.

There is no documented endpoint to patch a key's scopes, expiry, user, or raw value in place. Rotation is replacement plus revocation. General key management is not required merely to generate a temporary URL for a readable file or manage an authorized file-only share.

## 11. Small JavaScript client reference

This example shows the HTTP contract. It is not an instruction to deploy a browser application with an embedded owner key. In a multi-user product, the trusted application backend normally owns administration and maps authenticated users to authorized CDN actions.

```javascript
const CDN_ORIGIN = new URL("https://cdn.example.com").origin;

function contentUrl(returnedUrl) {
  const url = new URL(returnedUrl, CDN_ORIGIN + "/");
  if (url.origin !== CDN_ORIGIN) throw new Error("Unexpected content origin");
  return url.href;
}

async function cdnJson(route, { key, method = "GET", json, form } = {}) {
  const headers = { Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(CDN_ORIGIN + route, {
    method,
    headers,
    body: form ?? (json === undefined ? undefined : JSON.stringify(json)),
    credentials: "omit"
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    throw new Error(data?.error || `CDN request failed (${response.status})`);
  }
  return data;
}

async function uploadOne(file, scopedUserKey, folder = "photos") {
  const form = new FormData();
  form.append("file", file);
  form.append("path", folder);
  form.append("visibility", "protected");
  // No manual multipart Content-Type: fetch supplies its boundary.
  return cdnJson("/upload", { key: scopedUserKey, method: "POST", form });
}

async function listPage(readKey, after) {
  const query = new URLSearchParams({ limit: "100" });
  if (after) query.set("after", after);
  return cdnJson("/api/files?" + query, { key: readKey });
}

async function browserLink(id, readKey, download = false) {
  const result = await cdnJson(`/api/files/${encodeURIComponent(id)}/links`, {
    key: readKey,
    method: "POST",
    json: { expiresIn: 300, download }
  });
  return { ...result, url: contentUrl(result.url) };
}

async function linkUsingFileKey(logicalPath, fileKey, download = false) {
  const result = await cdnJson("/api/access-links", {
    key: fileKey,
    method: "POST",
    json: { path: logicalPath, expiresIn: 300, download }
  });
  return { ...result, url: contentUrl(result.url) };
}
```

The JavaScript sample assumes the API and public content share one origin. If an operator deliberately separates a trusted internal API origin from the public BASE_URL, the application configures and validates that public content origin separately rather than accepting arbitrary response destinations.

A permitted application can assign the fresh signed URL to `img.src`, `video.src`, or an anchor. Large downloads stream directly from the CDN instead of first buffering the complete file into a JavaScript Blob. Link renewal needs the appropriate still-valid credential; changing an expired URL's timestamp/signature locally is not supported.

For a media element, the parent application's own CSP also needs to allow the CDN origin in `img-src` or `media-src`. The media endpoint cannot override a restrictive policy on the embedding application's page.

A protected video can make later range requests while playing/seeking. If the signed URL expires, those new requests can fail. A player may need to request a fresh authorized URL and restore its playback position. The maximum permitted lifetime is controlled by the operator; an integration does not bypass it to keep a stream alive indefinitely.

## 12. A Drive-style application using this API

A personal or multi-user drive usually separates its application layer from the CDN:

1. The application handles login and trusted identity. Its backend maps that identity to a CDN `userId`, an appropriately scoped credential, and permitted operations.
2. Before accepting long-term storage, it chooses a retention policy supported by the operator. Protected uploads are a typical default for personal documents.
3. Upload completion records the returned file ID and metadata in app state/database. Expiry, logical location, detected MIME, and filtered display name come from the response.
4. Listing uses the correct per-user read authority and pagination. App-owned state can add friendly/empty folders, tags, search, favorites, permissions UI, or a trash workflow.
5. Preview/download requests are authorized by the application before it creates a short-lived CDN link. The browser receives that link rather than the CDN bootstrap credential.
6. An explicit share action can issue a temporary URL or a file-only key. A recipient needs no access to the sender's account-wide credentials.
7. Move, rename, visibility, retention, and deletion actions update app state from the CDN result. Mutable URLs are not treated as stable IDs.

A single trusted personal backend can call the CDN on behalf of its sole owner. A multi-user backend using a broad key must enforce its own user authorization before every operation; possession of a backend owner key is not evidence that a particular logged-in frontend user owns a requested file.

An alternative for direct browser uploads is a short-lived scoped user credential issued through a trusted backend. That design still keeps bootstrap/key-management authority out of public bundles and binds user identity on the server. It also requires a deliberate credential lifetime, revocation, and storage policy.

The application can implement a trash feature by delaying actual CDN deletion, but it must account for CDN retention continuing to run. Once this API deletes or expires a file, no built-in restore operation exists.

## 13. Serving, caching, previews, and filenames

### HTTP serving behavior

File bytes are streamed, not loaded wholesale into application memory. Responses support Content-Length, Content-Type, safe Content-Disposition, Accept-Ranges, ETag, and Last-Modified.

Single `bytes=` ranges support explicit bounds, open-ended bounds, and suffix ranges. Valid requests return 206 and Content-Range. Unsatisfiable/malformed single byte ranges can return 416 with `Content-Range: bytes */SIZE`. Oversized ends are clamped. Multiple ranges fall back to a complete 200 response; multipart byte-range bodies are not implemented. HEAD returns full representation headers and ignores Range.

Conditional GET/HEAD supports If-None-Match and If-Modified-Since; If-None-Match takes precedence. If-Range can determine whether a GET range is honored. Other HTTP precondition features are not an implied API promise. Authorization and expiration are checked before 304/206 handling.

### Inline types and browser security

The inline allowlist is: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/avif`, `video/mp4`, `video/webm`, `audio/mpeg`, `audio/ogg`, `audio/wav`, and `text/plain`. Download requests can still force attachment for those types.

HTML, SVG, PDF, and unknown formats default to attachment. File responses include nosniff. In 2.1.1, recognized inline binary media permits its own media/image resources without a CSP sandbox so the native browser player works; scripts remain blocked. Active/unknown downloads retain the restrictive sandbox policy. The included control panel has a distinct policy because it is an actual application page.

An extensionless image/video URL still returns its detected content type. A third-party preview service can fetch a public URL or an unexpired signed protected URL, but it cannot send the owner's bearer header merely because a private URL was pasted into a message.

Discord and other clients control preview rendering, supported formats, and caching. This reference does not promise a particular Discord unfurl or cache purge. Download-only URLs are for attachment download, not a guarantee of inline preview.

### Caching and deletion

Public content uses `public, max-age=0, s-maxage=0, must-revalidate`. Protected content, signed URLs, API responses, and errors use restrictive no-store caching; public content requested with Authorization is also served restrictively. Proxy rules must not override this with a long edge TTL or “Cache Everything.”

Deleting a file or reaching `expiresAt` prevents future authorized origin serving. Cleanup removes its managed bytes and only empty parent directories. It cannot erase content already displayed in a browser, downloaded, copied, screenshotted, or cached elsewhere. Removing a UUID folder is not a remote wipe mechanism for client devices.

### Download names and word filtering

The URL does not determine the download filename. Content-Disposition uses the sanitized/redacted `originalName`, or its authorized replacement.

The built-in filter targets a conservative list of common English profanity and racial/homophobic slurs. Matching is case-insensitive, normalizes common full-width characters, and uses whole-word boundaries. It does not automatically redact innocent substrings such as those inside “Scunthorpe,” “assistant,” or “cocktail.” Filename path components, controls, unsafe device names, and other unsafe characters are separately sanitized.

`FILENAME_REDACT_WORDS` replaces the default list with a comma-separated operator list; an explicitly empty value disables word redaction. `FILENAME_REDACTION_TEXT` defaults to `redacted`; empty replacement removes matches. Star characters are not a supported replacement under the safe filename configuration. The word list is limited to 100 terms of 80 characters; replacement text is limited to 32 safe characters.

Filtering applies to new uploads, name changes, metadata output, and Content-Disposition, including older records without rewriting their file bytes or URLs. It is best-effort filename cleanup, not content moderation, semantic analysis, a malware scan, or reliable detection of every language/obfuscation. Clients display returned names as text, not unsanitized HTML, and do not independently assume the operator uses the default list.

## 14. Configuration reference

These are operator settings, not a client API for changing a running service. The service loads `.env` beside `server.js`; existing process/PM2 environment variables take precedence. Restarting is needed after intentional configuration changes. No public configuration-discovery endpoint is implemented.

| Variable | Default / behavior |
| --- | --- |
| `OWNER_API_KEY` | Required; at least 32 bytes. A cryptographically random operator secret is appropriate. |
| `HOST` | `127.0.0.1`; loopback by default. |
| `PORT` | `3010`. |
| `BASE_URL` | Optional public HTTP(S) origin. Missing value produces relative returned URLs. No path prefix, embedded credentials, query, or fragment. |
| `DATA_DIR` | Project directory by default, preserving legacy in-place storage. |
| `UPLOAD_URL_STYLE` | `folder`; `legacy` also supported for future uploads. |
| `DEFAULT_VISIBILITY` | `public`; `protected` also supported. |
| `DEFAULT_RETENTION_MINUTES` | `10080` (seven days); must be at least the configured minimum. |
| `MIN_RETENTION_MINUTES` | `1440` (24 hours) for normal users. |
| `ALLOW_PERMANENT` | `false`; `true` permits normal users to request permanent storage. The bootstrap owner can request permanence independently. |
| `MAX_UPLOAD_SIZE_GB` | `25`, interpreted using 1024-based byte units. |
| `MAX_UPLOAD_BYTES` | Optional positive integer byte limit; overrides the GB setting, including for limits below one GB. |
| `MAX_CONCURRENT_UPLOADS` | `4`; includes admitted uploads and conversion work. |
| `MAX_USER_BYTES` | `0` disables the finalized-byte quota; otherwise applies per user, except bootstrap owner. |
| `UPLOAD_TIMEOUT_SECONDS` | `3600`, covering the upload operation. |
| `CONVERT_MEDIA` | Enabled unless set to `false`. |
| `FFMPEG_PATH` | `ffmpeg`, resolved as the host executable. |
| `CONVERSION_TIMEOUT_SECONDS` | `900` per FFmpeg command attempt; remux fallback can run another attempt. |
| `ALLOWED_MIME_TYPES` | Empty permits all detected types, with safe download behavior. Otherwise comma-separated exact detected MIME values checked on input before conversion. |
| `SIGNED_URL_MAX_SECONDS` | `900`; upper bound for temporary links, further capped by key/file expiry. |
| `CLEANUP_INTERVAL_SECONDS` | `3600` when selected; overrides the older hours setting. |
| `RETENTION_CHECK_INTERVAL_HOURS` | Legacy fallback, default `1`. |
| `TEMP_MAX_AGE_MINUTES` | `1440`; abandoned temporary files older than this can be removed, excluding active/journal-referenced temps. |
| `CORS_ORIGINS` | `*`, or comma-separated exact allowed origins. |
| `FILENAME_REDACT_WORDS` | Built-in list when unset; a supplied list replaces it; explicitly empty disables word redaction. |
| `FILENAME_REDACTION_TEXT` | `redacted`; safe empty replacement is allowed. |

Operator policy can be stricter than these defaults. A CDN URL does not reveal those settings. The host filesystem, OS resource limits, and reverse proxy can impose additional capacity, size, or time limits.

## 15. Storage, recovery, migration, and deployment

### Runtime data

The persistent data directory contains SQLite `cdn.db` (and possibly WAL/SHM files), `uploads/`, `temp/`, and `signing.key`. Legacy installations may initially have `keys.json` awaiting migration. These are deployment data, not sample project files for public distribution.

Core SQLite tables are `files`, `api_keys`, `operations`, and `settings`. Metadata tracks file ownership, visibility, logical/disk paths, layout, timestamps, retention, active state, and separate link/share versions. The operation journal records interrupted filesystem work. These fields are internal implementation data, not a public direct-write database interface.

Uploads and moves use exclusive hard links on a local filesystem and persist intent before publishing active metadata. Interrupted upload/move/delete operations recover on startup and cleanup. Pending/moving/deleting rows are not normally served. Cleanup runs at startup and periodically without overlapping itself. Missing files during deletion are handled safely; unresolved failures remain recoverable and can cause readiness 503.

Only empty UUID/ancestor directories are pruned. Unrelated files and the storage root are preserved. Disk files without database metadata are not automatically published or blindly deleted.

This is recoverable coordination between SQLite and filesystem operations, not an atomic transaction spanning both systems under every power-loss scenario. Consistent backups and normal filesystem durability still matter.

### Process and filesystem requirements

The declared Node requirement is 22 or later; the existing validation used Node 24 on Linux. FFmpeg is a host dependency when conversion is enabled. Native better-sqlite3 installation can need a supported prebuilt binary or Python/C/C++ build tools.

The supported storage model is one service process per private data directory on a local filesystem supporting hard links. Upload and temporary storage need to be on the same filesystem. SQLite alone does not make the in-process upload limits, temporary-file tracking, and recovery safe across multiple replicas. The deployment is not designed for Node cluster workers sharing a data directory or a network-mounted storage tree.

SIGINT/SIGTERM requests a graceful HTTP shutdown with up to 30 seconds for draining; interrupted operations remain subject to restart recovery. The service runs as an unprivileged OS user. Path traversal and symlink checks protect managed operations, but a hostile local process able to rewrite the data tree/database is outside that boundary. The operator controls filesystem permissions on the tree and its ancestors.

Systemd and Cloudflare Tunnel example configurations are included in the source. A tunnel commonly routes `https://cdn.example.com` to `http://127.0.0.1:3010` on the same machine. A mismatched port or failed Node startup can produce a public 502. A separate frontend's successful deployment does not establish backend readiness.

### Installation and upgrades

A standard installation uses `npm ci`, a populated `.env` derived from `.env.example`, a persistent data directory, and `npm start` or an equivalent single-process service manager. Production dependency installation can use `npm ci --omit=dev`. The backend must use HTTPS publicly through its deployment/proxy setup.

For PM2, the important properties are the correct project/script, one process, the expected environment, and restart after changes. `pm2 restart ecdn --update-env` refreshes the process with the current shell's environment; an explicitly supplied PM2/shell variable can still override `.env`. PM2 reporting “online” is not a readiness check. Startup diagnostic codes explain authored configuration/migration failures without echoing raw key material.

An upgrade normally stops the process, makes a private consistent backup, replaces source while preserving `.env` and all runtime data, installs locked dependencies if needed, restarts, and checks liveness/readiness. Copying an empty example environment over an existing one or changing to an empty DATA_DIR is not a migration repair.

Existing v2 extension URLs, metadata ownership/visibility/retention, API-key hashes, and valid earlier signatures are intended to survive the additive 2.1 upgrade when the actual data, signing key, owner key, and policy are preserved. Public paths are backfilled from existing storage metadata. New uploads then follow the configured layout.

### Legacy keys and ownership

A valid legacy file has the shape `{ "keys":[{"key":"<LEGACY_KEY>","userId":"alice"}] }`. Migration hashes the existing token into SQLite transactionally, then removes the plaintext input file without making another plaintext copy. Retry after commit/removal interruption does not duplicate hashes. Existing tokens can remain usable for their historical user with upload/read/write/delete/manage, but do not gain key administration from a legacy owner flag.

Malformed JSON, missing/invalid users, or invalid entries stop startup with a safe diagnostic and preserve the input for offline repair. Runtime key creation never writes a new plaintext `keys.json`.

Very old file records did not carry explicit ownership. Migration can infer a historical user from the established `unverified/file/USER/` namespace; otherwise it assigns the bootstrap-owner user. Ambiguous/unmatched disk locations need operator review. These are migration assumptions about old data, not permission rules for new client-supplied paths.

Backups need SQLite and stored bytes to agree. A stopped-service backup is the simplest approach; WAL/SHM state matters when relevant. Secrets, signing keys, metadata, and any old plaintext key copies need private handling. Rollback uses a complete compatible backup rather than running old code against a newly migrated live database. Deleting a plaintext file does not guarantee erasure from SSD snapshots or backups.

## 16. Error handling and common integration failures

| Result | Typical meaning / client behavior |
| --- | --- |
| 400 | Invalid path, duration, fields, JSON, multipart request, or unsupported request shape. Fix input rather than blindly retrying. |
| 401 | Missing, invalid, expired, or revoked authentication; invalid/expired signed link. Recognized bearer JSON clients retain these errors; public content failures use a uniform 404 instead. |
| 403 | Authenticated credential lacks scope, ownership, directory/file permission, or retention authority. |
| 404 | Unknown, expired, inactive, moved, or missing file, or the request went to a host/route without that API. |
| 408 | An interrupted/timed-out upload can report this when a response is still possible. A disconnected client may instead see a network error. |
| 409 | Destination collision, or the active file-key count limit was reached. |
| 413 | Upload/output size, quota, or request-body limit exceeded. |
| 415 | Detected input MIME was rejected by the configured allowlist. |
| 416 | Unsatisfiable/malformed single byte range. |
| 500 | An internal conversion, database, filesystem, or unexpected operation failed. |
| 503 | Upload capacity exhausted (with Retry-After, normally 5 seconds), or readiness is not established. |
| 507 | Storage space/quota exhaustion at the filesystem level. |
| Proxy 502/other gateway error | Backend/tunnel/proxy issue; the response may not be generated by MUIZI or have its CORS/JSON headers. |

Exact human-readable error strings are not a stable machine protocol. Error bodies should be displayed safely as text. A stream that fails after headers are sent can terminate without a new JSON error response.

Frequent problems:

- **POST goes to the frontend and returns 404:** the backend origin field/configuration is wrong. The static frontend does not have `/upload`.
- **Browser says CORS and public health is 502:** Node/tunnel connectivity must be restored first. Adding headers to the frontend does not repair a failed origin.
- **Upload rejects a read/management key:** read does not imply upload, and the management role does not include upload.
- **Private URL opens 401 in a normal tab:** the address bar has no bearer header. A fresh signed URL or the file-key reader is appropriate.
- **Old video tab/link fails:** check current authorization/expiry, MIME/codecs, Range handling, and the effective response CSP. The 2.1.1 native-media fix must be applied to backend code, not only to the frontend HTML.
- **Video loads initially but later seeking fails:** later range requests can encounter link expiry; the player needs an authorized link refresh strategy.
- **Retention update immediately hides an older file:** duration is measured from original creation time, not the update date.
- **Deletion/revocation appears ineffective in an existing preview:** an already loaded/cached copy is different from a new origin fetch. Public visibility is also independent of revoking a share key.
- **Readiness says recovery pending:** unresolved journaled storage work needs space/permissions/path issues repaired, followed by retry/restart. Removing the database to suppress the check loses metadata and access control.

## 17. Source map and validation context

The implementation is organized as follows:

| File | Responsibility |
| --- | --- |
| `server.js` | Project-adjacent environment loading, HTTP startup, timeouts, shutdown, and safe startup diagnostics. |
| `lib/config.js` | Validated environment settings and defaults. |
| `lib/app.js` | HTTP routes, metadata responses, permission use, signed links, file serving, CORS, and response security/caching. |
| `lib/security.js` | Credential hashing/comparison, authentication, scopes, ownership/restrictions, key creation, and retention parsing. |
| `lib/storage.js` | SQLite schema/migration, path checks, disk operations, operation journal, cleanup, and signing-key persistence. |
| `lib/upload.js` | Streaming multipart intake, temporary files, limits/abort handling, quota checks, conversion orchestration, and finalization. |
| `lib/media.js` | Content identification and serialized, bounded FFmpeg work. |
| `lib/filenames.js` | Sanitized display/download names and configurable whole-word redaction. |
| `lib/startup-error.js` | Specific safe diagnostics without raw parser/driver secret fragments. |
| `example-upload.html` | Existing standalone upload/manage/share/recipient-reader panel. |
| `test/` and `scripts/browser-smoke.js` | HTTP/integration tests and real Chromium workflow/media checks. |
| `.env.example`, `deploy/`, and upgrade docs | Configuration/deployment examples and data-preserving upgrade guidance. |

The 2.1.1 validation recorded 45 passing HTTP/integration tests, real FFmpeg audio/video conversion, and Chromium checks including native protected MP4 playback/seeking and a separate static frontend using the correct backend origin. It also exercised ownership, legacy paths/migration, signed-link invalidation, file-only sharing, limits, failure recovery, and safe active-document download behavior.

These are development verification results, not a promise of every operating system/browser/codec, a live Discord integration, an external security audit, a production load certification, or a complete power-loss simulation. New integration code needs its own tests for its accounts, authorization mapping, lifecycle, deployment, and failure handling.

The source package declares `GPL-3.0-only` and contains a GPLv3 LICENSE. That file governs the project's licensing; dependency licenses also apply. The package's `private: true` npm flag prevents accidental npm publication and does not make the source closed or make hosted files private.

## 18. Integration guardrails — invalid assumptions and unsafe patterns

These notes describe boundaries of the existing service. They are reference constraints, not a request for an AI tool to execute changes or an authorization to administer a live instance.

| Pattern to avoid | Reason / supported alternative |
| --- | --- |
| Embedding the bootstrap key in a public frontend, mobile bundle, client-visible environment variable, or repository | It grants global access. Administration belongs in a trusted backend/operator environment; clients receive deliberately scoped authority or signed URLs. |
| Accepting a frontend-provided `userId` as proof of ownership | Identity mapping is the trusted application's responsibility. CDN ownership comes from the validated key, not upload path/body claims. |
| Putting permanent API/file keys into URLs | Keys are header credentials. Only server-created temporary signature tokens belong in content URLs. |
| Logging Authorization headers, new raw key responses, signed query strings, or private contents | Those values can grant access. Operational logs can use non-secret IDs/status/codes instead. |
| Sharing .env, signing.key, SQLite/WAL files, runtime uploads, old keys.json, or private backups with an open-source archive or a coding assistant | They are deployment data/secrets. Public source and this reference do not need them. |
| Assuming a public URL is private because its UUID is hard to guess | Public visibility allows anonymous retrieval. Protected visibility plus authorization is the control. |
| Serving uploads through an independent static directory or a metadata-bypassing proxy route | It bypasses privacy, retention, ownership, and alias checks. Managed bytes go through the application. |
| Using internal `content.ext` disk locations as client URLs or constructing every URL from an extension | Returned URLs are authoritative; layouts and reserved API routes differ. |
| Disabling CORS/authentication checks, using `mode: "no-cors"`, or adding headers only to the frontend to suppress an error | That does not implement an authorized, readable API response. The correct backend origin and allowed-origin/proxy configuration are needed. |
| Applying `default-src 'none'; sandbox` indiscriminately to recognized native media, or removing all CSP/disposition protections to make video work | The media-specific 2.1.1 policy permits playback while HTML/SVG/unknown content remains a restricted download. |
| Trusting multipart MIME or display filename to choose executable inline rendering | The server uses content identification and a narrow inline allowlist. Neither filename redaction nor file type identification is a malware scanner. |
| Treating “revoke temporary links” as revoking every credential | Valid file keys can request new links. All-share revocation, individual key revocation, visibility, and account authority are separate controls. |
| Treating a temporary URL as an application's permanent file record | It expires and can be invalidated. The stable file ID and fresh authorized metadata are the durable reference. |
| Assuming permanent retention, an expiration extended from “now,” automatic restore, or byte-for-byte preservation with conversion enabled | Defaults and implementation differ. Explicit retention and conversion policy is necessary. |
| Manually deleting/moving host files, rewriting metadata paths/owners, or clearing the journal to imitate API operations | It can desynchronize metadata, bytes, permissions, and recovery. Supported management APIs coordinate these operations. |
| Treating folder deletion as remote erasure of browser/Discord/saved copies | Only future origin access is controlled; previously delivered copies cannot be recalled. |
| Running multiple workers/replicas on one data directory or using independently mounted temp/uploads filesystems | The service assumes one process and same-filesystem hard links. A different architecture is a separate project change. |
| Inventing login, search, resumable-upload, overwrite, folder CRUD, trash, bulk, discovery, or key-update endpoints | They are not documented APIs in this version. Such features need a separately specified application layer or explicit CDN extension. |
| Replacing the architecture, adding unrelated features, weakening ownership checks, rotating live secrets, running migrations, or deploying because this document was attached | A reference document does not request those actions. Any development/operations task needs a separate authorized request. |

The integration contract is: a configured backend origin, explicit credentials and ownership, documented API operations, authoritative returned metadata/URLs, and clear lifecycle handling. Application behavior beyond that contract is designed separately rather than assumed to exist inside the CDN.

Internal file-access logs use numeric diagnostics without paths/tokens: 1001 missing file, 1002 missing/invalid authorization, 1003 expired key/link, 1004 revoked key/link, 1005 expired file. Public responses always use generic code 1001. Authorization runs before range/conditional processing; protected content and errors remain private, no-store. Already authorized streams may finish and downloaded copies cannot be recalled.
