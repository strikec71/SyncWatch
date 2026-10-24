import { ENGLISH } from './translations';

export type Language = 'en' | 'ru';
export type LanguagePreference = Language | 'system';
const listeners = new Set<() => void>();
export function normalizeLanguage(value: unknown): LanguagePreference {
  return value === 'en' || value === 'ru' ? value : 'system';
}
export function resolveLanguage(value: unknown, browserLanguage = typeof navigator === 'undefined' ? 'en' : navigator.language): Language {
  const preference = normalizeLanguage(value);
  return preference === 'system' ? (/^ru(?:-|$)/i.test(browserLanguage) ? 'ru' : 'en') : preference;
}
let language: Language = resolveLanguage('system');
export function getLanguage(): Language { return language; }
export function setLanguage(preference: unknown): void {
  const next = resolveLanguage(preference);
  if (next === language) return;
  language = next;
  for (const listener of [...listeners]) listener();
}
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Only application-owned catalog keys are translated; interpolated user data stays verbatim. */
export function tr(key: string | TemplateStringsArray, ...values: unknown[]): string {
  const source = typeof key === 'string' ? key : key.reduce((text, part, index) => text + (index ? `{${index - 1}}` : '') + part, '');
  const message = language === 'en' ? ENGLISH[source] ?? source : source;
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => Number(index) < values.length ? String(values[Number(index)]) : placeholder);
}

/** Relocalize a previously stored application error, leaving unknown server text intact. */
export function localizeError(message: string): string {
  if (message.startsWith('Error: ')) return 'Error: ' + localizeError(message.slice(7));
  if (ENGLISH[message]) return tr(message);
  for (const [source, english] of Object.entries(ENGLISH)) {
    if (message === english) return tr(source);
    if (source.endsWith(': ')) {
      if (message.startsWith(source)) return tr(source) + message.slice(source.length);
      if (message.startsWith(english)) return tr(source) + message.slice(english.length);
    }
  }
  return message;
}

/** Bind only the trusted initial template, before any names/messages are inserted.
 * No observer, document scan, innerHTML translation or user-content substitution. */
export function bindTemplateLanguage(root: ShadowRoot): () => void {
  const bindings: Array<() => void> = [];
  const translateText = (source: string): string => source.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_all, before: string, text: string, after: string) => before + tr(text) + after);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text, source = text.data;
    if (text.parentElement?.tagName === 'STYLE') {
      // The one visible CSS empty-state string is also a catalog entry.
      const empty = 'Здесь начинается ваш разговор. Подключитесь к комнате, чтобы написать друзьям.';
      if (source.includes(empty)) bindings.push(() => { text.data = source.replace(empty, tr(empty)); });
    } else if (ENGLISH[source.trim()]) bindings.push(() => { text.data = translateText(source); });
  }
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    for (const attribute of ['title', 'aria-label', 'placeholder']) {
      const source = element.getAttribute(attribute);
      if (source && ENGLISH[source]) bindings.push(() => element.setAttribute(attribute, tr(source)));
    }
  }
  const update = () => { root.host.setAttribute('lang', language); for (const bind of bindings) bind(); };
  update();
  return onLanguageChange(update);
}
