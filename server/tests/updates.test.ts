import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { readFileSync } from 'node:fs';

describe('Chrome release channel', () => {
  it('serves English pages by default and allows explicit Russian, preserving escaped room text', async () => {
    const english = await worker.fetch(new Request('https://signal.test/privacy'), {} as any);
    const text = await english.text();
    expect(text).toContain('<html lang="en">'); expect(text).toContain('Presence and friends');
    expect(text).toContain('language and appearance'); expect(text).toContain('End-to-end encryption is not provided');
    const russian = await worker.fetch(new Request('https://signal.test/privacy?lang=ru'), {} as any);
    expect(await russian.text()).toContain('<html lang="ru">');
    const browserRussian = await worker.fetch(new Request('https://signal.test/join',{headers:{'accept-language':'ru-RU,ru;q=0.9'}}), {} as any);
    expect(await browserRussian.text()).toContain('приглашение в комнату');
    const override = await worker.fetch(new Request('https://signal.test/r/%3Cimg%3E?lang=en',{headers:{'accept-language':'ru'}}), {} as any);
    const invite = await override.text(); expect(invite).toContain('room invitation'); expect(invite).not.toContain('<img>');
  });
  it('identifies the deployed server independently of the store version', async () => {
    const response = await worker.fetch(new Request('https://signal.test/healthz'), { RELEASE_SHA: 'verified-commit' } as any);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(await response.json()).toEqual({service:'syncwatch-signal',version:pkg.version,revision:'verified-commit'});
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('reports the existing store version rather than an unpublished build', async () => {
    const response = await worker.fetch(new Request('https://signal.test/version'), {} as any);
    expect(await response.json()).toEqual({ version: '0.6.0', notes: '' });
  });
  it('no longer serves an alternate browser update manifest', async () => {
    const response = await worker.fetch(new Request('https://signal.test/updates.json'), {} as any);
    expect(response.status).toBe(404);
  });
});
