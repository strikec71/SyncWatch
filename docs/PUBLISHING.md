# Publishing SyncWatch

Current extension: **0.10.0**. Server: **0.4.1**. Existing Chrome Web Store item:
mincjbhfhimdgnjjonocoogphjgkfffm. Always update this item; registration and extension
identity are already established. See releases/STATUS.md for confirmed live state.

## Verification and package

Use Node.js 24. Run npm ci separately in extension/ and server/.

- extension/: npm run verify, npm run build, npx playwright install chromium,
  then npm run test:browser.
- server/: npm run verify.
- Verify /healthz, /privacy?lang=en, /privacy?lang=ru and an isolated WebSocket JOIN.
- Set SYNCWATCH_SERVER_URL to the verified production origin before the release
  build. Existing user relay preferences must survive updates.
- npm run package in extension/ verifies versions and produces
  dist/packages/syncwatch-chrome-0.10.0.zip and SHA256SUMS. manifest.json must be
  at archive root; _locales/en and _locales/ru must be included.

The normal packager uses Info-ZIP with fixed order, permissions and timestamps.
When it is unavailable on Windows, a deterministic Python ZIP can be used only
with CRC, file-by-file build comparison and repeat-digest verification recorded.
It need not be byte-identical to the Linux Info-ZIP output. Publish the exact ZIP
submitted to the store; do not rebuild silently after review.

## GitHub release

Commit and push the complete reviewed source. Preserve all existing tags. Create
a new v0.10.0 tag pointing at the release commit and publish a GitHub release with
the Chrome ZIP, SHA256SUMS, English notes and current screenshot assets. A GitHub
release does not mean the Web Store update has been approved or distributed.

The legacy tag-triggered workflow deploys production and needs Cloudflare Actions
secrets. For a release prepared with authorized local OAuth, use the documented
manual path in releases/DEPLOYMENT.md; do not set up credentials or redeploy simply
to make the workflow green. Keep reported deployment/review evidence accurate.

## Store listing and review

1. If an older update is still under review, withdraw that review before replacing
   its package. Do not unpublish the installed public version.
2. Upload the verified 0.10.0 ZIP as a new package for the same item.
3. Set English as the primary listing language, keep a Russian translation, and
   use the English description from releases/STORE-SUBMISSION.md.
4. Replace outdated screenshots with the five current 1280 × 800 English screenshots.
   Images show actual UI with clearly marked illustrative data. Chrome accepts
   24-bit PNG or JPEG; validate dimensions/color mode before upload.
5. Keep permission/data disclosures aligned with the implementation. Language
   selection adds no permissions, tracking, translation service or data category.
   The privacy URL serves English and Russian versions.
6. Update reviewer instructions, save the draft and submit. For 0.10.0, the owner
   requested **automatic publication after approval**: enable that submission option.
7. Record the actual confirmed version/review state. Pending review is not approved
   or available. Installed-extension acceptance on live video sites remains distinct
   from the automated source-module fixtures.

The server's /version currently has a historical 0.6.0 value; update it in a tested
follow-up only after confirming the current version is actually available in the
Web Store. Chrome itself distributes extension updates. The removed /updates.json
channel returns 404.
