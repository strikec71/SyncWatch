// Обработка инвайт-ссылок (Фаза 4): подключение в один клик.
// Партнёр открывает ссылку с room-кодом в хэше — мы сохраняем настройки и просим
// background подключиться. Два формата:
//   • страница /join: #r=<код>&s=<wss-сервер>  (универсальная ссылка-приглашение)
//   • любой URL видео: #syncwatch=<код>          (server берётся из дефолта)
// Запускать только в верхнем фрейме — хэш живёт на адресе вкладки.

import browser from '../shared/browser';
import { saveSettings } from '../shared/settings';

export function handleInvite(): void {
  if (window.top !== window) return; // хэш — только у верхнего документа
  const hash = location.hash.slice(1);
  if (!hash) return;

  const params = new URLSearchParams(hash);
  const room = (params.get('r') ?? params.get('syncwatch') ?? '').trim();
  if (!room) return; // в хэше нет нашего приглашения — не вмешиваемся (SPA-роутинг и пр.)

  const rawServer = params.get('s');
  const serverUrl = rawServer ? safeDecode(rawServer).trim() : undefined;

  void apply(room, serverUrl);
}

async function apply(room: string, serverUrl?: string): Promise<void> {
  await saveSettings(serverUrl ? { room, serverUrl } : { room });
  // Убираем хэш, чтобы приглашение не сработало повторно при навигации/перезагрузке.
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch { /* некоторые песочницы запрещают replaceState */ }
  await browser.runtime.sendMessage({ kind: 'connect' }).catch(() => { /* SW перезапускается */ });
  showToast(`SyncWatch: подключаюсь к комнате «${room}»…`);
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Короткое всплывающее подтверждение (3с). Оверлей Фазы 5 затем показывает статус. */
function showToast(text: string): void {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);';
  const shadow = host.attachShadow({ mode: 'open' });
  const box = document.createElement('div');
  box.textContent = text;
  box.style.cssText =
    'font-family:system-ui,sans-serif;font-size:13px;color:#fff;background:#1a73e8;' +
    'padding:9px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);';
  shadow.appendChild(box);
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 3000);
}
