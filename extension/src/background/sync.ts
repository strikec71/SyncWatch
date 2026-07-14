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
import {
  type Session,
  sendWire,
  amHost,
  amController,
  noteActivity,
  ECHO_EPSILON,
  EXPECTED_NAV_TTL_MS,
  peerName,
} from './state';
import { framesWithVideo } from './presence';
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

/** Cold-start (Фаза 1): в какой фрейм слать get-snapshot. Активный, если он реально
 *  держит видео; иначе первый фрейм с видео; иначе — активный (пусть промахнётся, чем
 *  ничего). Фиксит гонку frameId=0 до первого player-event хоста (снимок с фрейма без видео). */
export function pickSnapshotFrame(activeFrameId: number, framesWithVideo: number[]): number {
  if (framesWithVideo.includes(activeFrameId)) return activeFrameId;
  if (framesWithVideo.length > 0) return framesWithVideo[0];
  return activeFrameId;
}

/** Cold-start (Фаза 1): слать ли resync (MODE{detached:false}) при готовности <video>.
 *  Только не-host и не-detached (нельзя выдёргивать из соло), с собственным троттлингом. */
export function readyResyncDecision(p: {
  connected: boolean;
  detached: boolean;
  amHost: boolean;
  now: number;
  lastAt: number;
  throttleMs: number;
}): boolean {
  if (!p.connected || p.detached || p.amHost) return false;
  return p.now - p.lastAt >= p.throttleMs;
}

