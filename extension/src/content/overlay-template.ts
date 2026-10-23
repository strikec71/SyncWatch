// Разметка + стили островка (Shadow DOM). Вынесено из overlay.ts, чтобы держать
// логику панели < 500 строк (см. overlay-roster.ts — тот же приём для roster-хелперов).
// Здесь только строковый шаблон; вся проводка обработчиков — в overlay.ts.

export const TEMPLATE = `
<style>
  :host {
    --ink: #eaedf5;
    --muted: #7e8699;
    --line: rgba(255,255,255,.08);
    --holo: linear-gradient(90deg,#7cf5ff 0%,#a9a0ff 34%,#ff9be1 60%,#7cf5ff 100%);
    --mono: ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace;
    --sans: system-ui,-apple-system,sans-serif;
  }
  * { box-sizing: border-box; }

  .panel {
    width: 280px; color: var(--ink); font-family: var(--sans);
    background: rgba(16,18,24,.82);
    -webkit-backdrop-filter: blur(14px) saturate(1.3); backdrop-filter: blur(14px) saturate(1.3);
    border: 1px solid var(--line); border-radius: 14px; overflow: hidden;
    box-shadow: 0 18px 50px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.05);
  }

  /* Шапка */
  .head { display: flex; align-items: center; gap: 9px; padding: 10px 12px 9px; cursor: move; user-select: none; }
  .mark { position: relative; width: 16px; height: 8px; flex: none; }
  .mark::before, .mark::after {
    content: ''; position: absolute; top: 1px; width: 6px; height: 6px; border-radius: 50%;
    background: var(--ink); opacity: .9;
  }
  .mark::before { left: 0; } .mark::after { right: 0; }
  .mark i { position: absolute; top: 3.5px; left: 5px; right: 5px; height: 1.5px; background: var(--holo); }
  .title { flex: 1; font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: 2.5px; text-transform: uppercase; }
  .hbtn { background: none; border: none; color: var(--muted); font-size: 12px; line-height: 1; cursor: pointer; padding: 2px 5px; border-radius: 6px; }
  .hbtn:hover { color: var(--ink); background: rgba(255,255,255,.06); }
  /* Кнопка 💬 в шапке (быстрые сообщения) + бейдж непрочитанных */
  .chatbtn { position: relative; font-size: 14px; }
  .chatbtn.disabled { opacity: .4; cursor: not-allowed; }
  .chatbadge {
    position: absolute; top: -3px; right: -3px; min-width: 13px; height: 13px; padding: 0 3px;
    display: flex; align-items: center; justify-content: center; box-sizing: border-box;
    font-family: var(--mono); font-size: 8px; font-weight: 700; line-height: 1; color: #0b0d12;
    background: #7cf5ff; border-radius: 999px; box-shadow: 0 0 6px rgba(124,245,255,.6);
  }
  .chatbadge[hidden] { display: none; }
  /* Бейдж «друзей онлайн» в шапке — виден и в компактной пилюле */
  .fbadge {
    min-width: 15px; height: 15px; padding: 0 4px; box-sizing: border-box;
    display: inline-flex; align-items: center; justify-content: center;
    font-family: var(--mono); font-size: 9px; font-weight: 700; line-height: 1;
    color: #0b0d12; background: #f5c451; border-radius: 999px; box-shadow: 0 0 6px rgba(245,196,81,.55);
  }
  .fbadge[hidden] { display: none; }

  /* СИГНАТУРА: живая линия связи под шапкой (видна и в свёрнутом виде) */
  .syncline { position: relative; height: 2px; background: rgba(255,255,255,.05); overflow: hidden; }
  .syncline::before { content: ''; position: absolute; inset: 0; background: var(--holo); background-size: 200% 100%; opacity: 0; transition: opacity .4s ease; }
  .syncline[data-state="on"]::before { opacity: 1; animation: slide 2.6s linear infinite; filter: drop-shadow(0 0 4px rgba(124,245,255,.45)); }
  .syncline[data-state="wait"]::before {
    opacity: .55; background: linear-gradient(90deg,transparent,#a9a0ff,transparent);
    background-size: 55% 100%; background-repeat: no-repeat; animation: sweep 1.9s ease-in-out infinite;
  }
  .syncline[data-state="off"]::before { opacity: .18; background: linear-gradient(90deg,transparent,rgba(255,255,255,.5),transparent); }
  @keyframes slide { to { background-position: -200% 0; } }
  @keyframes sweep { 0% { background-position: -55% 0; } 100% { background-position: 155% 0; } }

  /* Тосты (события + подсказки) — вне .body, видны в любом состоянии */
  .toasts { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 0; }
  .toasts:empty { display: none; }
  .toast {
    font-size: 11px; line-height: 1.35; color: var(--ink);
    background: rgba(255,255,255,.05); border: 1px solid var(--line);
    border-left: 2px solid rgba(169,160,255,.7); border-radius: 8px; padding: 6px 9px;
    animation: tin .28s ease both;
  }
  .toast.accent { border-left-color: #7cf5ff; }
  @keyframes tin { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

  /* Тело */
  .body { padding: 11px 12px 12px; }
  .panel.collapsed .body { display: none; }

  /* Компактная «пилюля»: нет видео И не подключены → только лого + линия связи + бейдж.
     ОТДЕЛЬНО от .collapsed (ручной тумблер пользователя) — это авто-состояние; клик по
     шапке разворачивает (overlay.ts: expandIfCompact). */
  .panel.compact { width: auto; }
  .panel.compact .body { display: none; }
  .panel.compact .toasts { max-width: 300px; padding-bottom: 8px; }
  .panel.compact .head { padding: 8px 11px; cursor: pointer; }
  .panel.compact .title { font-size: 10px; letter-spacing: 2px; }
  .panel.compact .chatbtn,
  .panel.compact #m { display: none; }

  .status { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot[data-state="on"] { background: #7cf5ff; box-shadow: 0 0 0 3px rgba(124,245,255,.15), 0 0 10px rgba(124,245,255,.6); }
  .dot[data-state="wait"] { background: #f5c451; box-shadow: 0 0 8px rgba(245,196,81,.5); }

  /* Roster: список участников */
  .roster { display: flex; flex-direction: column; gap: 4px; margin: 9px 0 11px; }
  .prow {
    display: flex; flex-wrap: wrap; align-items: center; gap: 7px; font-size: 11px; color: var(--ink);
    background: rgba(255,255,255,.04); border: 1px solid var(--line);
    padding: 4px 8px; border-radius: 8px;
  }
  .prow.solo { opacity: .55; }
  .prow.empty { color: var(--muted); justify-content: center; font-family: var(--mono); letter-spacing: 1px; }
  .prow.asking { border-color: rgba(124,245,255,.5); box-shadow: 0 0 0 1px rgba(124,245,255,.18); }
  .pdot { width: 5px; height: 5px; border-radius: 50%; background: #7cf5ff; flex: none; }
  .pdot.ctl { background: #a9a0ff; box-shadow: 0 0 6px rgba(169,160,255,.7); }
  .pname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pbadge {
    font-family: var(--mono); font-size: 8.5px; letter-spacing: .6px; text-transform: uppercase;
    color: var(--muted); background: rgba(255,255,255,.06); border-radius: 5px; padding: 2px 5px; flex: none;
  }
  .pbadge.me { color: #7cf5ff; }
  .pbadge.ctl { color: #a9a0ff; }
  .pbadge.muted { opacity: .7; }

  .eyebrow { display: block; font-family: var(--mono); font-size: 9px; letter-spacing: 1.6px; text-transform: uppercase; color: var(--muted); margin: 0 0 5px; }
  input[type=text], input[type=number] {
    width: 100%; padding: 7px 9px; font-size: 12px; font-family: var(--mono); color: var(--ink);
    background: rgba(0,0,0,.28); border: 1px solid var(--line); border-radius: 8px; outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  input:focus { border-color: rgba(124,245,255,.55); box-shadow: 0 0 0 2px rgba(124,245,255,.18); }
  input::placeholder { color: rgba(126,134,153,.7); }

  .row { display: flex; gap: 7px; }
  .row > * { flex: 1; }
  .field { margin-bottom: 10px; }

  button.btn {
    font-family: var(--mono); font-size: 11px; letter-spacing: .5px; cursor: pointer;
    padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line);
    background: rgba(255,255,255,.04); color: var(--ink);
    transition: background .15s, border-color .15s, transform .05s;
  }
  button.btn:hover { background: rgba(255,255,255,.09); }
  button.btn:active { transform: translateY(1px); }
  button.btn:focus-visible { outline: none; border-color: rgba(124,245,255,.55); box-shadow: 0 0 0 2px rgba(124,245,255,.25); }
  .mini { flex: 0 0 auto; padding: 8px 10px; }
  /* Микро-кнопки в строке roster (Передать/Забрать/Запросить управление): переносятся
     на вторую строку ряда (.prow flex-wrap) во всю ширину — длинные лейблы не ломают ряд. */
  button.btn.micro { padding: 3px 7px; font-size: 9px; letter-spacing: .4px; flex: 1 1 100%; }
  button.btn.micro.on { border-color: rgba(169,160,255,.6); background: rgba(169,160,255,.16); color: #cfc8ff; }
  /* Кнопка режима Соло/Синхрон */
  button.btn.mode { width: 100%; margin-bottom: 10px; }
  button.btn.mode.solo { border-color: rgba(245,196,81,.5); color: #f5d98a; }

  /* Primary — тёмное стекло с голографической кромкой и sheen на ховере */
  button.btn.primary {
    position: relative; border: 1px solid transparent; color: #eff6ff; overflow: hidden;
    background: linear-gradient(rgba(15,17,23,.92),rgba(15,17,23,.92)) padding-box, var(--holo) border-box;
    background-size: auto, 200% 100%;
  }
  button.btn.primary:hover { animation: edge 2.2s linear infinite; }
  @keyframes edge { to { background-position: 0 0, -200% 0; } }
  button.btn.primary::before {
    content: ''; position: absolute; top: 0; left: -60%; width: 45%; height: 100%;
    background: linear-gradient(90deg,transparent,rgba(255,255,255,.2),transparent); transform: skewX(-18deg);
  }
  button.btn.primary:hover::before { animation: sheen 1.1s ease forwards; }
  @keyframes sheen { to { left: 130%; } }

  /* Тумблер авто-подключения */
  .chk { display: flex; align-items: center; gap: 9px; font-size: 12px; margin-top: 11px; cursor: pointer; }
  .chk input {
    appearance: none; -webkit-appearance: none; margin: 0; flex: none; width: 32px; height: 18px;
    border-radius: 999px; background: rgba(255,255,255,.12); border: 1px solid var(--line);
    position: relative; cursor: pointer; transition: background .2s;
  }
  .chk input::after { content: ''; position: absolute; top: 1px; left: 1px; width: 14px; height: 14px; border-radius: 50%; background: var(--ink); transition: transform .2s; }
  .chk input:checked { background: linear-gradient(90deg,#7cf5ff,#a9a0ff); }
  .chk input:checked::after { transform: translateX(14px); }
  .chk input:focus-visible { box-shadow: 0 0 0 2px rgba(124,245,255,.35); }

  details { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
  summary { font-family: var(--mono); font-size: 9px; letter-spacing: 1.6px; text-transform: uppercase; color: var(--muted); cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: '+ '; }
  details[open] summary::before { content: '– '; }
  details .field:first-of-type { margin-top: 10px; }

  /* Секция «Чат»: лог сообщений + (пока задизейбленный) ввод */
  .chatlog {
    display: flex; flex-direction: column; gap: 4px; margin: 10px 0;
    max-height: 140px; overflow-y: auto;
  }
  .chatlog:empty { display: none; }
  .crow {
    font-size: 11px; line-height: 1.35; color: var(--ink); word-break: break-word;
    background: rgba(255,255,255,.04); border: 1px solid var(--line);
    border-left: 2px solid rgba(255,255,255,.14); border-radius: 8px; padding: 5px 8px;
  }
  .crow.self { border-left-color: #7cf5ff; color: #d7f6ff; }
  input:disabled, button.btn:disabled {
    opacity: .5; cursor: not-allowed;
  }

  /* Секция «Друзья»: список строк + кнопка «Добавить друга» */
  .friends { display: flex; flex-direction: column; gap: 4px; margin: 10px 0; }
  .friends:empty { display: none; }
  .frow {
    display: flex; flex-wrap: wrap; align-items: center; gap: 7px; font-size: 11px; color: var(--ink);
    background: rgba(255,255,255,.04); border: 1px solid var(--line);
    padding: 4px 8px; border-radius: 8px;
  }
  .frow.empty { color: var(--muted); justify-content: center; font-family: var(--mono); letter-spacing: .6px; }
  .frow.frq { border-color: rgba(124,245,255,.45); box-shadow: 0 0 0 1px rgba(124,245,255,.14); }
  .fdot { width: 5px; height: 5px; border-radius: 50%; background: var(--muted); flex: none; }
  .fdot[data-state="online"] { background: #f5c451; box-shadow: 0 0 6px rgba(245,196,81,.6); }
  .fdot[data-state="watching"] { background: #7cf5ff; box-shadow: 0 0 6px rgba(124,245,255,.7); }
  .fname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fsub {
    font-family: var(--mono); font-size: 8.5px; letter-spacing: .6px; text-transform: uppercase;
    color: var(--muted); flex: none;
  }
  /* В строке друга микро-кнопки делят строку (короткие лейблы), ✕ — по контенту.
     (В roster .micro = flex:1 1 100% ради длинных лейблов «Передать управление».) */
  .frow button.btn.micro { flex: 1 1 auto; padding: 3px 7px; }
  .frow button.btn.micro.frm { flex: 0 0 auto; padding: 3px 6px; }

  @media (prefers-reduced-motion: reduce) {
    .syncline::before, button.btn.primary, button.btn.primary::before { animation: none !important; }
    .toast { animation: none; }
  }
</style>
<div class="panel">
  <div class="head" id="h">
    <span class="mark"><i></i></span>
    <span class="title">SyncWatch</span>
    <button class="hbtn chatbtn disabled" id="chat-open" type="button" title="Подключитесь, чтобы отправлять сообщения">💬<span class="chatbadge" id="chatbadge" hidden></span></button>
    <span class="fbadge" id="fbadge" hidden></span>
    <button class="hbtn" id="m" title="Свернуть">▾</button>
  </div>
  <div class="syncline" id="sync" data-state="off"></div>

  <div class="toasts" id="toasts" role="status" aria-live="polite"></div>

  <div class="body">
    <a id="update" href="https://chromewebstore.google.com/" target="_blank" rel="noopener noreferrer" style="display:none;color:inherit">Доступна новая версия</a>
    <div class="status"><span class="dot" id="dot" data-state="off"></span><span id="s" role="status" aria-live="polite">Не подключено</span></div>

    <span class="eyebrow" style="margin-top:10px">Участники</span>
    <div class="roster" id="roster"></div>

    <button class="btn mode" id="mode" type="button" style="display:none">Смотреть соло</button>

    <div class="field">
      <span class="eyebrow">Код доступа (не передавайте посторонним)</span>
      <div class="row">
        <input id="room" aria-label="Секретный код комнаты" type="text" autocomplete="off" spellcheck="false" placeholder="код" />
        <button class="btn mini" id="create" type="button" title="Сгенерировать секретный код комнаты">Код</button>

      </div>
    </div>

    <div class="field">
      <button class="btn" id="invite" type="button" style="width:100%">Пригласить</button>
    </div>

    <div class="row">
      <button class="btn primary" id="c" type="button">Подключиться</button>
      <button class="btn" id="d" type="button" style="display:none">Отключиться</button>
    </div>

    <label class="chk"><input id="auto" type="checkbox" /> Автоподключение</label>

    <details id="chatbox">
      <summary>Чат</summary>
      <div class="chatlog" id="chatlog"></div>
      <div class="row">
        <input id="chatinput" aria-label="Сообщение в комнату" type="text" maxlength="200" disabled placeholder="Сообщение (до 200 символов)" />
        <button class="btn mini" id="chatsend" type="button" disabled>Отправить</button>
      </div>
    </details>

    <details id="friendsbox">
      <summary>Друзья</summary>
      <div class="friends" id="friends"></div>
      <button class="btn" id="friend-add" type="button" style="width:100%">Добавить друга</button>
    </details>


    <details>
      <summary>Настройки</summary>
      <div class="field"><span class="eyebrow">Имя устройства</span>
        <input id="dev" aria-label="Имя устройства" type="text" autocomplete="off" spellcheck="false" /></div>
      <div class="field"><span class="eyebrow">Сервер</span>
        <input id="serverUrl" aria-label="Адрес сервера" type="text" autocomplete="off" spellcheck="false" placeholder="wss://…" /></div>
      <div class="field"><span class="eyebrow">Порог рассинхрона, с</span>
        <input id="drift" aria-label="Порог рассинхрона в секундах" type="number" step="0.5" min="0" /></div>
      <label class="chk" style="margin-top:0" title="Показывает друзьям, что вы онлайн и в комнате, и обновляет их статусы у вас. Выключено — обмен presence не идёт в обе стороны.">
        <input id="share-presence" type="checkbox" /> Обмен статусом с друзьями</label>

    </details>
  </div>
</div>`;
