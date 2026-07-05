// Worker fetch-handler: маршрутизирует WebSocket-upgrade в Durable Object
// по room-коду из пути URL: wss://<host>/room/<code>.
// Плюс: страница-приглашение /join (back-compat), именованная /r/<slug> и GET /version.

import { Room } from './room';

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace;
}

// Версия сервера для нотификатора обновлений (Фаза C потребляет /version). Это «последняя
// опубликованная» версия: клиент показывает баннер обновления, когда VERSION > установленной.
// Бампить ПОСЛЕ публикации новой сборки в CWS/AMO (см. PUBLISHING.md).
const VERSION = '0.2.0';

// GitHub Releases — хостинг подписанного Firefox `.xpi`. Тег релиза = `v<version>`,
// имя ассета фиксировано (его же кладёт `npm run package`). OWNER/REPO — реальный
// репозиторий (подставить при первом релизе, см. PUBLISHING.md).
const GH_REPO = 'strikec71/SyncWatch';

/** Манифест обновления Firefox (self-distribution): версия → ссылка на подписанный `.xpi`.
 *  Firefox опрашивает `update_url` из manifest.firefox.json, сверяет версию и качает `.xpi`.
 *  Чистая функция — тестируется без Worker-харнеса. */
export function firefoxUpdatesManifest(version: string): string {
  return JSON.stringify({
    addons: {
      'syncwatch@local': {
        updates: [
          {
            version,
            update_link: `https://github.com/${GH_REPO}/releases/download/v${version}/syncwatch-firefox-${version}.xpi`,
          },
        ],
      },
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // Эндпоинт версии — JSON для клиента-нотификатора (Фаза C).
    if (parts[0] === 'version') {
      return new Response(JSON.stringify({ version: VERSION, notes: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    // Firefox-манифест автообновления (Фаза C). Указан как `update_url` в
    // manifest.firefox.json; отдаётся с нашего домена, ссылается на `.xpi` в GitHub Releases.
    if (parts[0] === 'updates.json') {
      return new Response(firefoxUpdatesManifest(VERSION), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    // Инвайт-страница: цель для клика партнёра (Фаза 4). Сам вход выполняет
    // content-script расширения (читает #r=…&s=… из хэша); HTML — лишь оболочка и
    // фолбэк для случая, когда расширение не установлено.
    if (parts[0] === 'join') {
      return htmlPage(joinPage(null));
    }

    // Именованная комната /r/<slug>: та же страница, но показывает имя комнаты.
    // Идентичность комнаты по-прежнему stateless — env.ROOM.idFromName(slug).
    if (parts[0] === 'r' && parts[1]) {
      return htmlPage(joinPage(parts[1]));
    }

    if (parts[0] !== 'room' || !parts[1]) {
      return new Response('SyncWatch signaling server', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const roomCode = parts[1];
    const id = env.ROOM.idFromName(roomCode);
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  },
};

function htmlPage(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// HTML-экранирование для slug (идёт из URL — недоверенный вход).
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

// Статическая страница приглашения. Расширение перехватывает её через content-script
// и само подключается к комнате из хэша; этот HTML виден лишь как подтверждение/фолбэк.
// slug !== null → именованная /r/<slug>, показываем имя комнаты.
function joinPage(slug: string | null): string {
  const roomLine = slug
    ? `<p class="muted">Комната: <code>${esc(slug)}</code></p>`
    : '';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SyncWatch — приглашение</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 460px; margin: 12vh auto; padding: 0 20px; line-height: 1.5; }
  h1 { font-size: 20px; }
  .muted { opacity: .7; font-size: 14px; }
  code { background: rgba(127,127,127,.18); padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
  <h1>SyncWatch — подключаюсь к комнате…</h1>
  ${roomLine}
  <p class="muted">Если установлено расширение SyncWatch, оно сейчас автоматически подключит вас к совместному просмотру.</p>
  <p class="muted">Ничего не произошло? Установите расширение SyncWatch (Load unpacked / about:debugging), затем откройте эту ссылку снова.</p>
</body>
</html>`;
}
