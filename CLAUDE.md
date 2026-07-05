# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Что это

SyncWatch — лёгкая система совместного просмотра видео в реальном времени **до 10
человек** (Фаза A/B; изначально были двое). Своей медиабазы нет; мы — гости на чужих
сайтах (YouTube, Kinogo, пиратские плееры на базе Кинопоиска вроде `smotvibe.lol`,
`jut.su`/аниме-площадки). Картинку/звук НЕ стримим — синхронизируем только команды
плеера (play/pause/seek), создавая «иллюзию одного экрана». Комнаты — именные
коды-ссылки без аккаунтов и паролей. **Дистрибуция (Фаза C):** Chrome Web Store
**unlisted** (по ссылке, не в поиске) + Firefox AMO **self-distribution** (подписанный
`.xpi` с автообновлением); Developer Mode (Load unpacked) остаётся для разработки.
Подробности релиза — `docs/PUBLISHING.md`. Инфраструктура бесплатная.

## Команды

### Расширение (`extension/`)
```bash
cd extension
npm install
npm run build          # бандлит src/ → dist/chrome И dist/firefox (esbuild)
npm run build:chrome   # только Chrome → dist/chrome
npm run build:firefox  # только Firefox → dist/firefox
npm run watch          # пересборка Chrome по изменениям
npm run typecheck      # tsc --noEmit
npm run package        # build + store-ready zip'ы в dist/packages/ (Фаза C, см. docs/PUBLISHING.md)
```
**Chrome:** `chrome://extensions` → Developer Mode → **Load unpacked** →
`extension/dist/chrome`. После `npm run build` жать «Обновить» на карточке.
**Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
`extension/dist/firefox/manifest.json` (снимается при перезапуске — аналог dev-mode;
для постоянной установки нужна бесплатная самоподпись через AMO → signed `.xpi`).
В Firefox MV3 host-permissions опциональны: при необходимости выдать доступ вручную.

### Сервер (`server/`) — Cloudflare Worker + Durable Object
```bash
cd server
npm install
npm run dev          # wrangler dev (локальный сервер на http://localhost:8787)
npm run deploy       # wrangler deploy (нужен `wrangler login`)
```
Адрес вида `wss://syncwatch-signal.<subdomain>.workers.dev` уже прошит в
`shared/settings.ts` (`DEFAULT_SETTINGS.serverUrl`); поле «Сервер» в островке («Ещё»)
трогать не нужно. Локально для теста: `ws://localhost:8787`.

## Архитектура

Монорепо из двух независимо собираемых пакетов: `extension/` и `server/`.

### Поток синхронизации
```
content (фрейм с <video>) → background (хаб, WS) → DO Room → background партнёра → content партнёра
```

### Сервер — чистый релей
- `server/src/index.ts` — Worker: WS-upgrade маршрутизируется в Durable Object по
  room-коду из пути `/room/<code>`.
- `server/src/room.ts` — DO `Room`: держит ≤2 сокета, **просто пересылает** любое
  сообщение второму участнику и сам генерирует `PEER joined/left`. Логику плеера не знает.
- Durable Object объявлен через `new_sqlite_classes` (это форма, доступная на
  **бесплатном** тарифе Workers; storage мы не используем).

### Расширение (MV3, TypeScript)
- **`src/background/index.ts` — ХАБ.** Единственный `WebSocket` живёт здесь, а не в
  content-скрипте. Причина: целевые сайты прячут плеер в **кросс-доменных iframe**;
  content-скрипты (`all_frames`) между собой кросс-домен не общаются, но каждый шлёт
  сообщения в background. Хаб выбирает «активный» фрейм (последний приславший реальное
  событие плеера) и шлёт ему удалённые команды через `chrome.tabs.sendMessage(...,{frameId})`.
  Засыпание SW в MV3 гасится keepalive-пингом (`PING`) по `chrome.alarms` (~24с).
  ⚠️ **Все обработчики WebSocket гейтятся `session.ws !== ws`** — события устаревшего
  сокета (после реконнекта/повторного connect) не должны трогать `session`, иначе
  поздний `close` старого сокета обнуляет новый → «сокет-зомби» (приём жив, отправка
  мертва). Это был критический баг асимметричной синхронизации.
