// Юнит-тесты валидатора на границе (shared/protocol.ts parseWire): round-trip
// сериализация/парсинг всех wire-сообщений Фазы A + отбраковка мусора/битых форм.

import { describe, it, expect } from 'vitest';
import { parseWire } from '../src/shared/protocol';
import type { WireMessage } from '../src/shared/protocol';

/** JSON.stringify → parseWire должен вернуть эквивалентный объект. */
function roundTrip(msg: WireMessage) {
  return parseWire(JSON.stringify(msg));
}

describe('parseWire — round-trip of valid messages', () => {
  const cases: WireMessage[] = [
    { type: 'JOIN', room: 'abc', name: 'Laptop' },
    { type: 'STATE', action: 'play', currentTime: 12.5, paused: false, ts: 1000 },
    { type: 'STATE', action: 'seek', currentTime: 99, paused: true, ts: 2, rate: 1.5, to: 4, from: 7 },
    { type: 'CONTROL', action: 'grant', target: 3 },
    { type: 'CONTROL', action: 'revoke', target: 5 },
    { type: 'MODE', detached: true },
    { type: 'SNAPSHOT_REQ', target: 6 },
    { type: 'BUFFER', buffering: true, currentTime: 3.3, ts: 10, from: 2 },
    { type: 'BEAT', currentTime: 4, playing: true, ts: 11, from: 1 },
    { type: 'AD', ad: false, ts: 12, from: 8 },
    { type: 'REQUEST_CONTROL' },
    { type: 'REQUEST_CONTROL', from: 3 },
    { type: 'PING', ts: 13 },
    {
      type: 'ROSTER',
      self: 1,
      peers: [{ id: 1, name: 'A', isHost: true, hasControl: false, detached: false }],
    },
  ];

  it.each(cases.map((c) => [c.type, c] as const))('round-trips %s', (_type, msg) => {
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('accepts an already-parsed object (not only a string)', () => {
    const obj = { type: 'PING', ts: 5 };
    expect(parseWire(obj)).toEqual(obj);
  });

  it('drops optional fields that are absent (STATE without rate/to/from)', () => {
    const parsed = parseWire(JSON.stringify({ type: 'STATE', action: 'pause', currentTime: 0, paused: true, ts: 1 }));
    expect(parsed).toEqual({ type: 'STATE', action: 'pause', currentTime: 0, paused: true, ts: 1 });
    expect(parsed).not.toHaveProperty('rate');
    expect(parsed).not.toHaveProperty('from');
  });
});

describe('parseWire — rejects malformed input', () => {
  it('rejects non-JSON strings', () => {
    expect(parseWire('not json')).toBeNull();
    expect(parseWire('{oops')).toBeNull();
  });

  it('rejects non-objects and objects without a string type', () => {
    expect(parseWire(null)).toBeNull();
    expect(parseWire(42)).toBeNull();
    expect(parseWire('[]')).toBeNull();
    expect(parseWire(JSON.stringify({ noType: true }))).toBeNull();
    expect(parseWire(JSON.stringify({ type: 123 }))).toBeNull();
  });

  it('rejects an unknown message type', () => {
    expect(parseWire(JSON.stringify({ type: 'NOPE' }))).toBeNull();
  });

  it('rejects JOIN missing name/room', () => {
    expect(parseWire(JSON.stringify({ type: 'JOIN', room: 'x' }))).toBeNull();
    expect(parseWire(JSON.stringify({ type: 'JOIN', name: 'x' }))).toBeNull();
  });

  it('rejects STATE with an invalid action', () => {
    expect(parseWire(JSON.stringify({ type: 'STATE', action: 'jump', currentTime: 1, paused: false, ts: 1 }))).toBeNull();
  });

  it('rejects STATE with non-finite currentTime', () => {
    expect(parseWire(JSON.stringify({ type: 'STATE', action: 'play', currentTime: 'x', paused: false, ts: 1 }))).toBeNull();
    // NaN/Infinity do not survive JSON (become null) — assert the object form is rejected too.
    expect(parseWire({ type: 'STATE', action: 'play', currentTime: NaN, paused: false, ts: 1 })).toBeNull();
    expect(parseWire({ type: 'STATE', action: 'play', currentTime: Infinity, paused: false, ts: 1 })).toBeNull();
  });

  it('rejects STATE with a non-integer to/from', () => {
    expect(parseWire({ type: 'STATE', action: 'play', currentTime: 1, paused: false, ts: 1, to: 1.5 })).toBeNull();
    expect(parseWire({ type: 'STATE', action: 'play', currentTime: 1, paused: false, ts: 1, from: 2.7 })).toBeNull();
  });

  it('rejects CONTROL with a bad action or non-integer target', () => {
    expect(parseWire(JSON.stringify({ type: 'CONTROL', action: 'nuke', target: 1 }))).toBeNull();
    expect(parseWire(JSON.stringify({ type: 'CONTROL', action: 'grant', target: 1.2 }))).toBeNull();
  });

  it('rejects MODE with a non-boolean detached', () => {
    expect(parseWire(JSON.stringify({ type: 'MODE', detached: 'yes' }))).toBeNull();
  });

  it('rejects SNAPSHOT_REQ with a non-integer target', () => {
    expect(parseWire(JSON.stringify({ type: 'SNAPSHOT_REQ', target: 'x' }))).toBeNull();
  });

  it('rejects ROSTER with a malformed peer', () => {
    expect(parseWire(JSON.stringify({ type: 'ROSTER', self: 1, peers: [{ id: 1, name: 'A' }] }))).toBeNull();
    expect(parseWire(JSON.stringify({ type: 'ROSTER', self: 'x', peers: [] }))).toBeNull();
    expect(parseWire(JSON.stringify({ type: 'ROSTER', self: 1, peers: 'nope' }))).toBeNull();
  });

  it('rejects BUFFER/BEAT/AD/PING with wrong field types', () => {
    expect(parseWire(JSON.stringify({ type: 'BUFFER', buffering: 'yes', currentTime: 1, ts: 1 }))).toBeNull();
    expect(parseWire(JSON.stringify({ type: 'BEAT', currentTime: 1, playing: 'no', ts: 1 }))).toBeNull();
    expect(parseWire(JSON.stringify({ type: 'AD', ad: 1, ts: 1 }))).toBeNull();
    expect(parseWire(JSON.stringify({ type: 'PING' }))).toBeNull();
  });

  it('does not trust a client-supplied non-integer from on BUFFER', () => {
    expect(parseWire({ type: 'BUFFER', buffering: true, currentTime: 1, ts: 1, from: 1.5 })).toBeNull();
  });

  it('rejects REQUEST_CONTROL with a non-integer from', () => {
    expect(parseWire({ type: 'REQUEST_CONTROL', from: 1.5 })).toBeNull();
  });
});
