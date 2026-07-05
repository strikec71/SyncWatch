// Чистые помощники roster-поверхности островка (Фаза B).
// Вынесены из overlay.ts, чтобы: (1) держать overlay.ts < 500 строк, (2) tester мог
// юнит-тестить логику бейджей/кнопок и генерацию кода БЕЗ браузера/DOM.
//   • friendlyCode()       — код комнаты «слово-слово-NN».
//   • decideRowControls()  — какие бейджи/кнопки показывать в строке участника.
//   • detachButton()       — маппинг detached → одна кнопка «Соло»↔«Синхрон».
//   • buildRosterRow()     — сборка DOM строки (имя — ТОЛЬКО через textContent: имена не доверенные).

import type { StatusSnapshot } from '../shared/messages';
import type { RosterPeer } from '../shared/protocol';

// Латиница намеренно (безопасно в URL-хэше и в room-path сервера), список маленький и «мягкий».
const WORDS = [
  'luna', 'nova', 'echo', 'orbit', 'pixel', 'tiger', 'mango', 'river', 'cloud', 'ember',
  'delta', 'koala', 'vibe', 'sonic', 'lumen', 'flint', 'zebra', 'comet', 'mocha', 'pluto',
  'raven', 'onyx', 'kiwi', 'frost',
];

/** Дружелюбный код комнаты: `слово-слово-NN` (нижний регистр). `rnd` инъектируется для тестов. */
export function friendlyCode(rnd: () => number = Math.random): string {
  const pick = (): string => WORDS[Math.floor(rnd() * WORDS.length) % WORDS.length];
  const a = pick();
  let b = pick();
  if (b === a) b = WORDS[(WORDS.indexOf(a) + 1) % WORDS.length]; // не «luna-luna»
  const nn = String(Math.floor(rnd() * 100) % 100).padStart(2, '0');
  return `${a}-${b}-${nn}`;
}

/** Решение по одной строке roster. Чистое — юнит-тест без DOM. */
export interface RowControls {
  present: boolean;     // есть ли участник с таким id
  isSelf: boolean;      // это моя строка → бейдж «вы»
  isHost: boolean;      // → бейдж «хост»
  detached: boolean;    // участник в соло → бейдж «соло», строка приглушена
  hasControl: boolean;  // → тонкий маркер «управляет»
  showGrant: boolean;   // я host, комната ≥3, чужая строка → кнопка «Контроль»
  grantActive: boolean; // участник уже с контролем (тумблер = «забрать»)
  showRequest: boolean; // я не-host гость в ≥3 без контроля, своя строка → «Запросить»
}

export function decideRowControls(snapshot: StatusSnapshot, rowId: number): RowControls {
  const peer = snapshot.peers.find((p) => p.id === rowId);
  const size = snapshot.peers.length;
  const isSelf = rowId === snapshot.self;
  if (!peer) {
    return {
      present: false, isSelf, isHost: false, detached: false, hasControl: false,
      showGrant: false, grantActive: false, showRequest: false,
    };
  }
  // В комнате ≤2 контроль симметричен — тумблер/запрос не показываем.
  const showGrant = snapshot.amHost && size >= 3 && !isSelf;
  const showRequest = isSelf && !snapshot.amHost && size >= 3 && !peer.hasControl;
  return {
    present: true,
    isSelf,
    isHost: peer.isHost,
    detached: peer.detached,
    hasControl: peer.hasControl,
    showGrant,
    grantActive: peer.hasControl,
    showRequest,
  };
}

/** Одна кнопка режима: `Соло` когда синхрон, `Синхрон` когда соло. `next` — что послать в set-mode. */
export interface DetachButton { label: string; title: string; next: boolean; }
export function detachButton(detached: boolean): DetachButton {
  return detached
    ? { label: 'Синхрон', title: 'вернуться к общему просмотру', next: false }
    : { label: 'Соло', title: 'смотреть в своём темпе', next: true };
}

/** Колбэки строки: тумблер контроля (host) и запрос контроля (гость). */
export interface RowCallbacks {
  onGrantToggle: (peerId: number, grant: boolean) => void;
  onRequest: () => void;
}

/** Собрать DOM-строку участника. Имя рендерится ТОЛЬКО через textContent (untrusted). */
export function buildRosterRow(
  peer: RosterPeer,
  ctl: RowControls,
  requesting: boolean,
  cb: RowCallbacks,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'prow';
  if (ctl.detached) row.classList.add('solo');
  if (requesting) row.classList.add('asking');

  const dot = document.createElement('i');
  dot.className = 'pdot' + (ctl.hasControl ? ' ctl' : '');

  const name = document.createElement('span');
  name.className = 'pname';
  name.textContent = peer.name || 'участник'; // ← textContent ONLY (XSS-гейт)

  row.append(dot, name);

  if (ctl.isHost) row.appendChild(badge('хост'));
  if (ctl.isSelf) row.appendChild(badge('вы', 'me'));
  if (ctl.detached) row.appendChild(badge('соло', 'muted'));
  if (ctl.hasControl && !ctl.isHost) row.appendChild(badge('управляет', 'ctl'));

  if (ctl.showGrant) {
    row.appendChild(rowBtn(
      'Контроль',
      ctl.grantActive ? 'забрать управление' : 'выдать управление',
      ctl.grantActive,
      () => cb.onGrantToggle(peer.id, !ctl.grantActive),
    ));
  } else if (ctl.showRequest) {
    row.appendChild(rowBtn('Запросить', 'попросить право управления у хоста', false, () => cb.onRequest()));
  }
  return row;
}

function badge(text: string, kind = ''): HTMLElement {
  const s = document.createElement('span');
  s.className = 'pbadge' + (kind ? ' ' + kind : '');
  s.textContent = text;
  return s;
}

function rowBtn(text: string, title: string, active: boolean, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn micro' + (active ? ' on' : '');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
