// Durable Object «Presence»: HTTP-хаб статуса «друзья онлайн». НЕ трогает WebSocket-релей
// (room.ts) — presence идёт отдельным HTTP JSON к тому же Worker. Вся логика решений —
// в presenceLogic.ts (чисто, тестируемо). Здесь только обвязка: разбор POST-тела, доступ
// к state.storage (SQLite-KV, бесплатный тариф), ленивый прунинг по TTL.
//
// Приватность: единственный инстанс (idFromName('v1')); записи — непрозрачный per-install
// UUID → { комната, имя устройства }, TTL ~2.5 мин; соц-граф (список друзей) на сервере
// НЕ хранится. Видимость взаимная: статус отдаётся только тем, кого пользователь сам
// прислал в `allow` (sha256 их clientId).

import {
  parsePresenceBeat,
  parsePresenceQuery,
  parsePresenceFriend,
} from '../../extension/src/shared/presence';
import type { InboxMsg } from '../../extension/src/shared/presence';
import {
  PRESENCE_TTL_MS,
  INBOX_TTL_MS,
  prunePresence,
  pruneInbox,
  visibleView,
  dedupInbox,
} from './presenceLogic';
import type { PresenceRecord } from './presenceLogic';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export class Presence {
  constructor(private state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return bad();

    const parts = new URL(request.url).pathname.split('/').filter(Boolean); // ['presence','beat']
    const action = parts[1] ?? '';

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return bad();
    }

    await this.prune();

    switch (action) {
      case 'beat':
        return this.beat(body);
      case 'query':
        return this.query(body);
      case 'friend':
        return this.friend(body);
      default:
        return bad();
    }
  }

  /** Ленивый прунинг при каждом обращении: presence по PRESENCE_TTL_MS, inbox по INBOX_TTL_MS.
   *  Два list-скана на запрос — дёшево при масштабе проекта (десятки-сотни записей). */
  private async prune(): Promise<void> {
    const now = Date.now();

    const pres = await this.state.storage.list<PresenceRecord>({ prefix: 'presence:' });
    const keptPres = prunePresence(pres, now, PRESENCE_TTL_MS);
    for (const k of pres.keys()) if (!keptPres.has(k)) await this.state.storage.delete(k);

    const inb = await this.state.storage.list<InboxMsg[]>({ prefix: 'inbox:' });
    const keptInb = pruneInbox(inb, now, INBOX_TTL_MS);
    for (const [k, list] of inb) {
      const next = keptInb.get(k);
      if (!next) await this.state.storage.delete(k);
      else if (next.length !== list.length) await this.state.storage.put(k, next);
    }
  }

  /** POST /presence/beat: upsert записи presence. `room:''` = онлайн вне комнаты. */
  private async beat(body: unknown): Promise<Response> {
    const b = parsePresenceBeat(body);
    if (!b) return bad();
    const rec: PresenceRecord = {
      room: b.room,
      deviceName: b.deviceName,
      at: Date.now(),
      allow: b.allow,
    };
    await this.state.storage.put(`presence:${b.clientId}`, rec);
    return ok();
  }

  /** POST /presence/query: статус друзей по взаимному гейту + дренаж инбокса вызывающего. */
  private async query(body: unknown): Promise<Response> {
    const q = parsePresenceQuery(body);
    if (!q) return bad();

    const callerHash = await sha256Hex(q.clientId);
    const views: Record<string, ReturnType<typeof visibleView>> = {};
    for (const fid of q.friendIds) {
      const rec = await this.state.storage.get<PresenceRecord>(`presence:${fid}`);
      views[fid] = visibleView(rec, callerHash);
    }

    const inboxKey = `inbox:${q.clientId}`;
    const inbox = (await this.state.storage.get<InboxMsg[]>(inboxKey)) ?? [];
    if (inbox.length > 0) await this.state.storage.delete(inboxKey);

    return jsonBody({ views, inbox });
  }

  /** POST /presence/friend: «<from> принял запрос» → в инбокс <to>, дедуп по from. */
  private async friend(body: unknown): Promise<Response> {
    const f = parsePresenceFriend(body);
    if (!f) return bad();
    const key = `inbox:${f.to}`;
    const list = (await this.state.storage.get<InboxMsg[]>(key)) ?? [];
    const msg: InboxMsg = { from: f.from, fromName: f.fromName, kind: 'accept', ts: Date.now() };
    await this.state.storage.put(key, dedupInbox(list, msg));
    return ok();
  }
}

/** sha256 в hex — для взаимного гейта: sha256(callerClientId) сверяется с record.allow. */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ok(): Response {
  return new Response('{"ok":true}', { headers: JSON_HEADERS });
}
function jsonBody(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { headers: JSON_HEADERS });
}
function bad(): Response {
  return new Response('{"error":"bad request"}', { status: 400, headers: JSON_HEADERS });
}
