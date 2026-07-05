// У пакета webextension-polyfill нет резолвимых типов под нашу сборку; форму API
// мы берём из @types/chrome (см. shared/browser.ts), поэтому достаточно объявить
// модуль как any.
declare module 'webextension-polyfill';
