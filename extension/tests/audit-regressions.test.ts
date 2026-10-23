// Audit checks assert desired behavior. Failures document unfixed defects.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from '../src/shared/browser';
import { PlayerController } from '../src/content/player';
import { createSession } from '../src/background/state';
import { onRemoteBuffer, onRemoteAd, onVideoReady } from '../src/background/sync';
import { onVideoPresence, forgetTab } from '../src/background/presence';
import { applyRoster, clearBlocks } from '../src/background/roster';
import { connect, disconnect, checkWatchdog } from '../src/background/connection';
import { parseWire } from '../src/shared/protocol';
import { decide } from '../../server/src/roomLogic';
import { Room } from '../../server/src/room';
import { saveSettings } from '../src/shared/settings';

function player(paused = false) {
  const video = {
    paused, currentTime: 50, playbackRate: 1, readyState: 4, duration: 120,
    play: vi.fn(function(this: any) { this.paused = false; return Promise.resolve(); }),
    pause: vi.fn(function(this: any) { this.paused = true; }),
  };
  const controller = new PlayerController();
  (controller as any).video = video;
  return { controller, video };
}
const peer = (id: number, isHost = false) => ({ id, name: `Peer ${id}`, isHost, hasControl: false, detached: false });
function session() {
  const s = createSession(42);
  s.myConnId = 1;
  s.roster = new Map([1, 2, 3].map(id => [id, peer(id, id === 1)]));
  return s;
}
class Socket {
  static instances: Socket[] = [];
  listeners = new Map<string, Function>();
  send = vi.fn(); close = vi.fn();
  constructor(public url: string) { Socket.instances.push(this); }
  addEventListener(type: string, cb: Function) { this.listeners.set(type, cb); }
  open() { this.listeners.get('open')?.({}); }
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  vi.stubGlobal('window', globalThis);
  Socket.instances = [];
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Player runtime behavior', () => {
  it('AUD-01: peer buffering pauses a playing video', () => {
    const { controller, video } = player(); controller.applyBufferControl(true);
    expect(video.paused).toBe(true);
  });
  it('AUD-01: peer ad pauses a playing video', () => {
    const { controller, video } = player(); controller.applyAdControl(true);
    expect(video.paused).toBe(true);
  });
  it('AUD-01: clearing the final hold resumes a held video', () => {
    const { controller, video } = player(false);
    controller.applyBufferControl(true); controller.applyBufferControl(false);
    expect(video.paused).toBe(false);
  });
  it('AUD-04: initial play snapshot restores host playback rate', () => {
    const { controller, video } = player(true); controller.applyRemote('play', 60, false, 1.5);
    expect(video.playbackRate).toBe(1.5);
  });
  it('AUD-05: incoming STATE must not seek the local advertisement timeline', () => {
    const { controller, video } = player(); (controller as any).isAdActive = true;
    controller.applyRemote('pause', 100, true, 1);
    expect(video.currentTime).toBe(50);
  });
  it('AUD-05: snapshot during local advertisement must not expose ad position as content', () => {
    const { controller } = player(); (controller as any).isAdActive = true;
    expect(controller.snapshot().ready).toBe(false);
  });
});

describe('Room holds must aggregate participants and clear on leave', () => {
  it('AUD-02: peer 2 ending buffering must not release peer 3 hold', () => {
    const s = session(); const send = vi.spyOn(browser.tabs, 'sendMessage');
    for (const [from, buffering] of [[2, true], [3, true], [2, false]] as const)
      onRemoteBuffer(s, { type: 'BUFFER', from, buffering, currentTime: 1, ts: 1 });
    const holds = send.mock.calls.map(c => c[1] as any).filter(m => m.kind === 'buffer-control');
    expect(holds.at(-1).buffering).toBe(true);
  });
  it('AUD-02: peer 2 ending ad must not release peer 3 hold', () => {
    const s = session(); const send = vi.spyOn(browser.tabs, 'sendMessage');
    for (const [from, ad] of [[2, true], [3, true], [2, false]] as const)
      onRemoteAd(s, { type: 'AD', from, ad, ts: 1 });
    const holds = send.mock.calls.map(c => c[1] as any).filter(m => m.kind === 'ad-control');
    expect(holds.at(-1).ad).toBe(true);
  });
  it('AUD-02: departed buffering participant releases content hold', () => {
    const s = session(); const send = vi.spyOn(browser.tabs, 'sendMessage');
    onRemoteBuffer(s, { type: 'BUFFER', from: 2, buffering: true, currentTime: 1, ts: 1 });
    send.mockClear(); applyRoster(s, { type: 'ROSTER', self: 1, peers: [peer(1, true), peer(3)] });
    expect(send.mock.calls.some(c => (c[1] as any).kind === 'buffer-control' && !(c[1] as any).buffering)).toBe(true);
  });
  it('AUD-02: clearing session releases content ad and buffer flags', () => {
    const s = session(); const send = vi.spyOn(browser.tabs, 'sendMessage');
    clearBlocks(s);
    expect(send.mock.calls.some(c => (c[1] as any).kind === 'ad-control' && !(c[1] as any).ad)).toBe(true);
  });
});

