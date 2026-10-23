// Единый источник правды по формату сообщений в WebSocket.
// Импортируется и расширением (esbuild), и сервером (wrangler).
//
// Фаза A: сервер стал roster-aware и штампует identity отправителя.
// `connId` — per-room монотонный integer, назначается Durable Object при accept
// сокета; меньший connId = старший (оперативный кандидат в host). `self`/`from`/`to`
// — это всегда connId. Клиент НИКОГДА не доверяет `from`, присланному другим клиентом:
// сервер сам вставляет `from` при релее (см. room.ts).

export type PlayerAction = 'play' | 'pause' | 'seek' | 'rate';

/** client → server: вход в комнату; несёт имя устройства для roster. */
export interface JoinMessage {
  type: 'JOIN';
  room: string;
  name: string;
}

/** Одна строка roster. `id` — connId участника. Присутствует в ROSTER.peers. */
export interface RosterPeer {
  id: number;
  name: string;
  isHost: boolean;
  hasControl: boolean;
  detached: boolean;
  buffering?: boolean;
  ad?: boolean;
}

/** server → client при ЛЮБОМ изменении roster (join/leave/host/control/mode).
 *  `peers` включает ВСЕХ, себя в том числе. `self` говорит клиенту, какой id — его.
 *  Join/left клиент выводит diff-ом последовательных ROSTER (PEER удалён). */
export interface RosterMessage {
  type: 'ROSTER';
  self: number;
  peers: RosterPeer[];
}

/** Команда плеера — основная единица синхронизации.
 *  `paused` — снимок play/pause отправителя (политика last-writer-wins, см. CLAUDE.md инвариант 4).
 *  `to?`  — направленная отправка (host → один connId), для снапшотов. Ставит клиент.
 *  `from?`— connId отправителя, ВСТАВЛЯЕТСЯ СЕРВЕРОМ при релее. На хопе client→server отсутствует. */
export interface StateMessage {
  revision?: number;
  pauseOnly?: boolean;
  pageUrl?: string;
  mediaSig?: string;
  type: 'STATE';
  action: PlayerAction;
  currentTime: number;
  rate?: number;
  paused: boolean;
  ts: number;
  to?: number;
  from?: number;
}

/** host → server. Выдать/забрать право управления у участника. */
export interface ControlMessage {
  type: 'CONTROL';
  action: 'grant' | 'revoke';
  target: number;
}

/** client → server. Переключить соло/синхрон (detach). Сервер правит roster и рассылает ROSTER. */
export interface ModeMessage {
  type: 'MODE';
  detached: boolean;
}

/** server → host. «Запушь STATE-снапшот участнику `target`.»
 *  Шлётся при новом join и при un-detach. Host отвечает STATE{...,to:target}. */
export interface SnapshotReqMessage {
  revision?: number;
  type: 'SNAPSHOT_REQ';
  target: number;
}

/** Буферизация. `from` вставляет сервер при релее. */
export interface BufferMessage {
  type: 'BUFFER';
  buffering: boolean;
  currentTime: number;
  ts: number;
  from?: number;
}

/** Heartbeat коррекции дрейфа — шлёт ТОЛЬКО host. `from` вставляет сервер. */
export interface BeatMessage {
  revision?: number;
  pageUrl?: string;
  mediaSig?: string;
  type: 'BEAT';
  currentTime: number;
  playing: boolean;
  ts: number;
  from?: number;
}

/** Граница рекламы у отправителя. `from` вставляет сервер при релее. */
export interface AdMessage {
  type: 'AD';
  ad: boolean;
  ts: number;
  from?: number;
}

/** Синхрон идентичности контента (Фаза 2/3). `scope:'page'` — URL страницы вкладки
 *  (аниме-сайты меняют серию сменой адреса, напр. jut.su); `scope:'player'` — выбор
 *  внутри плеера без смены URL (Kodik: серия/сезон/озвучка в `sig`). Направленный `to`
 *  (host→новичку в снапшоте) выставляет клиент; `from` вставляет сервер при релее.
 *  Одно из `url`/`sig` по scope: page → `url` (≤2048), player → `sig` (≤512). */
export interface NavMessage {
  revision?: number;
  type: 'NAV';
  scope: 'page' | 'player';
  url?: string;
  sig?: string;
  ts: number;
  to?: number;
  from?: number;
}

/** guest → server: «прошу право управления». Сервер релеит ТОЛЬКО текущему host,
 *  вставляя `from` = connId просителя. Host решает (жмёт CONTROL grant на его строке). */
export interface RequestControlMessage {
  type: 'REQUEST_CONTROL';
  from?: number; // ВСТАВЛЯЕТ СЕРВЕР при релее host'у; на хопе client→server отсутствует.
}

