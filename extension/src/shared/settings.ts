// Обёртка над browser.storage.local для пользовательских настроек.

import browser from './browser';

export interface Settings {
  /** Базовый URL сервера, например wss://syncwatch-signal.<subdomain>.workers.dev */
  serverUrl: string;
  /** Код комнаты — общий секрет на двоих. */
  room: string;
  /** Допустимый рассинхрон без коррекции, секунды (Фаза 2). */
  driftThreshold: number;
  /** Автоматически подключаться при старте браузера и переподключаться при обрыве (Фаза 4). */
  autoConnect: boolean;
  /** Показывать внутристраничную панель управления (Фаза 5). */
  overlayEnabled: boolean;
  /** Имя этого устройства для списка подключённых (реальный hostname браузеру недоступен). */
  deviceName: string;
  /** Показывать друзьям, что я онлайн / в комнате (Фаза «друзья»). false → presence-beat
   *  не шлётся вовсе, друзья видят «оффлайн». */
  sharePresence: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  // Пусто НАМЕРЕННО: общего публичного релея по умолчанию нет. Каждый поднимает свой
  // (см. docs/PUBLISHING.md / инструкцию self-host) и вписывает адрес в поле «Сервер»,
  // либо получает его автоматически из инвайт-ссылки /join (#r=код&s=сервер). Без адреса
  // connect() вернёт «Не задан адрес сервера» — это ожидаемо до первой настройки/приглашения.
  serverUrl: '',
  room: '',
  driftThreshold: 2.0,
  autoConnect: true,
  overlayEnabled: true,
  deviceName: '', // пустое → сгенерируем при первом запуске (см. ensureDeviceName)
  sharePresence: true,
};

/** Сгенерировать дефолтное имя устройства из платформы + короткий суффикс. */
export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Android/.test(ua) ? 'Android'
    : /Linux/.test(ua) ? 'Linux'
    : 'PC';
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${os}-${suffix}`;
}

/** Вернуть имя устройства, сгенерировав и сохранив его при первом обращении. */
export async function ensureDeviceName(): Promise<string> {
  const s = await loadSettings();
  if (s.deviceName) return s.deviceName;
  const name = defaultDeviceName();
  await saveSettings({ deviceName: name });
  return name;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings> | undefined) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = { ...current, ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}

// ── Идентичность и друзья (Фаза «друзья + presence») ──────────────────────────
// Всё живёт ОТДЕЛЬНЫМИ ключами storage.local, НЕ в блобе `settings`: у saveSettings
// read-modify-write гонка (см. коммент overlay.ts про per-field persist), а friends/
// identity/inbox пишутся из background асинхронно и независимо от островка.
// `clientId` — единственный стабильный per-install идентификатор (crypto.randomUUID,
// однократно); отображаемое имя — по-прежнему редактируемое `deviceName`.

/** Стабильная per-install идентичность. Два устройства одного человека = два clientId. */
export interface Identity {
  clientId: string;
}

/** Друг в списке: непрозрачный clientId + имя (снимок его deviceName на момент добавления). */
export interface Friend {
  id: string;
  name: string;
  addedAt: number;
}

/** Входящий запрос в друзья, ждёт «Принять»/«Отклонить» в островке. `serverUrl` — адрес
 *  релея инициатора: принявший наследует его, если своего ещё нет. */
export interface FriendInboxEntry {
  id: string;
  name: string;
  serverUrl: string;
  ts: number;
}

const IDENTITY_KEY = 'identity';
const FRIENDS_KEY = 'friends';
const FRIEND_INBOX_KEY = 'friendInbox';

export async function loadIdentity(): Promise<Identity | null> {
  const stored = await browser.storage.local.get(IDENTITY_KEY);
  const v = stored[IDENTITY_KEY] as Partial<Identity> | undefined;
  return v && typeof v.clientId === 'string' && v.clientId ? { clientId: v.clientId } : null;
}

/** Вернуть clientId, сгенерировав и сохранив его при первом обращении. */
export async function ensureClientId(): Promise<string> {
  const existing = await loadIdentity();
  if (existing) return existing.clientId;
  const clientId = crypto.randomUUID();
  await browser.storage.local.set({ [IDENTITY_KEY]: { clientId } as Identity });
  return clientId;
}

export async function loadFriends(): Promise<Friend[]> {
  const stored = await browser.storage.local.get(FRIENDS_KEY);
  const list = stored[FRIENDS_KEY];
  if (!Array.isArray(list)) return [];
  return list.filter(
    (f): f is Friend =>
      !!f &&
      typeof f.id === 'string' &&
      typeof f.name === 'string' &&
      typeof f.addedAt === 'number',
  );
}

export async function saveFriends(list: Friend[]): Promise<void> {
  await browser.storage.local.set({ [FRIENDS_KEY]: list });
}

export async function loadFriendInbox(): Promise<FriendInboxEntry[]> {
  const stored = await browser.storage.local.get(FRIEND_INBOX_KEY);
  const list = stored[FRIEND_INBOX_KEY];
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is FriendInboxEntry =>
      !!e &&
      typeof e.id === 'string' &&
      typeof e.name === 'string' &&
      typeof e.serverUrl === 'string' &&
      typeof e.ts === 'number',
  );
}

export async function saveFriendInbox(list: FriendInboxEntry[]): Promise<void> {
  await browser.storage.local.set({ [FRIEND_INBOX_KEY]: list });
}
