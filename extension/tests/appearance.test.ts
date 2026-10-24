import { afterEach, describe, expect, it, vi } from 'vitest';
import browser from '../src/shared/browser';
import { DEFAULT_APPEARANCE, normalizeAppearance } from '../src/shared/appearance';
import { loadSettings, updateSettings } from '../src/shared/settings';

afterEach(() => vi.restoreAllMocks());
describe('appearance preferences migration and isolation', () => {
  it('migrates existing installations without changing their connection preferences', async () => {
    vi.spyOn(browser.storage.local, 'get').mockResolvedValue({ settings: { room: 'existing-room', serverUrl: 'wss://my-relay.test', sharePresence: false } });
    const settings = await loadSettings();
    expect(settings).toMatchObject({ ...DEFAULT_APPEARANCE, room: 'existing-room', serverUrl: 'wss://my-relay.test', sharePresence: false });
  });
  it('normalizes damaged stored preferences before applying styles', () => {
    expect(normalizeAppearance({ uiTheme: 'arbitrary-css' as any, uiAccent: 'url(evil)' as any, uiOpacity: NaN, uiMotion: 'yes' as any })).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ uiOpacity: 5, uiDockSide: 'left' }).uiOpacity).toBe(85);
    expect(normalizeAppearance({ uiOpacity: 999 }).uiOpacity).toBe(100);
  });
  it('serializes simultaneous room and appearance writes without losing either', async () => {
    let saved: any = { settings: { room: 'before', serverUrl: 'wss://private-relay.test', uiTheme: 'light' } };
    vi.spyOn(browser.storage.local, 'get').mockImplementation(async () => structuredClone(saved));
    vi.spyOn(browser.storage.local, 'set').mockImplementation(async values => { saved = structuredClone(values); });
    await Promise.all([updateSettings({ room: 'after' }), updateSettings({ uiAccent: 'rose', uiDensity: 'compact' })]);
    expect(saved.settings).toMatchObject({ room: 'after', serverUrl: 'wss://private-relay.test', uiTheme: 'light', uiAccent: 'rose', uiDensity: 'compact' });
  });
  it('resets appearance without clearing room, name, server or presence choice', async () => {
    const old = { room: 'secret', serverUrl: 'wss://my.test', deviceName: 'Viewer', sharePresence: false, uiAccent: 'rose', uiOpacity: 85 };
    vi.spyOn(browser.storage.local, 'get').mockResolvedValue({ settings: old });
    const save = vi.spyOn(browser.storage.local, 'set').mockResolvedValue();
    await updateSettings(DEFAULT_APPEARANCE);
    expect(save.mock.calls[0][0]).toEqual({ settings: expect.objectContaining({ ...old, ...DEFAULT_APPEARANCE }) });
  });
});
