# Apply the video and panel fix

This patch contains lib/app.js (backend media headers) and example-upload.html (panel configuration checks). It does not include .env, cdn.db, uploads, signing.key or API key data. Production dependencies and schema are unchanged from 2.1.0.

1. Stop the process: pm2 stop ecdn
2. Extract this patch into the existing backend project folder, replacing lib/app.js and example-upload.html.
3. If your panel is separately hosted, also deploy the updated example-upload.html there as index.html (or its existing filename).
4. Restart the backend: pm2 restart ecdn --update-env
5. Hard-refresh the panel. Set CDN URL to https://assets.evtrg.com and click Test CDN Connection. The separate frontend hostname is not the upload API. Only this verified public backend origin is remembered; keys are never saved.
6. Close the old video tab, generate a fresh temporary link, and open it in a new tab. Existing temporary links may have expired while troubleshooting.

Backend change: recognized image/audio/video responses permit same-origin media and images without the native-player-breaking CSP sandbox. Scripts remain blocked. HTML/SVG/unknown documents still download as attachments under the strict sandbox policy. The application still checks privacy, key scopes, expiration and range authorization before serving bytes.

Validation: 45 HTTP/integration tests passed. Chromium tests passed for actual protected MP4 decoding/playback/seeking and for uploading through a separately hosted frontend with the correct backend origin.

The separate full v2.1.1 source ZIP also contains package metadata, tests and documentation. Applying this minimal patch alone leaves the package version label at 2.1.0; the runtime fixes are the same.
