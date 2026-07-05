// WebSocket-жизнецикл хаба: connect/disconnect, hardened reconnect (экспоненциальный
// backoff с джиттером, без предела попыток), dead-socket watchdog, onWire-диспетчер.
// Zombie-gate инвариант сохранён: КАЖДЫЙ обработчик сокета гейтится `session.ws !== ws`.

import browser from '../shared/browser';
import { loadSettings, ensureDeviceName } from '../shared/settings';
import { parseWire } from '../shared/protocol';
import type {
  StateMessage,
  BufferMessage,
  BeatMessage,
  AdMessage,
  SnapshotReqMessage,
  RosterMessage,
  RequestControlMessage,
} from '../shared/protocol';
import {
  session,
  sendWire,
  amHost,
  KEEPALIVE_ALARM,
  BACKOFF_BASE,
  BACKOFF_CAP,
  BACKOFF_JITTER,
  WATCHDOG_SILENCE_MS,
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

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

/** Чистый расчёт задержки реконнекта: min(CAP, BASE·2^attempt) + джиттер (Фаза A). */
export function computeBackoff(attempt: number, rand: number = Math.random()): number {
  const exp = Math.min(BACKOFF_CAP, BACKOFF_BASE * 2 ** Math.max(0, attempt));
  return exp + Math.floor(rand * BACKOFF_JITTER);
}

/** Установить соединение. Используется и пользователем, и авто-реконнектом — сам
 *  reconnectAttempt НЕ трогает (растёт в scheduleReconnect, сбрасывается на `open`). */
export async function connect(): Promise<{ ok: boolean; error?: string }> {
  const settings = await loadSettings();
  if (!settings.room) return { ok: false, error: 'Не задан код комнаты' };
  if (!settings.serverUrl) return { ok: false, error: 'Не задан адрес сервера' };

  teardownSocket(); // тихо снимаем старый сокет, не трогая backoff/intentionalClose

  session.deviceName = await ensureDeviceName();
  session.autoConnect = settings.autoConnect;
  session.intentionalClose = false;
  session.driftThreshold = settings.driftThreshold;

  const base = settings.serverUrl.replace(/\/+$/, '');
  const url = `${base}/room/${encodeURIComponent(settings.room)}`;

  try {
    const ws = new WebSocket(url);
    session.ws = ws;
    session.room = settings.room;

    // Zombie-gate: события устаревшего сокета (заменённого в connect/реконнекте) НЕ
    // должны трогать session, кормить onWire или планировать реконнект. Иначе поздний
    // close старого сокета обнулит session.ws нового → «сокет-зомби» (приём жив, отправка мертва).
    ws.addEventListener('open', () => {
      if (session.ws !== ws) return;
      session.connected = true;
      session.lastRecvAt = Date.now();
      reconnectAttempt = 0; // успешное соединение сбрасывает backoff
      sendWire({ type: 'JOIN', room: settings.room, name: session.deviceName });
      if (session.detached) sendWire({ type: 'MODE', detached: true }); // соло переживает реконнект
      browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~24с
      notifyEvent(`Подключено к комнате «${settings.room}»`);
      notifyPopup();
    });
    ws.addEventListener('message', (evt) => { if (session.ws === ws) onWire(evt.data); });
    ws.addEventListener('close', () => { if (session.ws === ws) onSocketDown(); });
    ws.addEventListener('error', () => { if (session.ws === ws) onSocketDown(); });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Пользователь отключился: реконнекта нет, backoff сброшен, сокет снят. */
export function disconnect(): void {
  session.intentionalClose = true;
  cancelReconnect();
  teardownSocket();
}

/** Снять текущий сокет и связанное состояние. НЕ трогает reconnectAttempt/intentionalClose. */
function teardownSocket(): void {
  browser.alarms.clear(KEEPALIVE_ALARM);
  if (session.ws) {
    try { session.ws.close(); } catch { /* already closed */ }
  }
  session.ws = null;
  session.connected = false;
  session.myConnId = -1;
  session.roster.clear();
  clearBlocks(); // сброс per-peer блоков + гашение баннера
  notifyPopup();
}

/** Сокет упал (close/error/watchdog): снимаем и, если уместно, реконнектим. */
function onSocketDown(): void {
  if (!session.intentionalClose) notifyEvent('Соединение потеряно — переподключаюсь…');
  teardownSocket();
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (session.intentionalClose || !session.autoConnect || !session.room) return;
  if (reconnectTimer != null) return;
  const delay = computeBackoff(reconnectAttempt);
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

/** Отменить запланированный реконнект и сбросить счётчик попыток (явное действие пользователя). */
export function cancelReconnect(): void {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
}

/** Watchdog: если соединение живо, но молчит дольше порога — форсируем реконнект. */
export function checkWatchdog(): void {
  if (!session.connected || !session.ws) return;
  if (Date.now() - session.lastRecvAt > WATCHDOG_SILENCE_MS) {
    notifyEvent('Соединение зависло — переподключаюсь…');
    onSocketDown();
  }
}

/** Диспетчер входящих WS-сообщений. Валидируем общим parseWire (тем же, что сервер). */
function onWire(raw: unknown): void {
  const msg = parseWire(raw);
  if (!msg) return; // мусор/невалидная форма — игнорируем
  session.lastRecvAt = Date.now();

  switch (msg.type) {
    case 'ROSTER':
      applyRoster(msg as RosterMessage);
      break;
    case 'STATE':
      applyRemoteState(msg as StateMessage);
      break;
    case 'BUFFER':
      onRemoteBuffer(msg as BufferMessage);
      break;
    case 'AD':
      onRemoteAd(msg as AdMessage);
      break;
    case 'BEAT':
      onRemoteBeat(msg as BeatMessage);
      break;
    case 'SNAPSHOT_REQ':
      void pushSnapshot(msg as SnapshotReqMessage);
      break;
    case 'REQUEST_CONTROL': {
      // Сервер релеит его ТОЛЬКО host'у, так что amHost() держится; гейт — defense-in-depth (RB5).
      const req = msg as RequestControlMessage;
      if (amHost() && req.from != null) pushControlRequest(req.from);
      break;
    }
    // JOIN/CONTROL/MODE/PING — server→client их не шлёт; игнорируем.
  }
}
