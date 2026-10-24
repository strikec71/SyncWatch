# SyncWatch development specification

Current extension: **0.10.0**, Glass Lounge with English/Russian language selection.
Current server: **0.4.1**, localized invitation/privacy pages; room and presence
protocols remain compatible. See docs/releases/STATUS.md for actual deployment,
GitHub release and Chrome Web Store state. Uploaded or submitted is not published.

SyncWatch synchronizes HTML video for up to 10 participants. Video/audio stay at
the original site. Release packages embed the verified SyncWatch Cloudflare relay;
users may choose their own. Existing server preferences are never replaced.

## Commands

Use Node.js 24; run npm ci separately in extension/ and server/.

- extension: npm run verify; npm run build; npm run test:browser.
- extension: npm run package requires Info-ZIP and verifies versions/types/tests.
- server: npm run verify; npm run dev for ws://localhost:8787.
- server: npm run deploy only within an authorized deployment task.

Read README.md, docs/LOCALIZATION.md, docs/SELF_HOST.md and docs/PUBLISHING.md.
Historical audits are evidence about old revisions, not the current specification.

## Architecture

content/player.ts owns one active video per frame. Universal detection traverses
open shadow roots; adapters.ts supports YouTube, jut.su, PlayerJS, Kodik and Alloha.
Current real sites must be tested separately from fixtures.

background/state.ts owns sessions keyed by tabId: room, server, roster, active frame,
mode and revision. Global preferences are defaults; never overwrite an active tab's
room/server with another tab's defaults. persistence.ts stores intentions in
storage.session across worker suspension; full browser restart clears that storage.

connection.ts owns connecting/joined/retrying/error/idle/disconnected phases.
WebSocket open is not confirmed JOIN. Backoff resets after ROSTER. Full rooms and
protocol failures must not retry forever. Old socket events cannot alter a newer
session. Background owns reconnect; UI only displays state and explicit actions.

sync.ts relays ordered commands/snapshots. roster.ts aggregates all non-detached
participants' buffer/ad holds and clears them on departure/disconnect/mode changes.
The Room Durable Object requires JOIN within 10 seconds, limits frequency/size and
removes stale clients with an independent alarm before checking capacity.

## Synchronization invariants

1. Server revisions and acknowledgements order STATE/NAV, including simultaneous
   optimistic actions. Never order clients using their wall clocks. Server rewrites
   sender and revision.
2. Up to two participants share control; at three or more, host/controller manages
   playback. Any participant can request pause; pauseOnly never changes time/speed.
3. Desired playback is separate from technical holds. Finishing buffering or ads
   cannot undo a manual pause or another participant's outstanding hold.
4. Remote commands and drift correction do not echo. Snapshots restore time, pause
   and base speed; temporary nudger speed is not a new base rate.
5. Advertisements are not content timelines: do not apply or snapshot content STATE
   against an ad. The latest state waits until the local ad ends.
6. Block time commands on content mismatch or during navigation. Missing episode/
   audio selection sets contentMismatch instead of seeking on the wrong content.
7. Readiness is reported for each source, even with a reused video. video-ready
   identifies its own frame and does not depend on presence event ordering.
8. A directed snapshot retains its request revision; stale asynchronous reads must
   not be promoted to a newer revision.

## UI and localization

The panel uses closed Shadow DOM. overlay-shell.ts manages tabs/appearance;
shared/appearance.ts normalizes preferences; content/appearance.ts applies shared
tokens to the panel, banners, bubbles and wheel. The mini launcher is 52px.

Language selection is en/ru/system, persisted through the existing background
writer. Russian browser locales resolve to Russian; all others use English.
Use shared/i18n.ts and its bundled catalog. Translate only application text;
user names/chat/URLs/codes stay verbatim and are inserted as textContent.
Only initial trusted template nodes are bound for in-place updates. Do not rebuild
an active panel or clear drafts/unread state when language changes. Appearance
reset preserves language and connection preferences. See docs/LOCALIZATION.md.

fullscreen.ts is a MAIN-world document_start entry without extension API/session
access. It redirects video/iframe fullscreen into an existing container during the
original gesture and restores styles on exit. native-fullscreen.ts supplies the
small mouse/keyboard-accessible button and accepts only a public locale event.
content/ui.ts chooses the top document normally and active leaf frame in fullscreen.
floating-layer.ts moves/restacks popover hosts; passive updates go to all frames,
player commands to the active frame only. Respect system reduced motion.

## Invitations, friends, chat and privacy

Generated watch-<32 hex> room codes contain 128 random bits and are access secrets.
Short manual codes are open/guessable. There are no accounts, passwords, host entry
approval or participant removal. Invitation entry requires explicit confirmation
of server/room; links cannot silently replace defaults in other tabs. Formats are
video#syncwatch=...&s=..., marked /join#r=...&s=..., and /r/<code>.

Automatic navigation stays on the viewing origin; leaving it enables solo mode.
New non-video pages are not broadcast. Strip known auth/tracking parameters and
fragments while preserving content parameters; this is not universal secret detection.

Chat is limited to 200 characters, one message/second across text/quick messages,
and 50 messages in session memory. Failed sends preserve drafts and are not logged.
Quick-message autopause sends pauseOnly, never an ad timeline; solo pause is local.

Presence identity is a SHA-256 public P-256 key ID. Requests are signed with server,
body, timestamp and nonce binding. The private key stays local. Separate friend
invitation tokens last 7 days; new tokens replace old. Mutations/acks serialize to
prevent lost writes or re-adding removed friends. Status TTL is 150 seconds;
confirmations live until ack or 14 days. Server-visible access-list hashes do not
hide the social graph from its operator. Disabling sharing revokes presence.

Privacy must disclose URLs, content choices, room codes, names, chat, presence and
server/Cloudflare processing. HTTPS/WSS is transport encryption, not end-to-end.

## Releases

All browser API access uses shared/browser.ts. Check types/tests before packaging;
CI checks extension, server and real Chromium separately. Browser fixtures replace
transport and do not establish installed-extension/live-site acceptance.

Do not move old tags. Publish the reviewed ZIP and SHA256SUMS against the exact
release source. Keep GitHub release, server deployment, store review and store
availability distinct. The owner requested automatic store publication for 0.10.0.
Update the server's published-version notifier only after a build is available in
the Chrome Web Store; /version is advisory, Chrome handles extension updates.
