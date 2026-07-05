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
    width: 250px; color: var(--ink); font-family: var(--sans);
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

  .status { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot[data-state="on"] { background: #7cf5ff; box-shadow: 0 0 0 3px rgba(124,245,255,.15), 0 0 10px rgba(124,245,255,.6); }
  .dot[data-state="wait"] { background: #f5c451; box-shadow: 0 0 8px rgba(245,196,81,.5); }

  /* Roster: список участников */
  .roster { display: flex; flex-direction: column; gap: 4px; margin: 9px 0 11px; }
  .prow {
    display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--ink);
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
  /* Микро-кнопки в строке roster (Контроль/Запросить) */
  button.btn.micro { padding: 3px 7px; font-size: 9px; letter-spacing: .4px; flex: none; }
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

  @media (prefers-reduced-motion: reduce) {
    .syncline::before, button.btn.primary, button.btn.primary::before { animation: none !important; }
    .toast { animation: none; }
  }
</style>
<div class="panel">
  <div class="head" id="h">
    <span class="mark"><i></i></span>
    <span class="title">SyncWatch</span>
    <button class="hbtn" id="m" title="Свернуть">▾</button>
  </div>
  <div class="syncline" id="sync" data-state="off"></div>

  <div class="toasts" id="toasts"></div>

  <div class="body">
    <div class="status"><span class="dot" id="dot" data-state="off"></span><span id="s">Не подключено</span></div>

    <span class="eyebrow" style="margin-top:10px">Участники</span>
    <div class="roster" id="roster"></div>

    <button class="btn mode" id="mode" type="button" style="display:none">Соло</button>

    <div class="field">
      <span class="eyebrow">Комната</span>
      <div class="row">
        <input id="room" type="text" autocomplete="off" spellcheck="false" placeholder="код" />
        <button class="btn mini" id="create" type="button" title="Сгенерировать код комнаты">Создать</button>
      </div>
    </div>

    <div class="field">
      <button class="btn" id="invite" type="button" style="width:100%">Позвать</button>
    </div>

    <div class="row">
      <button class="btn primary" id="c" type="button">Войти</button>
      <button class="btn" id="d" type="button" style="display:none">Выйти</button>
    </div>

    <label class="chk"><input id="auto" type="checkbox" /> Автовход</label>

    <details>
      <summary>Ещё</summary>
      <div class="field"><span class="eyebrow">Имя устройства</span>
        <input id="dev" type="text" autocomplete="off" spellcheck="false" /></div>
      <div class="field"><span class="eyebrow">Сервер</span>
        <input id="serverUrl" type="text" autocomplete="off" spellcheck="false" placeholder="wss://…" /></div>
      <div class="field" style="margin-bottom:0"><span class="eyebrow">Порог рассинхрона, с</span>
        <input id="drift" type="number" step="0.5" min="0" /></div>
    </details>
  </div>
</div>`;
