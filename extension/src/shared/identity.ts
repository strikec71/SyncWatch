// Public IDs are shareable; the signing key never leaves storage.local.
export function randomSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function digestHex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export interface SigningIdentity { clientId: string; publicKey: JsonWebKey; privateKey: JsonWebKey }
export function publicKeyShape(key: JsonWebKey): JsonWebKey | null {
  return key?.kty === 'EC' && key.crv === 'P-256' && typeof key.x === 'string' && typeof key.y === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key.x) && /^[A-Za-z0-9_-]{43}$/.test(key.y)
    ? { kty: 'EC', crv: 'P-256', x: key.x, y: key.y } : null;
}
export async function publicKeyId(key: JsonWebKey): Promise<string> { return digestHex(JSON.stringify(publicKeyShape(key))); }
function proofText(url: string, body: string, time: string, nonce: string): ArrayBuffer {
  // Bind the proof to this relay, endpoint and exact payload; no cross-relay replay.
  // encode() allocates an ArrayBuffer; worker and DOM type libraries differ here.
  return new TextEncoder().encode(`POST\n${new URL(url).href}\n${time}\n${nonce}\n${body}`).buffer as ArrayBuffer;
}
export async function signPresence(identity: SigningIdentity, url: string, body: string): Promise<Record<string,string>> {
  const time = String(Date.now()), nonce = randomSecret();
  const key = await crypto.subtle.importKey('jwk', identity.privateKey, {name:'ECDSA',namedCurve:'P-256'}, false, ['sign']);
  const proof = await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, key, proofText(url,body,time,nonce));
  const signature = [...new Uint8Array(proof)].map(b => b.toString(16).padStart(2,'0')).join('');
  return { authorization:`Signature ${signature}`, 'x-syncwatch-key':JSON.stringify(identity.publicKey), 'x-syncwatch-time':time, 'x-syncwatch-nonce':nonce };
}
export async function verifyPresence(request: Request, body: string, clientId: unknown): Promise<string | null> {
  try {
    const encoded = request.headers.get('x-syncwatch-key') || '';
    const time = request.headers.get('x-syncwatch-time') || '', nonce = request.headers.get('x-syncwatch-nonce') || '';
    const signature = request.headers.get('authorization')?.replace(/^Signature /,'') || '';
    if (encoded.length > 256 || !/^[a-f0-9]{64}$/.test(nonce) || !/^\d{13}$/.test(time) || Math.abs(Date.now()-Number(time))>60_000 || !/^[a-f0-9]{128}$/.test(signature)) return null;
    const publicKey = publicKeyShape(JSON.parse(encoded));
    if (!publicKey || await publicKeyId(publicKey) !== clientId) return null;
    const key = await crypto.subtle.importKey('jwk', publicKey, {name:'ECDSA',namedCurve:'P-256'}, false, ['verify']);
    const bytes = new Uint8Array(signature.match(/../g)!.map(x => parseInt(x,16)));
    return await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,bytes,proofText(request.url,body,time,nonce)) ? nonce : null;
  } catch { return null; }
}
