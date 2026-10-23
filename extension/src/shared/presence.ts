// Единый источник правды по формату presence-сообщений (друзья онлайн, Фаза «друзья»).
// Импортируется и расширением (esbuild), и сервером (wrangler) — как protocol.ts.
//
// Presence идёт по HTTP JSON к тому же Worker, НЕ через WebSocket-релей. Тут — только
// формы тел запросов + валидаторы на границе доверия (паттерн parseWire): строка →
// JSON.parse → объект с known-полями → каждое поле нужного примитива и в пределах капа
// → иначе null. `from`, присланный клиентом в /presence/friend, не доверяется семантически
// (сервер сам знает отправителя по телу — соц-граф на сервере не хранится).

/** client → server (POST /presence/beat): «я онлайн вот в этой комнате».
 *  `room: ''` = онлайн, но не в комнате. `allow` — sha256(clientId друга) в hex:
 *  кому этот пользователь разрешил видеть себя (взаимный гейт). */
export interface PresenceBeat {
  clientId: string;
  room: string;
  deviceName: string;
  allow: string[];
}

/** client → server (POST /presence/query): «покажи статус этих друзей + мой инбокс». */
export interface PresenceQuery {
  clientId: string;
  friendIds: string[];
}

/** server → client: статус одного друга. Отдаётся, только если наш sha256 ∈ его `allow`,
 *  иначе offline-заглушка (утёкшая friend-ссылка не даёт слежки). */
export interface PresenceView {
  online: boolean;
  room: string;
  deviceName: string;
}

/** Входящее в инбоксе: «<from> принял ваш запрос в друзья» → авто-добавление у инициатора. */
export interface InboxMsg {
  from: string;
  fromName: string;
  kind: 'accept';
  ts: number;
}

/** Ответ на POST /presence/query. */
export interface PresenceQueryResult {
  views: Record<string, PresenceView>;
  inbox: InboxMsg[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Валидация на границе. Никогда не доверяем произвольному входу.
// ─────────────────────────────────────────────────────────────────────────────

const CLIENT_ID_MAX = 64;
const DEVICE_NAME_MAX = 64;
const ROOM_MAX = 128;
const ARRAY_MAX = 64;
const HEX64 = /^[0-9a-f]{64}$/;

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Сырая строка (WebSocket/HTTP-тело) ИЛИ уже распарсенный объект → объект или null. */
function asObj(raw: unknown): Record<string, unknown> | null {
  let v: unknown = raw;
  if (isStr(raw)) {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return isObj(v) ? v : null;
}

/** непустая строка ≤ max */
function id(v: unknown, max: number): v is string {
  return isStr(v) && v.length >= 1 && v.length <= max;
}

export function parsePresenceBeat(raw: unknown): PresenceBeat | null {
  const o = asObj(raw);
  if (!o) return null;
  if (!id(o.clientId, CLIENT_ID_MAX)) return null;
  if (!isStr(o.room) || o.room.length > ROOM_MAX) return null;
  if (!isStr(o.deviceName) || o.deviceName.length > DEVICE_NAME_MAX) return null;
  if (!Array.isArray(o.allow) || o.allow.length > ARRAY_MAX) return null;
  if (!o.allow.every((h) => isStr(h) && HEX64.test(h))) return null;
  return {
    clientId: o.clientId,
    room: o.room,
    deviceName: o.deviceName,
    allow: o.allow as string[],
  };
}

export function parsePresenceQuery(raw: unknown): PresenceQuery | null {
  const o = asObj(raw);
  if (!o) return null;
  if (!id(o.clientId, CLIENT_ID_MAX)) return null;
  if (!Array.isArray(o.friendIds) || o.friendIds.length > ARRAY_MAX) return null;
  if (!o.friendIds.every((s) => id(s, CLIENT_ID_MAX))) return null;
  return { clientId: o.clientId, friendIds: o.friendIds as string[] };
}

export function parsePresenceFriend(
  raw: unknown,
): { from: string; fromName: string; to: string } | null {
  const o = asObj(raw);
  if (!o) return null;
  if (!id(o.from, CLIENT_ID_MAX)) return null;
  if (!id(o.to, CLIENT_ID_MAX)) return null;
  if (!isStr(o.fromName) || o.fromName.length > DEVICE_NAME_MAX) return null;
  return { from: o.from, fromName: o.fromName, to: o.to };
}
