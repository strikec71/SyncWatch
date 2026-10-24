import { tr } from '../shared/i18n';
// WebSocket-жизнецикл хаба ПО ВКЛАДКАМ: connect/disconnect на конкретную `Session`,
// hardened reconnect (backoff с джиттером в самой сессии), dead-socket watchdog, onWire.
// Zombie-gate инвариант сохранён: КАЖДЫЙ обработчик сокета гейтится `s.ws !== ws`.
// Аларм-тики (keepalive/reconnect) итерируют все сессии — их гоняет index.ts.

import browser from '../shared/browser';
import { normalizeServerUrl } from '../shared/validation';
import { validRoom } from '../shared/protocol';
import { checkUpdates } from './notifier';
import { queryVideoAvailable } from './presence';
import { persistSessions } from './persistence';
import { loadSettings, ensureDeviceName } from '../shared/settings';
import { parseWire } from '../shared/protocol';
import type {
  StateMessage,
  BufferMessage,
  BeatMessage,
  AdMessage,
  NavMessage,
  ChatMessage,
  SnapshotReqMessage,
  RosterMessage,
  RequestControlMessage,
} from '../shared/protocol';
import {
  type Session,
  sendWire,
  amHost,
  KEEPALIVE_ALARM,
  RECONNECT_ALARM,
  BACKOFF_BASE,
  BACKOFF_CAP,
  BACKOFF_JITTER,
  WATCHDOG_SILENCE_MS,
  IDLE_DISCONNECT_MS,
  isIdleExpired,
  shouldAutoResume,
} from './state';
import {
  applyRoster,
  notifyEvent,
  notifyPopup,
  clearBlocks,
  pushControlRequest,
} from './roster';
import {
  applyRemoteState,
  onRemoteBuffer,
  onRemoteAd,
  onRemoteBeat,
  pushSnapshot,
} from './sync';
import { applyRemoteNav } from './nav';
import { onRemoteChat } from './chat';

/** Чистый расчёт задержки реконнекта: min(CAP, BASE·2^attempt) + джиттер (Фаза A). */
export function computeBackoff(attempt: number, rand: number = Math.random()): number {
  const exp = Math.min(BACKOFF_CAP, BACKOFF_BASE * 2 ** Math.max(0, attempt));
  return exp + Math.floor(rand * BACKOFF_JITTER);
}

/** Установить соединение вкладки к её комнате. `s.tabId` уже задан (при роутинге connect).
 *  Комната/сервер приходят от вызывающего (per-tab), остальное — из глобальных настроек. */
export async function connect(
  s: Session,
  room: string,
  serverUrl?: string,
): Promise<{ ok: boolean; error?: string }> {
  const generation = ++s.connectGeneration;
  const settings = await loadSettings();
  if (generation !== s.connectGeneration) return { ok: false, error: tr('Подключение отменено') };
  const useRoom = (room || s.room).trim();
  const useServer = normalizeServerUrl(serverUrl || s.serverUrl || settings.serverUrl);
  if (!validRoom(useRoom)) return { ok: false, error: tr('Код комнаты: 1–128 латинских букв, цифр, дефисов или _') };
  if (!useServer) return { ok: false, error: tr('Укажите корректный wss:// сервер (ws:// — только localhost)') };

  if (s.room !== useRoom || s.serverUrl !== useServer) { s.chatLog = []; s.chatDraft = ''; s.lastChatSentAt = 0; s.navigationOrigin = ''; s.expectedNav = null; s.expectedSig = null; s.mismatchSig = null; }
  teardownSocket(s); // тихо снимаем старый сокет, не трогая backoff/intentionalClose

  const name = await ensureDeviceName();
  if (generation !== s.connectGeneration) return { ok: false, error: tr('Подключение отменено') };
  s.deviceName = name;
  s.autoConnect = settings.autoConnect;
  s.intentionalClose = false;
  s.idleClosed = false; // явное/авто-подключение снимает idle-состояние
  s.driftThreshold = settings.driftThreshold;
  s.room = useRoom; s.serverUrl = useServer;
  if (s.pageUrl && queryVideoAvailable(s.tabId)) s.navigationOrigin = new URL(s.pageUrl).origin;
  s.phase = 'connecting'; s.error = ''; s.revision = -1; s.contentMismatch = false;
  void persistSessions().catch(() => {});

  const url = `${useServer}/room/${encodeURIComponent(useRoom)}`;

  try {
    const ws = new WebSocket(url);
    s.ws = ws;

    // Zombie-gate: события устаревшего сокета (заменённого в connect/реконнекте) НЕ
    // должны трогать сессию, кормить onWire или планировать реконнект. Иначе поздний
    // close старого сокета обнулит s.ws нового → «сокет-зомби» (приём жив, отправка мертва).
    ws.addEventListener('open', () => {
      if (s.ws !== ws) return;
      s.connected = true;
      s.lastRecvAt = Date.now();
      s.lastActivityAt = Date.now(); // отсчёт простоя идёт от подключения, даже без единого события
      // Backoff is reset only after ROSTER confirms JOIN.
      sendWire(s, { type: 'JOIN', room: useRoom, name: s.deviceName });
      if (s.detached) sendWire(s, { type: 'MODE', detached: true }); // соло переживает реконнект
      browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); // keepalive; браузер клампит к минимуму (Chrome ~30с, FF ~60с)
      notifyEvent(s, tr`Соединяемся с комнатой «${useRoom}»…`);
      notifyPopup(s);
    });
    ws.addEventListener('message', (evt) => { if (s.ws === ws) onWire(s, evt.data); });
    ws.addEventListener('close', (event) => {
      if (s.ws !== ws) return;
      if ([1008, 1009, 1013].includes(event.code)) {
        s.intentionalClose = true; cancelReconnect(s); teardownSocket(s);
        s.phase = 'error'; s.error = event.code === 1013 ? tr('Комната заполнена (максимум 10 участников)') : tr('Сервер отклонил подключение: ') + event.reason;
        void persistSessions().catch(() => {}); notifyPopup(s); return;
      }
      onSocketDown(s);
    });
    ws.addEventListener('error', () => { if (s.ws === ws) onSocketDown(s); });

    s.openTimer = setTimeout(() => { if (s.ws === ws && s.phase !== 'joined') onSocketDown(s); }, 15000);
    notifyPopup(s);
    return { ok: true };
  } catch (e) {
    s.phase = 'error'; s.error = String(e); notifyPopup(s);
    return { ok: false, error: String(e) };
  }
}

