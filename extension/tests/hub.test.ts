// Юнит-тесты чистых функций хаба (background/*). Ни браузера, ни WS: только детерминированные
// селекторы/агрегаторы. webextension-polyfill алиасен на стаб (см. vitest.config.ts).
//   connection.ts → computeBackoff (реконнект-бэкофф с джиттером, без предела попыток)
//   sync.ts       → isEcho (анти-эхо), canEmit (гейтинг прав + detach, size-aware)
//   roster.ts     → diffRoster (join/left), aggregateBanner (баннер, detached исключены)
//   state.ts      → computeAmHost/computeAmController (зеркала host/control) + константы

import { describe, it, expect } from 'vitest';
import {
  BACKOFF_BASE,
  BACKOFF_CAP,
  BACKOFF_JITTER,
  ECHO_EPSILON,
  WATCHDOG_SILENCE_MS,
  computeAmHost,
  computeAmController,
  emptyBlock,
  type PeerBlock,
} from '../src/background/state';
import { computeBackoff, reconnectDecision } from '../src/background/connection';
import { isEcho, canEmit } from '../src/background/sync';
import { diffRoster, aggregateBanner } from '../src/background/roster';
import type { RosterPeer } from '../src/shared/protocol';

// ── helpers ───────────────────────────────────────────────────────────────────

function rp(id: number, over: Partial<RosterPeer> = {}): RosterPeer {
  return { id, name: `p${id}`, isHost: false, hasControl: false, detached: false, ...over };
}
function rosterMap(...peers: RosterPeer[]): Map<number, RosterPeer> {
  return new Map(peers.map((p) => [p.id, p]));
}
function block(over: Partial<PeerBlock> = {}): PeerBlock {
  return { ...emptyBlock(), ...over };
}

// ── constants (contract with tests per coder-hub handoff) ────────────────────

describe('hub constants', () => {
  it('match the documented Phase-A contract', () => {
    expect(ECHO_EPSILON).toBe(0.5);
    expect(BACKOFF_BASE).toBe(1000);
    expect(BACKOFF_CAP).toBe(30000);
    expect(BACKOFF_JITTER).toBe(1000);
    expect(WATCHDOG_SILENCE_MS).toBe(45000);
  });
});

// ── computeBackoff ────────────────────────────────────────────────────────────

describe('computeBackoff', () => {
  it('is exponential with rand=0: min(CAP, BASE*2^attempt)', () => {
    expect(computeBackoff(0, 0)).toBe(1000);
    expect(computeBackoff(1, 0)).toBe(2000);
    expect(computeBackoff(2, 0)).toBe(4000);
    expect(computeBackoff(3, 0)).toBe(8000);
    expect(computeBackoff(4, 0)).toBe(16000);
  });

  it('caps the exponential term at BACKOFF_CAP (unlimited attempts, bounded delay)', () => {
    expect(computeBackoff(5, 0)).toBe(30000); // 32000 → capped
    expect(computeBackoff(50, 0)).toBe(30000);
    expect(computeBackoff(1000, 0)).toBe(30000);
  });

  it('clamps negative attempts to 0', () => {
    expect(computeBackoff(-5, 0)).toBe(1000);
  });

  it('adds jitter within [0, BACKOFF_JITTER)', () => {
    // rand just below 1 → +999 (floor of rand*1000).
    expect(computeBackoff(0, 0.9999)).toBe(1999);
    expect(computeBackoff(0, 0.5)).toBe(1500);
  });

  it('always lands in [exp, exp+JITTER) for the default random source', () => {
    for (let attempt = 0; attempt <= 8; attempt++) {
      const exp = Math.min(BACKOFF_CAP, BACKOFF_BASE * 2 ** attempt);
      for (let i = 0; i < 200; i++) {
        const d = computeBackoff(attempt);
        expect(d).toBeGreaterThanOrEqual(exp);
        expect(d).toBeLessThan(exp + BACKOFF_JITTER);
      }
    }
  });
});

// ── reconnectDecision (персистентный alarm-фолбэк реконнекта) ───────────────────

