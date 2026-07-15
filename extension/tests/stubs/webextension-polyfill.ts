// Тестовый стаб для webextension-polyfill: настоящий полифилл бросает исключение вне
// контекста расширения (нет globalThis.chrome.runtime.id). Юнит-тесты чистых функций
// хаба этих API не вызывают — стаб нужен лишь чтобы импорт модулей разрешался в Node.
// vitest.config.ts алиасит 'webextension-polyfill' сюда.

const resolved = () => Promise.resolve();

// Реестр URL вкладок для tabs.get — тесты Fix 1 (сверка реального URL перед reload) им
// управляют через __setTabUrl/__clearTabs. По умолчанию url отсутствует (Fix 1 не срабатывает).
const tabUrls = new Map<number, string>();
export function __setTabUrl(tabId: number, url: string): void { tabUrls.set(tabId, url); }
export function __clearTabs(): void { tabUrls.clear(); }

const stub = {
  tabs: {
    sendMessage: () => resolved(),
    query: () => Promise.resolve([] as unknown[]),
    update: () => resolved(),
    get: (tabId: number) => Promise.resolve({ id: tabId, url: tabUrls.get(tabId) }),
  },
  runtime: {
    sendMessage: () => resolved(),
    onMessage: { addListener: () => {} },
  },
  alarms: {
    create: () => {},
    clear: () => Promise.resolve(true),
    onAlarm: { addListener: () => {} },
  },
  storage: {
    local: { get: () => Promise.resolve({}), set: () => resolved() },
    sync: { get: () => Promise.resolve({}), set: () => resolved() },
    onChanged: { addListener: () => {} },
  },
  action: { onClicked: { addListener: () => {} } },
};

export default stub;
