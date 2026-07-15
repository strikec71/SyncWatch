// Юнит-тесты чистой функции решения коррекции дрейфа (content/player.ts, пункт 1 фиксов):
// двухступенчатость (nudge/seek), гейт «два бита подряд», знак не влияет (abs), границы.

import { describe, it, expect } from 'vitest';
import { driftDecision } from '../src/content/drift';

const TH = 2;      // порог
const HARD = 4;    // выше — жёсткий seek

describe('driftDecision', () => {
  it('в пределах порога → none при любом числе strikes', () => {
    expect(driftDecision(0, TH, HARD, 5)).toBe('none');
    expect(driftDecision(TH, TH, HARD, 5)).toBe('none');   // граница включительно
    expect(driftDecision(-TH, TH, HARD, 5)).toBe('none');
    expect(driftDecision(1.9, TH, HARD, 99)).toBe('none');
  });

  it('одиночное превышение (strikes<2) → none — гасим сетевой/рендер-выброс', () => {
    expect(driftDecision(3, TH, HARD, 0)).toBe('none');
    expect(driftDecision(3, TH, HARD, 1)).toBe('none');
    expect(driftDecision(10, TH, HARD, 1)).toBe('none'); // даже большой одиночный — ждём подтверждения
  });

  it('умеренный дрейф после двух битов подряд → nudge (плавно скоростью)', () => {
    expect(driftDecision(3, TH, HARD, 2)).toBe('nudge');
    expect(driftDecision(HARD, TH, HARD, 2)).toBe('nudge'); // граница hardSeekS включительно
    expect(driftDecision(3, TH, HARD, 7)).toBe('nudge');
  });

  it('большой дрейф после двух битов подряд → seek (плавно не догнать)', () => {
    expect(driftDecision(HARD + 0.01, TH, HARD, 2)).toBe('seek');
    expect(driftDecision(7, TH, HARD, 3)).toBe('seek');
  });

  it('знак не влияет — решаем по модулю (впереди/отстаём симметрично)', () => {
    expect(driftDecision(-3, TH, HARD, 2)).toBe('nudge');
    expect(driftDecision(-7, TH, HARD, 2)).toBe('seek');
  });
});