describe('reconnectDecision', () => {
  const base = {
    intentionalClose: false,
    autoConnect: true,
    room: 'abc',
    connected: false,
    timerPending: false,
  };

  it('connect: должны быть на связи, но не на связи и быстрый setTimeout не ждёт', () => {
    expect(reconnectDecision(base)).toBe('connect');
  });

  it('wait: быстрый setTimeout ещё запланирован (SW жив) — не мешаем', () => {
    expect(reconnectDecision({ ...base, timerPending: true })).toBe('wait');
  });

  it('clear: уже на связи', () => {
    expect(reconnectDecision({ ...base, connected: true })).toBe('clear');
  });

  it('clear: намеренный disconnect', () => {
    expect(reconnectDecision({ ...base, intentionalClose: true })).toBe('clear');
  });

  it('clear: авто-коннект выключен или нет комнаты', () => {
    expect(reconnectDecision({ ...base, autoConnect: false })).toBe('clear');
    expect(reconnectDecision({ ...base, room: '' })).toBe('clear');
  });

  it('clear доминирует над timerPending (интент важнее ожидания)', () => {
    expect(reconnectDecision({ ...base, connected: true, timerPending: true })).toBe('clear');
    expect(reconnectDecision({ ...base, intentionalClose: true, timerPending: true })).toBe('clear');
  });
});

// ── isEcho ────────────────────────────────────────────────────────────────────

describe('isEcho', () => {
  it('is false when there is no lastSync', () => {
    expect(isEcho(null, 'play', 10, ECHO_EPSILON)).toBe(false);
  });

  it('is true when action matches and time is within epsilon', () => {
    expect(isEcho({ action: 'play', currentTime: 10 }, 'play', 10.4, ECHO_EPSILON)).toBe(true);
    expect(isEcho({ action: 'seek', currentTime: 10 }, 'seek', 9.6, ECHO_EPSILON)).toBe(true);
  });

  it('is false when the action differs', () => {
    expect(isEcho({ action: 'play', currentTime: 10 }, 'pause', 10, ECHO_EPSILON)).toBe(false);
  });

  it('is false when time drift meets/exceeds epsilon', () => {
    expect(isEcho({ action: 'play', currentTime: 10 }, 'play', 10.5, ECHO_EPSILON)).toBe(false);
    expect(isEcho({ action: 'play', currentTime: 10 }, 'play', 12, ECHO_EPSILON)).toBe(false);
  });
});

// ── canEmit (control gating, size-aware, detach) ─────────────────────────────

describe('canEmit', () => {
  it('never emits while detached — even pause', () => {
    expect(canEmit('pause', { amController: true, detached: true, size: 2 })).toBe(false);
    expect(canEmit('play', { amController: true, detached: true, size: 2 })).toBe(false);
  });

  it('always allows pause when not detached (any size, non-controller)', () => {
    expect(canEmit('pause', { amController: false, detached: false, size: 10 })).toBe(true);
    expect(canEmit('pause', { amController: false, detached: false, size: 2 })).toBe(true);
  });

  it('is symmetric in a room of ≤2: anyone may emit play/seek/rate', () => {
    for (const a of ['play', 'seek', 'rate'] as const) {
      expect(canEmit(a, { amController: false, detached: false, size: 2 })).toBe(true);
      expect(canEmit(a, { amController: false, detached: false, size: 1 })).toBe(true);
    }
  });

  it('in a room of ≥3, gates play/seek/rate on being controller', () => {
    for (const a of ['play', 'seek', 'rate'] as const) {
      expect(canEmit(a, { amController: false, detached: false, size: 3 })).toBe(false);
      expect(canEmit(a, { amController: true, detached: false, size: 3 })).toBe(true);
    }
  });

  it('mirrors the server gate: same result as the ≥3 permission matrix', () => {
    // controller can seek at size 5; plain peer cannot; either can pause.
    expect(canEmit('seek', { amController: true, detached: false, size: 5 })).toBe(true);
    expect(canEmit('seek', { amController: false, detached: false, size: 5 })).toBe(false);
    expect(canEmit('pause', { amController: false, detached: false, size: 5 })).toBe(true);
  });
});

// ── computeAmHost / computeAmController ──────────────────────────────────────

describe('host / controller mirrors', () => {
  it('computeAmHost is true only when isHost', () => {
    expect(computeAmHost(undefined)).toBe(false);
    expect(computeAmHost(rp(1))).toBe(false);
    expect(computeAmHost(rp(1, { isHost: true }))).toBe(true);
  });

  it('computeAmController is true for host OR granted control', () => {
    expect(computeAmController(undefined)).toBe(false);
    expect(computeAmController(rp(1))).toBe(false);
    expect(computeAmController(rp(1, { isHost: true }))).toBe(true);
    expect(computeAmController(rp(1, { hasControl: true }))).toBe(true);
  });
});

