# Self-hosting SyncWatch

Store builds include the SyncWatch relay. You can instead use your own compatible
Cloudflare Worker; everyone in a room must choose the same server. Chrome 120+ and
a consistent current extension version are recommended for all participants.

1. Install Node.js 24 and configure a Cloudflare account.
2. In server/, run npm ci and npm run verify.
3. For local checks, run npm run dev. The address is ws://localhost:8787.
4. For your deployment, sign in with npx wrangler login, inspect wrangler.toml and
   run npm run deploy. Keep the Room/Presence namespaces and migrations intact.
5. Use the resulting HTTPS origin as a wss:// origin in Room → Connection settings.
   Public connections require WSS; WS is limited to localhost/127.0.0.1/::1.
6. Create a room code, Connect, then Invite to room. The toolbar panel is available
   on normal web pages even before a video is found.

Generated watch-... codes have 128 unpredictable bits and grant room access. Do
not publish private codes. Short manual codes can be guessed. The current system
has no accounts, host admission approval or participant removal.

Invitation formats: https://video-site/watch#syncwatch=<code>&s=<encoded-wss-origin>,
marked server /join#r=<code>&s=<origin>, and /r/<code>. Recipients explicitly confirm
the server and room; invitation links do not silently overwrite other tabs.
Server invitation/privacy pages support ?lang=en or ?lang=ru. Browser preference
otherwise chooses Russian for ru locales and English for other locales.

Each tab has its own session. Connect automatically enables recovery from a lost
connection. storage.session restores intentions after background worker suspension;
a full browser restart clears it. Watch solo retains the room/chat with independent
playback. Automatic navigation stays within the video site. For another site,
share a new invitation. Missing episode/audio choices suspend time synchronization.

Room limits: 10 connections, JOIN within 10 seconds, bounded message size/frequency,
and stale-client cleanup. Operators remain responsible for service access, quotas,
costs, logs and policy. These limits are not a complete public-service abuse system.

## Friends and chat

Presence uses its own Durable Object (v2 migration in wrangler.toml). Server 0.4.0+
supports signed friend requests and separate invitation tokens. Both friends use
the same server. Add friend creates a 7-day link; a new link replaces it. Turning
sharing off revokes visibility; disconnected status expires within about 150 seconds.
Friend lists stay local, while the server temporarily processes access-list hashes
and confirmations (until acknowledged or 14 days). Explain this in your privacy policy.

Chat supports 200 characters, one message/second including quick messages, and
50 messages in session memory. No permanent application chat archive is provided.

## Troubleshooting

Reload video pages after installing/updating; Chrome does not inject new scripts
into every existing document automatically. Browser-internal pages and the Web
Store cannot host the panel. Click the player if autoplay is blocked. Test actual
players, cross-origin frames, ads, fullscreen and worker suspension separately.

The chosen operator and Cloudflare process connection metadata and relayed content.
HTTPS/WSS protects transport; end-to-end encryption is not provided. See /privacy
and adapt that policy to your own operation. Language/appearance preferences remain
local and do not change room connections.
