import { tr } from '../shared/i18n';
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
  type Session,
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
    name: picked.p.name || '',
  };
}

// ── Мутаторы per-peer блоков (зовёт sync.ts на входящие STATE/BUFFER/AD) ──────

function blockOf(s: Session, id: number): PeerBlock {
  let b = s.blocks.get(id);
  if (!b) { b = emptyBlock(); s.blocks.set(id, b); }
  return b;
}

export function notePeerPaused(s: Session, from: number | undefined, paused: boolean): void {
  if (from == null) return;
  blockOf(s, from).paused = paused;
  recomputeBanner(s);
}

export function notePeerBuffer(s: Session, from: number | undefined, buffering: boolean): void {
  if (from == null) return;
  blockOf(s, from).buffer = buffering;
  recomputeBanner(s);
}

export function notePeerAd(s: Session, from: number | undefined, ad: boolean): void {
  if (from == null) return;
  const b = blockOf(s, from);
  if (ad && !b.ad) b.adSince = Date.now();
  b.ad = ad;
  recomputeBanner(s);
}

/** last-writer: наше локальное play/pause снимает «зависшую» паузу у всех участников. */
export function clearPeerPausedFlags(s: Session): void {
  let changed = false;
  for (const b of s.blocks.values()) {
    if (b.paused) { b.paused = false; changed = true; }
  }
  if (changed) recomputeBanner(s);
}

/** Полный сброс блоков (реконнект/выход) + гашение баннера. */
export function clearBlocks(s: Session): void {
  s.blocks.clear();
  recomputeBanner(s);
}

// ── Пуш баннера ──────────────────────────────────────────────────────────────

export function syncHolds(s: Session): void {
  const blocks = [...s.roster.values()].filter(p => p.id !== s.myConnId && !p.detached).map(p => s.blocks.get(p.id));
  for (const msg of [
    { kind: 'buffer-control', buffering: !s.detached && blocks.some(b => b?.buffer) },
    { kind: 'ad-control', ad: !s.detached && blocks.some(b => b?.ad) },
  ]) browser.tabs.sendMessage(s.tabId, msg, { frameId: s.frameId }).catch(() => {});
}

export function recomputeBanner(s: Session): void {
  syncHolds(s);
  const { state, since, name } = aggregateBanner(s.blocks, s.roster, s.myConnId);
  const key = `${state}|${name}|${since}`;
  if (key === s.lastBannerKey) return;
  s.lastBannerKey = key;
  const banner: BannerMsg = { kind: 'banner', state, since, name };
  browser.tabs.sendMessage(s.tabId, banner, { frameId: 0 }).catch(() => { /* нет баннера */ });
}

// ── Применение ROSTER ─────────────────────────────────────────────────────────

/** Применить снимок roster от сервера: обновить myConnId, вывести join/left diff-ом,
 *  подчистить блоки ушедших, пересчитать баннер и уведомить оверлей. */
export function applyRoster(s: Session, msg: RosterMessage): void {
  const prev = s.roster;
  s.myConnId = msg.self;

  const { joined, left } = diffRoster(prev, msg.peers);
  for (const p of joined) {
    if (p.id !== msg.self) notifyEvent(s, tr`${p.name || tr('Партнёр')} подключился(-ась)`);
  }
  for (const p of left) {
    if (p.id !== msg.self) notifyEvent(s, tr`${p.name || tr('Партнёр')} отключился(-ась)`);
  }

  const nextMap = new Map<number, RosterPeer>(msg.peers.map((p) => [p.id, p]));
  for (const id of [...s.blocks.keys()]) {
    if (!nextMap.has(id) || nextMap.get(id)?.detached) s.blocks.delete(id);
  }
  s.roster = nextMap;
  for (const p of msg.peers) {
    if (p.buffering !== undefined) blockOf(s, p.id).buffer = p.buffering;
    if (p.ad !== undefined) { const b = blockOf(s, p.id); if (p.ad && !b.ad) b.adSince = Date.now(); b.ad = p.ad; }
  }

  recomputeBanner(s);
  notifyPopup(s);
}

// ── Снимок состояния и уведомления оверлея ───────────────────────────────────

export function statusSnapshot(s: Session): StatusSnapshot {
  const peers = [...s.roster.values()];
  const others = livePeers(s);
  return {
    connected: s.connected && s.phase === 'joined',
    updateVersion: s.updateVersion, serverUrl: s.serverUrl, phase: s.phase, error: s.error, contentMismatch: s.contentMismatch,
    peerPresent: others.length > 0,
    room: s.room,
    deviceName: s.deviceName,
    peerName: others[0]?.name || '',
    peers,
    amHost: amHost(s),
    amController: amController(s),
    detached: s.detached,
    self: s.myConnId, // RB2: единственный источник — метка строки «вы»
  };
}

export function notifyPopup(s: Session): void {
  // Статус — ТОЛЬКО в островок своей вкладки (frame 0), не runtime-бродкаст: иначе
  // островки других вкладок получили бы чужой статус.
  browser.tabs
    .sendMessage(s.tabId, { kind: 'status', ...statusSnapshot(s) }, { frameId: 0 })
    .catch(() => { /* оверлея нет — нормально */ });
}

/** Доставить сообщение в островок СВОЕЙ вкладки (верхний фрейм). tabId сессии известен
 *  с момента connect, поэтому всегда адресно (без бродкаста). */
export function sendToOverlays(s: Session, msg: RuntimeMessage): void {
  browser.tabs.sendMessage(s.tabId, msg).catch(() => { /* нет оверлея */ });
}

/** Событие активности в ленту островка. */
export function notifyEvent(s: Session, text: string): void {
  const ev: EventMsg = { kind: 'event', text, ts: Date.now() };
  sendToOverlays(s, ev);
}

/** host получил REQUEST_CONTROL: предложить островку выдать право просителю. */
export function pushControlRequest(s: Session, from: number): void {
  const name = s.roster.get(from)?.name || tr('Партнёр');
  const msg: ControlRequestMsg = { kind: 'control-request', from, name };
  sendToOverlays(s, msg);
}
