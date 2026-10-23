import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Presence } from '../src/presence';
import { digestHex, signPresence, publicKeyId, publicKeyShape } from '../../extension/src/shared/identity';
async function identity() {
  const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const publicKey = publicKeyShape(await crypto.subtle.exportKey('jwk',pair.publicKey))!;
  return {clientId:await publicKeyId(publicKey),publicKey,privateKey:await crypto.subtle.exportKey('jwk',pair.privateKey)};
}
const [secretA,secretB,secretC] = await Promise.all([identity(),identity(),identity()]);
let server: Presence, data: Map<string, unknown>;
const ids = [secretA,secretB,secretC].map(i=>i.clientId);
const [a,b,c] = ids;
beforeEach(() => {
  data = new Map();
  const storage = {
    getAlarm: async () => null, setAlarm: vi.fn(), deleteAlarm: vi.fn(),
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    delete: async (key: string) => data.delete(key),
    list: async ({prefix}: {prefix:string}) => new Map([...data].filter(([key]) => key.startsWith(prefix))),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(storage),
  };
  server = new Presence({storage} as unknown as DurableObjectState, {});
});
afterEach(() => vi.useRealTimers());
async function post(action: string, body: unknown, secret = secretA) {
  const url = `https://relay/presence/${action}`, payload = JSON.stringify(body);
  return server.fetch(new Request(url, {method:'POST',headers:await signPresence(secret,url,payload),body:payload}));
}
async function invite() { return (await (await post('invite',{clientId:a})).json() as {token:string}).token; }
describe('authenticated Presence HTTP lifecycle', () => {
  it('rejects impersonated beat, query, inbox drain and friendship, even with a known public ID', async () => {
    expect((await post('beat',{clientId:a,room:'secret',deviceName:'A',allow:[]},secretB)).status).toBe(401);
    expect((await post('query',{clientId:a,friendIds:[b]},secretB)).status).toBe(401);
    expect((await post('ack',{clientId:a,acks:[]},secretB)).status).toBe(401);
    expect((await post('friend',{from:a,to:b,fromName:'A',token:'f'.repeat(64)},secretB)).status).toBe(401);
    expect(data.size).toBe(0);
  });
  it('rejects replay, modified payload and use on a different relay', async () => {
    const url='https://relay/presence/query', body=JSON.stringify({clientId:a,friendIds:[]});
    const headers=await signPresence(secretA,url,body);
    expect((await server.fetch(new Request(url,{method:'POST',headers,body}))).status).toBe(200);
    expect((await server.fetch(new Request(url,{method:'POST',headers,body}))).status).toBe(409);
    expect((await server.fetch(new Request(url,{method:'POST',headers,body:JSON.stringify({clientId:a,friendIds:[b]})}))).status).toBe(401);
    expect((await server.fetch(new Request('https://other/presence/query',{method:'POST',headers,body}))).status).toBe(401);
  });
  it('requires an invitation capability, never accepts a public ID as proof of invitation', async () => {
    await invite();
    expect((await post('friend',{from:b,to:a,fromName:'B',token:'f'.repeat(64)},secretB)).status).toBe(403);
    expect((await post('friend',{from:b,to:a,fromName:'B'},secretB)).status).toBe(400);
  });
  it('delivers acceptance until local persistence is acknowledged, and restricts room visibility', async () => {
    const token = await invite();
    expect((await post('friend',{from:b,to:a,fromName:'B',token},secretB)).status).toBe(200);
    const first = await (await post('query',{clientId:a,friendIds:[]})).json() as any;
    const retry = await (await post('query',{clientId:a,friendIds:[]})).json() as any;
    expect(first.inbox).toHaveLength(1); expect(retry.inbox).toEqual(first.inbox);
    await post('ack',{clientId:a,acks:[`${b}:${first.inbox[0].ts}`]});
    expect((await (await post('query',{clientId:a,friendIds:[]})).json() as any).inbox).toEqual([]);
    await post('beat',{clientId:a,room:'private-room',deviceName:'A',allow:[await digestHex(b)]});
    expect((await (await post('query',{clientId:b,friendIds:[a]},secretB)).json() as any).views[a].room).toBe('private-room');
    expect((await (await post('query',{clientId:c,friendIds:[a]},secretC)).json() as any).views[a]).toEqual({online:false,room:'',deviceName:''});
    await post('clear',{clientId:a});
    expect((await (await post('query',{clientId:b,friendIds:[a]},secretB)).json() as any).views[a].online).toBe(false);
  });
  it('replaces invitations, expires them after seven days and expires status by TTL', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T12:00Z'));
    const old = await invite(), token = await invite();
    expect((await post('friend',{from:b,to:a,fromName:'B',token:old},secretB)).status).toBe(403);
    await post('beat',{clientId:a,room:'r',deviceName:'A',allow:[await digestHex(b)]});
    vi.advanceTimersByTime(150_000);
    expect((await (await post('query',{clientId:b,friendIds:[a]},secretB)).json() as any).views[a].online).toBe(false);
    vi.advanceTimersByTime(7*86400_000);
    expect((await post('friend',{from:b,to:a,fromName:'B',token},secretB)).status).toBe(403);
  });
  it('cleans up expired status without another client request', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T12:00Z'));
    await post('beat',{clientId:a,room:'r',deviceName:'A',allow:[]});
    expect(data.has(`presence:${a}`)).toBe(true);
    vi.advanceTimersByTime(150_000); await server.alarm();
    expect(data.has(`presence:${a}`)).toBe(false);
  });
  it('limits request bodies while streaming and limits per-owner request rate', async () => {
    expect((await post('beat',{clientId:a,junk:'x'.repeat(17000)})).status).toBe(413);
    for(let i=0;i<60;i++) expect((await post('query',{clientId:a,friendIds:[]})).status).toBe(200);
    expect((await post('query',{clientId:a,friendIds:[]})).status).toBe(429);
  });
});
