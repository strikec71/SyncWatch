# Localization

SyncWatch 0.10.0 supports English and Russian across the panel, room roster,
connection settings, chat, friends, invitations, quick messages, banners, errors,
tooltips and native fullscreen control. Browser metadata is localized separately
using Chrome's `_locales/en` and `_locales/ru` catalogs; `default_locale` is `en`.

## Saved selection

`settings.language` is `en`, `ru` or `system`. Missing or invalid values normalize
to `system` for existing installations. Russian browser language variants use
Russian; other languages fall back to English. Selection is global to the installation,
while rooms and relay connections remain per tab.

Changing language uses the existing serialized background settings writer.
Open panels update in place. Appearance reset does not reset the language.
The extension does not translate names, room codes, URLs or user-entered messages.
Quick messages are sent as stable codes and translated when rendered by recipients.

## Implementation

- `extension/src/shared/translations.ts` maps original Russian interface keys to
  English. Both catalogs ship inside the ZIP; no translation service is contacted.
- `shared/i18n.ts` resolves language, formats positional parameters and provides
  change subscriptions. Tagged `tr` templates keep interpolated user data separate
  from catalog text. Preserve every numbered placeholder when adding translations.
- `bindTemplateLanguage` binds only the initial trusted shadow template before
  user data is inserted. It updates registered text/attributes and the CSS empty
  state. It never scans or rewrites subsequent chat or roster content.
- Dynamic roster/status/friend/chat rendering uses `tr` at render time. Quick-message
  getters follow the current language. Switching preserves drafts and unread counts.
- The MAIN-world fullscreen button receives only an `en`/`ru` public locale event;
  it has no extension APIs, private keys, settings or session data. That event cannot
  trigger privileged actions.
- Server invitation and privacy pages support `?lang=en` and `?lang=ru`, otherwise
  the first browser language is used with English fallback. Language links preserve
  invitation fragments locally in the browser.

## Checks

Run `npm run verify` and `npm run test:browser` in `extension/`, plus `npm run verify`
in `server/`. Unit tests cover normalization, placeholder parity, plurals, quick
messages, subscriptions and settings migration. Browser checks exercise live
switching, persistence, drafts, unchanged user text, friends and remounting.

To regenerate the English store screenshots, set `STORE_SCREENSHOTS` to an output
directory before running `node docs/audit/design-check.mjs` from the repository root.
They show the actual UI modules with illustrative data and substituted extension
transport. All images are 1280 × 800. They are not evidence of live-site acceptance.