- **`src/content/player.ts`** — детект `<video>`: сначала сайт-специфичный адаптер
  (`content/adapters.ts`), при `null` — универсальная эвристика (`MutationObserver` +
  поллинг + deep-поиск сквозь shadow DOM + «играет / самое большое»). Захват
  `play/pause/seeked/ratechange`, применение удалённых команд.
- **`src/content/adapters.ts`** — реестр оверрайдов: `youtube` (берёт `.html5-main-video`),
  `jut.su`, `playerjs` (Video.js/PlayerJS «балансеров» Kinogo/smotvibe — матч по
  **DOM-сигнатуре**, т.к. домен iframe неизвестен). Адаптер возвращает `null` →
  мягкий откат к универсальному поиску. Новые сайты добавляй сюда же.
- **`src/content/index.ts`** — точка входа во всех фреймах; в верхнем фрейме монтирует
  островок (по настройке `overlayEnabled`, реагирует на `storage.onChanged` — живой
  показ/скрытие) и обрабатывает инвайт-ссылку.
- **`src/content/invite.ts`** — инвайт-ссылки (Фаза 4): читает `#r=код&s=сервер`
  (страница `/join`) или `#syncwatch=код` (любой URL) → сохраняет настройки и шлёт
  `connect`. Только верхний фрейм; после применения чистит хэш.
- **`src/content/overlay.ts`** — островок: **единственный UI расширения** (popup
  удалён). Плавающий виджет в **Shadow DOM**, верхний фрейм, перетаскиваемый. Содержит
  все функции: комната + «Создать», подключение, инвайт-ссылки («Приглашение» = `/join`,
  «Ссылка на видео» = `location.href#syncwatch`), тумблер авто-коннект,
  «Ещё» (имя устройства, сервер, порог). **Сворачиваемый** (▾/▸, `localStorage`).
  **Крестика нет** — показ/скрытие острова делает тумблер на иконке расширения
  (`action.onClicked` в background → переключает `overlayEnabled`). Статус
  **опрашивает** (`get-status`); события background **пушит** через
  `tabs.sendMessage(tabId,{frameId:0})` → `runtime.onMessage` (`kind:'event'`).
  События показываются **тостами** (видны в любом состоянии, гаснут ~3.5с) + раздел
  **«История»** (виден в развёрнутом). Показывает **имена устройств** (своё
  редактируемое + партнёра из `HELLO`); реальный hostname браузеру недоступен.
- **`src/shared/browser.ts`** — единый promisified API для Chrome и Firefox: реэкспорт
  `webextension-polyfill`, типизированный как `typeof chrome`. **Везде в коде —
  `browser.*` (не `chrome.*`)**; полифилл даёт промисы в обоих браузерах.
  *(Popup удалён — весь UI в островке; ролей в UI нет, права у участников равные.)*

### Два важных инварианта
1. **Гашение эха (двойная защита).** Удалённую команду применяем под флагом
   `isApplyingRemote` (в `player.ts`) — события, которые она порождает, не транслируются
   обратно. Страховка на уровне хаба (`background/index.ts`): сверка с `lastSync` по
   `ECHO_EPSILON`. Без этого система зацикливается (A→B→A→…).
2. **Активный фрейм.** `session.tabId/frameId` в хабе указывают, куда слать команды.
   Обновляется на каждом `player-event` от content-скрипта. Поэтому на странице с
   несколькими `<video>`/iframe «ведущим» становится тот, где реально шло действие.
3. **Равные права + опорный клиент дрейфа.** Команды play/pause/seek/rate **симметричны**:
   любой участник управляет, у второго применяется (`onPlayerEvent → STATE →
   broadcastExcept`). Ролей master/slave НЕТ. Непрерывную коррекцию дрейфа делает один
   **опорный клиент**, выбранный автоматически и скрыто: при появлении партнёра пиры
   обмениваются `HELLO`-`id` (случайный per-connection), выше id → опорный
   (`session.isDriftRef`, `recomputeDriftRef`). Только опорный шлёт `BEAT`; остальные
   правят свою позицию. Опорный неподвижен → нет осцилляции. Это влияет ТОЛЬКО на
   фоновое выравнивание времени, не на права управления.
