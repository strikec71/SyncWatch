// Единый promisified API расширений для Chrome и Firefox (Фаза 6).
// webextension-polyfill гарантирует промисы в обоих браузерах (в Firefox — нативный
// `browser.*`, в Chrome — обёртка над callback-ами `chrome.*`).
// Типы берём из @types/chrome; полифилл совместим с ними по форме промис-методов MV3.

import polyfill from 'webextension-polyfill';

const browser = polyfill as unknown as typeof chrome;
export default browser;
