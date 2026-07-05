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

    // Политика конфиденциальности: обязательный URL для Chrome Web Store / Firefox AMO.
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
  <p class="muted">В силе с 5 июля 2026 г.</p>

  <p>SyncWatch — браузерное расширение для совместного просмотра видео: оно
  синхронизирует команды плеера (воспроизведение, пауза, перемотка, скорость) между
  участниками одной комнаты, создавая эффект «одного экрана». Расширение не имеет
  собственной медиатеки и не передаёт изображение или звук.</p>

  <h2>Какие данные обрабатываются</h2>
  <p>Для работы синхронизации между участниками в реальном времени передаются только:</p>
  <ul>
    <li>код комнаты (произвольная строка, которую вы задаёте или генерируете);</li>
    <li>отображаемое имя устройства, которое вы указываете сами (можно оставить произвольным);</li>
    <li>события плеера: воспроизведение, пауза, позиция перемотки, скорость, состояние
    буферизации/рекламы;</li>
    <li>временный случайный идентификатор соединения (генерируется заново при каждом подключении).</li>
  </ul>
  <p>Эти данные передаются <strong>транзитно</strong> через сервер-ретранслятор другим
  участникам вашей комнаты и нужны исключительно для синхронизации просмотра.</p>

  <h2>Чего мы НЕ делаем</h2>
  <ul>
    <li>Не собираем персональные данные (имя, email, телефон, адрес, платёжные данные).</li>
    <li>Не сохраняем на сервере историю просмотров, ссылки на видео или события плеера —
    сервер работает как чистый ретранслятор и не ведёт логов содержимого.</li>
    <li>Не читаем и не передаём содержимое просматриваемых вами страниц; расширение
    работает только с элементом видео на странице.</li>
    <li>Не продаём и не передаём данные третьим лицам.</li>
    <li>Не используем данные для рекламы, профилирования или оценки кредитоспособности.</li>
    <li>Не задействуем аналитику, трекеры и сторонний удалённый код.</li>
  </ul>

  <h2>Хранение на вашем устройстве</h2>
  <p>Настройки (код комнаты, имя устройства, адрес сервера, порог рассинхрона,
  переключатели) хранятся локально в браузере через <code>storage.local</code> и не
  покидают ваше устройство.</p>

  <h2>Разрешения</h2>
  <ul>
    <li><code>storage</code> — локальное хранение ваших настроек.</li>
    <li><code>alarms</code> — служебный таймер, поддерживающий соединение (keepalive) и
    проверку обновлений; пользовательские данные не обрабатывает.</li>
    <li>доступ к сайтам — чтобы обнаружить видеоплеер на странице; целевые домены
    заранее неизвестны, поэтому запрашивается доступ ко всем сайтам. Содержимое страниц
    не читается.</li>
  </ul>

  <h2>Сервер</h2>
  <p>Ретранслятор реализован на Cloudflare Workers и передаёт сообщения между участниками
  комнаты в реальном времени. Содержимое сообщений на сервере не хранится.</p>

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
