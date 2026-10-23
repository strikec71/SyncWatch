import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
let browser: typeof import('../src/shared/browser').default;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('__SYNCWATCH_SERVER_URL__', 'wss://release-relay.test');
  browser = (await import('../src/shared/browser')).default;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('release server on first launch', () => {
  it('uses the bundled relay when the installation has no saved server', async () => {
    vi.spyOn(browser.storage.local, 'get').mockResolvedValue({ settings: { deviceName: 'First install' } });
    const { loadSettings } = await import('../src/shared/settings');
    expect((await loadSettings()).serverUrl).toBe('wss://release-relay.test');
  });
  it('preserves a server chosen before the extension update', async () => {
    vi.spyOn(browser.storage.local, 'get').mockResolvedValue({ settings: { serverUrl: 'https://my-relay.test/' } });
    const { loadSettings } = await import('../src/shared/settings');
    expect((await loadSettings()).serverUrl).toBe('wss://my-relay.test');
  });
  it('does not replace an explicitly cleared server or an unsafe saved value', async () => {
    const read = vi.spyOn(browser.storage.local, 'get');
    const { loadSettings } = await import('../src/shared/settings');
    for (const serverUrl of ['', 'wss://user:secret@relay.test']) {
      read.mockResolvedValue({ settings: { serverUrl } });
      expect((await loadSettings()).serverUrl).toBe('');
    }
  });
});
