// Юнит-тесты чистой логики presence (server/src/presenceLogic.ts): прунинг presence/inbox
// по TTL, взаимный гейт видимости (sha256 не в allow → скрыт), дедуп инбокса, различение
// «онлайн вне комнаты» (room:'') и «оффлайн» (запись протухла).

import { describe, it, expect } from 'vitest';
import {
  PRESENCE_TTL_MS,
  INBOX_TTL_MS,
  prunePresence,
  pruneInbox,
  visibleView,
  dedupInbox,
} from '../src/presenceLogic';
import type { PresenceRecord } from '../src/presenceLogic';
import type { InboxMsg } from '../../extension/src/shared/presence';

// ── helpers ───────────────────────────────────────────────────────────────────

function rec(over: Partial<PresenceRecord> = {}): PresenceRecord {
  return { room: 'r1', deviceName: 'Ноут', at: 1_000_000, allow: [], ...over };
}
function inbox(from: string, ts: number): InboxMsg {
  return { from, fromName: `имя-${from}`, kind: 'accept', ts };
}
const HASH = 'a'.repeat(64); // условный sha256(caller) в hex

// ── prunePresence ─────────────────────────────────────────────────────────────

describe('prunePresence', () => {
  it('оставляет свежие записи и выкидывает протухшие', () => {
    const now = 1_000_000 + PRESENCE_TTL_MS;
    const map = new Map<string, PresenceRecord>([
      ['fresh', rec({ at: now - 1 })],
      ['stale', rec({ at: now - PRESENCE_TTL_MS - 1 })],
    ]);
    const out = prunePresence(map, now, PRESENCE_TTL_MS);
    expect([...out.keys()]).toEqual(['fresh']);
  });

  it('порог `>=`: ровно ttl назад — уже протухла', () => {
    const now = 5_000_000;
    const map = new Map<string, PresenceRecord>([['edge', rec({ at: now - PRESENCE_TTL_MS })]]);
    expect(prunePresence(map, now, PRESENCE_TTL_MS).size).toBe(0);
  });

  it('возвращает новую Map, вход не мутирует', () => {
    const map = new Map<string, PresenceRecord>([['x', rec({ at: 0 })]]);
    const out = prunePresence(map, 999_999_999, PRESENCE_TTL_MS);
    expect(out).not.toBe(map);
    expect(map.size).toBe(1);
  });
});

// ── pruneInbox ────────────────────────────────────────────────────────────────

describe('pruneInbox', () => {
  it('фильтрует протухшие сообщения внутри списка', () => {
    const now = 10_000_000;
    const map = new Map<string, InboxMsg[]>([
      ['u1', [inbox('old', now - INBOX_TTL_MS - 1), inbox('new', now - 10)]],
    ]);
    const out = pruneInbox(map, now, INBOX_TTL_MS);
    expect(out.get('u1')).toEqual([inbox('new', now - 10)]);
  });

  it('выбрасывает ключ, чей список опустел', () => {
    const now = 10_000_000;
    const map = new Map<string, InboxMsg[]>([['u1', [inbox('old', now - INBOX_TTL_MS - 1)]]]);
    expect(pruneInbox(map, now, INBOX_TTL_MS).has('u1')).toBe(false);
  });

  it('оставляет непустой список как есть', () => {
    const now = 10_000_000;
    const list = [inbox('a', now - 5), inbox('b', now - 6)];
    const out = pruneInbox(new Map([['u1', list]]), now, INBOX_TTL_MS);
    expect(out.get('u1')).toHaveLength(2);
  });
});

// ── visibleView — взаимный гейт ───────────────────────────────────────────────

describe('visibleView', () => {
  it('sha256 вызывающего в allow → полный статус', () => {
    expect(visibleView(rec({ allow: [HASH], room: 'кино' }), HASH)).toEqual({
      online: true,
      room: 'кино',
      deviceName: 'Ноут',
    });
  });

  it('sha256 вызывающего НЕ в allow → offline-заглушка (утёкшая friend-ссылка не следит)', () => {
    expect(visibleView(rec({ allow: ['b'.repeat(64)] }), HASH)).toEqual({
      online: false,
      room: '',
      deviceName: '',
    });
  });

  it('записи нет (протухла/неизвестна) → offline', () => {
    expect(visibleView(undefined, HASH)).toEqual({ online: false, room: '', deviceName: '' });
  });

  it('room:"" при разрешённом доступе → онлайн вне комнаты (не то же, что оффлайн)', () => {
    const idle = visibleView(rec({ allow: [HASH], room: '' }), HASH);
    expect(idle).toEqual({ online: true, room: '', deviceName: 'Ноут' });
    expect(idle.online).toBe(true);
    // Оффлайн отличается именно флагом online.
    expect(visibleView(undefined, HASH).online).toBe(false);
  });
});

// ── dedupInbox ───────────────────────────────────────────────────────────────

describe('dedupInbox', () => {
  it('второе сообщение того же from вытесняет первое (свежее побеждает, длина 1)', () => {
    const list = [inbox('anya', 100)];
    const out = dedupInbox(list, inbox('anya', 200));
    expect(out).toEqual([inbox('anya', 200)]);
  });

  it('сообщение от другого from добавляется в хвост', () => {
    const out = dedupInbox([inbox('anya', 100)], inbox('bob', 200));
    expect(out.map((m) => m.from)).toEqual(['anya', 'bob']);
  });

  it('не мутирует исходный список', () => {
    const list = [inbox('anya', 100)];
    dedupInbox(list, inbox('anya', 200));
    expect(list).toEqual([inbox('anya', 100)]);
  });
});
