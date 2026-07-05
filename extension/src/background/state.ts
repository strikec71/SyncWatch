// Ядро состояния хаба: РЕЕСТР сессий по вкладкам, константы и чистые селекторы.
// Синхрон — принадлежность ВКЛАДКИ: каждая видео-вкладка держит свою `Session` (свой WS,
// комнату, roster, активный фрейм). Реестр `sessions: Map<tabId, Session>` заменил бывший
// глобальный синглтон — так несколько вкладок синхронятся независимо, без перехвата.
// Roster-based (Фаза A): карта всех участников + per-peer блоки для баннера.
// Ни от кого не зависит (только типы) — все остальные модули импортируют отсюда.

import type { RosterPeer, ClientMessage } from '../shared/protocol';

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
  /** Вкладка-владелец сессии (ключ реестра, фиксируется при connect). */
  tabId: number;
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
  /** Активный плеерный фрейм ВНУТРИ вкладки (куда слать удалённые команды).
   *  tabId фиксирован; frameId двигается на каждом реальном событии плеера. */
  frameId: number;
  /** Последнее применённое/отправленное состояние — страховочный анти-эхо на уровне хаба. */
  lastSync: { action: string; currentTime: number } | null;
  /** Ключ последнего пушнутого баннера — антиспам (state|name|since). */
  lastBannerKey: string;
  /** Метка последнего входящего сообщения — для watchdog. */
  lastRecvAt: number;
  /** Per-session реконнект (раньше — модульные let в connection.ts). */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
}

/** Свежая сессия для вкладки (ещё не подключена). */
export function createSession(tabId: number): Session {
  return {
    tabId,
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
    frameId: 0,
    lastSync: null,
    lastBannerKey: 'none',
    lastRecvAt: 0,
    reconnectTimer: null,
    reconnectAttempt: 0,
  };
}

// ── Реестр сессий по вкладкам ─────────────────────────────────────────────────

const sessions = new Map<number, Session>();

/** Сессия вкладки, создаётся при первом обращении. */
export function getSession(tabId: number): Session {
  let s = sessions.get(tabId);
  if (!s) { s = createSession(tabId); sessions.set(tabId, s); }
  return s;
}

/** Сессия вкладки, если существует (без создания). */
export function peekSession(tabId: number): Session | undefined {
  return sessions.get(tabId);
}

/** Забыть сессию вкладки (при закрытии/disconnect). Вызывающий сам гасит сокет. */
export function forgetSession(tabId: number): void {
  sessions.delete(tabId);
}

/** Все живые сессии (для глобальных алармов: keepalive/watchdog/reconnect). */
export function allSessions(): Session[] {
  return [...sessions.values()];
}

// ── Чистые селекторы над одной строкой roster (unit-testable без сессии) ────────

/** host = опорный клиент дрейфа (единственный, кто шлёт BEAT). */
export function computeAmHost(me: RosterPeer | undefined): boolean {
  return me?.isHost === true;
}

/** Право управления: host ИЛИ явно выданный контроль. Влияет на play/seek/rate при ≥3. */
export function computeAmController(me: RosterPeer | undefined): boolean {
  return me?.isHost === true || me?.hasControl === true;
}

// ── Селекторы над сессией ──────────────────────────────────────────────────────

export function amHost(s: Session): boolean {
  return computeAmHost(s.roster.get(s.myConnId));
}

export function amController(s: Session): boolean {
  return computeAmController(s.roster.get(s.myConnId));
}

/** Участники кроме нас (для «партнёр на связи» и рассылок). */
export function livePeers(s: Session): RosterPeer[] {
  const out: RosterPeer[] = [];
  for (const p of s.roster.values()) {
    if (p.id !== s.myConnId) out.push(p);
  }
  return out;
}

/** Имя участника по connId (или дефолт). */
export function peerName(s: Session, id: number | undefined): string {
  if (id == null) return 'Партнёр';
  return s.roster.get(id)?.name || 'Партнёр';
}

/** Низкоуровневая отправка в WS сессии. Гейтит ws/connected, гасит исключения.
 *  Живёт здесь (а не в connection.ts), чтобы sync.ts мог слать без цикла импортов. */
export function sendWire(s: Session, msg: ClientMessage): boolean {
  const ws = s.ws;
  if (!ws || !s.connected) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false; // сокет умер — close-обработчик подчистит
  }
}
