// Зеркало roster + агрегация центрального баннера + уведомления оверлея.
// Roster-based (Фаза A): состояние партнёра больше не бинарно — держим карту всех
// участников и per-peer блокирующие состояния; баннер считаем поверх ВСЕХ
// не-detached участников (приоритет реклама > буфер > пауза), с указанием «кто».

import browser from '../shared/browser';
import type { RosterPeer, RosterMessage } from '../shared/protocol';
import type {
  BannerMsg,
  StatusSnapshot,
  EventMsg,
  ControlRequestMsg,
  RuntimeMessage,
} from '../shared/messages';
import {
  session,
  amHost,
  amController,
  livePeers,
  emptyBlock,
  type PeerBlock,
} from './state';

type BannerState = BannerMsg['state'];

// ── Чистые функции (unit-testable без singleton) ─────────────────────────────

/** Diff двух roster: кто появился (в next, не было в prev) и кто ушёл (был в prev, нет в next). */
export function diffRoster(
  prev: Map<number, RosterPeer>,
  next: RosterPeer[],
): { joined: RosterPeer[]; left: RosterPeer[] } {
  const nextIds = new Set(next.map((p) => p.id));
  const joined = next.filter((p) => !prev.has(p.id));
  const left: RosterPeer[] = [];
  for (const p of prev.values()) {
    if (!nextIds.has(p.id)) left.push(p);
  }
  return { joined, left };
}

/** Агрегировать баннер поверх всех НЕ-detached участников (кроме себя).
 *  Приоритет реклама > буфер > пауза; при равном — младший connId (детерминизм).
 *  Возвращает выбранное состояние, «кого» и `since` (для count-up рекламы). */
export function aggregateBanner(
  blocks: Map<number, PeerBlock>,
  roster: Map<number, RosterPeer>,
  self: number,
): { state: BannerState; since: number; name: string } {
  const peers = [...roster.values()]
    .filter((p) => p.id !== self && !p.detached)
    .sort((a, b) => a.id - b.id);

  let ad: RosterPeer | null = null;
  let buffer: RosterPeer | null = null;
  let paused: RosterPeer | null = null;
  for (const p of peers) {
    const b = blocks.get(p.id);
    if (!b) continue;
    if (b.ad && !ad) ad = p;
    else if (b.buffer && !buffer) buffer = p;
    else if (b.paused && !paused) paused = p;
  }

  const picked: { p: RosterPeer; state: BannerState } | null = ad
    ? { p: ad, state: 'peer-ad' }
    : buffer
      ? { p: buffer, state: 'peer-buffer' }
      : paused
        ? { p: paused, state: 'peer-paused' }
        : null;

  if (!picked) return { state: 'none', since: 0, name: '' };
  const b = blocks.get(picked.p.id);
  return {
    state: picked.state,
    since: picked.state === 'peer-ad' && b ? b.adSince : 0,
    name: picked.p.name || 'Партнёр',
  };
}

// ── Мутаторы per-peer блоков (зовёт sync.ts на входящие STATE/BUFFER/AD) ──────

function blockOf(id: number): PeerBlock {
  let b = session.blocks.get(id);
  if (!b) { b = emptyBlock(); session.blocks.set(id, b); }
  return b;
}

export function notePeerPaused(from: number | undefined, paused: boolean): void {
  if (from == null) return;
  blockOf(from).paused = paused;
  recomputeBanner();
}

export function notePeerBuffer(from: number | undefined, buffering: boolean): void {
  if (from == null) return;
  blockOf(from).buffer = buffering;
  recomputeBanner();
}

export function notePeerAd(from: number | undefined, ad: boolean): void {
  if (from == null) return;
  const b = blockOf(from);
  if (ad && !b.ad) b.adSince = Date.now();
  b.ad = ad;
  recomputeBanner();
}

