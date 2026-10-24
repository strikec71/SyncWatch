# Verification results and limits

Current release work: extension 0.10.0, server 0.4.1. The full original 0.8.0
remediation narrative is preserved in archive/ru/FIX-RESULTS-0.8.0.md. The historical
0.6.0 audit remains indexed in AUDIT-2026-10-24.md. Current release/deployment/store
evidence is recorded in releases/STATUS.md.

## Current automated coverage

- Extension TypeScript and 356 unit/regression checks: playback ordering, settings,
  protocol validation, chat, friends, presence, appearance and localization.
- Server TypeScript and 73 checks: Room/Presence logic, lifecycle, update channel,
  health metadata and localized public pages.
- Chromium fullscreen suite: 34 real pointer/keyboard/video checks across container,
  video, native controls and iframe presentation, drafts, focus and safe text.
- Chromium design/localization suite: 22 checks for roster/roles, launcher/unread,
  keyboard tabs, appearance persistence/reset, viewport bounds, reduced motion,
  English switching, drafts, unchanged user text, local quick phrases and remounting.

Test definitions and CI must be consulted for the actual outcome of the current
commit; counts alone do not establish a successful run. Browser fixtures execute
real source modules and real Chromium, replacing extension transport. Store images
show the actual UI with illustrative room data, not recorded live user sessions.

## Earlier remediation

Playback now separates manual intent from technical holds, aggregates all peers,
orders commands using server revisions and acknowledges senders. Snapshot rate,
source readiness, ad timelines and pauseOnly permissions have explicit guards.
Tabs retain independent room/server intent across background suspension. Reconnect
owns generation checks, confirmed JOIN, bounded backoff and idle behavior.

Chat preserves failed drafts and treats names/messages as text. Fullscreen uses a
container selected inside the original gesture, including an accessible native
video control. Only the active presentation frame displays UI; commands still go
to the active player frame. Friend presence uses signed installation ownership,
separate expiring tokens, serialized writes/confirmations, revocation and alarms.
Privacy discloses server-visible URLs, chat, identifiers and access lists.

## Practical limits

Installed-extension acceptance on current YouTube/Kodik/Alloha/other sites, real
ads, autoplay policies, iframe restrictions, MV3 suspension and long sleep remains
separate. A full Chromium startup attempt on this Windows host failed with spawn
UNKNOWN; the headless source-module fixtures work. Do not describe that launch
error as proof of an administrator ban or as an extension failure.

Room codes grant access; short manually chosen codes can be guessed. There are no
accounts, host admission approval or kick controls. Presence signatures prove an
installation, not a person's real identity. The chosen relay can read relayed data;
access-list hashing does not hide the social graph from the server operator.

Future work includes regular live-site acceptance, stronger access controls if
private communities require them, operational limits/log policy for a public relay,
and a separately tested development-tooling dependency update. A previous server
audit reported three Wrangler/Miniflare/undici development vulnerabilities; none
should be called resolved without a new audit and compatible dependency update.