4. **last-writer-wins (политика рассинхрона).** play/pause/seek/rate — **последнее
   побеждает**: локальное действие просто транслируем (`onPlay/onPause → emit`), удалённое
   применяем напрямую в `applyRemote` под `isApplyingRemote` (гашение эха). Ролей/приоритета
   нет — любой play/pause применяется у обоих. *(Раньше была «пауза в приоритете» с
   `updatePlayback()`/`localPauseIntent`/`peerPaused` — удалена: двусторонний жёсткий блок
   давал сетевой пинг-понг play↔pause ~1 fps, т.к. `currentTime` дрейфовал и анти-эхо хаба
   не совпадало.)* **Транзитные холды** буфера/рекламы остаются (`pausedByPeerBuffer`,
   `pausedByPeerAd`, `isAdActive`): пока партнёр буферизуется/смотрит рекламу — мы на паузе
   (`applyHold`, `heldByPeer`), не играем сквозь холд; по снятию — возобновляем. Это
   одностороннее ожидание ждущего, не драка. Остаток рассинхрона добивает дрейф. **Синк при
   входе:** опорный пушит новичку снимок (`get-snapshot`→`pushStateToPeer`).

### Протоколы — не путать
- `src/shared/protocol.ts` — формат сообщений **поверх WebSocket** (`JOIN/STATE/PEER/
  BUFFER/BEAT`). Концептуально общий с сервером.
- `src/shared/messages.ts` — **внутренние** сообщения `chrome.runtime` между
  content/background/popup (`player-event/apply/connect/status/…`).

## Состояние и роадмап

Реализованы **Фазы 1–6** (базовый синхрон на двоих) и **Фазы A/B/C** (масштаб до 10
человек + именные комнаты + дистрибуция). `host_permissions`/`matches` = `<all_urls>`
(осознанно: универсальный детект + неизвестные заранее домены iframe пиратских плееров).

- **Фаза 1 (MVP):** релей-сервер, детект плеера, симметричная синхронизация
  play/pause/seek/rate с гашением эха, popup с подключением.
- **Фаза 2 (устойчивость к лагам):**
  - Пауза по буферизации: `waiting`/`stalled` → партнёр на паузу, `playing` → снятие.
    Логика в `player.ts` (`onWaiting`/`onPlaying`/`applyBufferControl`), релей через
    `BUFFER` в хабе.
  - Heartbeat коррекции дрейфа: **content-скрипт** шлёт `beat` каждые ~3с (не
    `chrome.alarms` — там минимум 30с). Опорный клиент ретранслирует как `BEAT`,
    остальные правят свою позицию (`applyDriftCorrection`) при дрейфе > `driftThreshold`.
    Корректирует только не-опорный → нет осцилляции. ⚠️ **`target = currentTime` напрямую,
    БЕЗ компенсации по `ts`.** `ts` — стенные часы ДРУГОЙ машины; часы двух ПК не синхронны
    (рассинхрон в секунды — норма), и «компенсация» `(Date.now()-ts)` вносила перекос часов
    прямо в позицию → откаты на 5–7с каждым биением. Реальная сетевая задержка (доли сек)
    покрыта `threshold`. Никогда не считать позицию через кросс-машинные таймстемпы.
  - Keepalive переведён с `BEAT` на `PING` (иначе вызывал бы ложную коррекцию).
