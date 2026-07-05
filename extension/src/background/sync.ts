// Синхронизация плеера: локальные события → STATE (с гейтингом прав и detach),
// применение удалённых команд, снапшоты (SNAPSHOT_REQ / STATE.to), дрейф (BEAT),
// релей буфера/рекламы, гашение эха. Roster-based, адаптивный контроль (Фаза A).

import browser from '../shared/browser';
import type {
  PlayerAction,
  StateMessage,
  BufferMessage,
  BeatMessage,
  AdMessage,
  SnapshotReqMessage,
} from '../shared/protocol';
import type {
  PlayerEventMsg,
  BufferingMsg,
  BeatMsg,
  AdMsg,
  PlayerSnapshot,
  RuntimeMessage,
} from '../shared/messages';
import { type Session, sendWire, amHost, amController, ECHO_EPSILON, peerName } from './state';
import {
  notifyEvent,
  notePeerPaused,
  notePeerBuffer,
  notePeerAd,
  clearPeerPausedFlags,
} from './roster';

// ── Чистые функции (unit-testable) ───────────────────────────────────────────

/** Анти-эхо: совпадает ли действие с тем, что мы только что применили из сети. */
export function isEcho(
  lastSync: { action: string; currentTime: number } | null,
  action: string,
  currentTime: number,
  epsilon: number,
): boolean {
  return (
    lastSync != null &&
    lastSync.action === action &&
    Math.abs(lastSync.currentTime - currentTime) < epsilon
  );
}

/** Можно ли транслировать локальное действие. Зеркалит серверный `canSendState`:
 *  detached → нет; pause → всегда; комната ≤2 → симметрично всем; ≥3 → только контроллер. */
export function canEmit(
  action: PlayerAction,
  opts: { amController: boolean; detached: boolean; size: number },
): boolean {
  if (opts.detached) return false;
  if (action === 'pause') return true;
  if (opts.size <= 2) return true;
  return opts.amController;
}

// ── Активный фрейм ────────────────────────────────────────────────────────────

/** Отправить сообщение content-скрипту активного (плеерного) фрейма вкладки сессии. */
export function sendToActiveFrame(s: Session, msg: RuntimeMessage): void {
  browser.tabs
    .sendMessage(s.tabId, msg, { frameId: s.frameId })
    .catch(() => { /* фрейм мог исчезнуть */ });
}

/** tabId сессии фиксирован; двигаем только активный плеерный фрейм внутри вкладки. */
function markActiveFrame(s: Session, frameId: number): void {
  s.frameId = frameId;
}

// ── Локальные события плеера → сеть ───────────────────────────────────────────

export function onPlayerEvent(s: Session, msg: PlayerEventMsg, frameId: number): void {
  markActiveFrame(s, frameId); // фрейм с реальным действием считаем активным

  if (isEcho(s.lastSync, msg.action, msg.currentTime, ECHO_EPSILON)) {
    s.lastSync = null;
    return;
  }

  if (!canEmit(msg.action, {
    amController: amController(s),
    detached: s.detached,
    size: s.roster.size,
  })) {
    return;
  }

  const wire: StateMessage = {
    type: 'STATE',
    action: msg.action,
    currentTime: msg.currentTime,
    rate: msg.rate,
    paused: msg.paused,
    ts: Date.now(),
  };
  sendWire(s, wire);

  // last-writer: наше play/pause снимает «зависшую» паузу партнёра в баннере.
  // ТОЛЬКО для play/pause — seek/rate не отражают намерение паузы (минорфикс #2).
  if (msg.action === 'play' || msg.action === 'pause') clearPeerPausedFlags(s);
}

export function onBuffering(s: Session, msg: BufferingMsg, frameId: number): void {
  markActiveFrame(s, frameId);
  if (s.detached) return;
  const wire: BufferMessage = {
    type: 'BUFFER',
    buffering: msg.buffering,
    currentTime: msg.currentTime,
    ts: Date.now(),
  };
  sendWire(s, wire);
}

