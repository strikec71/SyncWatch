// Юнит-тесты чистых функций Kodik-адаптера (content/adapters.ts, Фаза 3):
// сборка/разбор подписи выбора серии/сезона/озвучки. Подпись — числа/id, одинаковые у всех
// участников на одном тайтле (без per-machine хэшей). DOM-драйв селектов здесь не тестируем
// (это интеграция с живым Kodik; логика — set value + dispatch change, см. syncwatch-kodik-player).

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { kodikBuildSig, kodikParseSig, findAdapter } from '../src/content/adapters';

// CSS.escape нет в node-окружении vitest — драйв селектов его зовёт; безобидный шим.
beforeAll(() => {
  (globalThis as { CSS?: { escape: (s: string) => string } }).CSS ??= { escape: (s) => s };
});

// ── Мини-фейк нативного <select> Kodik (jsdom не установлен, окружение node) ──────
// Драйв читает `.value`, ищет `option[value="X"]`, диспатчит change. Моделируем: value
// меняется только если опция есть в наборе; репопуляции нет (наборы фиксированы в тесте).
class FakeSelect {
  constructor(public value: string, private options: Set<string>) {}
  querySelector(sel: string): { value: string } | null {
    const m = sel.match(/option\[value="(.*)"\]/);
    return m && this.options.has(m[1]) ? { value: m[1] } : null;
  }
  dispatchEvent(): boolean { return true; }
}

/** Фейк-document: querySelector('<box> select') → соответствующий FakeSelect (или null). */
function fakeKodikDoc(boxes: Record<string, FakeSelect>): Document {
  return {
    querySelector(sel: string): unknown {
      for (const [box, fs] of Object.entries(boxes)) if (sel === `${box} select`) return fs;
      return null;
    },
  } as unknown as Document;
}

describe('KODIK.applySelection (сигнал onDone)', () => {
  const KODIK = findAdapter('kodikplayer.com', {} as unknown as Document)!; // матч по host — doc не читается

  it('опция есть → достигаем выбора → onDone(true)', () => {
    const doc = fakeKodikDoc({ '.serial-series-box': new FakeSelect('1', new Set(['1', '5'])) });
    const onDone = vi.fn();
    KODIK.applySelection!('kodik|e=5', doc, onDone);
    expect(onDone).toHaveBeenCalledWith(true);
  });

  it('такой серии нет → по исчерпании ретраев onDone(false)', () => {
    vi.useFakeTimers();
    const doc = fakeKodikDoc({ '.serial-series-box': new FakeSelect('1', new Set(['1', '2'])) });
    const onDone = vi.fn();
    KODIK.applySelection!('kodik|e=5', doc, onDone); // '5' нет в наборе
    vi.runAllTimers();
    expect(onDone).toHaveBeenCalledWith(false);
    vi.useRealTimers();
  });

  it('битая подпись → onDone(false) сразу', () => {
    const onDone = vi.fn();
    KODIK.applySelection!('playerjs|e=1', fakeKodikDoc({}), onDone);
    expect(onDone).toHaveBeenCalledWith(false);
  });
});

describe('kodikBuildSig', () => {
  it('сериал: сезон+серия+озвучка в фиксированном порядке s|e|t', () => {
    expect(kodikBuildSig({ season: '4', episode: '1', translation: '609' })).toBe('kodik|s=4|e=1|t=609');
  });

  it('фильм: только озвучка (нет серий/сезонов)', () => {
    expect(kodikBuildSig({ season: null, episode: null, translation: '610' })).toBe('kodik|t=610');
  });

  it('сериал без сезонов: серия+озвучка', () => {
    expect(kodikBuildSig({ season: null, episode: '5', translation: '609' })).toBe('kodik|e=5|t=609');
  });

  it('ни одного измерения (плеер не готов) → null', () => {
    expect(kodikBuildSig({ season: null, episode: null, translation: null })).toBeNull();
  });
});

describe('kodikParseSig', () => {
  it('round-trip сериала', () => {
    expect(kodikParseSig('kodik|s=4|e=1|t=609')).toEqual({ season: '4', episode: '1', translation: '609' });
  });

  it('round-trip фильма', () => {
    expect(kodikParseSig('kodik|t=610')).toEqual({ season: null, episode: null, translation: '610' });
  });

  it('чужой префикс → null (не наш адаптер)', () => {
    expect(kodikParseSig('playerjs|e=1')).toBeNull();
    expect(kodikParseSig('e=1')).toBeNull();
  });

  it('игнорирует незнакомые/пустые куски', () => {
    expect(kodikParseSig('kodik|x=9|e=3|=')).toEqual({ season: null, episode: '3', translation: null });
  });

  it('build∘parse стабильно для всех комбинаций', () => {
    for (const sel of [
      { season: '1', episode: '2', translation: '3' },
      { season: null, episode: '2', translation: '3' },
      { season: null, episode: null, translation: '3' },
    ]) {
      const sig = kodikBuildSig(sel)!;
      expect(kodikParseSig(sig)).toEqual(sel);
    }
  });
});
