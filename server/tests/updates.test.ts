import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { readFileSync } from 'node:fs';

describe('Chrome release channel', () => {
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
