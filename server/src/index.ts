import { joinPage, privacyPage, pageLanguage } from './pages';
// Worker fetch-handler: маршрутизирует WebSocket-upgrade в Durable Object
// по room-коду из пути URL: wss://<host>/room/<code>.
// Плюс: страница-приглашение /join (back-compat), именованная /r/<slug> и GET /version.

import { Room } from './room';
import { Presence } from './presence';
import { validRoom } from '../../extension/src/shared/protocol';


export { Room };
export { Presence };

export interface Env {
  ROOM: DurableObjectNamespace;
  PRESENCE: DurableObjectNamespace;
  RELEASE_SHA?: string;
}

// Версия, уже загруженная владельцем в существующую карточку Chrome Web Store.
// Следующую объявлять только после ее публикации в магазине.
const PUBLISHED_EXTENSION_VERSION = '0.6.0';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({ service: 'syncwatch-signal', version: '0.4.1', revision: env.RELEASE_SHA || 'development' }), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // Эндпоинт версии — JSON для клиента-нотификатора (Фаза C).
    if (parts[0] === 'version') {
      return new Response(JSON.stringify({ version: PUBLISHED_EXTENSION_VERSION, notes: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    if (parts[0] === 'updates.json') return new Response('Not found', { status: 404 });

    // Инвайт-страница: цель для клика партнёра (Фаза 4). Сам вход выполняет
    // content-script расширения (читает #r=…&s=… из хэша); HTML — лишь оболочка и
    // фолбэк для случая, когда расширение не установлено.
    if (parts[0] === 'join') {
      return htmlPage(joinPage(null, pageLanguage(request)));
    }

    // Именованная комната /r/<slug>: та же страница, но показывает имя комнаты.
    // Идентичность комнаты по-прежнему stateless — env.ROOM.idFromName(slug).
    if (parts[0] === 'r' && parts[1]) {
      return htmlPage(joinPage(parts[1], pageLanguage(request)));
    }

    // Presence «друзья онлайн»: HTTP JSON к тому же Worker, отдельный Durable Object
    // (единственный инстанс). НЕ WebSocket-релей. Полный запрос форвардим как есть —
    // DO читает parts[1] (beat/query/friend). См. server/src/presence.ts.
    if (parts[0] === 'presence') {
      return env.PRESENCE.get(env.PRESENCE.idFromName('v1')).fetch(request);
    }

    // Политика конфиденциальности: обязательный URL для Chrome Web Store.

    // Отдаётся с нашего домена по стабильной ссылке, ссылка вписывается в листинг сторов.
    if (parts[0] === 'privacy') {
      return htmlPage(privacyPage(pageLanguage(request)));
    }

    if (parts[0] !== 'room' || !parts[1]) {
      return new Response('SyncWatch signaling server', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const roomCode = parts[1];
    if (!validRoom(roomCode) || parts.length !== 2) return new Response('Invalid room code', { status: 400 });
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