// noteActivity живёт в state.ts (общая точка для sync.ts и nav.ts) — сбрасывает таймер
// авто-дисконнекта по простою. PING/roster активностью НЕ считаются.

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
  noteActivity(s); // локальное действие (в т.ч. пауза) сбрасывает таймер простоя

  if (isEcho(s.lastSync, msg.action, msg.currentTime, ECHO_EPSILON)) {
    s.lastSync = null;
    return;
  }

  if (!canEmit(msg.action, {
    amController: amController(s),
    detached: s.detached,
    size: s.roster.size,
  })) {
    // ⚠️ Критично для ≥3: действие НЕ ушло в сеть, но локальный плеер его уже выполнил —
    // наш просмотр «форкнулся» от комнаты (играем, пока все стоят / уехали по перемотке).
    // Молча бросить нельзя (это разваливало синхрон у троих) — просим у сервера снапшот
    // хоста и откатываемся к общему состоянию. Detach не трогаем — там расход намеренный.
    if (!s.detached) requestGateResync(s);
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
  noteActivity(s); // beat приходит ТОЛЬКО при воспроизведении → мы активно смотрим
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

// Не чаще раза в 3с: серия seek/ratechange от одного жеста не должна спамить хоста.
const GATE_RESYNC_THROTTLE_MS = 3000;
// Cold-start: троттлинг resync по готовности <video> (смена качества дёргает событие часто).
const READY_RESYNC_THROTTLE_MS = 3000;

/** Cold-start (Фаза 1): фрейм доиграл <video>. Помечаем его активным (если он в
 *  presence-карте) и, если мы не-host и в синхроне, просим направленный снапшот тем же
 *  идемпотентным MODE{detached:false} → SNAPSHOT_REQ хосту → STATE в уже готовый плеер. */
export function onVideoReady(s: Session, frameId: number): void {
  if (framesWithVideo(s.tabId).includes(frameId)) markActiveFrame(s, frameId);
  if (!readyResyncDecision({
    connected: s.connected,
    detached: s.detached,
    amHost: amHost(s),
    now: Date.now(),
    lastAt: s.lastReadyResyncAt,
    throttleMs: READY_RESYNC_THROTTLE_MS,
  })) return;
  s.lastReadyResyncAt = Date.now();
  sendWire(s, { type: 'MODE', detached: false });
}

/** Заблокированное гейтом действие уже исполнилось локально → вернуть себя к состоянию
 *  комнаты. MODE{detached:false} на сервере (уже задеплоенном) идемпотентен и триггерит
 *  SNAPSHOT_REQ хосту → нам прилетит направленный STATE — тот же механизм, что синк при
 *  входе. Плюс объясняем пользователю, почему его play/seek «не сработал». */
export function requestGateResync(s: Session): void {
  const now = Date.now();
  if (now - s.lastGateResyncAt < GATE_RESYNC_THROTTLE_MS) return;
  s.lastGateResyncAt = now;
  sendWire(s, { type: 'MODE', detached: false });
  notifyEvent(s, 'Управляет хост — плеер выровнен по комнате. Право можно получить кнопкой «Запросить»');
}

// ── Удалённые сообщения → плеер ──────────────────────────────────────────────

export function applyRemoteState(s: Session, state: StateMessage): void {
  noteActivity(s); // партнёр действует → комната активна, простой сбрасываем даже в соло
  if (s.detached) return; // соло: смотрим независимо, чужое не применяем
  if (state.to != null && state.to !== s.myConnId) return; // чужой направленный снапшот
  // Пока навигируемся по NAV партнёра (страница ИЛИ серия/озвучка) — этот STATE адресован
  // СТАРОМУ документу/серии. Дропаем: свежий приедет после готовности нового плеера
  // (video-ready → resync Фазы 1). TTL страхует от залипшего expected (Фазы 2/3).
  const nowTs = Date.now();
  if (s.expectedNav && nowTs - s.expectedNavAt < EXPECTED_NAV_TTL_MS) return;
  if (s.expectedSig && nowTs - s.expectedSigAt < EXPECTED_NAV_TTL_MS) return;

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
  noteActivity(s); // входящий BEAT = партнёр играет → комната активна
  // Дрейф правит только НЕ host и НЕ detached. Host — источник, себя не корректирует.
  if (s.detached || amHost(s)) return;
  sendToActiveFrame(s, {
    kind: 'sync-time',
    currentTime: msg.currentTime,
    ts: msg.ts,
    driftThreshold: s.driftThreshold,
  });
}

// Снимок неготового плеера ({paused:true,currentTime:0}) перемотал бы новичка в 0:00 —
// один повтор через это окно, дальше молча пропускаем (свежий STATE приедет по video-ready).
const SNAPSHOT_RETRY_MS = 1500;

/** Мы host и сервер попросил снапшот участнику `target`: спросить фрейм с видео и
 *  отправить направленный STATE{to:target}. Нет фрейма/снимка — молча пропускаем.
 *  Неготовый снимок (ready:false) отбраковываем и один раз повторяем. */
export async function pushSnapshot(s: Session, req: SnapshotReqMessage, attempt = 0): Promise<void> {
  if (!amHost(s)) return;
  // Синхрон страницы (Фаза 2): перед позицией отдаём новичку АДРЕС страницы комнаты
  // направленным NAV — иначе он остался бы на дефолтной серии (URL плеера её не несёт).
  // Только раз (attempt===0), только если знаем свою страницу. Он навигируется, а
  // позиция досинкается после готовности его нового плеера (video-ready → resync).
  if (attempt === 0 && s.pageUrl) {
    sendWire(s, { type: 'NAV', scope: 'page', url: s.pageUrl, ts: Date.now(), to: req.target });
  }
  // Затем — выбор серии/сезона/озвучки (Фаза 3), чтобы новичок оказался НЕ на дефолтной
  // серии. Порядок: страница → серия → позиция. Плеер сменит источник на месте, позицию
  // добьёт resync по video-ready. Это и есть фикс «приглашённый на 1-й серии/дефолтной озвучке».
  if (attempt === 0 && s.mediaSig) {
    sendWire(s, { type: 'NAV', scope: 'player', sig: s.mediaSig, ts: Date.now(), to: req.target });
  }
  const frameId = pickSnapshotFrame(s.frameId, framesWithVideo(s.tabId));
  try {
    const snap = (await browser.tabs.sendMessage(
      s.tabId, { kind: 'get-snapshot' }, { frameId },
    )) as PlayerSnapshot | undefined;
    if (!snap) return;
    if (snap.ready === false) {
      // Плеер новичка/хоста ещё не доиграл метаданные — не шлём мусор в 0:00.
      if (attempt === 0) setTimeout(() => void pushSnapshot(s, req, 1), SNAPSHOT_RETRY_MS);
      return;
    }
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
