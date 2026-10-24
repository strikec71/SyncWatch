// Localized server pages. Language links keep the URL fragment (invitation secret) in the browser.
type PageLanguage = 'en' | 'ru';
const navigation = '<nav aria-label="Language"><a href="?lang=en" lang="en">English</a> · <a href="?lang=ru" lang="ru">Русский</a></nav>';
const keepInvitation = '<script>document.querySelectorAll("nav a").forEach(a=>{a.hash=location.hash})</script>';
const style = '<style>:root{color-scheme:light dark}body{font:16px/1.65 system-ui,sans-serif;max-width:740px;margin:7vh auto;padding:0 24px}h1{font-size:28px;line-height:1.2}h2{font-size:19px;margin-top:32px}nav{font-size:13px;margin-bottom:28px}a{color:#9583df}code{background:#8882;padding:2px 5px;border-radius:5px}.muted{opacity:.75;font-size:14px}li{margin:8px 0}</style>';
function page(title: string, content: string, invite = false): string {
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${invite ? '<meta name="syncwatch-invite" content="1">' : ''}${style}</head><body>${navigation}${content}${keepInvitation}</body></html>`;
}
export function joinPage(slug: string | null, language: PageLanguage): string {
 if (language === 'ru') return joinPageRu(slug);
 return page('SyncWatch — room invitation', `<h1>You’re invited to watch together.</h1>${slug ? `<p>Room: <code>${esc(slug)}</code></p>` : ''}<p>If SyncWatch is installed, choose <strong>Join room</strong> on the invitation card. It shows the server and room before you connect.</p><p>Open the extension’s panel from its toolbar icon. Your chosen language applies to the invitation card too.</p><p>Nothing appeared? <a href="https://chromewebstore.google.com/detail/mincjbhfhimdgnjjonocoogphjgkfffm">Install SyncWatch from the Chrome Web Store</a>, then reopen this invitation. Reload pages after updating the extension.</p><p class="muted">Chrome 120+. Everyone needs access to the original video. SyncWatch synchronizes commands; it does not stream or provide films.</p>`, true);
}
export function privacyPage(language: PageLanguage): string {
 if (language === 'ru') return privacyPageRu();
 return page('SyncWatch — Privacy policy', `<h1>SyncWatch Privacy Policy</h1><p class="muted">Updated 25 October 2026</p>
<p>SyncWatch synchronizes HTML video playback, pause, seeking, speed and content selection between participants in a room. It has no media library and does not transmit video or audio.</p>
<h2>Data used for shared viewing</h2><p>The selected relay server and room participants process:</p><ul>
<li>The room’s secret access code.</li><li>The viewing-page URL, including parameters needed for content selection, and the selected episode, season and audio track.</li><li>The display name you choose, which can be a nickname.</li><li>Playback, pause, seeking position, speed, buffering and advertisement events.</li><li>Quick messages and text you send in chat (up to 200 characters).</li><li>A temporary connection identifier, regenerated when you connect.</li></ul>
<p>These data pass through the relay to synchronize the room. HTTPS/WSS encrypt the connection, but the selected server processes the contents. End-to-end encryption is not provided.</p>
<h2>Presence and friends</h2><p>When presence sharing is enabled, roughly once per minute the extension sends your public installation identifier, display name, current room on the selected server, and hashes of friend identifiers allowed to see your status. Requests are signed by the installation’s private key and bound to the server, request body and time. The server receives the public key and signature. The private key stays on your device and is never included in invitation links. Hashing the access list does not prevent the server operator from associating connections between users.</p>
<p>Only confirmed recipients can see presence. Status expires after 150 seconds without an update; expired records are removed by a maintenance alarm. Turning sharing off sends a status-removal request and stops periodic sending and querying; if the network is unavailable, the expiry still applies. Changing servers revokes the previous presence. With multiple tabs, the first connected room on the selected server is published; solo tabs are not shown as shared viewing.</p>
<p>A friend invitation uses a separate random token valid for 7 days. The server stores its hash and expiry; creating a new link replaces the previous link. Friendship confirmations remain until the client acknowledges them, for at most 14 days. The friend list is stored in the browser; the server temporarily processes access lists and friendship confirmations.</p>
<h2>What SyncWatch does not do</h2><ul><li>No SyncWatch account, email address, telephone number, postal address or payment details are requested. Your chosen display name is shared.</li><li>Viewing history and chat are not recorded in permanent application storage on the server. Current room state is temporarily held in memory.</li><li>No page text, screen recording, video or audio is transmitted. The extension reads the URL, video elements and episode/audio controls needed for synchronization.</li><li>Data are not sold or used for advertising, profiling or creditworthiness decisions.</li><li>No analytics, trackers or third-party remote code are included.</li></ul>
<h2>Storage on your device</h2><p>Room code, display name, server address, sync tolerance, toggles, language and appearance preferences are stored in <code>storage.local</code>. Tab connection intentions use <code>storage.session</code>. The room code and name are sent to the server and room participants when connecting.</p><p>The installation identifier and private key, friend list, incoming requests and acknowledgements are stored locally. Up to 50 chat messages and the draft are held in the background session’s memory; leaving or restarting the worker clears that history.</p>
<h2>Permissions</h2><ul><li><code>storage</code> saves preferences and local installation data.</li><li><code>alarms</code> schedules connection maintenance, update checks and friend presence. The timer itself transmits nothing; the extension’s code performs the described requests.</li><li>Access to websites and frames detects HTML video and player controls across sites whose domains cannot be listed in advance. Shared navigation is restricted to the current viewing site; leaving that site switches to solo mode.</li></ul>
<h2>Server infrastructure</h2><p>The default relay runs on Cloudflare Workers. You can select your own compatible server. Room messages are relayed in real time without a permanent application chat archive. Your chosen server operator and Cloudflare process network connections according to their own operating policies, including any infrastructure logs.</p>
<h2>Children</h2><p>SyncWatch is not directed specifically at children. Data processing is described above; avoid sharing sensitive information in names or chat.</p>
<h2>Changes</h2><p>Material changes will update this page and its revision date.</p><h2>Contact</h2><p>Privacy questions: <a href="mailto:strikec71@gmail.com">strikec71@gmail.com</a>.</p>`);
}
export function pageLanguage(request: Request): PageLanguage {
 const requested = new URL(request.url).searchParams.get('lang');
 if (requested === 'ru' || requested === 'en') return requested;
 return /^ru(?:-|,|;|$)/i.test(request.headers.get('accept-language') || '') ? 'ru' : 'en';
}
function esc(s: string): string { return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }
function joinPageRu(slug: string | null): string {
  const roomLine = slug
    ? `<p class="muted">Комната: <code>${esc(slug)}</code></p>`
    : '';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SyncWatch — приглашение</title>
<meta name="syncwatch-invite" content="1" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 460px; margin: 12vh auto; padding: 0 20px; line-height: 1.5; }
  h1 { font-size: 20px; }
  .muted { opacity: .7; font-size: 14px; }
  code { background: rgba(127,127,127,.18); padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
  <nav aria-label="Язык"><a href="?lang=en" lang="en">English</a> · <a href="?lang=ru" lang="ru">Русский</a></nav>
  <h1>SyncWatch — приглашение в комнату</h1>
  ${roomLine}
  <p class="muted">Если установлено расширение SyncWatch, нажмите «Войти в комнату» в карточке приглашения. Управление доступно также с иконки расширения.</p>
  <p class="muted">Ничего не произошло? Установите SyncWatch из Chrome Web Store, затем откройте эту ссылку снова. После обновления расширения перезагрузите страницу.</p>
${keepInvitation}</body>
</html>`;
}

