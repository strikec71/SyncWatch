// Юнит-тест чистой функции Firefox-манифеста автообновления (server/src/index.ts):
// структура addons[id].updates + подстановка версии в update_link на подписанный .xpi.

import { describe, it, expect } from 'vitest';
import { firefoxUpdatesManifest } from '../src/index';

describe('firefoxUpdatesManifest', () => {
  it('builds a valid Firefox update manifest for the addon id', () => {
    const json = JSON.parse(firefoxUpdatesManifest('0.2.0'));
    const updates = json.addons['syncwatch@local'].updates;
    expect(updates).toHaveLength(1);
    expect(updates[0].version).toBe('0.2.0');
  });

  it('points update_link at the tagged, versioned .xpi asset', () => {
    const json = JSON.parse(firefoxUpdatesManifest('1.4.2'));
    const link = json.addons['syncwatch@local'].updates[0].update_link;
    expect(link).toMatch(/\/releases\/download\/v1\.4\.2\/syncwatch-firefox-1\.4\.2\.xpi$/);
    expect(link.startsWith('https://')).toBe(true);
  });
});
