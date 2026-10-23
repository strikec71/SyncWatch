// Promisified adapter for Chrome extension APIs, typed with @types/chrome.
import polyfill from 'webextension-polyfill';

const browser = polyfill as unknown as typeof chrome;
export default browser;
