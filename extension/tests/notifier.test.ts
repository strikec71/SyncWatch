// Юнит-тесты чистых функций нотификатора обновлений (background/notifier.ts):
// semverGt (сравнение версий по major.minor.patch) и httpBaseFromWs (ws→http база
// для GET /version). checkForUpdate не тестируем — он async/fetch (не чист).

import { describe, it, expect } from 'vitest';
import { semverGt, httpBaseFromWs } from '../src/background/notifier';

describe('semverGt', () => {
  it('is true when a is strictly greater', () => {
    expect(semverGt('0.2.0', '0.1.0')).toBe(true);
    expect(semverGt('1.0.0', '0.9.9')).toBe(true);
    expect(semverGt('0.1.1', '0.1.0')).toBe(true);
    expect(semverGt('2.0.0', '1.9.9')).toBe(true);
  });

  it('is false for equal versions', () => {
    expect(semverGt('0.1.0', '0.1.0')).toBe(false);
    expect(semverGt('1.2.3', '1.2.3')).toBe(false);
  });

  it('is false when a is lower', () => {
    expect(semverGt('0.1.0', '0.2.0')).toBe(false);
    expect(semverGt('0.9.9', '1.0.0')).toBe(false);
    expect(semverGt('1.2.3', '1.2.4')).toBe(false);
  });

  it('compares major before minor before patch', () => {
    expect(semverGt('1.0.0', '0.99.99')).toBe(true);
    expect(semverGt('1.2.0', '1.1.99')).toBe(true);
  });

  it('treats missing segments as 0', () => {
    // '0.1' → [0,1,0]; equal to '0.1.0' → not strictly greater.
    expect(semverGt('0.1', '0.1.0')).toBe(false);
    expect(semverGt('0.1.0', '0.1')).toBe(false);
    expect(semverGt('1', '0.9.9')).toBe(true);
  });

  it('treats non-numeric segments as 0 (pre-release tags ignored)', () => {
    // '0.1.0-beta' → patch parseInt('0-beta')=0 → equal to '0.1.0'.
    expect(semverGt('0.1.0', '0.1.0-beta')).toBe(false);
    expect(semverGt('0.1.0-beta', '0.1.0')).toBe(false);
    expect(semverGt('x.y.z', '0.0.0')).toBe(false);
  });
});

describe('httpBaseFromWs', () => {
  it('maps wss → https', () => {
    expect(httpBaseFromWs('wss://x.workers.dev')).toBe('https://x.workers.dev');
  });

  it('maps ws → http', () => {
    expect(httpBaseFromWs('ws://localhost:8787')).toBe('http://localhost:8787');
  });

  it('strips trailing slashes', () => {
    expect(httpBaseFromWs('wss://x.workers.dev/')).toBe('https://x.workers.dev');
    expect(httpBaseFromWs('wss://x.workers.dev///')).toBe('https://x.workers.dev');
  });

  it('normalizes an uppercase scheme (WSS→https, WS→http)', () => {
    expect(httpBaseFromWs('WSS://x.workers.dev/')).toBe('https://x.workers.dev');
    expect(httpBaseFromWs('WS://a.b')).toBe('http://a.b');
  });

  it('leaves a path intact (only the scheme + trailing slash change)', () => {
    expect(httpBaseFromWs('wss://host/room/abc')).toBe('https://host/room/abc');
  });
});
