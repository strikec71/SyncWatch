// Юнит-тесты реестра сессий по вкладкам (background/state.ts): getSession создаёт/
// переиспользует по tabId, forgetSession изолирует, и — главное — две сессии НЕ делят
// состояние (room/roster/myConnId). Это ядро независимости вкладок.

import { describe, it, expect, afterEach } from 'vitest';
import {
  getSession,
  peekSession,
  forgetSession,
  allSessions,
  amHost,
  amController,
  livePeers,
} from '../src/background/state';
import type { RosterPeer } from '../src/shared/protocol';

function rp(id: number, over: Partial<RosterPeer> = {}): RosterPeer {
  return { id, name: `p${id}`, isHost: false, hasControl: false, detached: false, ...over };
}

afterEach(() => {
  for (const s of allSessions()) forgetSession(s.tabId);
});

describe('реестр сессий по вкладкам', () => {
  it('getSession создаёт сессию с дефолтами и tabId-ключом', () => {
    const s = getSession(10);
    expect(s.tabId).toBe(10);
    expect(s.room).toBe('');
    expect(s.myConnId).toBe(-1);
    expect(s.connected).toBe(false);
    expect(s.roster.size).toBe(0);
  });

  it('getSession переиспользует ту же сессию для одного tabId', () => {
    const a = getSession(10);
    a.room = 'ABC';
    const b = getSession(10);
    expect(b).toBe(a);
    expect(b.room).toBe('ABC');
  });

  it('разные вкладки — разные сессии, состояние изолировано', () => {
    const a = getSession(1);
    const b = getSession(2);
    expect(a).not.toBe(b);

    a.room = 'ROOM-A';
    a.myConnId = 5;
    a.roster.set(5, rp(5, { isHost: true }));

    // Вкладка B не видит комнату/roster/self вкладки A.
    expect(b.room).toBe('');
    expect(b.myConnId).toBe(-1);
    expect(b.roster.size).toBe(0);
  });

  it('селекторы читают только свою сессию', () => {
    const a = getSession(1);
    const b = getSession(2);
    a.myConnId = 5;
    a.roster.set(5, rp(5, { isHost: true }));
    a.roster.set(6, rp(6));
    b.myConnId = 7;
    b.roster.set(7, rp(7, { hasControl: true }));

    expect(amHost(a)).toBe(true);       // 5 — host в A
    expect(amController(a)).toBe(true); // host ⇒ controller
    expect(livePeers(a).map((p) => p.id)).toEqual([6]); // кроме себя

    expect(amHost(b)).toBe(false);      // 7 не host
    expect(amController(b)).toBe(true); // но hasControl
    expect(livePeers(b)).toHaveLength(0);
  });

  it('forgetSession убирает вкладку из реестра', () => {
    getSession(1);
    getSession(2);
    expect(allSessions().map((s) => s.tabId).sort()).toEqual([1, 2]);
    forgetSession(1);
    expect(peekSession(1)).toBeUndefined();
    expect(allSessions().map((s) => s.tabId)).toEqual([2]);
  });

  it('peekSession не создаёт сессию', () => {
    expect(peekSession(99)).toBeUndefined();
    expect(allSessions()).toHaveLength(0);
  });
});
