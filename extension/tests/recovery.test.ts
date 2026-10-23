import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import browser from '../src/shared/browser';
import { __setTabUrl } from './stubs/webextension-polyfill';
import { allSessions, forgetSession, getSession } from '../src/background/state';
import { persistSessions, restoreSessions } from '../src/background/persistence';
import { connect, disconnect, checkWatchdog } from '../src/background/connection';
import { applyRemoteState, onRemoteBeat } from '../src/background/sync';
import { onMediaApplyFailed, onNavReport, normalizeSyncUrl, applyRemoteNav } from '../src/background/nav';
import { onVideoPresence, forgetTab } from '../src/background/presence';
import { PlayerController } from '../src/content/player';
import { parseInvite } from '../src/content/invite';
import { normalizeServerUrl } from '../src/shared/validation';
import { friendlyCode } from '../src/content/overlay-roster';
import { semverGt } from '../src/background/notifier';
import { loadSettings } from '../src/shared/settings';

class WS {
  static sockets: WS[] = [];
  events = new Map<string, Function>(); send = vi.fn(); close = vi.fn();
  constructor(public url: string) { WS.sockets.push(this); }
  addEventListener(type: string, fn: Function) { this.events.set(type, fn); }
  emit(type: string, data: any = {}) { this.events.get(type)?.(data); }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  vi.stubGlobal('window', globalThis); vi.stubGlobal('WebSocket', WS); WS.sockets = [];
  vi.spyOn(browser.storage.local, 'get').mockResolvedValue({ settings: { deviceName: 'Test', autoConnect: true, serverUrl: 'wss://default.test' } });
});
afterEach(() => {
  for (const s of allSessions()) { disconnect(s); forgetSession(s.tabId); }
  forgetTab(1);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe('session recovery and command boundaries', () => {
  it('restores separate rooms and servers after losing the memory registry', async () => {
    let saved: any;
    vi.spyOn(browser.storage.session, 'set').mockImplementation(async (v: any) => { saved = structuredClone(v); });
    vi.spyOn(browser.storage.session, 'get').mockImplementation(async () => saved);
    for (const id of [1, 2]) {
      const s = getSession(id); s.room = `room-${id}`; s.serverUrl = `wss://server-${id}.test`;
      __setTabUrl(id, `https://video.test/${id}`);
    }
    await persistSessions(); forgetSession(1); forgetSession(2); await restoreSessions();
    expect(allSessions().map(s => [s.tabId, s.room, s.serverUrl])).toEqual([[1, 'room-1', 'wss://server-1.test'], [2, 'room-2', 'wss://server-2.test']]);
  });
  it('a deliberate disconnect is not resurrected from persistence', async () => {
    const write = vi.spyOn(browser.storage.session, 'set');
    const s = getSession(1); s.room = 'secret'; s.serverUrl = 'wss://test'; disconnect(s);
    await persistSessions(); expect(write.mock.calls.at(-1)?.[0]).toEqual({ sessions: [] });
  });
  it('late events from an old socket cannot tear down the replacement', async () => {
    const s = getSession(1); await connect(s, 'room'); const old = WS.sockets[0];
    await connect(s, 'room'); const current = WS.sockets[1]; current.emit('open'); old.emit('close');
    expect(s.ws).toBe(current); expect(s.connected).toBe(true);
  });
  it('room-full stops retries and exposes an actionable error', async () => {
    const s = getSession(1); await connect(s, 'room'); const ws = WS.sockets[0]; ws.emit('open'); ws.emit('close', { code: 1013, reason: 'room full' });
    vi.advanceTimersByTime(60_000); expect(WS.sockets).toHaveLength(1); expect(s.error).toContain('заполнена');
  });
  it('quiet connections survive delayed ticks; dead ones reconnect', async () => {
    const s = getSession(1); await connect(s, 'room'); WS.sockets[0].emit('open');
    // Simulate a confirmed join.
    WS.sockets[0].emit('message', { data: JSON.stringify({ type: 'ROSTER', self: 1, peers: [{ id: 1, name: 'Me', isHost: true, hasControl: false, detached: false }] }) });
    vi.advanceTimersByTime(90_000); checkWatchdog(s); expect(s.connected).toBe(true);
    vi.advanceTimersByTime(100_000); checkWatchdog(s); expect(s.connected).toBe(false);
    vi.advanceTimersByTime(3000); await vi.runAllTicks(); expect(s.phase).toBe('retrying');
  });
  it('outdated revisions do not overwrite an already applied command', () => {
    const s = getSession(1); s.myConnId = 2; const send = vi.spyOn(browser.tabs, 'sendMessage');
    applyRemoteState(s, { type: 'STATE', action: 'pause', paused: true, currentTime: 20, ts: 1, revision: 2 });
    send.mockClear(); applyRemoteState(s, { type: 'STATE', action: 'play', paused: false, currentTime: 1, ts: 1, revision: 1 });
    expect(send).not.toHaveBeenCalled();
  });
  it('content mismatch blocks both commands and drift until corrected', () => {
    const s = getSession(1); s.expectedSig = 'kodik|e=2'; s.expectedSigAt = Date.now(); onMediaApplyFailed(s, 'kodik|e=1');
    expect(s.contentMismatch).toBe(true); const send = vi.spyOn(browser.tabs, 'sendMessage'); send.mockClear();
    applyRemoteState(s, { type: 'STATE', action: 'play', paused: false, currentTime: 50, ts: 1 });
    onRemoteBeat(s, { type: 'BEAT', playing: true, currentTime: 50, ts: 1 }); expect(send).not.toHaveBeenCalled();
  });
  it('ending a technical hold preserves the user pause', () => {
    const controller = new PlayerController();
    const video = { paused: true, play: vi.fn(() => Promise.resolve()), pause: vi.fn() };
    (controller as any).video = video; controller.applyBufferControl(true); controller.applyBufferControl(false);
    expect(video.play).not.toHaveBeenCalled();
  });
  it('guest pause-only applies no position or speed changes', () => {
    const controller = new PlayerController();
    const video = { currentTime: 25, playbackRate: 1, paused: false, readyState: 4, duration: 100, pause: vi.fn(), play: vi.fn() };
    (controller as any).video = video; controller.applyRemote('pause', 999, true, 4, true);
    expect(video.currentTime).toBe(25); expect(video.playbackRate).toBe(1); expect(video.pause).toHaveBeenCalled();
  });
  it('does not send a page URL outside the viewing site', () => {
    const s = getSession(1); s.connected = true; s.navigationOrigin = 'https://video.test'; s.pageUrl = 'https://video.test/watch';
    const send = vi.fn(); s.ws = { send } as any;
    onNavReport(s, 'https://bank.test/account?token=secret');
    expect(s.detached).toBe(true);
    expect(send.mock.calls.map(c => JSON.parse(c[0]))).toEqual([{ type: 'MODE', detached: true }]);
  });
  it('waits for a video before publishing a new page and detaches if none appears', () => {
    const s = getSession(1); s.connected = true; s.navigationOrigin = 'https://video.test'; s.pageUrl = 'https://video.test/watch';
    const send = vi.fn(); s.ws = { send } as any;
    onNavReport(s, 'https://video.test/account'); expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(11_000); onNavReport(s, 'https://video.test/account');
    expect(s.detached).toBe(true); expect(send.mock.calls.some(c => JSON.parse(c[0]).type === 'NAV')).toBe(false);
  });
  it('publishes the next episode after its video is available', () => {
    const s = getSession(1); s.connected = true; s.navigationOrigin = 'https://video.test'; s.pageUrl = 'https://video.test/1';
    const send = vi.fn(); s.ws = { send } as any;
    onVideoPresence(1, 0, true); onNavReport(s, 'https://video.test/2?episode=2&token=secret');
    expect(send.mock.calls.map(c => JSON.parse(c[0]))).toContainEqual(expect.objectContaining({ type: 'NAV', url: 'https://video.test/2?episode=2' }));
  });
  it('does not automatically follow a room to a different site', async () => {
    const s = getSession(1); s.navigationOrigin = 'https://video.test';
    const update = vi.spyOn(browser.tabs, 'update');
    await applyRemoteNav(s, { type: 'NAV', scope: 'page', url: 'https://unrelated.test', ts: 1 });
    expect(update).not.toHaveBeenCalled();
    expect(normalizeSyncUrl('https://video.test/watch?e=2&access_token=secret&utm_source=ad#invite')).toBe('https://video.test/watch?e=2');
  });
});
describe('invitations and updates', () => {
  it('normalizes invalid settings saved by an earlier version', async () => {
    vi.mocked(browser.storage.local.get).mockResolvedValue({ settings: { driftThreshold: -9, autoConnect: 'false', serverUrl: 'javascript:bad', deviceName: 123 } } as any);
    expect(await loadSettings()).toMatchObject({ driftThreshold: 0.25, autoConnect: true, serverUrl: '', deviceName: '' });
  });
  it('recognizes named rooms only on an explicitly marked invitation page', () => {
    expect(parseInvite('https://signal.test/r/my-room', true)).toEqual({ room: 'my-room', serverUrl: 'wss://signal.test' });
    expect(parseInvite('https://unrelated.test/r/my-room')).toBeNull();
    expect(parseInvite('https://unrelated.test/#r=my-room')).toBeNull();
  });
  it('does not decode server parameters twice', () => {
    expect(parseInvite('https://video.test/#syncwatch=room&s=wss%3A%2F%2Fserver.test')).toEqual({ room: 'room', serverUrl: 'wss://server.test' });
  });
  it('rejects unsafe server addresses and validates names', () => {
    for (const server of ['javascript:alert(1)', 'wss://u:p@server.test', 'ws://server.test', 'wss://server.test/?token=123']) expect(normalizeServerUrl(server)).toBeNull();
    expect(normalizeServerUrl('ws://localhost:8787/')).toBe('ws://localhost:8787');
    expect(parseInvite('https://video.test/#syncwatch=bad%2Froom')).toBeNull();
  });
  it('generates secret codes from 128 cryptographic bits', () => {
    const codes = new Set(Array.from({ length: 100 }, () => friendlyCode())); expect(codes.size).toBe(100);
    for (const code of codes) expect(code).toMatch(/^watch-[a-f0-9]{32}$/);
  });
  it('compares release numbers numerically and rejects malformed remote versions', () => {
    expect(semverGt('0.10.0', '0.9.0')).toBe(true); expect(semverGt('0.6.0', '0.6.0')).toBe(false);
    expect(semverGt('<script>', '0.6.0')).toBe(false);
  });
});
