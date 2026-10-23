// Друзья + живой presence (Фаза «друзья»). Presence идёт HTTP-JSON к тому же Worker,
// НЕ через WS-релей: `beat` («я онлайн вот в этой комнате») + `query` («статусы друзей +
// мой инбокс»). Комнатный релей (room.ts / protocol.ts / parseWire) не трогаем.
//
// Ядро — чистые функции (деривация https-хоста, sha256-hex, view→статус, слияние инбокса,
// сборка ссылок); сетевые обёртки дёргают fetch из service worker. Хранилище — отдельные
// ключи storage.local (см. shared/settings.ts), а не блоб `settings`.
//
// ⚠️ sha256-hex — СТРОЧНЫМИ буквами: сервер держит `allow` в lowercase и сверяет как есть.
// ⚠️ friendViews живут в памяти SW и теряются при выгрузке — восстанавливаются первым же
//    тиком аларма (или kick'ом при открытии островка).

import browser from '../shared/browser';
import {
  loadSettings,
  saveSettings,
  ensureClientId,
  ensureDeviceName,
  loadFriends,
  saveFriends,
  loadFriendInbox,
  saveFriendInbox,
  type Friend,
} from '../shared/settings';
import type { PresenceQueryResult, PresenceView } from '../shared/presence';
import type {
  FriendRow,
  InboxRow,
  FriendsStatusMsg,
  EventMsg,
  FriendRequestIncomingMsg,
} from '../shared/messages';
import { allSessions } from './state';

export const PRESENCE_ALARM = 'syncwatch-presence';

const PRESENCE_PERIOD_MIN = 1; // браузер клампит к своему минимуму; presence-TTL на сервере ~150с
const TICK_THROTTLE_MS = 5000; // не гоняем tick чаще этого на ручных триггерах (открытие островка)

// friendId → последний известный статус (пусто = ещё не опрашивали / SW перезапустился).
const friendViews = new Map<string, PresenceView>();
let lastTickAt = 0;

// ── Чистые функции (unit-testable без сети) ──────────────────────────────────

/** `wss://host` → `https://host`, `ws://host` → `http://host`; хвостовой слэш срезаем.
 *  Уже-http(s) URL пропускаем как есть; голый хост считаем https. Пустой вход → ''. */
export function httpsHostFromServer(serverUrl: string): string {
  const t = serverUrl.trim().replace(/\/+$/, '');
  if (!t) return '';
  if (t.startsWith('wss://')) return 'https://' + t.slice(6);
  if (t.startsWith('ws://')) return 'http://' + t.slice(5);
  if (t.startsWith('https://') || t.startsWith('http://')) return t;
  return 'https://' + t;
}

/** PresenceView → статус-строка для островка. offline → нет кнопки «Войти». */
export function viewToStatus(v: PresenceView | undefined): FriendRow['status'] {
  if (!v || !v.online) return 'offline';
  return v.room ? 'watching' : 'online';
}

/** sha256(строка) в СТРОЧНОМ hex — ровно то, что сервер держит в `allow` и сверяет. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Слить входящие `accept` из инбокса в список друзей: инициатор уже согласился, отправив
 *  ссылку, поэтому accept партнёра завершает рукопожатие. Дедуп по id. Возвращает новый
 *  список + имена реально добавленных (для тоста). Чистая. */
export function mergeAcceptInbox(
  friends: Friend[],
  inbox: PresenceQueryResult['inbox'],
  now: number,
): { friends: Friend[]; added: string[] } {
  const byId = new Map(friends.map((f) => [f.id, f]));
  const added: string[] = [];
  for (const m of inbox) {
    if (m.kind !== 'accept' || byId.has(m.from)) continue;
    const f: Friend = { id: m.from, name: m.fromName || 'Друг', addedAt: now };
    byId.set(f.id, f);
    added.push(f.name);
  }
  return { friends: [...byId.values()], added };
}

/** Ссылка-приглашение в друзья: friend-invite.ts парсит `#syncwatch-friend=` на ЛЮБОМ URL,
 *  но саму ссылку кладём на страницу `/join` сервера (единый вид с обычным инвайтом). */
export function buildFriendLink(
  httpsHost: string,
  clientId: string,
  deviceName: string,
  wssServer: string,
): string {
  const q =
    `syncwatch-friend=${encodeURIComponent(clientId)}` +
    `&n=${encodeURIComponent(deviceName)}` +
    `&s=${encodeURIComponent(wssServer)}`;
  return `${httpsHost}/join#${q}`;
}

/** URL новой вкладки «Войти к другу» — та же цепочка, что обычный инвайт
 *  (`/join#r=&s=` → invite.ts handleInvite → connect → снапшот хоста → cold-start). */