- **Фаза 3:**
  - ✅ **Авто-выбор опорного клиента дрейфа (без ролей).** При появлении партнёра пиры
    обмениваются `HELLO`-`id` (случайный `Math.random()` per-connection), выше id →
    опорный (`recomputeDriftRef`/`sendHello` в `background/index.ts`,
    `session.isDriftRef`). Ничья (строгое `>`, ≈невозможна на float) → оба не опорные
    (безопасно: дрейф временно не правится). **Master/slave и ручной выбор роли удалены**
    (равные права) — опорный клиент невидим в UI и влияет только на коррекцию дрейфа.
  - ❌ **Кастомный AdBlocker — удалён.** Не изобретаем велосипед: блокировку рекламы
    отдаём внешним расширениям (uBlock Origin и т.п.). Удалены `content/adblock.ts`,
    `rules/ads.json`, разрешение `declarativeNetRequest`, настройка `adMode` и тумблер.
    **Sync-aware пауза на рекламе оставлена** (см. ниже) — это фича синхрона, не блокировщик.

  - ✅ **Сайт-специфичные оверрайды детекта плеера** (`content/adapters.ts`):
    адаптеры `youtube`/`jut.su`/`playerjs` + проникновение в shadow DOM в
    универсальном фолбэке. Мягкая деградация: нет адаптера или вернул `null` →
    универсальная эвристика.
  - ✅ **Sync-aware поведение во время рекламы.** Адаптер детектит рекламу
    (`SiteAdapter.isAd`; для YouTube — класс `.ad-showing`/`.ad-interrupting`).
    `player.ts` опрашивает каждые 500мс: при входе/выходе из рекламы шлёт `ad` →
    хаб релеит `AD` партнёру → у партнёра `applyAdControl` ставит/снимает паузу
    контента (флаг `pausedByPeerAd`, под `isApplyingRemote`). Пока у нас своя реклама,
    локальные `emit`/`beat`/`buffering` подавлены (`isAdActive`), а входящие
    buffer/drift/ad-паузы игнорируются — чтобы не уносить ad-таймлайн в синхрон и не
    трогать чужую/свою рекламу. По окончании рекламы контент-события возобновляются
    естественно, дрейф добивает остаточный рассинхрон.

- **Фаза 4 (подключение в один клик):**
  - ✅ **Инвайт-ссылки.** Сервер отдаёт страницу `/join` (`server/src/index.ts`);
    `content/invite.ts` ловит `#r=код&s=сервер` на ней ИЛИ `#syncwatch=код` на любом
    URL → сохраняет настройки и подключается. В popup — «Создать комнату» (случайный
    код) и копирование двух ссылок (универсальной `/join` и на текущее видео).
  - ✅ **Авто-подключение и авто-реконнект.** Настройка `autoConnect` (дефолт `true`):
    background поднимает соединение в `onStartup`/`onInstalled` и переподключается при
    обрыве WS с нарастающей задержкой (`RECONNECT_DELAYS`). Ручной `disconnect`
    ставит `intentionalClose` → реконнекта нет. Бэкофф сбрасывается на успешном `open`.
  - ⚠️ `DEFAULT_SETTINGS.serverUrl` в `shared/settings.ts` — **единственная точка**,
    куда прошивается реальный адрес сервера после деплоя; тогда поле «Сервер» не трогают.
- **Фаза 5 (внутристраничный оверлей):**
  - ✅ `content/overlay.ts` — Shadow-DOM-панель в верхнем фрейме (статус/коннект/✕,
    перетаскивание). ✕ прячет до перезагрузки (флаг в `sessionStorage`). Тумблер
    `overlayEnabled` (дефолт `true`). Решение не exe: нативный бинарник не убирает
    расширение (DOM-инъекция в чужие страницы) — оверлей даёт тот же UX внутри расширения.
- **Фаза 6 (Firefox):**
  - ✅ **Две сборки.** `esbuild.config.mjs` собирает `dist/chrome` (manifest.json) и
    `dist/firefox` (`manifest.firefox.json`: `background.scripts` + `browser_specific_settings.gecko`).
  - ✅ **Namespace.** Весь код через `shared/browser.ts` (`webextension-polyfill`,
    промисы в обоих браузерах). Keepalive-alarm `~0.4 мин` каждый браузер клампит к
    своему минимуму (Chrome ~0.5, Firefox ~1); пробелы добивает авто-реконнект Фазы 4.

