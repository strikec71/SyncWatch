// Тестовый стаб для webextension-polyfill: настоящий полифилл бросает исключение вне
// контекста расширения (нет globalThis.chrome.runtime.id). Юнит-тесты чистых функций
// хаба этих API не вызывают — стаб нужен лишь чтобы импорт модулей разрешался в Node.
// vitest.config.ts алиасит 'webextension-polyfill' сюда.

const resolved = () => Promise.resolve();

const stub = {
  tabs: {
    sendMessage: () => resolved(),
    query: () => Promise.resolve([] as unknown[]),
    update: () => resolved(),
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
