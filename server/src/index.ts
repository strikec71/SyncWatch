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
      return new Response(JSON.stringify({ service: 'syncwatch-signal', version: '0.4.0', revision: env.RELEASE_SHA || 'development' }), {
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
      return htmlPage(joinPage(null));
    }

    // Именованная комната /r/<slug>: та же страница, но показывает имя комнаты.
    // Идентичность комнаты по-прежнему stateless — env.ROOM.idFromName(slug).
    if (parts[0] === 'r' && parts[1]) {
      return htmlPage(joinPage(parts[1]));
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
      return htmlPage(privacyPage());
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
<meta name="syncwatch-invite" content="1" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 460px; margin: 12vh auto; padding: 0 20px; line-height: 1.5; }
  h1 { font-size: 20px; }
  .muted { opacity: .7; font-size: 14px; }
  code { background: rgba(127,127,127,.18); padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
  <h1>SyncWatch — приглашение в комнату</h1>
  ${roomLine}
  <p class="muted">Если установлено расширение SyncWatch, нажмите «Войти в комнату» в карточке приглашения. Управление доступно также с иконки расширения.</p>
  <p class="muted">Ничего не произошло? Установите расширение SyncWatch (Load unpacked / about:debugging), затем откройте эту ссылку снова.</p>
</body>
</html>`;
}

// Политика конфиденциальности SyncWatch. Статический документ; отражает фактическое
// поведение расширения (см. CLAUDE.md): ретранслятор команд плеера, без сбора личных
// данных и без хранения на сервере. Дату «в силе» обновлять при существенных изменениях.
function privacyPage(): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SyncWatch — Политика конфиденциальности</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 8vh auto; padding: 0 20px; line-height: 1.6; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  h2 { font-size: 17px; margin-top: 28px; }
  .muted { opacity: .7; font-size: 14px; }
  code { background: rgba(127,127,127,.18); padding: 1px 5px; border-radius: 4px; }
  ul { padding-left: 20px; }
  li { margin: 4px 0; }
</style>
</head>
<body>
  <h1>Политика конфиденциальности SyncWatch</h1>
  <p class="muted">В силе с 23 октября 2026 г.</p>


  <p>SyncWatch — браузерное расширение для совместного просмотра видео: оно
  синхронизирует команды плеера (воспроизведение, пауза, перемотка, скорость) между
  участниками одной комнаты, создавая эффект «одного экрана». Расширение не имеет
  собственной медиатеки и не передаёт изображение или звук.</p>

  <h2>Какие данные обрабатываются</h2>
  <p>Для работы синхронизации между участниками в реальном времени передаются только:</p>
  <ul>
    <li>секретный код доступа к комнате;</li>
    <li>адрес страницы просмотра (включая параметры, нужные для серии), выбранная серия, сезон и озвучка;</li>
    <li>отображаемое имя устройства, которое вы указываете сами (можно оставить произвольным);</li>
    <li>события плеера: воспроизведение, пауза, позиция перемотки, скорость, состояние
    буферизации/рекламы;</li>
    <li>быстрые фразы и введенный вами текст чата (до 200 символов);</li>
    <li>временный идентификатор соединения (генерируется заново при каждом подключении).</li>
  </ul>
  <p>Эти данные передаются <strong>транзитно</strong> через сервер-ретранслятор другим
  участникам вашей комнаты и нужны исключительно для синхронизации просмотра.</p>

  <h2>Присутствие (друзья онлайн)</h2>
  <p>При включенном обмене статусом расширение примерно раз в минуту отправляет выбранному серверу
  публичный идентификатор установки, имя устройства, текущую комнату на этом сервере и хеши
  идентификаторов друзей, которым разрешена видимость. Запросы подписываются приватным
  ключом установки с привязкой к адресу сервера, телу и времени; сервер получает публичный ключ и подпись. Приватный ключ не передается серверу или в приглашениях. Владелец сервера
  обрабатывает эти данные и может сопоставлять связи, несмотря на хеширование списка доступа.</p>
  <p>Статус доступен только подтвержденным получателям и истекает через 150 секунд без обновлений.
  Просроченные записи удаляются служебным alarm. Выключение обмена отправляет одно служебное
  удаление статуса и прекращает периодическую отправку и опрос; при сетевой ошибке действует TTL.
  Смена сервера отзывает старый статус. Из нескольких вкладок публикуется первая подключенная
  комната выбранного сервера; вкладки в соло не публикуются как совместный просмотр.</p>
  <p>Приглашение в друзья содержит отдельный случайный токен на 7 дней. Сервер хранит его хеш и
  срок действия; создание новой ссылки заменяет прежнюю. Подтверждения дружбы хранятся до получения
  квитанции клиента, максимум 14 дней. Список друзей хранится в браузере; сервер временно обрабатывает
  списки доступа и подтверждения. Отображаемое имя в ссылке задает отправитель и не удостоверяет личность.</p>

  <h2>Чего мы НЕ делаем</h2>
  <ul>
    <li>Не запрашиваем аккаунт, email, телефон, адрес или платёжные данные. Выбранное отображаемое имя передается участникам.</li>
    <li>Не записываем историю просмотров и сообщения в постоянное прикладное хранилище. Текущее состояние комнаты временно обрабатывается в памяти сервера.</li>
    <li>Не передаем текст страниц, изображение или звук. Расширение читает URL, элементы video и элементы выбора серии/озвучки для синхронизации.</li>
    <li>Не продаём данные. Передача участникам комнаты, подтвержденным друзьям и выбранному серверу описана выше; сервер использует инфраструктуру Cloudflare.</li>
    <li>Не используем данные для рекламы, профилирования или оценки кредитоспособности.</li>
    <li>Не задействуем аналитику, трекеры и сторонний удалённый код.</li>
  </ul>

  <h2>Хранение на вашем устройстве</h2>
  <p>Настройки (код комнаты, имя устройства, адрес сервера, порог рассинхрона,
  переключатели) хранятся в <code>storage.local</code>, намерения подключения вкладок — в <code>storage.session</code>. Код комнаты и имя передаются серверу и участникам при подключении; адрес сервера нужен для связи.</p>
  <p>Идентификатор и приватный ключ установки, список друзей, входящие запросы и квитанции хранятся в storage.local. История чата (до 50 сообщений) хранится только в памяти фоновой сессии и исчезает при выходе или перезапуске worker.</p>


  <h2>Разрешения</h2>
  <ul>
    <li><code>storage</code> — локальное хранение ваших настроек.</li>
    <li><code>alarms</code> — служебный таймер, поддерживающий соединение (keepalive),
    проверку обновлений и периодический обмен статусом присутствия с друзьями;
    сам по себе не передает данные: запросы выполняет код расширения.</li>
    <li>доступ к сайтам — чтобы обнаружить видеоплеер на странице; целевые домены
    заранее неизвестны, поэтому запрашивается доступ ко всем сайтам. Для адаптеров читаются элементы управления плеером. Совместная навигация ограничена сайтом просмотра; при уходе на другой сайт включается соло.</li>
  </ul>

  <h2>Сервер</h2>
  <p>Ретранслятор реализован на Cloudflare Workers и передаёт сообщения между участниками
  комнаты в реальном времени. Сообщения не записываются в постоянное прикладное хранилище; последнее состояние временно находится в памяти. Оператор выбранного вами сервера и Cloudflare обрабатывают сетевые подключения по своим правилам.</p>

  <h2>Дети</h2>
  <p>Расширение не предназначено для сбора данных детей и не собирает персональные данные
  ни от каких пользователей.</p>

  <h2>Изменения</h2>
  <p>При существенных изменениях мы обновим эту страницу и дату «в силе».</p>

  <h2>Контакты</h2>
  <p>Вопросы по конфиденциальности: <a href="mailto:strikec71@gmail.com">strikec71@gmail.com</a>.</p>
</body>
</html>`;
}
