// Юнит-тесты чистых функций Kodik-адаптера (content/adapters.ts, Фаза 3):
// сборка/разбор подписи выбора серии/сезона/озвучки. Подпись — числа/id, одинаковые у всех
// участников на одном тайтле (без per-machine хэшей). DOM-драйв селектов здесь не тестируем
// (это интеграция с живым Kodik; логика — set value + dispatch change, см. syncwatch-kodik-player).

import { describe, it, expect } from 'vitest';
import { kodikBuildSig, kodikParseSig } from '../src/content/adapters';

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