/** Быстрое сообщение / чат (Фаза 0.7.0). Социальный сигнал — сервер релеит его ВСЕМ БЕЗ
 *  гейта прав/detach (соло-зритель тоже общается). Передаётся `code` (ключ каталога,
 *  получатель рендерит локализованный текст+эмодзи; неизвестный код молча игнорируется —
 *  forward-compat) И/ИЛИ свободный `text` (шаблон будущего текстового чата). Минимум одно
 *  из них. `from` вставляет сервер при релее. `ts` — стенные часы отправителя, для позиции
 *  НЕ используется (получатель штампует своё Date.now()); держим для совместимости формы. */
export interface ChatMessage {
  type: 'CHAT';
  code?: string;
  text?: string;
  ts: number;
  from?: number;
}
export const CHAT_CODE_MAX = 32;
export const CHAT_TEXT_MAX = 200;

/** WS keepalive против засыпания SW. Сервер ПОГЛОЩАЕТ его и НЕ релеит. */
export interface PingMessage {
  type: 'PING';
  ts: number;
}

export type ClientMessage =
  | JoinMessage
  | StateMessage
  | ControlMessage
  | ModeMessage
  | RequestControlMessage
  | BufferMessage
  | BeatMessage
  | AdMessage
  | NavMessage
  | ChatMessage
  | PingMessage;

export type ServerMessage =
  | RosterMessage
  | StateMessage
  | SnapshotReqMessage
  | RequestControlMessage
  | BufferMessage
  | BeatMessage
  | AdMessage
  | NavMessage
  | ChatMessage;

export type WireMessage = ClientMessage | ServerMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Валидация на границе (используется сервером; тот же валидатор, что мы отгружаем).
// Никогда не доверяем произвольному входу: строка → JSON.parse → объект с known type
// → каждое поле нужного примитива. Всё «не то» → null. `from`, присланный клиентом,
// не доверяется на уровне сервера (перезаписывается при релее); здесь просто пропускаем
// его как опциональное число, если оно синтаксически валидно.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_WIRE_LENGTH = 8192;
export const MAX_ROOM_LENGTH = 128;
export const MAX_NAME_LENGTH = 64;
export const validRoom = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const validTime = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 31536000;
const validRevision = (v: unknown): boolean => v === undefined || (Number.isSafeInteger(v) && (v as number) >= 0);
const validUrl = (v: unknown): v is string => {
  if (!isStr(v) || v.length > 2048) return false;
  try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
};

const ACTIONS: ReadonlySet<string> = new Set(['play', 'pause', 'seek', 'rate']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}
/** optional finite number: absent → ok, present → must be finite. */
function optNum(v: unknown): boolean {
  return v === undefined || isNum(v);
}
/** optional integer connId. */
function optInt(v: unknown): boolean {
  return v === undefined || isInt(v);
}

function validRosterPeer(v: unknown): v is RosterPeer {
  return (
    isObj(v) &&
    isInt(v.id) &&
    isStr(v.name) && v.name.length <= MAX_NAME_LENGTH &&
    isBool(v.isHost) &&
    isBool(v.hasControl) &&
    isBool(v.detached) && (v.buffering === undefined || isBool(v.buffering)) && (v.ad === undefined || isBool(v.ad))
  );
}

/**
 * Валидирует один wire-message. Принимает сырую строку (WebSocket frame) ИЛИ уже
 * распарсенный объект. Возвращает типизированное сообщение или null.
 */