export function buildJoinUrl(httpsHost: string, room: string, wssServer: string): string {
  return `${httpsHost}/join#r=${encodeURIComponent(room)}&s=${encodeURIComponent(wssServer)}`;
}

// ── Сетевые обёртки ─────────────────────────────────────────────────────────

async function postJson(url: string, body: unknown): Promise<unknown> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null; // сеть/CORS/оффлайн — presence best-effort, молча
  }
}

/** Комната для presence-beat: код первой сессии с живым (или поднимающимся) сокетом.
 *  Не ждём `connected`: connect() резолвится ещё до `open`, а мы хотим, чтобы статус
 *  «смотрит» вставал у друзей сразу после нажатия «Подключиться». Неудачный connect
 *  самоисправится (teardownSocket обнулит s.ws) в пределах TTL/аларма. */
function currentRoom(): string {
  for (const s of allSessions()) {
    if (s.room && !s.intentionalClose && !s.idleClosed && (s.connected || s.ws)) return s.room;
  }
  return '';
}

/** POST /presence/beat. Пропускаем при `!sharePresence` (друзья увидят «оффлайн» по TTL). */
export async function beatPresence(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.sharePresence) return;
  const host = httpsHostFromServer(settings.serverUrl);
  if (!host) return;
  const friends = await loadFriends();
  const [clientId, deviceName] = await Promise.all([ensureClientId(), ensureDeviceName()]);
  const allow = await Promise.all(friends.map((f) => sha256Hex(f.id)));
  await postJson(`${host}/presence/beat`, {
    clientId,
    room: currentRoom(),
    deviceName,
    allow,
  });
}

/** POST /presence/query: обновить friendViews, разобрать инбокс (accept → авто-add),
 *  запушить `friends-status` во все островки. */
export async function pollPresence(): Promise<void> {
  const settings = await loadSettings();
  const host = httpsHostFromServer(settings.serverUrl);
  if (!host) return;
  const clientId = await ensureClientId();
  const friends = await loadFriends();
  const result = (await postJson(`${host}/presence/query`, {
    clientId,
    friendIds: friends.map((f) => f.id),
  })) as PresenceQueryResult | null;
  if (!result) return;

  friendViews.clear();
  for (const [id, view] of Object.entries(result.views ?? {})) friendViews.set(id, view);

  const inbox = Array.isArray(result.inbox) ? result.inbox : [];
  if (inbox.length) {
    const merged = mergeAcceptInbox(friends, inbox, Date.now());
    if (merged.added.length) {
      await saveFriends(merged.friends);
      for (const name of merged.added) toast(`${name} теперь у вас в друзьях`);
      await ensurePresenceAlarm();
    }
  }

  await pushFriendsStatus();
}

/** beat + query одним тиком (вызывается аларм-обработчиком index.ts). */
export async function tickPresence(): Promise<void> {
  lastTickAt = Date.now();
  await beatPresence();
  await pollPresence();
}

// ── Аларм ────────────────────────────────────────────────────────────────────

/** Держать presence-аларм включённым, когда `sharePresence && друзей > 0`; иначе гасить. */
export async function ensurePresenceAlarm(): Promise<void> {
  const [settings, friends] = await Promise.all([loadSettings(), loadFriends()]);
  if (settings.sharePresence && friends.length > 0) {
    browser.alarms.create(PRESENCE_ALARM, { periodInMinutes: PRESENCE_PERIOD_MIN });
  } else {
    await clearPresenceAlarm();
  }
}

export async function clearPresenceAlarm(): Promise<void> {
  await browser.alarms.clear(PRESENCE_ALARM);
  friendViews.clear();
}

// ── Пуш в островки ──────────────────────────────────────────────────────────

async function friendRows(): Promise<FriendRow[]> {
  const friends = await loadFriends();
  return friends.map((f) => {
    const v = friendViews.get(f.id);
    return { id: f.id, name: f.name, status: viewToStatus(v), room: v?.room ?? '' };
  });
}

async function inboxRows(): Promise<InboxRow[]> {
  const inbox = await loadFriendInbox();
  return inbox.map((e) => ({ id: e.id, name: e.name }));
}

/** Разослать актуальный список друзей + инбокс во все островки (глобальный бродкаст —
 *  друзья не привязаны к вкладке). */
export async function pushFriendsStatus(): Promise<void> {
  const [friends, inbox] = await Promise.all([friendRows(), inboxRows()]);
  const msg: FriendsStatusMsg = { kind: 'friends-status', friends, inbox };
  browser.runtime.sendMessage(msg).catch(() => { /* островков нет — норма */ });
}

