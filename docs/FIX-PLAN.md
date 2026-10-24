# Verification plan

Current extension: 0.10.0. Server: 0.4.1. The original 0.8.0 remediation plan is
preserved in archive/ru/FIX-PLAN-0.8.0.md. This document is the current checklist.

| Area | Required behavior | Verification |
|---|---|---|
| Playback/session ordering | Desired pause separate from holds; aggregate ads/buffers; revisions/ACKs; per-tab state; one reconnect owner | Controller/Room regressions; real video/Worker fixtures; stale socket and cross-command cases |
| Chat/fullscreen | Single active presentation frame; gesture-time fullscreen; text-safe names/chat; drafts/errors/cooldown | Chromium pointer/keyboard checks across container, video, native control and iframe |
| Friends/privacy | Signed ownership; separate invitation token; serialized writes/acks; revocation and expiry | Independent background/Worker fixtures, forged/expired requests, lifecycle tests |
| Language/appearance | English/Russian/system; in-place selection; unchanged user content; persisted preferences | Unit catalog/placeholder/plural/settings checks and Chromium switching/remount tests |
| Packaging/store | Matching versions/locales, verified default relay, deterministic archive, current screenshots | ZIP CRC/file comparison/digest, server health/JOIN, package/listing confirmation |

Run extension and server verification, then both browser suites. Fixture results
must remain separate from installed-extension acceptance in two actual Chrome
profiles on current target sites, with real ads, autoplay, suspension and sleep.
A previous full Chromium launch failed with spawn UNKNOWN on this Windows host;
this does not prove an administrator policy or a product defect.

Record deployment, GitHub release, store review and public availability independently.
Do not infer any of them from package creation or an upload alone.
