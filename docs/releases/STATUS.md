# Release status — 25 October 2026

## Extension 0.10.0

Published GitHub release: https://github.com/strikec71/SyncWatch/releases/tag/v0.10.0 .
This is a public release, not a draft/prerelease. It contains the reviewed Chrome
ZIP, SHA256SUMS and five current English screenshots. The release tag and deployed
server source point to b36501e328a27d33c2c67f994c78217a83499187, merged into main
through PR #2. Older tags are preserved.

Chrome Web Store accepted **0.10.0** on 25 October 2026 and shows **Pending review**.
The previous 0.9.0 review was withdrawn before replacement. **Automatically publish
after review was checked when submitting**, as requested by the owner. The currently
published store version was still **0.7.0** at submission; pending is not approved.

Existing item: mincjbhfhimdgnjjonocoogphjgkfffm.
Listing: https://chromewebstore.google.com/detail/mincjbhfhimdgnjjonocoogphjgkfffm .
English is the default listing language with an updated Russian description.
Both language listings have five new localized 1280 × 800 RGB screenshots, showing
the actual UI with illustrative data. Older global fallback artwork was retained;
the new localized image sets take precedence. Permission justifications, purpose,
privacy URL and reviewer instructions were updated in English. Existing data
categories and limited-use disclosures remain consistent with the implementation.

Package: syncwatch-chrome-0.10.0.zip, **102,547 bytes**, 11 files.
SHA-256: **53e3535073f02c0cce37ac0485a80cf8f0ec6ceec0a0f1ab6951047f14049c0f**.
The GitHub asset digest matches the exact ZIP uploaded to the store. The Windows
archive uses deterministic Python ZIP metadata because Info-ZIP is unavailable;
CRC, locale catalogs, every file against the Node 24 build, and repeated SHA-256
were verified. This does not claim byte equality with Linux Info-ZIP output.

## Production server 0.4.1

Deployed to https://syncwatch-signal.strikec71.workers.dev using authorized local
Wrangler OAuth. Cloudflare version ID: e8288192-4248-492a-b228-d1bfe18cae36.
/healthz reports version 0.4.1 and the exact release SHA above. The deployment
verifier passed English privacy and an isolated WebSocket JOIN/host roster;
Russian privacy and the English invitation page were checked too. Room/presence
protocols remain compatible; only public pages changed.

## Verification

- Extension TypeScript and **356** unit/regression tests passed.
- Server TypeScript and **73** tests passed.
- Chromium: **34** fullscreen + **22** design/localization checks passed.
- PR verification: https://github.com/strikec71/SyncWatch/actions/runs/40138104888 .
- Main verification: https://github.com/strikec71/SyncWatch/actions/runs/40138191947 .
  Extension, server and browser jobs all succeeded.

Creating the release tag through GitHub's API also triggered the legacy Release
SyncWatch workflow. Run 40138297685 stopped at missing CLOUDFLARE_API_TOKEN and
CLOUDFLARE_ACCOUNT_ID Actions secrets; its deployment never ran. The successful
local deployment and public release above were verified separately. Local OAuth
does not configure CI deployment. Set up durable CI credentials separately before
relying on the tag-driven deployment workflow.

Installed-extension acceptance on current live sites, real ads, MV3 suspension and
long sleep remains separate from source-module fixtures. Full Chromium previously
failed to launch on this Windows host with spawn UNKNOWN; headless fixtures work.
The old /version notifier still says 0.6.0; update it in a tested follow-up only
after confirming a new version is available in the Web Store. Chrome distributes
updates independently. Previously reported server development-tooling dependency
findings also remain a separate tested-update task.