/** Тост в островок (глобально) — переиспользуем существующий `event`-канал onPush. */
function toast(text: string): void {
  const ev: EventMsg = { kind: 'event', text, ts: Date.now() };
  browser.runtime.sendMessage(ev).catch(() => { /* островков нет */ });
}

/** Ненавязчивый рефреш при ручном триггере (открытие островка) — с троттлингом. */
function maybeKickTick(): void {
  if (Date.now() - lastTickAt > TICK_THROTTLE_MS) void tickPresence();
}

// ── Обработчики runtime-сообщений (зовёт index.ts) ───────────────────────────

export async function handleGetFriends(
  sendResponse: (r: { friends: FriendRow[]; inbox: InboxRow[] }) => void,
): Promise<void> {
  const [friends, inbox] = await Promise.all([friendRows(), inboxRows()]);
  sendResponse({ friends, inbox });
  maybeKickTick();
}

export async function handleAddFriendLink(
  sendResponse: (r: { link?: string; error?: string }) => void,
): Promise<void> {
  const settings = await loadSettings();
  const host = httpsHostFromServer(settings.serverUrl);
  if (!settings.serverUrl || !host) {
    sendResponse({ error: 'Сначала задайте адрес сервера в настройках островка' });
    return;
  }
  const [clientId, deviceName] = await Promise.all([ensureClientId(), ensureDeviceName()]);
  sendResponse({ link: buildFriendLink(host, clientId, deviceName, settings.serverUrl) });
}

export async function handleAcceptFriend(id: string): Promise<void> {
  const inbox = await loadFriendInbox();
  const entry = inbox.find((e) => e.id === id);
  if (!entry) return;
  await saveFriendInbox(inbox.filter((e) => e.id !== id));

  const friends = await loadFriends();
  if (!friends.some((f) => f.id === id)) {
    friends.push({ id, name: entry.name || 'Друг', addedAt: Date.now() });
    await saveFriends(friends);
  }

  // Наследуем адрес релея инициатора, если своего ещё нет.
  let settings = await loadSettings();
  if (!settings.serverUrl && entry.serverUrl) {
    settings = await saveSettings({ serverUrl: entry.serverUrl });
  }

  // Рукопожатие: «я принял запрос <id>» → сервер кладёт accept в инбокс инициатора,
  // тот авто-добавит нас на своём следующем query.
  const host = httpsHostFromServer(settings.serverUrl);
  if (host) {
    const [clientId, deviceName] = await Promise.all([ensureClientId(), ensureDeviceName()]);
    await postJson(`${host}/presence/friend`, { from: clientId, fromName: deviceName, to: id });
  }

  await ensurePresenceAlarm();
  await tickPresence();
  await pushFriendsStatus();
}

export async function handleDeclineFriend(id: string): Promise<void> {
  const inbox = await loadFriendInbox();
  await saveFriendInbox(inbox.filter((e) => e.id !== id));
  await pushFriendsStatus();
}

export async function handleRemoveFriend(id: string): Promise<void> {
  const friends = await loadFriends();
  await saveFriends(friends.filter((f) => f.id !== id));
  friendViews.delete(id);
  await ensurePresenceAlarm();
  await pushFriendsStatus();
}

export async function handleFriendRequestIncoming(msg: FriendRequestIncomingMsg): Promise<void> {
  const friends = await loadFriends();
  if (friends.some((f) => f.id === msg.id)) return; // уже друзья — игнорируем повторную ссылку

  const inbox = await loadFriendInbox();
  const existing = inbox.find((e) => e.id === msg.id);
  if (existing) {
    // Повторная ссылка — освежим имя/сервер, метку не двигаем.
    const next = inbox.map((e) =>
      e.id === msg.id
        ? { ...e, name: msg.name || e.name, serverUrl: msg.serverUrl || e.serverUrl }
        : e,
    );
    await saveFriendInbox(next);
  } else {
    inbox.push({
      id: msg.id,
      name: msg.name || 'Друг',
      serverUrl: msg.serverUrl ?? '',
      ts: Date.now(),
    });
    await saveFriendInbox(inbox);
  }
  await pushFriendsStatus();
}

export async function handleJoinFriend(id: string): Promise<void> {
  const view = friendViews.get(id);
  if (!view || !view.online || !view.room) {
    toast('Друг сейчас не в комнате');
    return;
  }
  const settings = await loadSettings();
  const host = httpsHostFromServer(settings.serverUrl);
  if (!settings.serverUrl || !host) {
    toast('Не задан адрес сервера');
    return;
  }
  await browser.tabs.create({ url: buildJoinUrl(host, view.room, settings.serverUrl) });
}
