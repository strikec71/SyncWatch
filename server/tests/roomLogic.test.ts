// Юнит-тесты чистой логики комнаты (server/src/roomLogic.ts): host-election по
// последовательностям add/remove, permission-матрица canSendState (≤2 vs ≥3, host,
// hasControl, pause), shapeRoster/self, зонтичное решение decide (релей + инъекция from).

import { describe, it, expect } from 'vitest';
import {
  electHost,
  shapeRoster,
  canSendState,
  canNavigate,
  decide,
} from '../src/roomLogic';
import type { PeerState } from '../src/roomLogic';
import type { WireMessage } from '../../extension/src/shared/protocol';

// ── helpers ───────────────────────────────────────────────────────────────────

function peer(connId: number, over: Partial<PeerState> = {}): PeerState {
  return {
    connId,
    name: `peer${connId}`,
    isHost: false,
    hasControl: false,
    detached: false,
    ...over,
  };
}

describe('electHost', () => {
  it('returns null for an empty room', () => {
    expect(electHost([])).toBeNull();
  });

  it('elects the sole peer', () => {
    expect(electHost([peer(1)])).toBe(1);
  });

  it('elects the oldest (smallest connId) regardless of array order', () => {
    expect(electHost([peer(3), peer(1), peer(2)])).toBe(1);
  });

  it('promotes the next oldest after the host leaves', () => {
    // 1 joins (host), 2 joins, 3 joins → host 1. 1 leaves → oldest remaining is 2.
    const afterLeave = [peer(2), peer(3)];
    expect(electHost(afterLeave)).toBe(2);
  });

  it('skips detached peers when a non-detached older peer exists', () => {
    expect(electHost([peer(1, { detached: true }), peer(2)])).toBe(2);
  });

  it('elects the oldest non-detached even if a younger one is also live', () => {
    expect(electHost([peer(1, { detached: true }), peer(2), peer(3)])).toBe(2);
  });

  it('falls back to the oldest overall when every peer is detached', () => {
    expect(electHost([peer(5, { detached: true }), peer(2, { detached: true })])).toBe(2);
  });

  it('is deterministic over an add/remove sequence', () => {
    // Simulate the DO churn: connIds are monotonic and never reused.
    let room: PeerState[] = [];
    room.push(peer(1));
    expect(electHost(room)).toBe(1); // first joiner
    room.push(peer(2));
    expect(electHost(room)).toBe(1); // oldest stays
    room = room.filter((p) => p.connId !== 1); // host leaves
    room.push(peer(3));
    expect(electHost(room)).toBe(2); // promote oldest remaining, not the newcomer
  });
});

describe('shapeRoster', () => {
  it('includes every peer (self included) and stamps self', () => {
    const peers = [peer(1, { isHost: true }), peer(2, { hasControl: true, detached: true })];
    const roster = shapeRoster(peers, 2);
    expect(roster.type).toBe('ROSTER');
    expect(roster.self).toBe(2);
    expect(roster.peers).toHaveLength(2);
    expect(roster.peers).toEqual([
      { id: 1, name: 'peer1', isHost: true, hasControl: false, detached: false },
      { id: 2, name: 'peer2', isHost: false, hasControl: true, detached: true },
    ]);
  });

  it('maps connId → id faithfully', () => {
    const roster = shapeRoster([peer(7)], 7);
    expect(roster.peers[0].id).toBe(7);
  });
});

describe('canSendState — permission matrix', () => {
  const actions = ['play', 'pause', 'seek', 'rate'] as const;

  it('allows any action from anyone in a room of ≤2 (symmetric)', () => {
    for (const size of [0, 1, 2]) {
      for (const a of actions) {
        expect(canSendState(a, size, false, false)).toBe(true);
      }
    }
  });

  it('in a room of ≥3, allows pause from anyone', () => {
    expect(canSendState('pause', 3, false, false)).toBe(true);
    expect(canSendState('pause', 10, false, false)).toBe(true);
  });

  it('in a room of ≥3, drops non-pause from a plain (non-host, no-control) peer', () => {
    for (const a of ['play', 'seek', 'rate'] as const) {
      expect(canSendState(a, 3, false, false)).toBe(false);
    }
  });

  it('in a room of ≥3, allows non-pause from host', () => {
    expect(canSendState('play', 3, true, false)).toBe(true);
    expect(canSendState('seek', 5, true, false)).toBe(true);
  });

  it('in a room of ≥3, allows non-pause from a controller', () => {
    expect(canSendState('rate', 3, false, true)).toBe(true);
  });
});

describe('canNavigate — NAV gate (no pause exception)', () => {
  it('allows anyone in a room of ≤2', () => {
    for (const size of [0, 1, 2]) expect(canNavigate(size, false, false)).toBe(true);
  });

  it('in a room of ≥3, allows only host or controller', () => {
    expect(canNavigate(3, false, false)).toBe(false);
    expect(canNavigate(3, true, false)).toBe(true);
    expect(canNavigate(3, false, true)).toBe(true);
    expect(canNavigate(10, false, false)).toBe(false);
  });
});

