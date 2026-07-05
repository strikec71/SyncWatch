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
import { session, sendWire, amHost, amController, ECHO_EPSILON, peerName } from './state';
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

/** Отправить сообщение content-скрипту активного (плеерного) фрейма. */
export function sendToActiveFrame(msg: RuntimeMessage): void {
  if (session.tabId == null) return;
  browser.tabs
    .sendMessage(session.tabId, msg, { frameId: session.frameId })
    .catch(() => { /* фрейм мог исчезнуть */ });
}

function markActiveFrame(tabId: number, frameId: number): void {
  session.tabId = tabId;
  session.frameId = frameId;
}

// ── Локальные события плеера → сеть ───────────────────────────────────────────

export function onPlayerEvent(msg: PlayerEventMsg, tabId: number, frameId: number): void {
  markActiveFrame(tabId, frameId); // фрейм с реальным действием считаем активным

  if (isEcho(session.lastSync, msg.action, msg.currentTime, ECHO_EPSILON)) {
    session.lastSync = null;
    return;
  }

  if (!canEmit(msg.action, {
    amController: amController(),
    detached: session.detached,
    size: session.roster.size,
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
  sendWire(wire);

  // last-writer: наше play/pause снимает «зависшую» паузу партнёра в баннере.
  // ТОЛЬКО для play/pause — seek/rate не отражают намерение паузы (минорфикс #2).
  if (msg.action === 'play' || msg.action === 'pause') clearPeerPausedFlags();
}

export function onBuffering(msg: BufferingMsg, tabId: number, frameId: number): void {
  markActiveFrame(tabId, frameId);
  if (session.detached) return;
  const wire: BufferMessage = {
    type: 'BUFFER',
    buffering: msg.buffering,
    currentTime: msg.currentTime,
    ts: Date.now(),
  };
  sendWire(wire);
}

export function onBeat(msg: BeatMsg, tabId: number, frameId: number): void {
  markActiveFrame(tabId, frameId);
  // BEAT шлёт ТОЛЬКО host (опорный клиент дрейфа). Не host / detached — молчим.
  if (session.detached || !amHost()) return;
  const wire: BeatMessage = {
    type: 'BEAT',
    currentTime: msg.currentTime,
    playing: msg.playing,
    ts: Date.now(),
  };
  sendWire(wire);
}

export function onAd(msg: AdMsg, tabId: number, frameId: number): void {
  markActiveFrame(tabId, frameId);
  if (session.detached) return;
  const wire: AdMessage = { type: 'AD', ad: msg.ad, ts: Date.now() };
  sendWire(wire);
  notifyEvent(msg.ad ? 'У вас реклама — партнёр ждёт' : 'Ваша реклама закончилась');
}

// ── Удалённые сообщения → плеер ──────────────────────────────────────────────

export function applyRemoteState(state: StateMessage): void {
  if (session.detached) return; // соло: смотрим независимо, чужое не применяем
  if (state.to != null && state.to !== session.myConnId) return; // чужой направленный снапшот

  // Снапшот (STATE.to === myConnId, при join/un-detach) применяем тем же путём.
  session.lastSync = { action: state.action, currentTime: state.currentTime };
  sendToActiveFrame({
    kind: 'apply',
    action: state.action,
    currentTime: state.currentTime,
    rate: state.rate,
    paused: state.paused,
  });
  notifyEvent(partnerActionText(state));
  notePeerPaused(state.from, state.paused);
}

export function onRemoteBuffer(msg: BufferMessage): void {
  if (session.detached) return;
  sendToActiveFrame({ kind: 'buffer-control', buffering: msg.buffering });
  notePeerBuffer(msg.from, msg.buffering);
}

export function onRemoteAd(msg: AdMessage): void {
  if (session.detached) return;
  sendToActiveFrame({ kind: 'ad-control', ad: msg.ad });
  const who = peerName(msg.from);
  notifyEvent(msg.ad ? `${who} смотрит рекламу — ждём` : 'Реклама у партнёра закончилась');
  notePeerAd(msg.from, msg.ad);
}

export function onRemoteBeat(msg: BeatMessage): void {
  // Дрейф правит только НЕ host и НЕ detached. Host — источник, себя не корректирует.
  if (session.detached || amHost()) return;
  sendToActiveFrame({
    kind: 'sync-time',
    currentTime: msg.currentTime,
    ts: msg.ts,
    driftThreshold: session.driftThreshold,
  });
}

/** Мы host и сервер попросил снапшот участнику `target`: спросить активный фрейм и
 *  отправить направленный STATE{to:target}. Нет фрейма/снимка — молча пропускаем. */
export async function pushSnapshot(req: SnapshotReqMessage): Promise<void> {
  if (!amHost() || session.tabId == null) return;
  try {
    const snap = (await browser.tabs.sendMessage(
      session.tabId, { kind: 'get-snapshot' }, { frameId: session.frameId },
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
    sendWire(wire);
  } catch { /* фрейма/снимка нет — пропускаем (R4) */ }
}

// ── Тексты ───────────────────────────────────────────────────────────────────

function partnerActionText(state: StateMessage): string {
  const who = peerName(state.from);
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
