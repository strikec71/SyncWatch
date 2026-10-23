import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../src/room';
class Socket {
  sent: any[] = [];
  close = vi.fn(); accept = vi.fn(); listeners = new Map<string, Function>();
  addEventListener(name: string, fn: Function) { this.listeners.set(name, fn); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  message(msg: unknown) { this.listeners.get('message')!({ data: JSON.stringify(msg) }); }
}
let room: Room;
function open(join = true) {
  const ws = new Socket(); (room as any).accept(ws);
  if (join) ws.message({ type: 'JOIN', room: 'test', name: 'Viewer' });
  return ws;
}
const command = (action: string, paused: boolean, currentTime = 10) => ({ type: 'STATE', action, paused, currentTime, rate: 1, ts: 1 });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); room = new Room({ storage: { setAlarm: vi.fn() } } as any, {}); });
afterEach(() => { vi.useRealTimers(); });
describe('room lifecycle and ordered relay', () => {
  it('AUD-03: crossed optimistic commands reach both senders in the same order', () => {
    const a = open(), b = open(); a.message(command('play', false)); b.message(command('pause', true));
    const states = (ws: Socket) => ws.sent.filter(m => m.type === 'STATE');
    expect(states(a)).toEqual(states(b));
    expect(states(a).map(m => [m.revision, m.paused])).toEqual([[1, false], [2, true]]);
  });
  it('ignores client-selected revision and sender identity', () => {
    const a = open(), b = open(); a.message({ ...command('play', false), from: 999, revision: 999 });
    expect(b.sent.at(-1)).toMatchObject({ revision: 1, from: 1 });
  });
  it('AUD-10: guest safety pause cannot move position or change speed', () => {
    const host = open(), guest = open(); open(); host.message(command('play', false, 20));
    guest.message({ ...command('pause', true, 999), rate: 4 });
    expect(host.sent.at(-1)).toMatchObject({ pauseOnly: true, paused: true, currentTime: 20, rate: 1 });
  });
  it('unjoined sockets neither become host nor relay commands', () => {
    const silent = open(false), host = open(); silent.message(command('play', false));
    expect(host.sent.filter(m => m.type === 'STATE')).toEqual([]);
    expect(host.sent.find(m => m.type === 'ROSTER').peers).toEqual([expect.objectContaining({ id: 2, isHost: true })]);
  });
  it('expires sockets before checking capacity', () => {
    for (let i = 0; i < 10; i++) open();
    vi.advanceTimersByTime(181_000); const newcomer = open();
    expect(newcomer.close).not.toHaveBeenCalled(); expect(newcomer.sent.at(-1).peers).toHaveLength(1);
  });
  it('independent alarm expires clients which never send JOIN', async () => {
    const ws = open(false); vi.advanceTimersByTime(10_001); await room.alarm();
    expect(ws.close).toHaveBeenCalledWith(1001, 'expired');
  });
  it('initial roster includes active buffer/ad holds', () => {
    const a = open(); a.message({ type: 'BUFFER', buffering: true, currentTime: 2, ts: 1 });
    a.message({ type: 'AD', ad: true, ts: 1 }); const b = open();
    expect(b.sent.find(m => m.type === 'ROSTER').peers[0]).toMatchObject({ buffering: true, ad: true });
  });
  it('rejects asynchronous snapshots from before a newer command', () => {
    const host = open(), guest = open(); host.message(command('play', false));
    host.message({ ...command('pause', true), to: 2, revision: 0 });
    expect(guest.sent.filter(m => m.type === 'STATE')).toHaveLength(1);
    expect(host.sent.at(-1)).toMatchObject({ type: 'SNAPSHOT_REQ', revision: 1 });
  });
  it('rejects old host beats after a newer command', () => {
    const host = open(), guest = open(); guest.message(command('seek', false, 70));
    host.message({ type: 'BEAT', playing: true, currentTime: 10, ts: 1, revision: 0 });
    expect(guest.sent.filter(m => m.type === 'BEAT')).toHaveLength(0);
  });
  it('bounds message size and frequency', () => {
    const a = open(); a.message({ type: 'JOIN', room: 'test', name: 'x'.repeat(10000) });
    expect(a.close).toHaveBeenCalledWith(1009, 'message too large');
    const b = open(); for (let i = 0; i < 50; i++) b.message({ type: 'PING', ts: 1 });
    expect(b.close).toHaveBeenCalledWith(1008, 'rate limit');
  });
  it('repeated JOIN does not request additional snapshots', () => {
    const host = open(), guest = open(); const before = host.sent.length;
    guest.message({ type: 'JOIN', room: 'test', name: 'Viewer' }); expect(host.sent).toHaveLength(before);
  });
  it('host readiness requests fresh snapshots for existing viewers', () => {
    const host = open(); open(); open(); host.sent = [];
    host.message({ type: 'MODE', detached: false });
    expect(host.sent.filter(m => m.type === 'SNAPSHOT_REQ').map(m => m.target)).toEqual([2, 3]);
  });
  it('relays text and wheel messages for solo participants, rewrites sender and limits chat spam', () => {
    const a = open(), b = open(); a.message({type:'MODE',detached:true});
    a.message({type:'CHAT',text:'Hello',ts:1,from:999});
    a.message({type:'CHAT',code:'lol',ts:1});
    expect(b.sent.filter(m => m.type === 'CHAT')).toEqual([{type:'CHAT',text:'Hello',ts:1,from:1}]);
    vi.advanceTimersByTime(1000); a.message({type:'CHAT',code:'lol',ts:2});
    expect(b.sent.filter(m => m.type === 'CHAT')).toHaveLength(2);
  });
  it('an explicit safety pause never seeks the room, even when sent by the host', () => {
    const a = open(), b = open(); a.message({...command('play',false,50),rate:1.5});
    a.message({...command('pause',true,999),rate:4,pauseOnly:true});
    expect(b.sent.at(-1)).toMatchObject({action:'pause',paused:true,pauseOnly:true,currentTime:50,rate:1.5});
  });

});