describe('decide — relay decision', () => {
  it('consumes PING/JOIN/MODE (handled statefully in room.ts, never relayed)', () => {
    for (const type of ['PING', 'JOIN', 'MODE'] as const) {
      const msg = { type } as unknown as WireMessage;
      expect(decide(msg, peer(1), 3).kind).toBe('consume');
    }
  });

  it('consumes CONTROL only from host, otherwise drops', () => {
    const ctl = { type: 'CONTROL', action: 'grant', target: 2 } as WireMessage;
    expect(decide(ctl, peer(1, { isHost: true }), 3).kind).toBe('consume');
    expect(decide(ctl, peer(1), 3).kind).toBe('drop');
  });

  it('broadcasts STATE with from-injection when permitted', () => {
    const st = { type: 'STATE', action: 'play', currentTime: 5, paused: false, ts: 1 } as WireMessage;
    const d = decide(st, peer(1), 2);
    expect(d).toEqual({ kind: 'broadcast', inject: true });
  });

  it('drops STATE from a detached sender', () => {
    const st = { type: 'STATE', action: 'play', currentTime: 5, paused: false, ts: 1 } as WireMessage;
    expect(decide(st, peer(1, { detached: true }), 2).kind).toBe('drop');
  });

  it('drops disallowed STATE in a room of ≥3 from a plain peer', () => {
    const st = { type: 'STATE', action: 'seek', currentTime: 5, paused: false, ts: 1 } as WireMessage;
    expect(decide(st, peer(1), 3).kind).toBe('drop');
  });

  it('routes directed STATE (snapshot) only from host, to the target', () => {
    const snap = { type: 'STATE', action: 'pause', currentTime: 9, paused: true, ts: 1, to: 4 } as WireMessage;
    expect(decide(snap, peer(1, { isHost: true }), 3)).toEqual({ kind: 'directed', target: 4, inject: true });
    expect(decide(snap, peer(1), 3).kind).toBe('drop'); // non-host cannot direct-send
  });

  it('broadcasts BEAT only from a non-detached host', () => {
    const beat = { type: 'BEAT', currentTime: 1, playing: true, ts: 1 } as WireMessage;
    expect(decide(beat, peer(1, { isHost: true }), 3)).toEqual({ kind: 'broadcast', inject: true });
    expect(decide(beat, peer(1), 3).kind).toBe('drop');
    expect(decide(beat, peer(1, { isHost: true, detached: true }), 3).kind).toBe('drop');
  });

  it('broadcasts BUFFER/AD from anyone not detached, drops when detached', () => {
    for (const type of ['BUFFER', 'AD'] as const) {
      const msg = { type, ts: 1, buffering: true, currentTime: 0, ad: true } as unknown as WireMessage;
      expect(decide(msg, peer(1), 3)).toEqual({ kind: 'broadcast', inject: true });
      expect(decide(msg, peer(1, { detached: true }), 3).kind).toBe('drop');
    }
  });

  it('routes REQUEST_CONTROL to the host with the requester as target; drops it from the host itself', () => {
    const req = { type: 'REQUEST_CONTROL' } as WireMessage;
    // A non-host requester (connId 4) → toHost, target is the requester's own connId.
    expect(decide(req, peer(4), 3)).toEqual({ kind: 'toHost', target: 4 });
    // The host asking itself → drop (no one to ask).
    expect(decide(req, peer(1, { isHost: true }), 3).kind).toBe('drop');
  });

  it('broadcasts NAV from anyone in ≤2, gates it on host/control in ≥3 (no pause exception)', () => {
    const nav = { type: 'NAV', scope: 'page', url: 'https://a/2', ts: 1 } as WireMessage;
    expect(decide(nav, peer(1), 2)).toEqual({ kind: 'broadcast', inject: true });
    expect(decide(nav, peer(2), 3).kind).toBe('drop'); // plain peer in ≥3
    expect(decide(nav, peer(1, { isHost: true }), 3)).toEqual({ kind: 'broadcast', inject: true });
    expect(decide(nav, peer(2, { hasControl: true }), 3)).toEqual({ kind: 'broadcast', inject: true });
  });

  it('drops NAV from a detached sender', () => {
    const nav = { type: 'NAV', scope: 'page', url: 'https://a/2', ts: 1 } as WireMessage;
    expect(decide(nav, peer(1, { detached: true }), 2).kind).toBe('drop');
  });

  it('routes directed NAV (snapshot) only from host, to the target', () => {
    const nav = { type: 'NAV', scope: 'page', url: 'https://a/2', ts: 1, to: 4 } as WireMessage;
    expect(decide(nav, peer(1, { isHost: true }), 3)).toEqual({ kind: 'directed', target: 4, inject: true });
    expect(decide(nav, peer(2), 3).kind).toBe('drop'); // non-host cannot direct-send
  });

  it('drops server→client message types appearing in the inbound stream', () => {
    for (const type of ['ROSTER', 'SNAPSHOT_REQ'] as const) {
      const msg = { type } as unknown as WireMessage;
      expect(decide(msg, peer(1), 3).kind).toBe('drop');
    }
  });
});
