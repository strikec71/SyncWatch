/** A signaling server never needs credentials, query parameters or fragments. */
export function normalizeServerUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol === 'https:') u.protocol = 'wss:';
    if (u.protocol === 'http:') u.protocol = 'ws:';
    if (u.username || u.password || u.search || u.hash || !['wss:', 'ws:'].includes(u.protocol)) return null;
    if (u.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
    return u.href.replace(/\/+$/, '');
  } catch { return null; }
}
