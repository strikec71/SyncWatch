// Ядро состояния хаба: singleton `session`, константы и чистые селекторы.
// Roster-based (Фаза A): заменил бинарные поля «я↔один партнёр» на карту roster
// (все участники, себя включая) и per-peer блокирующие состояния для баннера.
// Ни от кого не зависит (только browser + типы) — все остальные модули импортируют отсюда.

import browser from '../shared/browser';
import type { RosterPeer, ClientMessage } from '../shared/protocol';
import type { BannerMsg } from '../shared/messages';

export const KEEPALIVE_ALARM = 'syncwatch-keepalive';
export const RECONNECT_ALARM = 'syncwatch-reconnect'; // персистентный фолбэк реконнекта (переживает выгрузку SW)
export const ECHO_EPSILON = 0.5; // сек: сколько считаем «тем же» состоянием при сверке эха

// Hardened reconnect (Фаза A): экспоненциальный backoff с джиттером, без предела попыток.
export const BACKOFF_BASE = 1000; // мс
export const BACKOFF_CAP = 30000; // мс — потолок задержки
export const BACKOFF_JITTER = 1000; // мс — верхняя граница случайной добавки

// Dead-socket watchdog (Фаза A): если соединение «молчит» дольше — форсируем реконнект.
export const WATCHDOG_SILENCE_MS = 45000;

/** Блокирующее состояние одного участника — вход для центрального баннера (Фаза 7). */
export interface PeerBlock {
  paused: boolean;
  buffer: boolean;
  ad: boolean;
  adSince: number; // ts начала рекламы — для count-up таймера
}

export function emptyBlock(): PeerBlock {
  return { paused: false, buffer: false, ad: false, adSince: 0 };
}

export interface Session {
  ws: WebSocket | null;
  connected: boolean;
  room: string;
  /** Наш connId (из ROSTER.self). -1 = ещё не в комнате. */
  myConnId: number;
  /** Весь roster: connId → участник (себя включая). */
  roster: Map<number, RosterPeer>;
  /** Per-peer блокирующие состояния (баннер). Ключ — connId участника. */
  blocks: Map<number, PeerBlock>;
  /** Имя нашего устройства — уходит в JOIN, чтобы сервер занёс нас в roster. */
  deviceName: string;
  /** НАШ режим соло/синхрон. Detached: не применяем/не шлём, но остаёмся в комнате. */
  detached: boolean;
  autoConnect: boolean;
  /** Закрытие инициировано пользователем — не реконнектить (Фаза 4). */
  intentionalClose: boolean;
  driftThreshold: number;
  /** Вкладка/фрейм активного плеера (куда слать удалённые команды). */
  tabId: number | null;
  frameId: number;
  /** Последнее применённое/отправленное состояние — страховочный анти-эхо на уровне хаба. */
  lastSync: { action: string; currentTime: number } | null;
  /** Ключ последнего пушнутого баннера — антиспам (state|name|since). */
  lastBannerKey: string;
  /** Метка последнего входящего сообщения — для watchdog. */
  lastRecvAt: number;
}

export const session: Session = {
  ws: null,
  connected: false,
  room: '',
  myConnId: -1,
  roster: new Map(),
  blocks: new Map(),
  deviceName: '',
  detached: false,
  autoConnect: true,
  intentionalClose: false,
  driftThreshold: 1.0,
  tabId: null,
  frameId: 0,
  lastSync: null,
  lastBannerKey: 'none',
  lastRecvAt: 0,
};

// ── Чистые селекторы над одной строкой roster (unit-testable без singleton) ──────

/** host = опорный клиент дрейфа (единственный, кто шлёт BEAT). */
export function computeAmHost(me: RosterPeer | undefined): boolean {
  return me?.isHost === true;
}

/** Право управления: host ИЛИ явно выданный контроль. Влияет на play/seek/rate при ≥3. */
export function computeAmController(me: RosterPeer | undefined): boolean {
  return me?.isHost === true || me?.hasControl === true;
}

// ── Селекторы над singleton ──────────────────────────────────────────────────

export function amHost(): boolean {
  return computeAmHost(session.roster.get(session.myConnId));
}

export function amController(): boolean {
  return computeAmController(session.roster.get(session.myConnId));
}

/** Участники кроме нас (для «партнёр на связи» и рассылок). */
export function livePeers(): RosterPeer[] {
  const out: RosterPeer[] = [];
  for (const p of session.roster.values()) {
    if (p.id !== session.myConnId) out.push(p);
  }
  return out;
}

/** Имя участника по connId (или дефолт). */
export function peerName(id: number | undefined): string {
  if (id == null) return 'Партнёр';
  return session.roster.get(id)?.name || 'Партнёр';
}

/** Низкоуровневая отправка в WS. Гейтит ws/connected, гасит исключения.
 *  Живёт здесь (а не в connection.ts), чтобы sync.ts мог слать без цикла импортов. */
export function sendWire(msg: ClientMessage): boolean {
  const ws = session.ws;
  if (!ws || !session.connected) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false; // сокет умер — close-обработчик подчистит
  }
}

/** Пуш баннера в верхний фрейм активной вкладки (frameId:0). */
export function pushBanner(banner: BannerMsg): void {
  if (session.tabId == null) return;
  browser.tabs.sendMessage(session.tabId, banner, { frameId: 0 }).catch(() => { /* нет баннера */ });
}
