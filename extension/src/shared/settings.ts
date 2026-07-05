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
}

export const DEFAULT_SETTINGS: Settings = {
  // Прошитый адрес задеплоенного релея — поле «Сервер» в UI трогать не нужно.
  serverUrl: 'wss://syncwatch-signal.strikec71.workers.dev',
  room: '',
  driftThreshold: 1.0,
  autoConnect: true,
  overlayEnabled: true,
  deviceName: '', // пустое → сгенерируем при первом запуске (см. ensureDeviceName)
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
