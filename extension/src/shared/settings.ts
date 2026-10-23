// Обёртка над browser.storage.local для пользовательских настроек.

import browser from './browser';
import { publicKeyId, publicKeyShape, type SigningIdentity } from './identity';
import { normalizeServerUrl } from './validation';

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
  const raw = (stored.settings && typeof stored.settings === 'object' ? stored.settings : {}) as Partial<Settings>;
  return {
    serverUrl: typeof raw.serverUrl === 'string' ? normalizeServerUrl(raw.serverUrl) || '' : '',
    room: typeof raw.room === 'string' ? raw.room.slice(0, 128) : '',
    deviceName: typeof raw.deviceName === 'string' ? raw.deviceName.slice(0, 64) : '',
    driftThreshold: typeof raw.driftThreshold === 'number' && Number.isFinite(raw.driftThreshold) ? Math.max(0.25, Math.min(10, raw.driftThreshold)) : DEFAULT_SETTINGS.driftThreshold,
    autoConnect: typeof raw.autoConnect === 'boolean' ? raw.autoConnect : DEFAULT_SETTINGS.autoConnect,
    overlayEnabled: typeof raw.overlayEnabled === 'boolean' ? raw.overlayEnabled : DEFAULT_SETTINGS.overlayEnabled,
    sharePresence: typeof raw.sharePresence === 'boolean' ? raw.sharePresence : DEFAULT_SETTINGS.sharePresence,
  };
}

export type SettingsPatch = Partial<Settings>;
let backgroundWriter = false;
export function useBackgroundSettings(): void { backgroundWriter = true; }
let writeQueue: Promise<unknown> = Promise.resolve();
export function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const operation = writeQueue.catch(() => {}).then(async () => {
    const current = await loadSettings();
    const next = { ...current };
    if (typeof patch.room === 'string') next.room = patch.room.slice(0, 128);
    if (typeof patch.serverUrl === 'string') {
      const server = patch.serverUrl ? normalizeServerUrl(patch.serverUrl) : '';
      if (server === null) throw new Error('Нужен wss:// адрес сервера (ws:// разрешен для localhost)');
      next.serverUrl = server;
    }
    if (typeof patch.deviceName === 'string') next.deviceName = patch.deviceName.trim().slice(0, 64);
    if (typeof patch.autoConnect === 'boolean') next.autoConnect = patch.autoConnect;
    if (typeof patch.overlayEnabled === 'boolean') next.overlayEnabled = patch.overlayEnabled;
    if (typeof patch.sharePresence === 'boolean') next.sharePresence = patch.sharePresence;
    if (typeof patch.driftThreshold === 'number' && Number.isFinite(patch.driftThreshold)) next.driftThreshold = Math.max(0.25, Math.min(10, patch.driftThreshold));
    await browser.storage.local.set({ settings: next });
    return next;
  });
  writeQueue = operation;
  return operation;
}
export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  // Content documents all delegate writes to the single background queue.
  if (!backgroundWriter && typeof document !== 'undefined') {
    const result = await browser.runtime.sendMessage({ kind: 'save-settings', patch }) as { settings?: Settings; error?: string };
    if (!result?.settings) throw new Error(result?.error || 'Не удалось сохранить настройки');
    return result.settings;
  }
  return updateSettings(patch);
}

// ── Идентичность и друзья (Фаза «друзья + presence») ──────────────────────────
// Идентичность, друзья и инбокс хранятся отдельно от настроек. Записи настроек и
// мутации друзей сериализованы в background. clientId — SHA-256 публичного P-256 ключа;
// приватный ключ остается на устройстве. Отображаемое имя редактируется независимо.

/** Стабильная per-install идентичность. Два устройства одного человека = два clientId. */
export interface Identity extends SigningIdentity {}

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
  inviteToken?: string;
}

const IDENTITY_KEY = 'identity';
const FRIENDS_KEY = 'friends';
const FRIEND_INBOX_KEY = 'friendInbox';

export async function loadIdentity(): Promise<Identity | null> {
  const stored = await browser.storage.local.get(IDENTITY_KEY);
  const v = stored[IDENTITY_KEY] as Partial<Identity> | undefined;
  return v?.publicKey && v.privateKey?.d && publicKeyShape(v.publicKey) && v.privateKey.x === v.publicKey.x && v.privateKey.y === v.publicKey.y && v.clientId === await publicKeyId(v.publicKey)
    ? {clientId:v.clientId, publicKey:publicKeyShape(v.publicKey)!, privateKey:v.privateKey} : null;
}

// Single writer in the background; concurrent first-use calls must get one identity.
let identityQueue: Promise<Identity> | null = null;
export function ensureIdentity(): Promise<Identity> {
  if (identityQueue) return identityQueue;
  const operation = (async () => {
    const existing = await loadIdentity();
    if (existing) return existing;
    const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify']);
    const publicKey = publicKeyShape(await crypto.subtle.exportKey('jwk',pair.publicKey))!;
    const privateKey = await crypto.subtle.exportKey('jwk',pair.privateKey);
    const identity = {clientId:await publicKeyId(publicKey),publicKey,privateKey};
    await browser.storage.local.set({ [IDENTITY_KEY]: identity });
    return identity;
  })();
  identityQueue = operation;
  void operation.finally(() => { identityQueue = null; }).catch(() => {});
  return operation;
}
export async function ensureClientId(): Promise<string> { return (await ensureIdentity()).clientId; }

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
