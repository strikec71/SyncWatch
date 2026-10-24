import { tr } from '../shared/i18n';
// Чистые помощники roster-поверхности островка (Фаза B).
// Вынесены из overlay.ts, чтобы: (1) держать overlay.ts < 500 строк, (2) tester мог
// юнит-тестить логику бейджей/кнопок и генерацию кода БЕЗ браузера/DOM.
//   • friendlyCode()       — код комнаты «слово-слово-NN».
//   • decideRowControls()  — какие бейджи/кнопки показывать в строке участника.
//   • detachButton()       — маппинг detached → одна кнопка «Соло»↔«Синхрон».
//   • buildRosterRow()     — сборка DOM строки (имя — ТОЛЬКО через textContent: имена не доверенные).

import type { StatusSnapshot } from '../shared/messages';
import type { RosterPeer } from '../shared/protocol';
import { getLanguage } from '../shared/i18n';

/** Дружелюбный код комнаты: `слово-слово-NN` (нижний регистр). `rnd` инъектируется для тестов. */
export function friendlyCode(): string {
  // 128 unpredictable bits; the code is the access secret, not a public label.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return 'watch-' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
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

/** Одна кнопка режима: «Смотреть соло» когда в синхроне, «Вернуться в синхрон» когда соло.
 *  `next` — что послать в set-mode. */
export interface DetachButton { label: string; title: string; next: boolean; }
export function detachButton(detached: boolean): DetachButton {
  return detached
    ? { label: tr('Вернуться в синхрон'), title: tr('вернуться к общему просмотру'), next: false }
    : { label: tr('Смотреть соло'), title: tr('смотреть в своём темпе'), next: true };
}

/** Число участников с корректной русской формой слова: `N участник(а/ов)`.
 *  Обычные правила: 1/21/31… → участник; 2-4/22-24… → участника; 5-20/11-14/25… → участников. */
export function peersLabel(n: number): string {
  if (getLanguage() === 'en') return `${n} ${n === 1 ? 'participant' : 'participants'}`;
  const mod100 = n % 100;
  const mod10 = n % 10;
  let word: string;
  if (mod100 >= 11 && mod100 <= 14) word = tr('участников');
  else if (mod10 === 1) word = tr('участник');
  else if (mod10 >= 2 && mod10 <= 4) word = tr('участника');
  else word = tr('участников');
  return `${n} ${word}`;
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
  name.textContent = peer.name || tr('участник'); // ← textContent ONLY (XSS-гейт)

  row.append(dot, name);

  if (ctl.isHost) row.appendChild(badge(tr('хост')));
  if (ctl.isSelf) row.appendChild(badge(tr('вы'), 'me'));
  if (ctl.detached) row.appendChild(badge(tr('соло'), 'muted'));
  if (ctl.hasControl && !ctl.isHost) row.appendChild(badge(tr('управляет'), 'ctl'));

  if (ctl.showGrant) {
    row.appendChild(rowBtn(
      ctl.grantActive ? tr('Забрать') : tr('Передать'),
      ctl.grantActive ? tr('забрать управление') : tr('выдать управление'),
      ctl.grantActive,
      () => cb.onGrantToggle(peer.id, !ctl.grantActive),
    ));
  } else if (ctl.showRequest) {
    row.appendChild(rowBtn(tr('Запросить управление'), tr('попросить право управления у хоста'), false, () => cb.onRequest()));
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
  b.setAttribute('aria-label', title);
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
