// Обработка ссылок-приглашений в друзья (Фаза «друзья»).
// Ссылка вида  <любой URL>#syncwatch-friend=<clientId>&n=<имя>&s=<wss-сервер>  —
// кладём запрос в инбокс друзей (background), островок покажет «Принять / Отклонить».
// Только верхний фрейм — хэш живёт на адресе вкладки. Запускать СРАЗУ после handleInvite()
// (у того другой ключ хэша, `r`/`syncwatch`, — не пересекается) и ДО startNavSync().

import browser from '../shared/browser';
import { normalizeServerUrl } from '../shared/validation';
import { showFloatingLayer, removeFloatingLayer } from './floating-layer';

export function handleFriendInvite(): void {
  if (window.top !== window) return; // хэш — только у верхнего документа
  const hash = location.hash.slice(1);
  if (!hash) return;

  const params = new URLSearchParams(hash);
  const id = (params.get('syncwatch-friend') ?? '').trim();
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return; // не наше приглашение в друзья — не вмешиваемся (SPA-роутинг и пр.)

  // URLSearchParams.get() уже раз-декодирует значение (add-friend-link кодирует
  // encodeURIComponent один раз) — второй decodeURIComponent не нужен.
  const name = (params.get('n') ?? '').trim().slice(0, 64);
  const serverUrl = normalizeServerUrl(params.get('s') ?? '');
  const inviteToken = params.get('t') ?? '';
  if (!serverUrl || !/^[a-f0-9]{64}$/.test(inviteToken)) return;

  // Срезаем хэш, чтобы приглашение не сработало повторно при навигации/перезагрузке.
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch { /* некоторые песочницы запрещают replaceState */ }

  void browser.runtime
    .sendMessage({ kind: 'friend-request-incoming', id, name, serverUrl, inviteToken })
    .catch(() => { /* SW перезапускается — повторится при следующем открытии ссылки */ });

  showToast(`SyncWatch: запрос в друзья от ${name || 'кого-то'} — откройте островок, раздел «Друзья»`);
}

/** Короткое всплывающее подтверждение (4с). Дальше запрос виден в островке → «Друзья». */
function showToast(text: string): void {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:auto;margin:0;border:0;padding:0;background:transparent;top:16px;left:50%;transform:translateX(-50%);';
  const shadow = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  box.textContent = text;
  box.style.cssText =
    'font-family:system-ui,sans-serif;font-size:13px;color:#fff;background:#1a73e8;' +
    'padding:9px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:80vw;';
  shadow.appendChild(box);
  document.documentElement.appendChild(host);
  showFloatingLayer(host, 30);
  setTimeout(() => { removeFloatingLayer(host); host.remove(); }, 4000);
}