/** last-writer: наше локальное play/pause снимает «зависшую» паузу у всех участников. */
export function clearPeerPausedFlags(): void {
  let changed = false;
  for (const b of session.blocks.values()) {
    if (b.paused) { b.paused = false; changed = true; }
  }
  if (changed) recomputeBanner();
}

/** Полный сброс блоков (реконнект/выход) + гашение баннера. */
export function clearBlocks(): void {
  session.blocks.clear();
  recomputeBanner();
}

// ── Пуш баннера ──────────────────────────────────────────────────────────────

export function recomputeBanner(): void {
  const { state, since, name } = aggregateBanner(
    session.blocks,
    session.roster,
    session.myConnId,
  );
  const key = `${state}|${name}|${since}`;
  if (key === session.lastBannerKey) return;
  session.lastBannerKey = key;
  const banner: BannerMsg = { kind: 'banner', state, since, name: name || 'Партнёр' };
  if (session.tabId != null) {
    browser.tabs.sendMessage(session.tabId, banner, { frameId: 0 }).catch(() => { /* нет баннера */ });
  }
}

// ── Применение ROSTER ─────────────────────────────────────────────────────────

/** Применить снимок roster от сервера: обновить myConnId, вывести join/left diff-ом,
 *  подчистить блоки ушедших, пересчитать баннер и уведомить оверлей. */
export function applyRoster(msg: RosterMessage): void {
  const prev = session.roster;
  session.myConnId = msg.self;

  const { joined, left } = diffRoster(prev, msg.peers);
  for (const p of joined) {
    if (p.id !== msg.self) notifyEvent(`${p.name || 'Партнёр'} подключился`);
  }
  for (const p of left) {
    if (p.id !== msg.self) notifyEvent(`${p.name || 'Партнёр'} отключился`);
  }

  const nextMap = new Map<number, RosterPeer>(msg.peers.map((p) => [p.id, p]));
  for (const id of [...session.blocks.keys()]) {
    if (!nextMap.has(id)) session.blocks.delete(id);
  }
  session.roster = nextMap;

  recomputeBanner();
  notifyPopup();
}

// ── Снимок состояния и уведомления оверлея ───────────────────────────────────

export function statusSnapshot(): StatusSnapshot {
  const peers = [...session.roster.values()];
  const others = livePeers();
  return {
    connected: session.connected,
    peerPresent: others.length > 0,
    room: session.room,
    deviceName: session.deviceName,
    peerName: others[0]?.name || '',
    peers,
    amHost: amHost(),
    amController: amController(),
    detached: session.detached,
    self: session.myConnId, // RB2: единственный источник — метка строки «вы»
  };
}

export function notifyPopup(): void {
  browser.runtime
    .sendMessage({ kind: 'status', ...statusSnapshot() })
    .catch(() => { /* оверлей закрыт — это нормально */ });
}

/** Доставить сообщение в оверлей (верхний фрейм). Если активная вкладка известна —
 *  туда; иначе (до первого player-event) — во все вкладки. Единая точка frame-0 пушей. */
function sendToOverlays(msg: RuntimeMessage): void {
  if (session.tabId != null) {
    browser.tabs.sendMessage(session.tabId, msg, { frameId: 0 }).catch(() => { /* нет оверлея */ });
    return;
  }
  browser.tabs
    .query({})
    .then((tabs) => {
      for (const t of tabs) {
        if (t.id != null) browser.tabs.sendMessage(t.id, msg, { frameId: 0 }).catch(() => { /* нет оверлея */ });
      }
    })
    .catch(() => { /* tabs недоступны */ });
}

/** Событие активности в ленту оверлея. */
export function notifyEvent(text: string): void {
  const ev: EventMsg = { kind: 'event', text, ts: Date.now() };
  sendToOverlays(ev);
}

/** host получил REQUEST_CONTROL: предложить оверлею выдать право просителю. */
export function pushControlRequest(from: number): void {
  const name = session.roster.get(from)?.name || 'Партнёр';
  const msg: ControlRequestMsg = { kind: 'control-request', from, name };
  sendToOverlays(msg);
}
