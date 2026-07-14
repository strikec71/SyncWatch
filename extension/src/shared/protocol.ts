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
  | PingMessage;

export type ServerMessage =
  | RosterMessage
  | StateMessage
  | SnapshotReqMessage
  | RequestControlMessage
  | BufferMessage
  | BeatMessage
  | AdMessage
  | NavMessage;

export type WireMessage = ClientMessage | ServerMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Валидация на границе (используется сервером; тот же валидатор, что мы отгружаем).
// Никогда не доверяем произвольному входу: строка → JSON.parse → объект с known type
// → каждое поле нужного примитива. Всё «не то» → null. `from`, присланный клиентом,
// не доверяется на уровне сервера (перезаписывается при релее); здесь просто пропускаем
// его как опциональное число, если оно синтаксически валидно.
// ─────────────────────────────────────────────────────────────────────────────

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
  return typeof v === 'number' && Number.isInteger(v);
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
    isStr(v.name) &&
    isBool(v.isHost) &&
    isBool(v.hasControl) &&
    isBool(v.detached)
  );
}

/**
 * Валидирует один wire-message. Принимает сырую строку (WebSocket frame) ИЛИ уже
 * распарсенный объект. Возвращает типизированное сообщение или null.
 */
export function parseWire(raw: unknown): WireMessage | null {
  let obj: unknown = raw;
  if (isStr(raw)) {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObj(obj) || !isStr(obj.type)) return null;

  switch (obj.type) {
    case 'JOIN':
      return isStr(obj.room) && isStr(obj.name)
        ? { type: 'JOIN', room: obj.room, name: obj.name }
        : null;

    case 'STATE':
      if (
        !isStr(obj.action) ||
        !ACTIONS.has(obj.action) ||
        !isNum(obj.currentTime) ||
        !isBool(obj.paused) ||
        !isNum(obj.ts) ||
        !optNum(obj.rate) ||
        !optInt(obj.to) ||
        !optInt(obj.from)
      ) {
        return null;
      }
      return {
        type: 'STATE',
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
      return isInt(obj.target) ? { type: 'SNAPSHOT_REQ', target: obj.target } : null;

    case 'ROSTER': {
      if (!isInt(obj.self) || !Array.isArray(obj.peers)) return null;
      if (!obj.peers.every(validRosterPeer)) return null;
      return { type: 'ROSTER', self: obj.self, peers: obj.peers as RosterPeer[] };
    }

    case 'BUFFER':
      return isBool(obj.buffering) && isNum(obj.currentTime) && isNum(obj.ts) && optInt(obj.from)
        ? {
            type: 'BUFFER',
            buffering: obj.buffering,
            currentTime: obj.currentTime,
            ts: obj.ts,
            ...(obj.from !== undefined ? { from: obj.from as number } : {}),
          }
        : null;

    case 'BEAT':
      return isNum(obj.currentTime) && isBool(obj.playing) && isNum(obj.ts) && optInt(obj.from)
        ? {
            type: 'BEAT',
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
        ts: obj.ts,
        ...(obj.to !== undefined ? { to: obj.to as number } : {}),
        ...(obj.from !== undefined ? { from: obj.from as number } : {}),
      };
      if (obj.scope === 'page') {
        return isStr(obj.url) && obj.url.length <= 2048
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

    case 'PING':
      return isNum(obj.ts) ? { type: 'PING', ts: obj.ts } : null;

    default:
      return null;
  }
}