// Политика конфиденциальности SyncWatch. Статический документ; отражает фактическое
// поведение расширения (см. CLAUDE.md): ретранслятор команд плеера, без сбора личных
// данных и без хранения на сервере. Дату «в силе» обновлять при существенных изменениях.
function privacyPageRu(): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SyncWatch — Политика конфиденциальности</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 8vh auto; padding: 0 20px; line-height: 1.6; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  h2 { font-size: 17px; margin-top: 28px; }
  .muted { opacity: .7; font-size: 14px; }
  code { background: rgba(127,127,127,.18); padding: 1px 5px; border-radius: 4px; }
  ul { padding-left: 20px; }
  li { margin: 4px 0; }
</style>
</head>
<body>
  <nav aria-label="Язык"><a href="?lang=en" lang="en">English</a> · <a href="?lang=ru" lang="ru">Русский</a></nav>
  <h1>Политика конфиденциальности SyncWatch</h1>
  <p class="muted">Обновлено 25 октября 2026 г.</p>


  <p>SyncWatch — браузерное расширение для совместного просмотра видео: оно
  синхронизирует команды плеера (воспроизведение, пауза, перемотка, скорость) между
  участниками одной комнаты, создавая эффект «одного экрана». Расширение не имеет
  собственной медиатеки и не передаёт изображение или звук.</p>

  <h2>Какие данные обрабатываются</h2>
  <p>Для работы синхронизации между участниками в реальном времени передаются только:</p>
  <ul>
    <li>секретный код доступа к комнате;</li>
    <li>адрес страницы просмотра (включая параметры, нужные для серии), выбранная серия, сезон и озвучка;</li>
    <li>отображаемое имя устройства, которое вы указываете сами (можно оставить произвольным);</li>
    <li>события плеера: воспроизведение, пауза, позиция перемотки, скорость, состояние
    буферизации/рекламы;</li>
    <li>быстрые фразы и введенный вами текст чата (до 200 символов);</li>
    <li>временный идентификатор соединения (генерируется заново при каждом подключении).</li>
  </ul>
  <p>Эти данные передаются <strong>транзитно</strong> через сервер-ретранслятор другим
  участникам вашей комнаты и нужны исключительно для синхронизации просмотра.</p>

  <h2>Присутствие (друзья онлайн)</h2>
  <p>При включенном обмене статусом расширение примерно раз в минуту отправляет выбранному серверу
  публичный идентификатор установки, имя устройства, текущую комнату на этом сервере и хеши
  идентификаторов друзей, которым разрешена видимость. Запросы подписываются приватным
  ключом установки с привязкой к адресу сервера, телу и времени; сервер получает публичный ключ и подпись. Приватный ключ не передается серверу или в приглашениях. Владелец сервера
  обрабатывает эти данные и может сопоставлять связи, несмотря на хеширование списка доступа.</p>
  <p>Статус доступен только подтвержденным получателям и истекает через 150 секунд без обновлений.
  Просроченные записи удаляются служебным alarm. Выключение обмена отправляет одно служебное
  удаление статуса и прекращает периодическую отправку и опрос; при сетевой ошибке действует TTL.
  Смена сервера отзывает старый статус. Из нескольких вкладок публикуется первая подключенная
  комната выбранного сервера; вкладки в соло не публикуются как совместный просмотр.</p>
  <p>Приглашение в друзья содержит отдельный случайный токен на 7 дней. Сервер хранит его хеш и
  срок действия; создание новой ссылки заменяет прежнюю. Подтверждения дружбы хранятся до получения
  квитанции клиента, максимум 14 дней. Список друзей хранится в браузере; сервер временно обрабатывает
  списки доступа и подтверждения. Отображаемое имя в ссылке задает отправитель и не удостоверяет личность.</p>

  <h2>Чего мы НЕ делаем</h2>
  <ul>
    <li>Не запрашиваем аккаунт, email, телефон, адрес или платёжные данные. Выбранное отображаемое имя передается участникам.</li>
    <li>Не записываем историю просмотров и сообщения в постоянное прикладное хранилище. Текущее состояние комнаты временно обрабатывается в памяти сервера.</li>
    <li>Не передаем текст страниц, изображение или звук. Расширение читает URL, элементы video и элементы выбора серии/озвучки для синхронизации.</li>
    <li>Не продаём данные. Передача участникам комнаты, подтвержденным друзьям и выбранному серверу описана выше; сервер использует инфраструктуру Cloudflare.</li>
    <li>Не используем данные для рекламы, профилирования или оценки кредитоспособности.</li>
    <li>Не задействуем аналитику, трекеры и сторонний удалённый код.</li>
  </ul>

  <h2>Хранение на вашем устройстве</h2>
  <p>Настройки (код комнаты, имя устройства, адрес сервера, порог рассинхрона,
  переключатели, язык и оформление) хранятся в <code>storage.local</code>, намерения подключения вкладок — в <code>storage.session</code>. Код комнаты и имя передаются серверу и участникам при подключении; адрес сервера нужен для связи.</p>
  <p>Идентификатор и приватный ключ установки, список друзей, входящие запросы и квитанции хранятся в storage.local. История чата (до 50 сообщений) хранится только в памяти фоновой сессии и исчезает при выходе или перезапуске worker.</p>


  <h2>Разрешения</h2>
  <ul>
    <li><code>storage</code> — локальное хранение ваших настроек.</li>
    <li><code>alarms</code> — служебный таймер, поддерживающий соединение (keepalive),
    проверку обновлений и периодический обмен статусом присутствия с друзьями;
    сам по себе не передает данные: запросы выполняет код расширения.</li>
    <li>доступ к сайтам — чтобы обнаружить видеоплеер на странице; целевые домены
    заранее неизвестны, поэтому запрашивается доступ ко всем сайтам. Для адаптеров читаются элементы управления плеером. Совместная навигация ограничена сайтом просмотра; при уходе на другой сайт включается соло.</li>
  </ul>

  <h2>Сервер</h2>
  <p>Ретранслятор реализован на Cloudflare Workers и передаёт сообщения между участниками
  комнаты в реальном времени. Сообщения не записываются в постоянное прикладное хранилище; последнее состояние временно находится в памяти. Оператор выбранного вами сервера и Cloudflare обрабатывают сетевые подключения по своим правилам.</p>

  <h2>Дети</h2>
  <p>Расширение не предназначено специально для детей. Обработка данных описана выше; не указывайте чувствительные сведения в имени или чате.</p>

  <h2>Изменения</h2>
  <p>При существенных изменениях мы обновим эту страницу и дату «в силе».</p>

  <h2>Контакты</h2>
  <p>Вопросы по конфиденциальности: <a href="mailto:strikec71@gmail.com">strikec71@gmail.com</a>.</p>
${keepInvitation}</body>
</html>`;
}