describe('Connection and isolation', () => {
  it('AUD-09: already-ready iframe is selected before initial directed snapshot', () => {
    forgetTab(42);
    const s = createSession(42);
    // PlayerController.scan calls attach/onReady before updatePresence.
    onVideoReady(s, 7);
    onVideoPresence(42, 7, true);
    expect(s.frameId).toBe(7);
    forgetTab(42);
  });
  it('AUD-06: reconnect retains original session server when global settings change', async () => {
    vi.stubGlobal('WebSocket', Socket);
    vi.spyOn(browser.storage.local, 'get').mockResolvedValue({ settings: { serverUrl: 'wss://server-b.test', deviceName: 'Audit' } });
    const s = createSession(42);
    await connect(s, 'room-a', 'wss://server-a.test'); disconnect(s);
    await connect(s, s.room);
    expect(Socket.instances.at(-1)!.url).toBe('wss://server-a.test/room/room-a');
  });
  it('AUD-07: healthy quiet socket survives a 60-second alarm interval', () => {
    const s = session(); const ws = new Socket('ws://local'); s.ws = ws as any;
    s.connected = true; s.autoConnect = false; s.lastRecvAt = Date.now();
    vi.setSystemTime(Date.now() + 60_000); checkWatchdog(s);
    expect(s.connected).toBe(true);
  });
  it('AUD-06: simultaneous settings patches preserve both fields', async () => {
    let stored = { settings: { room: 'old', serverUrl: 'wss://old' } };
    vi.spyOn(browser.storage.local, 'get').mockImplementation(async () => structuredClone(stored));
    vi.spyOn(browser.storage.local, 'set').mockImplementation(async (v: any) => { stored = structuredClone(v); });
    await Promise.all([saveSettings({ room: 'new' }), saveSettings({ serverUrl: 'wss://new' })]);
    expect(stored.settings).toMatchObject({ room: 'new', serverUrl: 'wss://new' });
  });
});

describe('Server boundary', () => {
  it('AUD-10: unprivileged pause must not carry a seek or rate payload into the room', () => {
    const msg = parseWire({ type: 'STATE', action: 'pause', currentTime: 99999, rate: -2, paused: false, ts: 1 })!;
    if (!msg) { expect(msg).toBeNull(); return; }
    const result = decide(msg, { connId: 3, name: 'Guest', isHost: false, hasControl: false, detached: false }, 3);
    expect(result.kind).toBe('drop');
  });
  it('AUD-11: stale full room admits a fresh participant', () => {
    const room = new Room({} as any, {}) as any;
    const makeWS = () => ({ accept: vi.fn(), close: vi.fn(), send: vi.fn(), addEventListener: vi.fn() });
    for (let i = 0; i < 10; i++) room.accept(makeWS());
    vi.setSystemTime(Date.now() + 181_000);
    const newcomer = makeWS(); room.accept(newcomer);
    expect(newcomer.close).not.toHaveBeenCalledWith(1013, 'room full');
  });
  it('AUD-10: protocol rejects negative video times and playback rates', () => {
    expect(parseWire({ type: 'STATE', action: 'rate', currentTime: -20, rate: -2, paused: false, ts: 1 })).toBeNull();
  });
  it('AUD-11: participant name has a bounded length', () => {
    expect(parseWire({ type: 'JOIN', room: 'a', name: 'x'.repeat(100_000) })).toBeNull();
  });
});
