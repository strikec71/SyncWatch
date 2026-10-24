# Deployment and release operations

For version/state evidence see STATUS.md. Extension 0.10.0 uses server 0.4.1;
server changes are limited to localized invitation/privacy pages. Never delete or
rename the Room/Presence Durable Object namespaces or v1/v2 migrations.

## Authorized local release

1. Verify both packages and Chromium UI using Node.js 24.
2. Commit the reviewed sources and record the full SHA. Use authenticated Wrangler
   to deploy server/ with RELEASE_SHA set to that SHA.
3. Run server/scripts/check-deployment.mjs with the HTTPS origin and exact SHA.
   It checks server package version/revision, English privacy, and a disposable
   WebSocket JOIN/host roster. Verify Russian privacy and invitation pages too.
4. Build the extension with SYNCWATCH_SERVER_URL pointing to that verified origin.
   Inspect manifest version, locales, release-config.json, CRC and archive contents.
5. Publish the exact ZIP and SHA256SUMS as GitHub release v0.10.0, targeting the
   committed release source. Do not move an existing tag.
6. Update the existing store item and submit with automatic publication enabled,
   as requested by the owner. Record the actual confirmation and package digest.

Credentials stay in the CLI credential stores/environment and never enter source,
archives, logs or release notes. A local OAuth login does not configure Actions.

## Legacy automated path

The Release SyncWatch workflow verifies, deploys and health-checks the server,
then builds a ZIP with the verified origin and creates a draft GitHub release.
It requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in repository Actions
secrets, and may require production-environment approval if configured by the owner.
The token should be limited to the appropriate Cloudflare account/Workers scope.

Creating a version tag through the GitHub Release API also triggers the tag-push
workflow. For 0.10.0 this legacy run stopped at missing Cloudflare Actions secrets;
the authorized local deployment and public release were verified separately.
Do not infer a failed production deployment from that credential check, or claim
that local OAuth configures CI. Configure durable CI credentials in a separate
authorized setup task before relying on this automated path.

## Version notifier

/healthz identifies deployed server version/revision independently of the store.
/version advertises a published extension version, not the development package or
pending review. Do not announce 0.10.0 before confirming store availability.

## Acceptance limits

Automated tests exercise real Chromium and source modules with extension transport
replaced. They do not replace two-profile installed-extension checks on current
video sites, ads, iframe permissions, autoplay, worker suspension and long sleep.
Deployment success requires the returned revision and successful live checks;
package creation alone is not deployment or store approval.
