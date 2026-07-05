# Публикация и обновление SyncWatch (Фаза C)

Дистрибуция расширения без «магазинной витрины»: **Chrome Web Store (unlisted)** +
**Firefox AMO (self-distribution)**, артефакты хостятся в **GitHub Releases**.
Сервер (Cloudflare Worker) отдаёт `/version` (баннер «доступно обновление») и
`/updates.json` (автообновление Firefox).

> Замени `strikec71/SyncWatch` на реальный `OWNER/REPO`, если репозиторий назван иначе.
> Ссылка сидит в двух местах: `server/src/index.ts` (`GH_REPO`) и в этом файле.

---

## 0. Разовая настройка

- **Chrome Web Store**: dev-аккаунт (единоразовые $5 уже оплачены).
- **Firefox AMO**: бесплатный аккаунт на <https://addons.mozilla.org>.
- **GitHub**: репозиторий `OWNER/REPO` с включёнными Releases.

Адрес релея синхрона в `extension/src/shared/settings.ts`
(`DEFAULT_SETTINGS.serverUrl`) **намеренно пуст** — общего сервера по умолчанию нет,
каждая группа поднимает свой (см. `docs/SELF_HOST.md`) и вписывает адрес в островок
или получает его из инвайт-ссылки `/join`. Прошитым остаётся только `update_url`
автообновления Firefox (`manifest.firefox.json` → `.../updates.json`) — это релиз-инфра,
а не релей синхрона.

---

## 1. Собрать и упаковать

```bash
cd extension
npm run package        # build (chrome+firefox) + zip'ы в dist/packages/
```

Получишь:

```
dist/packages/syncwatch-chrome-<v>.zip    → Chrome Web Store
dist/packages/syncwatch-firefox-<v>.zip   → Firefox AMO
```

Версия берётся из `manifest.json`. Перед релизом подними её **в обоих манифестах**
(`manifest.json` и `manifest.firefox.json`) — они должны совпадать.

---

## 2. Chrome Web Store (unlisted)

1. <https://chrome.google.com/webstore/devconsole> → **New item**.
2. Загрузи `syncwatch-chrome-<v>.zip`.
3. **Visibility → Unlisted** — расширение не в поиске, доступно только по прямой ссылке.
4. Отправь на ревью. После аппрува ссылка вида `https://chrome.google.com/webstore/detail/<id>`.
5. Обновление: загрузи новый zip с большей версией на ту же карточку — Chrome обновит
   пользователей автоматически (встроенный CWS-автоапдейт).

---

## 3. Firefox AMO (self-distribution) + автообновление

Firefox ставит только подписанные `.xpi`. Подписываем через AMO **без листинга**
(self-distribution), хостим `.xpi` сами (GitHub Releases), обновление гонит `update_url`.

1. <https://addons.mozilla.org/developers/> → **Submit a New Add-on** →
   **On your own site** (self-distribution).
2. Загрузи `syncwatch-firefox-<v>.zip`. AMO проверит и вернёт **подписанный `.xpi`**.
3. Переименуй его в `syncwatch-firefox-<v>.xpi` (имя должно совпасть со ссылкой в
   `/updates.json` — её строит `firefoxUpdatesManifest`).
4. Идентификатор аддона `syncwatch@local` и `update_url` уже в `manifest.firefox.json` —
   ничего вручную не правь.

Как работает автообновление: Firefox периодически опрашивает `update_url`
(`https://syncwatch-signal.strikec71.workers.dev/updates.json`), сравнивает версию с
установленной и, если новее, качает `.xpi` по `update_link` (GitHub Releases).

---

## 4. GitHub Releases (хостинг артефактов)

1. Создай релиз с тегом **`v<version>`** (например `v0.2.0`) — тег обязан совпасть с
   версией: `firefoxUpdatesManifest` строит ссылку `.../download/v<version>/syncwatch-firefox-<version>.xpi`.
2. Приложи ассеты:
   - `syncwatch-firefox-<v>.xpi` (подписанный на шаге 3) — **обязателен** для Firefox-автообновления.
   - (опц.) `syncwatch-chrome-<v>.zip` — как резервная копия/ручная установка.

---

## 5. Дать серверу знать о новой версии (баннер обновления)

Нотификатор (`extension/src/background/notifier.ts`) показывает баннер, когда
`GET /version` > установленной. Поэтому **после** публикации подними константу и
задеплой Worker:

```bash
# server/src/index.ts → const VERSION = '<новая версия>';
cd server
npm run deploy
```

`/updates.json` тоже завязан на `VERSION` — деплой обновит и Firefox-манифест.

Порядок на релиз (важен): опубликуй сборки (CWS/AMO/GitHub) → **потом** бампни
`VERSION` на сервере. Иначе клиенты попросят обновиться раньше, чем артефакт доступен.

---

## Чеклист релиза

```
[ ] Бампнуть version в manifest.json и manifest.firefox.json (одинаково)
[ ] cd extension && npm run typecheck && npm test && npm run package
[ ] Chrome: залить chrome-zip в CWS (Unlisted)
[ ] Firefox: залить firefox-zip в AMO → скачать подписанный .xpi → переименовать
[ ] GitHub: релиз v<version> + приложить syncwatch-firefox-<version>.xpi
[ ] server: VERSION = <version> → npm run deploy
[ ] Проверить: у установленного клиента всплыл баннер обновления
```