/** Пользователь отключил вкладку: реконнекта нет, backoff сброшен, сокет снят. */
export function disconnect(s: Session): void {
  ++s.connectGeneration;
  s.intentionalClose = true;
  cancelReconnect(s);
  teardownSocket(s);
  s.phase = 'disconnected';
  void persistSessions().catch(() => {});
}

/** Снять текущий сокет и связанное состояние сессии. НЕ трогает backoff/intentionalClose. */
function teardownSocket(s: Session): void {
  if (s.openTimer != null) { clearTimeout(s.openTimer); s.openTimer = null; }
  if (s.ws) {
    try { s.ws.close(); } catch { /* already closed */ }
  }
  s.ws = null;
  s.connected = false; s.phase = 'disconnected';
  s.myConnId = -1;
  s.roster.clear();
  clearBlocks(s); // сброс per-peer блоков + гашение баннера
  notifyPopup(s);
}

/** Сокет упал (close/error/watchdog): снимаем и, если уместно, реконнектим. */
function onSocketDown(s: Session): void {
  if (!s.intentionalClose) notifyEvent(s, s.autoConnect ? tr('Соединение потеряно — переподключаюсь…') : tr('Соединение потеряно'));
  teardownSocket(s);
  s.phase = s.autoConnect && !s.intentionalClose ? 'retrying' : 'disconnected'; notifyPopup(s);
  scheduleReconnect(s);
}

function scheduleReconnect(s: Session): void {
  if (s.intentionalClose || !s.autoConnect || !s.room) return;
  // Персистентный фолбэк: alarm переживает выгрузку service worker и разбудит нас, даже
  // если быстрый setTimeout ниже будет потерян (MV3 НЕ продлевает жизнь SW ради pending
  // setTimeout). Идемпотентно; период браузер клампит к минимуму (~30с). Снимается на
  // успешном open, при disconnect и когда reconnectDecision → 'clear'.
  browser.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  if (s.reconnectTimer != null) return;
  const delay = computeBackoff(s.reconnectAttempt);
  s.reconnectAttempt++;
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    void connect(s, s.room);
  }, delay);
}

/** Решение alarm-фолбэка (чистое, тестируемое). `clear` — реконнект больше не нужен;
 *  `wait` — быстрый setTimeout ещё запланирован (SW жив), не мешаем;
 *  `connect` — форсируем попытку (типично после выгрузки SW: setTimeout был потерян). */
export type ReconnectDecision = 'clear' | 'wait' | 'connect';
export function reconnectDecision(p: {
  intentionalClose: boolean;
  autoConnect: boolean;
  room: string;
  connected: boolean;
  timerPending: boolean;
  idleClosed: boolean;
}): ReconnectDecision {
  // idle-закрытие: реконнекта по таймеру нет (возврат только по активности — shouldAutoResume).
  if (p.intentionalClose || p.idleClosed || !p.autoConnect || !p.room || p.connected) return 'clear';
  if (p.timerPending) return 'wait';
  return 'connect';
}

