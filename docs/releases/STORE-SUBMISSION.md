# Chrome Web Store submission materials — 0.10.0

Primary listing: English, with a maintained Russian translation. Copy is in
../store/0.10.0/description-en.txt and description-ru.txt. Five current 1280 × 800
screenshots in the same folder show actual UI modules with illustrative room data.
The owner requested review and **automatic publication after approval**.

## Single purpose

Synchronize HTML video playback for a room of up to 10 people, with room chat,
quick messages and friend presence supporting the shared viewing session. Video
and audio stay on the source site; no media library is supplied.

## Permissions and remote code

- storage: language/appearance and connection preferences, installation identity,
  local friends/requests/acknowledgements; storage.session restores tab intentions
  after background suspension.
- alarms: connection maintenance/retry, update checks and periodic presence.
- All websites/frames: detect and control HTML video on arbitrary viewing pages
  and cross-origin player frames. Sync URLs only for connected sessions. The relay
  is configurable; the domain/player list cannot be fixed in advance.
- Bundled MAIN-world script: gesture-time fullscreen and the native video control.
  It receives only a public locale value; no extension APIs, private keys, room
  settings or messages. Other extension logic runs in the isolated world with
  closed-shadow UI.
- No remote executable code, translation service, analytics or trackers. HTTP and
  WebSocket carry data, not code. No additional permissions were added in 0.10.0.

## Data disclosure

| Processing | Store disclosure |
|---|---|
| Viewing URL and episode/season/audio choice | Web history/site content; disclose relay/room transmission despite no history API permission |
| Chat and quick messages | Personal communications; no permanent server chat archive |
| Chosen display name and public installation ID/key | Personally identifying/pseudonymous information; no account or email required |
| Secret room code and signed friend authorization | Authentication data; private installation key remains local |
| Play/pause/seek/rate, buffering/ads and presence | User activity necessary to synchronization/presence |
| Friend access-list hashes and confirmations | Temporary relay processing; status TTL 150 seconds, tokens 7 days, acknowledgements up to 14 days |

Keep the six applicable form categories selected: personally identifiable
information, authentication information, personal communications, web history,
user activity and website content. Medical, financial and precise location data
are not requested. Confirm the existing limited-use certifications accurately.

HTTPS/WSS protects transport; do not claim end-to-end encryption. The selected
operator and Cloudflare process relayed data/network connections under their
operating policies. No sale or advertising/creditworthiness use.

Privacy: https://syncwatch-signal.strikec71.workers.dev/privacy?lang=en
Russian: https://syncwatch-signal.strikec71.workers.dev/privacy?lang=ru

## Reviewer instructions

No SyncWatch account/payment. Chrome 120+, two profiles, same HTML video. Relay:
wss://syncwatch-signal.strikec71.workers.dev. Create/connect a room and open its
invite in profile 2; confirm entry. Test play/pause/seek, chat, fullscreen (native
video: small ⛶ control), Friends → Add friend, and Style → Language. Both profiles
use the same relay. If autoplay blocks playback, click Play. Privacy URL above.

The dashboard's short instructions field has a 500-character limit; use a compact
version without real-user room codes or credentials. Submission must be confirmed
by the dashboard, not inferred from uploading the ZIP.
