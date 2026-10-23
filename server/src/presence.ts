// Authenticated presence: the public client ID is SHA-256 of a public P-256 key.
// Friend links carry a separate expiring invitation capability, never the owner key.
import { parsePresenceBeat, parsePresenceQuery, parsePresenceFriend } from '../../extension/src/shared/presence';
import type { InboxMsg } from '../../extension/src/shared/presence';
import { digestHex, randomSecret, verifyPresence } from '../../extension/src/shared/identity';
import { PRESENCE_TTL_MS, INBOX_TTL_MS, prunePresence, pruneInbox, visibleView, dedupInbox } from './presenceLogic';
import type { PresenceRecord } from './presenceLogic';
const HEX = /^[a-f0-9]{64}$/;
const INVITE_TTL = 7 * 86400_000;
interface Invite { hash: string; until: number }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
export class Presence {
  private lastPrune = 0;
  private proofs = new Map<string, number>();
  private budgets = new Map<string, { at: number; count: number }>();
  constructor(private state: DurableObjectState, _env: unknown) {}
  private async scheduleExpiry(at: number): Promise<void> {
    const current = await this.state.storage.getAlarm();
    if (current === null || current > at) await this.state.storage.setAlarm(at);
  }
  async alarm(): Promise<void> { this.lastPrune = Date.now(); await this.prune(); }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
    // Enforce the limit while streaming, including requests without Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'body required' }, 400);
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 16_384) { await reader.cancel(); return json({ error: 'body too large' }, 413); }
        chunks.push(value);
      }
    } catch { return json({ error: 'bad body' }, 400); }
    let body: Record<string, unknown>, bodyText = '';
    try {
      const bytes = new Uint8Array(length); let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      bodyText = new TextDecoder().decode(bytes); body = JSON.parse(bodyText);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    } catch { return json({ error: 'bad request' }, 400); }
    const action = new URL(request.url).pathname.split('/').filter(Boolean)[1];
    const clientId = action === 'friend' ? body.from : body.clientId;
    const proof = await verifyPresence(request, bodyText, clientId);
    if (!proof || typeof clientId !== 'string') return json({error:'unauthorized'},401);
    const now = Date.now();
    for (const [nonce, at] of this.proofs) if (now - at > 120_000) this.proofs.delete(nonce);
    if (this.proofs.has(proof)) return json({error:'replayed request'},409);
    if (this.proofs.size >= 10_000) return json({error:'busy'},503);
    this.proofs.set(proof,now);
    for (const [id, b] of this.budgets) if (now - b.at >= 60_000) this.budgets.delete(id);
    const budget = this.budgets.get(clientId) || { at: now, count: 0 };
    if (++budget.count > 60) return json({ error: 'rate limit' }, 429);
    this.budgets.set(clientId, budget);
    if (now - this.lastPrune >= 60_000) { this.lastPrune = now; await this.prune(); }
    switch (action) {
      case 'beat': {
        const b = parsePresenceBeat(body); if (!b) break;
        await this.state.storage.put(`presence:${clientId}`, { room: b.room, deviceName: b.deviceName, at: now, allow: b.allow } satisfies PresenceRecord);
        await this.scheduleExpiry(now + PRESENCE_TTL_MS);
        return json({ ok: true });
      }
      case 'clear':
        await this.state.storage.delete(`presence:${clientId}`); return json({ ok: true });
      case 'invite': {
        const token = randomSecret();
        await this.state.storage.put(`invite:${clientId}`, { hash: await digestHex(token), until: now + INVITE_TTL } satisfies Invite);
        await this.scheduleExpiry(now + INVITE_TTL);
        return json({ token, expiresAt: now + INVITE_TTL });
      }
      case 'query': {
        const q = parsePresenceQuery(body); if (!q) break;
        const views: Record<string, unknown> = Object.create(null);
        const callerHash = await digestHex(clientId);
        for (const fid of q.friendIds) {
          const rec = await this.state.storage.get<PresenceRecord>(`presence:${fid}`);
          views[fid] = visibleView(rec && now - rec.at < PRESENCE_TTL_MS ? rec : undefined, callerHash);
        }
        const inbox = (await this.state.storage.get<InboxMsg[]>(`inbox:${clientId}`) || []).filter(m => now - m.ts < INBOX_TTL_MS);
        // The client acknowledges only after persisting the new friends locally.
        return json({ views, inbox });
      }
      case 'ack': {
        if (!Array.isArray(body.acks) || body.acks.length > 64 || !body.acks.every(x => typeof x === 'string' && x.length <= 100)) break;
        const acks = new Set(body.acks);
        await this.state.storage.transaction(async tx => {
          const key = `inbox:${clientId}`, list = await tx.get<InboxMsg[]>(key) || [];
          const next = list.filter(m => !acks.has(`${m.from}:${m.ts}`));
          if (next.length) await tx.put(key, next); else await tx.delete(key);
        });
        return json({ ok: true });
      }
      case 'friend': {
        const f = parsePresenceFriend(body); if (!f || !HEX.test(String(body.token)) || f.from === f.to) break;
        const invite = await this.state.storage.get<Invite>(`invite:${f.to}`);
        if (!invite || invite.until <= now || invite.hash !== await digestHex(String(body.token))) return json({ error: 'invitation expired or invalid' }, 403);
        await this.state.storage.transaction(async tx => {
          const key = `inbox:${f.to}`, list = await tx.get<InboxMsg[]>(key) || [];
          await tx.put(key, dedupInbox(list, { from: f.from, fromName: f.fromName, kind: 'accept', ts: now }).slice(-64));
        });
        await this.scheduleExpiry(now + INBOX_TTL_MS);
        return json({ ok: true });
      }
    }
    return json({ error: 'bad request' }, 400);
  }
  private async prune(): Promise<void> {
    const now = Date.now();
    let nextExpiry = Infinity;
    const pres = await this.state.storage.list<PresenceRecord>({ prefix: 'presence:' });
    const kept = prunePresence(pres, now, PRESENCE_TTL_MS);
    for (const key of pres.keys()) if (!kept.has(key)) await this.state.storage.delete(key);
    for (const rec of kept.values()) nextExpiry = Math.min(nextExpiry, rec.at + PRESENCE_TTL_MS);
    const inbox = await this.state.storage.list<InboxMsg[]>({ prefix: 'inbox:' });
    const next = pruneInbox(inbox, now, INBOX_TTL_MS);
    for (const [key, list] of inbox) {
      if (!next.has(key)) await this.state.storage.delete(key);
      else if (next.get(key)!.length !== list.length) await this.state.storage.put(key, next.get(key)!);
    }
    for (const list of next.values()) for (const msg of list) nextExpiry = Math.min(nextExpiry, msg.ts + INBOX_TTL_MS);
    const invites = await this.state.storage.list<Invite>({ prefix: 'invite:' });
    for (const [key, invite] of invites) {
      if (invite.until <= now) await this.state.storage.delete(key);
      else nextExpiry = Math.min(nextExpiry, invite.until);
    }
    if (Number.isFinite(nextExpiry)) await this.state.storage.setAlarm(Math.max(now + 1000, nextExpiry));
    else await this.state.storage.deleteAlarm();
  }
}