/** Тик персистентного фолбэка для одной сессии (вызывается из onAlarm по всем сессиям). */
export function reconnectTick(s: Session): void {
  const decision = reconnectDecision({
    intentionalClose: s.intentionalClose,
    autoConnect: s.autoConnect,
    room: s.room,
    connected: s.connected,
    timerPending: s.reconnectTimer != null,
    idleClosed: s.idleClosed,
  });
  if (decision === 'wait') return;      // SW жив, setTimeout дожмёт сам
  if (decision === 'connect' && s.phase !== 'connecting') void connect(s, s.room); // connect() сам снимет полу-открытый сокет
  // 'clear' — этой сессии реконнект не нужен; аларм гасит index.ts, когда он не нужен НИКОМУ.
}

/** Отменить запланированный реконнект и сбросить счётчик попыток (явное действие пользователя). */
export function cancelReconnect(s: Session): void {
  if (s.reconnectTimer != null) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }
  s.reconnectAttempt = 0;
}

/** Watchdog одной сессии: соединение живо, но молчит дольше порога — форсируем реконнект. */
export function checkWatchdog(s: Session): void {
  if (!s.connected || !s.ws) return;
  if (Date.now() - s.lastRecvAt > WATCHDOG_SILENCE_MS) {
    notifyEvent(s, tr('Соединение зависло — переподключаюсь…'));
    onSocketDown(s);
  }
}

/** Простой одной сессии: живой сокет без реальной активности просмотра дольше
 *  IDLE_DISCONNECT_MS → закрываем БЕЗ реконнекта (экономия серверного трафика на
 *  забытой вкладке-паузе). Возврат — только вручную. Сессию не забываем: островок
 *  покажет «не подключено» с пред-заполненной комнатой, готовой к повторному «Подключиться». */
export function checkIdle(s: Session): void {
  if (!isIdleExpired({
    connected: s.connected,
    intentionalClose: s.intentionalClose,
    lastActivityAt: s.lastActivityAt,
    now: Date.now(),
    idleMs: IDLE_DISCONNECT_MS,
  })) return;
  notifyEvent(s, tr('Простой дольше 6 ч — соединение приостановлено, продолжится при просмотре'));
  // idle-закрытие (НЕ ручное): intentionalClose НЕ ставим, реконнект по таймеру не планируем.
  // Сокет рвём (экономим трафик); вернёмся автоматически при первой активности (maybeResume).
  s.idleClosed = true;
  void persistSessions().catch(() => {});
  cancelReconnect(s); // снять возможный отложенный таймер — не реконнектить по расписанию
  teardownSocket(s); s.phase = 'idle'; notifyPopup(s); // close()→'close' придёт уже с s.ws===null (zombie-gate) → onSocketDown не сработает
}

/** Реальная активность просмотра после idle-закрытия → бесшовно переподключаемся.
 *  Возврат ТОЛЬКО по активности: idle-сессию таймерный реконнект не трогает
 *  (reconnectDecision→'clear'). Для не-idle сессий — no-op. */
export function maybeResume(s: Session): void {
  if (!shouldAutoResume({ idleClosed: s.idleClosed, room: s.room, intentionalClose: s.intentionalClose })) return;
  s.idleClosed = false;
  void connect(s, s.room);
}

/** Диспетчер входящих WS-сообщений сессии. Валидируем общим parseWire (тем же, что сервер). */
function onWire(s: Session, raw: unknown): void {
  const msg = parseWire(raw);
  if (!msg) return; // мусор/невалидная форма — игнорируем
  s.lastRecvAt = Date.now();

  switch (msg.type) {
    case 'ROSTER':
      if (s.openTimer != null) { clearTimeout(s.openTimer); s.openTimer = null; }
      s.phase = 'joined'; s.reconnectAttempt = 0;
      void checkUpdates(s);
      applyRoster(s, msg as RosterMessage);
      break;
    case 'STATE':
      applyRemoteState(s, msg as StateMessage);
      break;
    case 'BUFFER':
      onRemoteBuffer(s, msg as BufferMessage);
      break;
    case 'AD':
      onRemoteAd(s, msg as AdMessage);
      break;
    case 'BEAT':
      onRemoteBeat(s, msg as BeatMessage);
      break;
    case 'NAV':
      if (msg.revision !== undefined) { if (msg.revision < s.revision) return; s.revision = msg.revision; }
      void applyRemoteNav(s, msg as NavMessage);
      break;
    case 'CHAT':
      // Чат — без гейта detached: соло-зритель тоже видит сообщения комнаты.
      onRemoteChat(s, msg as ChatMessage);
      break;
    case 'SNAPSHOT_REQ':
      void pushSnapshot(s, msg as SnapshotReqMessage);
      break;
    case 'REQUEST_CONTROL': {
      // Сервер релеит его ТОЛЬКО host'у, так что amHost() держится; гейт — defense-in-depth (RB5).
      const req = msg as RequestControlMessage;
      if (amHost(s) && req.from != null) pushControlRequest(s, req.from);
      break;
    }
    // JOIN/CONTROL/MODE/PING — server→client их не шлёт; игнорируем.
  }
}
