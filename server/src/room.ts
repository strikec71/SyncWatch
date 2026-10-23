// Ordered, bounded room relay. Only joined clients participate in elections.
import { parseWire, MAX_WIRE_LENGTH } from '../../extension/src/shared/protocol';
import type { JoinMessage, StateMessage, WireMessage } from '../../extension/src/shared/protocol';
import { decide, electHost, shapeRoster } from './roomLogic';
import type { PeerState } from './roomLogic';
const MAX_PEERS = 10, STALE_MS = 180_000, JOIN_TIMEOUT_MS = 10_000;
interface Entry {
  ws: WebSocket; state: PeerState; joined: boolean; lastSeenAt: number; acceptedAt: number;
  tokens: number; budgetAt: number; lastSnapshotAt: number; lastChatAt: number;
}
export class Room {
  private peers = new Map<number, Entry>();
  private nextConnId = 1;
  private revision = 0;
  private lastState: StateMessage | null = null;
  private lastStateAt = 0;
  constructor(private context: DurableObjectState, _env: unknown) {}
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const pair = new WebSocketPair(); this.accept(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private accept(ws: WebSocket): void {
    this.reapDead(); ws.accept();
    if (this.peers.size >= MAX_PEERS) { ws.close(1013, 'room full'); return; }
    const now = Date.now(), connId = this.nextConnId++;
    const entry: Entry = {
      ws, state: { connId, name: '', isHost: false, hasControl: false, detached: false, buffering: false, ad: false },
      joined: false, acceptedAt: now, lastSeenAt: now, tokens: 40, budgetAt: now, lastSnapshotAt: 0, lastChatAt: -Infinity,
    };
    this.peers.set(connId, entry);
    ws.addEventListener('message', evt => { if (typeof evt.data === 'string') this.handleMessage(entry, evt.data); else this.remove(entry, 1003, 'text messages only'); });
    ws.addEventListener('close', () => { try { ws.close(); } catch {} this.cleanup(entry); });
    ws.addEventListener('error', () => this.cleanup(entry));
    this.scheduleSweep();
  }
  async alarm(): Promise<void> { this.reapDead(); if (this.peers.size) this.scheduleSweep(); }
  private scheduleSweep(): void { void this.context.storage?.setAlarm(Date.now() + JOIN_TIMEOUT_MS); }
  private handleMessage(e: Entry, raw: string): void {
    if (!this.peers.has(e.state.connId)) return;
    if (raw.length > MAX_WIRE_LENGTH) { this.remove(e, 1009, 'message too large'); return; }
    const now = Date.now();
    e.tokens = Math.min(40, e.tokens + (now - e.budgetAt) / 100); e.budgetAt = now;
    if (e.tokens < 1) { this.remove(e, 1008, 'rate limit'); return; } e.tokens--;
    const msg = parseWire(raw); if (!msg) return;
    e.lastSeenAt = now;
    if (msg.type === 'JOIN') {
      if (!e.joined) this.onJoin(e, msg);
      else if (e.state.name !== msg.name) { e.state.name = msg.name; this.broadcastRoster(); }
      return;
    }
    if (!e.joined) return;
    this.reapDead(); if (!this.peers.has(e.state.connId)) return;
    if (msg.type === 'MODE') {
      e.state.detached = msg.detached;
      if (msg.detached) { e.state.buffering = false; e.state.ad = false; }
      this.reelectHost(); this.broadcastRoster();
      if (!msg.detached && now - e.lastSnapshotAt >= 500) {
        if (e.state.isHost) { e.lastSnapshotAt = now; for (const target of this.peers.values()) this.requestSnapshot(target); }
        else this.requestSnapshot(e);

      }
      return;
    }
    if (msg.type === 'CONTROL') {
      if (!e.state.isHost) return;
      const target = this.peers.get(msg.target); if (!target?.joined || target.state.isHost) return;
      target.state.hasControl = msg.action === 'grant'; this.broadcastRoster(); return;
    }
    this.relay(e, msg);
  }
  private onJoin(e: Entry, msg: JoinMessage): void {
    e.joined = true; e.state.name = msg.name;
    this.reelectHost(); this.broadcastRoster(); this.requestSnapshot(e);
  }
  private relay(e: Entry, msg: WireMessage): void {
    if (msg.type === 'CHAT') {
      if (Date.now() - e.lastChatAt < 1000) return;
      e.lastChatAt = Date.now();
    }
    const d = decide(msg, e.state, this.states().length); if (d.kind === 'drop') return;
    if (d.kind === 'consume') { if (msg.type === 'PING') this.send(e, msg); return; }
    if (d.kind === 'toHost') {
      const host = [...this.peers.values()].find(p => p.joined && p.state.isHost);
      if (host && host !== e) this.send(host, { ...msg, from: e.state.connId }); return;
    }
    if (d.kind === 'directed') {
      const target = this.peers.get(d.target); if (!target?.joined || target.state.detached) return;
      // Never stamp an asynchronous old snapshot with a newer revision.
      if ('revision' in msg && msg.revision !== undefined && msg.revision !== this.revision) { this.requestSnapshot(target); return; }
      this.send(target, { ...msg, from: e.state.connId, revision: this.revision }); return;
    }
    let out: WireMessage = { ...msg, from: e.state.connId } as WireMessage;
    if (msg.type === 'STATE') {
      const pauseOnly = (msg.action === 'pause' && msg.pauseOnly === true) || (this.states().length >= 3 && !e.state.isHost && !e.state.hasControl);
      const { pauseOnly: _clientFlag, ...state } = msg;
      out = { ...state, from: e.state.connId, revision: ++this.revision, ...(pauseOnly ? { pauseOnly: true, paused: true } : {}) };
      if (pauseOnly && this.lastState) {
        const advance = this.lastState.paused ? 0 : Math.max(0, Date.now() - this.lastStateAt) / 1000 * (this.lastState.rate ?? 1);
        out = { ...out, currentTime: this.lastState.currentTime + advance, rate: this.lastState.rate } as StateMessage;
      }
      this.lastState = out as StateMessage; this.lastStateAt = Date.now();
    }
    if (msg.type === 'NAV') { out = { ...msg, from: e.state.connId, revision: ++this.revision }; this.lastState = null; }
    if (msg.type === 'BEAT') {
      if (msg.revision !== undefined && msg.revision !== this.revision) return;
      out = { ...msg, from: e.state.connId, revision: this.revision };
      if (this.lastState && !this.lastState.paused) { this.lastState.currentTime = msg.currentTime; this.lastStateAt = Date.now(); }
    }
    if (msg.type === 'BUFFER') e.state.buffering = msg.buffering;
    if (msg.type === 'AD') e.state.ad = msg.ad;
    // Ordered commands also acknowledge the optimistic sender.
    for (const other of [...this.peers.values()]) {
      if (other.joined && (other !== e || msg.type === 'STATE' || msg.type === 'NAV')) this.send(other, out);
    }
  }
  private requestSnapshot(e: Entry): void {
    if (!e.joined || e.state.detached) return;
    const host = [...this.peers.values()].find(p => p.joined && p.state.isHost && !p.state.detached);
    if (!host || host === e) return;
    e.lastSnapshotAt = Date.now(); this.send(host, { type: 'SNAPSHOT_REQ', target: e.state.connId, revision: this.revision });
  }
  private states(): PeerState[] { return [...this.peers.values()].filter(e => e.joined).map(e => e.state); }
  private reelectHost(): void {
    const host = electHost(this.states());
    for (const e of this.peers.values()) e.state.isHost = e.joined && e.state.connId === host;
  }
  private broadcastRoster(): void {
    const states = this.states();
    for (const e of [...this.peers.values()]) if (e.joined) this.send(e, shapeRoster(states, e.state.connId));
  }
  private reapDead(): void {
    const now = Date.now(); let changed = false;
    for (const e of [...this.peers.values()]) {
      if ((!e.joined && now - e.acceptedAt >= JOIN_TIMEOUT_MS) || now - e.lastSeenAt >= STALE_MS) {
        this.peers.delete(e.state.connId); changed ||= e.joined;
        try { e.ws.close(1001, 'expired'); } catch {}
      }
    }
    if (changed) { this.reelectHost(); this.broadcastRoster(); }
  }
  private remove(e: Entry, code: number, reason: string): void { try { e.ws.close(code, reason); } catch {} this.cleanup(e); }
  private cleanup(e: Entry): void {
    if (!this.peers.delete(e.state.connId)) return; this.reelectHost(); this.broadcastRoster();
  }
  private send(e: Entry, msg: unknown): void {
    try { e.ws.send(JSON.stringify(msg)); }
    catch { queueMicrotask(() => this.cleanup(e)); }
  }
}