// ── diffRoster ────────────────────────────────────────────────────────────────

describe('diffRoster', () => {
  it('reports newcomers as joined', () => {
    const prev = rosterMap(rp(1));
    const { joined, left } = diffRoster(prev, [rp(1), rp(2)]);
    expect(joined.map((p) => p.id)).toEqual([2]);
    expect(left).toEqual([]);
  });

  it('reports departures as left', () => {
    const prev = rosterMap(rp(1), rp(2), rp(3));
    const { joined, left } = diffRoster(prev, [rp(1), rp(3)]);
    expect(joined).toEqual([]);
    expect(left.map((p) => p.id)).toEqual([2]);
  });

  it('reports simultaneous join and leave', () => {
    const prev = rosterMap(rp(1), rp(2));
    const { joined, left } = diffRoster(prev, [rp(1), rp(3)]);
    expect(joined.map((p) => p.id)).toEqual([3]);
    expect(left.map((p) => p.id)).toEqual([2]);
  });

  it('reports no change when rosters match', () => {
    const prev = rosterMap(rp(1), rp(2));
    const { joined, left } = diffRoster(prev, [rp(2), rp(1)]);
    expect(joined).toEqual([]);
    expect(left).toEqual([]);
  });
});

// ── aggregateBanner ───────────────────────────────────────────────────────────

describe('aggregateBanner', () => {
  const SELF = 1;

  it('is "none" when no peer is blocked', () => {
    const roster = rosterMap(rp(SELF), rp(2));
    const blocks = new Map<number, PeerBlock>();
    expect(aggregateBanner(blocks, roster, SELF)).toEqual({ state: 'none', since: 0, name: '' });
  });

  it('excludes self from the aggregation', () => {
    const roster = rosterMap(rp(SELF), rp(2));
    const blocks = new Map<number, PeerBlock>([[SELF, block({ paused: true })]]);
    expect(aggregateBanner(blocks, roster, SELF).state).toBe('none');
  });

  it('excludes DETACHED peers (detach removes them from buffer/ad waiting)', () => {
    const roster = rosterMap(rp(SELF), rp(2, { detached: true }));
    const blocks = new Map<number, PeerBlock>([[2, block({ ad: true, adSince: 111 })]]);
    expect(aggregateBanner(blocks, roster, SELF).state).toBe('none');
  });

  it('surfaces a paused peer with their name', () => {
    const roster = rosterMap(rp(SELF), rp(2, { name: 'Bob' }));
    const blocks = new Map<number, PeerBlock>([[2, block({ paused: true })]]);
    expect(aggregateBanner(blocks, roster, SELF)).toEqual({ state: 'peer-paused', since: 0, name: 'Bob' });
  });

  it('prioritises ad > buffer > paused across peers', () => {
    const roster = rosterMap(rp(SELF), rp(2), rp(3), rp(4));
    const blocks = new Map<number, PeerBlock>([
      [2, block({ paused: true })],
      [3, block({ buffer: true })],
      [4, block({ ad: true, adSince: 500 })],
    ]);
    const out = aggregateBanner(blocks, roster, SELF);
    expect(out.state).toBe('peer-ad');
    expect(out.name).toBe('p4');
    expect(out.since).toBe(500); // adSince carried through for the count-up timer
  });

  it('falls back to buffer when no one is on an ad', () => {
    const roster = rosterMap(rp(SELF), rp(2), rp(3));
    const blocks = new Map<number, PeerBlock>([
      [2, block({ paused: true })],
      [3, block({ buffer: true })],
    ]);
    expect(aggregateBanner(blocks, roster, SELF).state).toBe('peer-buffer');
  });

  it('breaks ties by ascending connId (deterministic)', () => {
    const roster = rosterMap(rp(SELF), rp(5, { name: 'five' }), rp(3, { name: 'three' }));
    const blocks = new Map<number, PeerBlock>([
      [5, block({ ad: true, adSince: 5 })],
      [3, block({ ad: true, adSince: 3 })],
    ]);
    const out = aggregateBanner(blocks, roster, SELF);
    expect(out.name).toBe('three'); // connId 3 < 5
    expect(out.since).toBe(3);
  });

  it('carries since only for the ad state, not paused/buffer', () => {
    const roster = rosterMap(rp(SELF), rp(2));
    const blocks = new Map<number, PeerBlock>([[2, block({ buffer: true, adSince: 999 })]]);
    expect(aggregateBanner(blocks, roster, SELF).since).toBe(0);
  });
});