- **Фаза 7 (центральный статус-баннер):**
  - ✅ **Центральный статус-баннер** (`content/banner.ts`, `StatusBanner`) — дышащая
    плашка по центру сверху (popover/top-layer, виден в фуллскрине), отражает состояние
    партнёра: пауза / буфер / реклама (`📺 … M:SS`, **count-up** от детекта старта).
    Состояние считает **хаб** (`recomputeBanner`, приоритет реклама>буфер>пауза) из
    входящих `STATE.paused`/`AD`/`BUFFER` и пушит структуру в `frameId:0`; текст и таймер
    баннер крутит локально. Только верхний фрейм, **не зависит от** `overlayEnabled`. При
    last-writer `peer-paused` снимается, как только МЫ сами жмём play/pause (`onPlayerEvent`
    сбрасывает `session.peerPaused`), иначе баннер «партнёр на паузе» завис бы.
  - ⚠️ **inset-ловушка попавера.** В инлайн-`cssText` островка/баннера `inset:auto` ДОЛЖЕН
    стоять ДО `top/right/left` — иначе шорткат `inset` затирает офсеты и элемент уезжает в
    левый верхний угол (и теряет кликабельность в фуллскрине).
  - ❌ **Лазерный курсор/«Указка» — удалён.** Двусторонняя трансляция курсора убрана по
    просьбе (отвлекала); статус-баннер оставлен. (`content/cursor.ts`, `CURSOR`,
    `pointer-mode`/`pointer-toggle` удалены.)

### Масштаб 2→10 человек (Фазы A/B/C)

- **Фаза A (фундамент):** **roster-протокол** — сервер `Room` держит до `MAX_PEERS=10`
  сокетов, ведёт список участников (`connId`, инъекция `from` в сообщения), выбирает
  **host** (host-election) и гейтит права. Хаб расщеплён на модули
  `background/{index,state,connection,roster,sync,notifier}.ts` (все <500 строк),
  hardened reconnect + watchdog, vitest.
- **Фаза B (UI):** roster-список в островке; кнопки **Соло/Синхрон** (выйти из
  синхрона / вернуться), **Контроль** (host выдаёт право управления), **Запросить**
  (гость просит контроль); нотификатор обновлений. CSS/HTML островка вынесены в
  `overlay-template.ts` (файлы <500 строк). **Имена — только `textContent`** (XSS-гейт).
- **Фаза C (дистрибуция + онлайн-обновление):**
  - ✅ **Chrome Web Store unlisted** (встроенный автоапдейт CWS) + **Firefox AMO
    self-distribution** (подписанный `.xpi`).
  - ✅ **Firefox автообновление:** `update_url` в `manifest.firefox.json` →
    `${server}/updates.json`; Worker строит манифест (`firefoxUpdatesManifest`,
    версия → ссылка на `.xpi` в GitHub Releases).
  - ✅ **Нотификатор обновлений:** `background/notifier.ts` опрашивает `GET /version`
    (сервер отдаёт «последнюю опубликованную» версию); при `semverGt(remote, local)`
    пушит баннер. Авто-скачивания в MV3 нет.
  - ✅ **`npm run package`** (`extension/scripts/package.mjs`) — store-ready zip'ы
    из `dist/chrome`/`dist/firefox` в `dist/packages/`.
  - ✅ **`docs/PUBLISHING.md`** — полный чеклист релиза (CWS/AMO/GitHub Releases +
    бамп `VERSION` на сервере после публикации).

### Гибрид-управление (право play/pause/seek)

- **≤2 участника:** симметрично, **last-writer-wins** — любой управляет, у остальных
  применяется (как в Фазах 1–6).
- **≥3 участника:** включаются **права host**; управлять могут host + те, кому host
  **выдал контроль** («Контроль»); гость просит через «Запросить». **Пауза/стоп
  доступны любому всегда** (safety). Гейтинг в 3 слоя: UI / хаб / сервер (`canSendState`).
- **Соло/Синхрон:** участник может временно выйти из синхрона (смотреть один) и
  вернуться — при возврате получает снимок состояния.

Дальше (опционально):
- Новые адаптеры в `adapters.ts` (включая `isAd` для не-YouTube плееров).
- Возможное расширение лимита участников выше 10.

## Кросс-браузерность
Chrome (MV3) и Firefox (MV3) поддержаны через `shared/browser.ts`
(`webextension-polyfill`, `browser.*`) и два манифеста. offscreen-документ НЕ
используется намеренно — схема «WS в SW/event-page + alarms» совместима с обоими.
Firefox: временная загрузка через `about:debugging`; host-permissions опциональны
(при необходимости выдать вручную); постоянная установка — signed `.xpi` через AMO.
