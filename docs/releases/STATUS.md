# SyncWatch release status — 25 October 2026

## Chrome 0.9.0

The Glass Lounge redesign is committed as `3a920cb528f721c94559a0e0682e25ff71041ab0`
on `codex/glass-lounge-redesign` and pushed to origin.
Draft pull request: https://github.com/strikec71/SyncWatch/pull/2 .
The original `v0.8.0` tag is preserved; this branch has not been merged into main.

Chrome Web Store accepted the 0.9.0 submission on 25 October 2026 and shows
**Pending review**. The pending 0.8.0 review was withdrawn before uploading 0.9.0.
The listing description now covers Glass Lounge and appearance preferences.
Publication after approval is **manual**; the console states deferred publication
expires 30 days after approval. The currently published version remains 0.7.0.

Store item: `mincjbhfhimdgnjjonocoogphjgkfffm`.
Public listing: https://chromewebstore.google.com/detail/mincjbhfhimdgnjjonocoogphjgkfffm .

Package: `syncwatch-chrome-0.9.0.zip`, 79,492 bytes, 9 files.
SHA-256: `76486f5950462d36637ca5cea315b2824b7921464692eb1203d44a4a51bd8b24`.
The Node 24 build was packaged with deterministic Python ZIP metadata on Windows
because Info-ZIP is unavailable. CRC and every file were checked against the build;
repeated local packaging produced the same digest. This does not claim byte equality
with the Linux Info-ZIP packager.

## Verification

- Extension TypeScript and 349 unit/regression tests passed.
- 34 Chromium fullscreen checks and 15 additional design acceptance checks passed.
- GitHub Actions extension, server, and browser jobs passed for code commit `3a920cb`:
  https://github.com/strikec71/SyncWatch/actions/runs/40136087404 .
- The UI fixtures replace extension transport; installed-extension acceptance on
  current video sites, advertisements, MV3 suspension and long sleep remain separate.
  Full Chromium failed to launch on this Windows host with `spawn UNKNOWN`; headless
  Chromium fixture checks completed successfully.

## Production server and follow-ups

Server 0.4.0 remains deployed at https://syncwatch-signal.strikec71.workers.dev
from `890f431f5ab5a4518907d6e8b25262c3f5344ecb` (the v0.8.0 source).
Cloudflare version ID: `674f4d4f-534a-4fe6-b465-0f7313bdc7ab`.
Health, privacy and an isolated WebSocket JOIN/roster check passed after deployment.
This presentation update does not require another server deployment.

The server `/version` response still says 0.6.0. Align the notifier in a tested
follow-up; do not advertise 0.9.0 before approval, manual publication and availability.
GitHub Actions Cloudflare deployment credentials are not configured; local OAuth
was used for the existing production deployment.

The prior server dependency audit reported three development-tooling vulnerabilities
through Wrangler/Miniflare/undici. Resolve them in a separate tested dependency update.
