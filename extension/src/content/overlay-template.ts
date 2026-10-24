import { OVERLAY_CSS } from './overlay-styles';
import { icon } from './overlay-icons';
export const TEMPLATE = `
<style>${OVERLAY_CSS}</style>
<div class="panel">
  <header class="head" id="h">
    <button class="launcher" id="launcher" type="button" aria-label="Свернуть SyncWatch" aria-expanded="true" aria-controls="panel-body" aria-describedby="s" title="Свернуть SyncWatch">${icon('logo')}<span class="launcher-dot" id="launcher-dot" data-state="off"></span><span class="mini-unread" id="mini-unread" hidden></span></button>
    <div class="identity"><span class="title">SyncWatch</span><span class="tagline">Хорошее кино. Своя компания.</span></div>
    <button class="hbtn chatbtn disabled" id="chat-open" type="button" aria-label="Быстрые сообщения" title="Быстрые сообщения">${icon('reactions')}</button>
    <button class="hbtn" id="m" type="button" aria-label="Свернуть SyncWatch" title="Свернуть">${icon('minimize')}</button>
  </header>
  <div class="syncline" id="sync" data-state="off"></div>
  <div class="toasts" id="toasts" role="status" aria-live="polite"></div>
  <div class="body" id="panel-body">
    <a id="update" href="https://chromewebstore.google.com/" target="_blank" rel="noopener noreferrer" style="display:none">Доступна новая версия</a>
    <div class="session-summary"><div class="session-top"><span class="session-title" id="session-title">Ваша комната</span><span class="fbadge" id="fbadge" hidden></span></div><div class="status"><span class="dot" id="dot" data-state="off"></span><span id="s" role="status" aria-live="polite">Выберите видео и пригласите друзей</span></div><div class="session-facts"><span class="fact">${icon('friends')}<span id="participant-count">До 10 участников</span></span><span class="fact" id="session-role">Без аккаунта</span></div></div>
    <nav class="tabs" role="tablist" aria-label="Разделы SyncWatch">
      <button class="tab" type="button" id="tab-room" role="tab" aria-selected="true" aria-controls="room-view" data-view="room">${icon('room')}Комната</button>
      <button class="tab" type="button" id="tab-chat" role="tab" aria-selected="false" aria-controls="chatbox" data-view="chat" tabindex="-1">${icon('chat')}Чат<span class="chatbadge" id="chatbadge" hidden></span></button>
      <button class="tab" type="button" id="tab-friends" role="tab" aria-selected="false" aria-controls="friendsbox" data-view="friends" tabindex="-1">${icon('friends')}Друзья</button>
      <button class="tab" type="button" id="tab-appearance" role="tab" aria-selected="false" aria-controls="appearance-view" data-view="appearance" tabindex="-1">${icon('style')}Вид</button>
    </nav>
    <section class="view" id="room-view" role="tabpanel" aria-labelledby="tab-room">
      <div class="section-heading"><span>Вместе в комнате</span><span id="room-role-hint">Один контент у всех</span></div><div class="roster" id="roster"></div>
      <button class="btn mode" id="mode" type="button" style="display:none">Смотреть соло</button>
      <button class="btn primary full" id="invite" type="button">${icon('link')}Пригласить в комнату</button>
      <div class="field"><label class="eyebrow" for="room">Код комнаты — ваш секрет доступа</label><div class="row"><input id="room" aria-label="Секретный код комнаты" type="text" autocomplete="off" spellcheck="false" placeholder="Вставьте код или создайте новый"/><button class="btn mini" id="create" type="button" title="Сгенерировать секретный код комнаты">Создать</button></div></div>
      <div class="row"><button class="btn full" id="c" type="button">Подключиться</button><button class="btn full" id="d" type="button" style="display:none">Отключиться</button></div>
      <details id="connection-settings"><summary>Настройки подключения</summary>
        <div class="field"><label class="eyebrow" for="dev">Ваше имя в комнате</label><input id="dev" aria-label="Имя устройства" type="text" autocomplete="off" spellcheck="false" maxlength="64"/></div>
        <div class="field"><label class="eyebrow" for="serverUrl">Сервер</label><input id="serverUrl" aria-label="Адрес сервера" type="text" autocomplete="off" spellcheck="false" placeholder="wss://…"/></div>
        <div class="field"><label class="eyebrow" for="drift">Порог рассинхрона, с</label><input id="drift" aria-label="Порог рассинхрона в секундах" type="number" step="0.25" min="0.25" max="10"/></div>
        <label class="chk"><input id="auto" type="checkbox"/>Автоподключение</label><label class="chk"><input id="share-presence" type="checkbox"/>Обмен статусом с друзьями</label>
        <p class="helper">Адрес страницы, команды и чат передаются выбранному серверу и участникам. Видео и звук остаются на сайте.</p>
      </details>
    </section>
    <section class="view" id="chatbox" role="tabpanel" aria-labelledby="tab-chat" hidden>
      <div class="section-heading"><span>Разговор о самом интересном</span><span>Только эта сессия</span></div><div class="chatlog" id="chatlog" role="log" aria-label="Сообщения комнаты" aria-live="polite"></div>
      <div class="composer"><input id="chatinput" aria-label="Сообщение в комнату" type="text" maxlength="200" disabled placeholder="Что скажете?"/><button class="btn primary" id="chatsend" type="button" disabled>Отправить</button></div><div class="chat-footer"><span>Enter — отправить</span><span id="chat-count">0 / 200</span></div>
    </section>
    <section class="view" id="friendsbox" role="tabpanel" aria-labelledby="tab-friends" hidden><p class="helper">Ваша компания всегда рядом. Пригласите друга по ссылке, чтобы видеть его статус на выбранном сервере.</p><div class="friends" id="friends"></div><button class="btn primary full" id="friend-add" type="button">Добавить друга</button></section>
    <section class="view" id="appearance-view" role="tabpanel" aria-labelledby="tab-appearance" hidden>
      <div class="field"><label class="eyebrow" for="uiTheme">Тема</label><select id="uiTheme"><option value="dark">Тёмный зал</option><option value="light">Светлая гостиная</option><option value="system">Как в системе</option></select></div>
      <div class="field"><span class="eyebrow">Градиент настроения</span><div class="accent-options" role="group" aria-label="Градиент"><button class="accent-option" type="button" data-accent-choice="lounge" aria-pressed="true"><span class="swatch"></span>Lounge</button><button class="accent-option" type="button" data-accent-choice="aurora" aria-pressed="false"><span class="swatch"></span>Aurora</button><button class="accent-option" type="button" data-accent-choice="ocean" aria-pressed="false"><span class="swatch"></span>Ocean</button><button class="accent-option" type="button" data-accent-choice="rose" aria-pressed="false"><span class="swatch"></span>Rose</button></div></div>
      <div class="row"><div class="field"><label class="eyebrow" for="uiDensity">Размер панели</label><select id="uiDensity"><option value="comfortable">Обычный</option><option value="compact">Компактный</option></select></div><div class="field"><label class="eyebrow" for="uiDockSide">Сторона экрана</label><select id="uiDockSide"><option value="right">Справа</option><option value="left">Слева</option></select></div></div>
      <div class="field"><label class="range-label" for="uiOpacity"><span>Плотность стекла</span><output id="opacity-value" for="uiOpacity">96%</output></label><input id="uiOpacity" type="range" min="85" max="100" step="1" value="96"/></div>
      <label class="chk"><input id="uiMotion" type="checkbox" checked/>Плавные анимации</label><p class="helper">Системная настройка уменьшения движения имеет приоритет. Панель можно перемещать за заголовок; значок разворачивает и сворачивает её.</p><button class="btn full" id="appearance-reset" type="button">Сбросить оформление</button>
    </section>
  </div>
</div>`;
