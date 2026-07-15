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

// Авто-дисконнект по простою: если нет НИКАКОЙ реальной активности просмотра (beat при
// воспроизведении, событие плеера, входящий STATE/BEAT) дольше этого — сокет закрывается
// БЕЗ авто-реконнекта, чтобы не жечь серверный трафик на забытой вкладке-паузе. Возврат —
// только вручную («Войти»). Порог намеренно большой: пока смотрят (beat каждые ~3с) или
// жмут кнопки — таймер сбрасывается; молчит только настоящая пауза/заброшенная вкладка.
// Отличать от watchdog (тот про мёртвый сокет и РЕКОННЕКТИТ; этот про живой-но-простаивающий
// и НЕ реконнектит) и от lastRecvAt (тот дёргает PING/roster — здесь не считается активностью).
// Порог большой (6 ч): фильм-найт с долгой паузой (отошли на 1,5–2 ч) НЕ рвёт сессию;
// закрываем лишь реально забытые вкладки. PING ~30с — копеечный трафик. Возврат из
// idle-закрытия — АВТОМАТический по первой активности просмотра (idleClosed, см. shouldAutoResume).
export const IDLE_DISCONNECT_MS = 6 * 60 * 60 * 1000; // 6 часов

// Синхрон идентичности контента (Фаза 2/3): пока мы навигируем по NAV партнёра, входящий
// STATE адресован СТАРОМУ документу — дропаем его столько после старта навигации. Свежий
// STATE приедет уже после готовности нового плеера (video-ready → resync Фазы 1). TTL
// одновременно защищает от «залипшего» expectedNav, если tabs.update не сработал.
export const EXPECTED_NAV_TTL_MS = 20000;

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
  /** Сокет закрыт по простою (idle), НЕ вручную: таймерный реконнект такую сессию не
   *  трогает (reconnectDecision→clear), но при первой активности просмотра автоматически
   *  переподключаемся (shouldAutoResume) — бесшовный возврат после долгой паузы. */
  idleClosed: boolean;
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
  /** Метка последней РЕАЛЬНОЙ активности просмотра (beat/событие плеера/STATE) — для
   *  авто-дисконнекта по простою. НЕ обновляется PING/roster (в отличие от lastRecvAt). */
  lastActivityAt: number;
  /** Per-session реконнект (раньше — модульные let в connection.ts). */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  /** Метка последнего запроса выравнивания после заблокированного гейтом действия
   *  (комната ≥3, мы не контроллер) — троттлинг, чтобы не спамить снапшотами. */
  lastGateResyncAt: number;
  /** Метка последнего resync по готовности <video> (cold-start, Фаза 1). Свой троттлинг,
   *  НЕ делим с lastGateResyncAt — это разные события. */
  lastReadyResyncAt: number;
  /** Синхрон URL страницы (Фаза 2): базовый (последний известный) адрес страницы комнаты,
   *  '' до первого репорта. Первый репорт НИКОГДА не транслируем (иначе /join-приглашённый
   *  уволок бы комнату на /join) — только устанавливаем baseline. */
  pageUrl: string;
  /** URL, на который мы СЕЙЧАС навигируемся по NAV партнёра (луп-гард): свой ре-репорт с
   *  этим url подтверждаем, не транслируем; входящий STATE дропаем до готовности. null = не навигируемся. */
  expectedNav: string | null;
  expectedNavAt: number; // Date.now() старта навигации — TTL против залипания (EXPECTED_NAV_TTL_MS)
  /** Когда мы в последний раз САМИ отправили NAV — окно разбора перекрёстных навигаций. */
  lastNavSentAt: number;
  /** URL, который мы ПОКИНУЛИ своей page-навигацией (+ метка). Защита от эхо-отката:
   *  направленный NAV снапшота с этим url (хост отстал baseline) в окне после ухода —
   *  игнорируем, чтобы инициатор не откатился на страницу, с которой сам ушёл. */
  lastLeftUrl: string;
  lastLeftAt: number;
  /** Имя инициатора последней применённой page-навигации — для тоста ПОСЛЕ reload вкладки
   *  (предыдущий тост «переходим…» гибнет с документом; хаб в SW живёт и досылает). */
  navFromName: string;
  /** Синхрон серии/озвучки внутри плеера (Фаза 3), scope:'player'. Зеркалит pageUrl-машину:
   *  mediaSig — базовый (последний известный) выбор, '' до первого репорта; expectedSig/At —
   *  выбор, который сейчас применяем по NAV партнёра (луп-гард + дроп STATE); lastSigSentAt —
   *  окно перекрёстных смен (отдельно от lastNavSentAt, чтобы смена страницы не глушила смену серии). */
  mediaSig: string;
  expectedSig: string | null;
  expectedSigAt: number;
  lastSigSentAt: number;
}

/** Отметить реальную активность просмотра (сброс таймера авто-дисконнекта по простою).
 *  Живёт здесь, чтобы и sync.ts, и nav.ts звали одну функцию. НЕ считается активностью
 *  keepalive PING/roster (см. lastActivityAt vs lastRecvAt). */
export function noteActivity(s: Session): void {
  s.lastActivityAt = Date.now();
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
    idleClosed: false,
    driftThreshold: 2.0,
    frameId: 0,
    lastSync: null,
    lastBannerKey: 'none',
    lastRecvAt: 0,
    lastActivityAt: 0,
    reconnectTimer: null,
    reconnectAttempt: 0,
    lastGateResyncAt: 0,
    lastReadyResyncAt: 0,
    pageUrl: '',
    expectedNav: null,
    expectedNavAt: 0,
    lastNavSentAt: 0,
    lastLeftUrl: '',
    lastLeftAt: 0,
    navFromName: '',
    mediaSig: '',
    expectedSig: null,
    expectedSigAt: 0,
    lastSigSentAt: 0,
  };
}

/** Пора ли рвать простаивающее соединение (чисто, тестируемо). Рвём только живой
 *  сокет пользователя, который не закрывался вручную и молчит по активности дольше idleMs.
 *  `lastActivityAt === 0` (ещё не было ни одной активности после connect) не срабатывает —
 *  connect проставляет метку на open, так что отсчёт всегда идёт от подключения. */
export function isIdleExpired(p: {
  connected: boolean;
  intentionalClose: boolean;
  lastActivityAt: number;
  now: number;
  idleMs: number;
}): boolean {
  return (
    p.connected &&
    !p.intentionalClose &&
    p.lastActivityAt > 0 &&
    p.now - p.lastActivityAt >= p.idleMs
  );
}

/** Пора ли бесшовно вернуться из idle-закрытия (чисто, тестируемо). Возврат ТОЛЬКО из
 *  idle-состояния (не ручного), при известной комнате и без пользовательского disconnect. */
export function shouldAutoResume(p: {
  idleClosed: boolean;
  room: string;
  intentionalClose: boolean;
}): boolean {
  return p.idleClosed && p.room !== '' && !p.intentionalClose;
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