export function parseWire(raw: unknown): WireMessage | null {
  let obj: unknown = raw;
  if (isStr(raw)) {
    if (raw.length > MAX_WIRE_LENGTH) return null;
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObj(obj) || !isStr(obj.type)) return null;

  if (!validRevision(obj.revision)) return null;
  const revision = obj.revision === undefined ? {} : { revision: obj.revision as number };
  if (obj.pageUrl !== undefined && !validUrl(obj.pageUrl)) return null;
  if (obj.mediaSig !== undefined && (!isStr(obj.mediaSig) || obj.mediaSig.length > 512)) return null;
  const content = {
    ...(obj.pageUrl === undefined ? {} : { pageUrl: obj.pageUrl as string }),
    ...(obj.mediaSig === undefined ? {} : { mediaSig: obj.mediaSig as string }),
  };
  switch (obj.type) {
    case 'JOIN':
      return validRoom(obj.room) && isStr(obj.name) && obj.name.length <= MAX_NAME_LENGTH
        ? { type: 'JOIN', room: obj.room, name: obj.name }
        : null;

    case 'STATE':
      if (
        !isStr(obj.action) ||
        !ACTIONS.has(obj.action) ||
        !validTime(obj.currentTime) ||
        !isBool(obj.paused) ||
        !isNum(obj.ts) ||
        !(obj.rate === undefined || (isNum(obj.rate) && obj.rate >= 0.25 && obj.rate <= 4)) ||
        (obj.action === 'play' && obj.paused !== false) ||
        (obj.action === 'pause' && obj.paused !== true) ||
        (obj.pauseOnly !== undefined && !isBool(obj.pauseOnly)) ||
        !optInt(obj.to) ||
        !optInt(obj.from)
      ) {
        return null;
      }
      return {
        type: 'STATE', ...revision, ...content,
        ...(obj.pauseOnly === undefined ? {} : { pauseOnly: obj.pauseOnly as boolean }),
        action: obj.action as PlayerAction,
        currentTime: obj.currentTime,
        paused: obj.paused,
        ts: obj.ts,
        ...(obj.rate !== undefined ? { rate: obj.rate as number } : {}),
        ...(obj.to !== undefined ? { to: obj.to as number } : {}),
        ...(obj.from !== undefined ? { from: obj.from as number } : {}),
      };

    case 'CONTROL':
      return (obj.action === 'grant' || obj.action === 'revoke') && isInt(obj.target)
        ? { type: 'CONTROL', action: obj.action, target: obj.target }
        : null;

    case 'MODE':
      return isBool(obj.detached) ? { type: 'MODE', detached: obj.detached } : null;

    case 'SNAPSHOT_REQ':
      return isInt(obj.target) ? { type: 'SNAPSHOT_REQ', target: obj.target, ...revision } : null;

    case 'ROSTER': {
      if (!isInt(obj.self) || !Array.isArray(obj.peers) || obj.peers.length > 10 || new Set(obj.peers.map((p: any) => p?.id)).size !== obj.peers.length) return null;
      if (!obj.peers.every(validRosterPeer)) return null;
      return { type: 'ROSTER', self: obj.self, peers: obj.peers as RosterPeer[] };
    }

    case 'BUFFER':
      return isBool(obj.buffering) && validTime(obj.currentTime) && isNum(obj.ts) && optInt(obj.from)
        ? {
            type: 'BUFFER',
            buffering: obj.buffering,
            currentTime: obj.currentTime,
            ts: obj.ts,
            ...(obj.from !== undefined ? { from: obj.from as number } : {}),
          }
        : null;

    case 'BEAT':
      return validTime(obj.currentTime) && isBool(obj.playing) && isNum(obj.ts) && optInt(obj.from)
        ? {
            type: 'BEAT', ...revision, ...content,
            currentTime: obj.currentTime,
            playing: obj.playing,
            ts: obj.ts,
            ...(obj.from !== undefined ? { from: obj.from as number } : {}),
          }
        : null;

    case 'AD':
      return isBool(obj.ad) && isNum(obj.ts) && optInt(obj.from)
        ? {
            type: 'AD',
            ad: obj.ad,
            ts: obj.ts,
            ...(obj.from !== undefined ? { from: obj.from as number } : {}),
          }
        : null;

    case 'NAV': {
      // scope из allowlist; page → url (≤2048), player → sig (≤512). Схему http/https
      // проверяют И сервер (decide), И клиент при применении (normalizeSyncUrl). Строим
      // объект строго по scope — лишнее поле другого scope не проносим.
      if ((obj.scope !== 'page' && obj.scope !== 'player') || !isNum(obj.ts) || !optInt(obj.to) || !optInt(obj.from)) {
        return null;
      }
      const tail = {
        ts: obj.ts, ...revision,
        ...(obj.to !== undefined ? { to: obj.to as number } : {}),
        ...(obj.from !== undefined ? { from: obj.from as number } : {}),
      };
      if (obj.scope === 'page') {
        return validUrl(obj.url)
          ? { type: 'NAV', scope: 'page', url: obj.url, ...tail }
          : null;
      }
      return isStr(obj.sig) && obj.sig.length <= 512
        ? { type: 'NAV', scope: 'player', sig: obj.sig, ...tail }
        : null;
    }

    case 'REQUEST_CONTROL':
      return optInt(obj.from)
        ? { type: 'REQUEST_CONTROL', ...(obj.from !== undefined ? { from: obj.from as number } : {}) }
        : null;

    case 'CHAT': {
      // Быстрое сообщение (code) и/или свободный текст. Минимум одно из них; капы длин;
      // from пропускаем как опциональный int (перезапишет сервер). Строгая сборка (паттерн BUFFER).
      if (!isNum(obj.ts) || !optInt(obj.from)) return null;
      const hasCode = obj.code !== undefined;
      const hasText = obj.text !== undefined;
      if (!hasCode && !hasText) return null;
      if (hasCode && (!isStr(obj.code) || (!obj.code.trim() || obj.code.length > CHAT_CODE_MAX))) return null;
      if (hasText && (!isStr(obj.text) || (!obj.text.trim() || obj.text.length > CHAT_TEXT_MAX))) return null;
      return {
        type: 'CHAT',
        ...(hasCode ? { code: obj.code as string } : {}),
        ...(hasText ? { text: obj.text as string } : {}),
        ts: obj.ts,
        ...(obj.from !== undefined ? { from: obj.from as number } : {}),
      };
    }

    case 'PING':
      return isNum(obj.ts) ? { type: 'PING', ts: obj.ts } : null;

    default:
      return null;
  }
}