export function onBeat(s: Session, msg: BeatMsg, frameId: number): void {
  markActiveFrame(s, frameId);
  // BEAT шлёт ТОЛЬКО host (опорный клиент дрейфа). Не host / detached — молчим.
  if (s.detached || !amHost(s)) return;
  const wire: BeatMessage = {
    type: 'BEAT',
    currentTime: msg.currentTime,
    playing: msg.playing,
    ts: Date.now(),
  };
  sendWire(s, wire);
}

export function onAd(s: Session, msg: AdMsg, frameId: number): void {
  markActiveFrame(s, frameId);
  if (s.detached) return;
  const wire: AdMessage = { type: 'AD', ad: msg.ad, ts: Date.now() };
  sendWire(s, wire);
  notifyEvent(s, msg.ad ? 'У вас реклама — партнёр ждёт' : 'Ваша реклама закончилась');
}

// ── Удалённые сообщения → плеер ──────────────────────────────────────────────

export function applyRemoteState(s: Session, state: StateMessage): void {
  if (s.detached) return; // соло: смотрим независимо, чужое не применяем
  if (state.to != null && state.to !== s.myConnId) return; // чужой направленный снапшот

  // Снапшот (STATE.to === myConnId, при join/un-detach) применяем тем же путём.
  s.lastSync = { action: state.action, currentTime: state.currentTime };
  sendToActiveFrame(s, {
    kind: 'apply',
    action: state.action,
    currentTime: state.currentTime,
    rate: state.rate,
    paused: state.paused,
  });
  notifyEvent(s, partnerActionText(s, state));
  notePeerPaused(s, state.from, state.paused);
}

export function onRemoteBuffer(s: Session, msg: BufferMessage): void {
  if (s.detached) return;
  sendToActiveFrame(s, { kind: 'buffer-control', buffering: msg.buffering });
  notePeerBuffer(s, msg.from, msg.buffering);
}

export function onRemoteAd(s: Session, msg: AdMessage): void {
  if (s.detached) return;
  sendToActiveFrame(s, { kind: 'ad-control', ad: msg.ad });
  const who = peerName(s, msg.from);
  notifyEvent(s, msg.ad ? `${who} смотрит рекламу — ждём` : 'Реклама у партнёра закончилась');
  notePeerAd(s, msg.from, msg.ad);
}

export function onRemoteBeat(s: Session, msg: BeatMessage): void {
  // Дрейф правит только НЕ host и НЕ detached. Host — источник, себя не корректирует.
  if (s.detached || amHost(s)) return;
  sendToActiveFrame(s, {
    kind: 'sync-time',
    currentTime: msg.currentTime,
    ts: msg.ts,
    driftThreshold: s.driftThreshold,
  });
}

/** Мы host и сервер попросил снапшот участнику `target`: спросить активный фрейм и
 *  отправить направленный STATE{to:target}. Нет фрейма/снимка — молча пропускаем. */
export async function pushSnapshot(s: Session, req: SnapshotReqMessage): Promise<void> {
  if (!amHost(s)) return;
  try {
    const snap = (await browser.tabs.sendMessage(
      s.tabId, { kind: 'get-snapshot' }, { frameId: s.frameId },
    )) as PlayerSnapshot | undefined;
    if (!snap) return;
    const wire: StateMessage = {
      type: 'STATE',
      action: snap.paused ? 'pause' : 'play',
      currentTime: snap.currentTime,
      rate: snap.rate,
      paused: snap.paused,
      ts: Date.now(),
      to: req.target,
    };
    sendWire(s, wire);
  } catch { /* фрейма/снимка нет — пропускаем (R4) */ }
}

// ── Тексты ───────────────────────────────────────────────────────────────────

function partnerActionText(s: Session, state: StateMessage): string {
  const who = peerName(s, state.from);
  switch (state.action) {
    case 'play': return `${who} продолжил воспроизведение`;
    case 'pause': return `${who} поставил на паузу`;
    case 'seek': return `${who} перемотал на ${fmtTime(state.currentTime)}`;
    case 'rate': return `${who} изменил скорость ×${state.rate ?? 1}`;
  }
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const base = `${mm}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${base}` : base;
}
