# Release status — 25 October 2026

Extension **0.10.0** is being prepared with English/Russian selection, localized
metadata/pages, English documentation and five current store screenshots.
Server **0.4.1** localizes public pages; room/presence protocols are unchanged.
Preparation alone does not establish publication or deployment.

Existing store item: mincjbhfhimdgnjjonocoogphjgkfffm. At the start of this task,
0.9.0 was pending review and 0.7.0 remained published. The owner requested replacing
that review with 0.10.0 and automatic publication after approval. Record the actual
dashboard confirmation once submitted.

Local checks: extension TypeScript and 356 unit/regression tests; server TypeScript
and 73 tests; 34 Chromium fullscreen checks and 22 design/localization checks.
CI/production evidence will be recorded after those checks complete. Fixtures do
not replace installed-extension acceptance on current real sites. Full Chromium
previously failed to start on this Windows host with spawn UNKNOWN; headless
source-module fixtures work.

Previous production server: 0.4.0 from
890f431f5ab5a4518907d6e8b25262c3f5344ecb at
https://syncwatch-signal.strikec71.workers.dev . A source commit does not establish
a deployment. The historical /version value is 0.6.0; update the notifier only
after confirming store availability, in a tested follow-up.

See 0.10.0.md, STORE-SUBMISSION.md and ../PUBLISHING.md. The previously reported
server development-tooling audit and missing Cloudflare Actions credentials remain
separate follow-ups. Local OAuth does not configure CI deployment credentials.
