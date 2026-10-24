import { afterEach, describe, expect, it, vi } from 'vitest';
import { tr, setLanguage, getLanguage, resolveLanguage, normalizeLanguage, onLanguageChange, localizeError } from '../src/shared/i18n';
import { ENGLISH } from '../src/shared/translations';
import { quickMessageByCode } from '../src/shared/quick-messages';
import { peersLabel } from '../src/content/overlay-roster';
import browser from '../src/shared/browser';
import { loadSettings, updateSettings } from '../src/shared/settings';

afterEach(() => { vi.restoreAllMocks(); setLanguage('ru'); });
describe('language selection and translation', () => {
  it('uses English for unsupported browsers and Russian for Russian browser variants', () => {
    expect(resolveLanguage('system', 'fr-FR')).toBe('en');
    expect(resolveLanguage('system', 'en-US')).toBe('en');
    expect(resolveLanguage('system', 'ru-KZ')).toBe('ru');
    expect(resolveLanguage('en', 'ru-RU')).toBe('en');
    expect(normalizeLanguage('unsafe')).toBe('system');
  });
  it('preserves interpolation slots in every English translation', () => {
    for (const [source, english] of Object.entries(ENGLISH)) {
      expect(english.trim(), source).not.toBe('');
      expect(english.match(/\{\d+\}/g)?.sort() ?? [], source).toEqual(source.match(/\{\d+\}/g)?.sort() ?? []);
      expect(english, source).not.toMatch(/[А-Яа-яЁё]/);
    }
  });
  it('changes quick phrases and participant plurals at render time', () => {
    setLanguage('en'); expect(quickMessageByCode('like')?.text).toBe('Nice!');
    expect(peersLabel(1)).toBe('1 participant'); expect(peersLabel(3)).toBe('3 participants');
    setLanguage('ru'); expect(quickMessageByCode('like')?.text).toBe('Класс!'); expect(peersLabel(3)).toBe('3 участника');
  });
  it('never translates interpolated names, room codes or chat content', () => {
    setLanguage('en');
    const name = '<b>Комната {0}</b>';
    expect(tr`${name} просит управление`).toBe(name + ' is requesting control');
    expect(tr('Комната')).toBe('Room');
  });
  it('notifies once per effective language change and unsubscribes', () => {
    setLanguage('ru'); const listener = vi.fn(); const stop = onLanguageChange(listener);
    setLanguage('en'); setLanguage('en'); expect(listener).toHaveBeenCalledTimes(1);
    stop(); setLanguage('ru'); expect(listener).toHaveBeenCalledTimes(1);
  });
  it('relocalizes stored connection errors while preserving unknown server details', () => {
    setLanguage('en');
    expect(localizeError('Комната заполнена (максимум 10 участников)')).toBe('Room full (up to 10 participants)');
    expect(localizeError('Сервер отклонил подключение: <raw reason>')).toBe('Server rejected the connection: <raw reason>');
    setLanguage('ru'); expect(localizeError('Room full (up to 10 participants)')).toBe('Комната заполнена (максимум 10 участников)');
  });
  it('migrates existing settings and saves language without replacing connection or appearance', async () => {
    let settings = {serverUrl:'wss://relay.test',room:'my-room',deviceName:'Комната',uiAccent:'ocean'};
    vi.spyOn(browser.storage.local, 'get').mockImplementation(async () => ({ settings }));
    vi.spyOn(browser.storage.local, 'set').mockImplementation(async (data: {settings: typeof settings}) => { settings=data.settings; });
    expect((await loadSettings()).language).toBe('system');
    const next = await updateSettings({language:'en'});
    expect(next).toMatchObject({language:'en',...settings,serverUrl:'wss://relay.test',room:'my-room',uiAccent:'ocean'});
    expect(getLanguage()).toBe('en');
    expect((await loadSettings()).language).toBe('en');
  });
});
