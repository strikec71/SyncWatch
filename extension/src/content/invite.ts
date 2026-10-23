import browser from '../shared/browser';
import { showFloatingLayer, removeFloatingLayer } from './floating-layer';
import { loadSettings } from '../shared/settings';
import { normalizeServerUrl } from '../shared/validation';
import { validRoom } from '../shared/protocol';

export function parseInvite(href: string, namedPage = false): { room: string; serverUrl?: string } | null {
  const url = new URL(href);
  const params = new URLSearchParams(url.hash.slice(1));
  const room = params.get('syncwatch') || (namedPage ? params.get('r') || url.pathname.match(/^\/r\/([^/]+)\/?$/)?.[1] : null);
  if (!validRoom(room)) return null;
  const raw = params.get('s') || (namedPage ? url.origin : undefined);
  const serverUrl = raw ? normalizeServerUrl(raw) : undefined;
  if (serverUrl === null) return null;
  return { room, ...(serverUrl ? { serverUrl } : {}) };
}

export function handleInvite(): void {
  if (window.top !== window) return;
  const invite = parseInvite(location.href, !!document.querySelector('meta[name="syncwatch-invite"]'));
  if (!invite) return;
  // A page cannot silently replace the signaling server or enter a room.
  void loadSettings().then(settings => {
    const serverUrl = invite.serverUrl || settings.serverUrl;
    const host = document.createElement('div'); host.dataset.syncwatchUi = '';
    host.style.cssText = 'position:fixed;z-index:2147483647;top:20px;left:20px';
    const shadow = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('section');
    box.style.cssText = 'font:14px system-ui;background:#162032;color:white;padding:20px;border-radius:12px;max-width:380px;overflow-wrap:anywhere';
    const text = document.createElement('p');
    text.textContent = `Войти в комнату ${invite.room} через ${serverUrl || 'неуказанный сервер'}? Участники смогут управлять видео и менять серию в этой вкладке.`;
    const join = document.createElement('button'); join.textContent = 'Войти в комнату';
    const dismiss = document.createElement('button'); dismiss.textContent = 'Отмена';
    const close = () => { removeFloatingLayer(host); host.remove(); };
    dismiss.onclick = close;
    join.onclick = async () => {
      join.disabled = true;
      try {
        const result = await browser.runtime.sendMessage({ kind: 'connect', room: invite.room, serverUrl }) as { ok?: boolean; error?: string };
        if (!result?.ok) throw new Error(result?.error || 'Не удалось подключиться');
        history.replaceState(null, '', location.pathname + location.search);
        // Keep controls available even on a join page with no video.
        await browser.runtime.sendMessage({ kind: 'open-overlay' });
        close();
      } catch (e) { text.textContent = String(e); join.disabled = false; }
    };
    box.append(text, join, dismiss); shadow.append(box); document.documentElement.append(host); showFloatingLayer(host, 30, shadow);
  }).catch(() => {});
}
