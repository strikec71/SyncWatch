// Юнит-тесты чистых функций Alloha-адаптера (content/adapters.ts, пункт 5 фиксов):
// сборка/разбор подписи выбора серии/сезона/озвучки «основного плеера» jut-su.net.
// Подпись — числа/id, одинаковые у всех на одном тайтле. DOM-драйв кастомных дропдаунов
// (клик по .select__drop-item) тут не тестируем — это интеграция с живым Alloha (риск №1).

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { allohaBuildSig, allohaParseSig, findAdapter } from '../src/content/adapters';

// В node-окружении vitest нет CSS.escape и MouseEvent — драйв кастомных дропдаунов их зовёт.
beforeAll(() => {
  const g = globalThis as { CSS?: { escape: (s: string) => string }; MouseEvent?: unknown };
  g.CSS ??= { escape: (s) => s };
  g.MouseEvent ??= class { constructor(_t: string, _o?: unknown) { /* шим */ } };
});

// ── Мини-фейк кастомных дропдаунов Alloha (jsdom не установлен) ────────────────
// Пункт — `button.select__drop-item[data-id]`, активный несёт класс `active`; клик по пункту
// плеер трактует как переключение → моделируем: click() делает пункт активным. Опции с
// отсутствующим data-id не находятся (набор фиксирован) → выбор недостижим.
class FakeItem {
  constructor(public id: string, private box: FakeBox) {}
  get classList() { return { contains: (c: string) => c === 'active' && this.box.active === this.id }; }
  getAttribute(a: string): string | null { return a === 'data-id' ? this.id : null; }
  click(): void { this.box.active = this.id; }
  dispatchEvent(): boolean { return true; }
}
class FakeBox {
  constructor(public prefix: string, public active: string, public ids: Set<string>) {}
  querySelector(q: string): FakeItem | null {
    const m = q.match(/data-id="([^"]*)"/);
    return m && this.ids.has(m[1]) ? new FakeItem(m[1], this) : null;
  }
}

/** Фейк-document: video#player + боксы `[data-select^=…]` с активным пунктом. */
function fakeAllohaDoc(boxes: FakeBox[]): Document {
  const q = (sel: string): unknown => {
    if (sel.includes(',')) { for (const p of sel.split(',')) { const r = q(p.trim()); if (r) return r; } return null; }
    if (sel === 'video#player') return { id: 'player' };
    if (sel.startsWith('.serial-panel') || sel.startsWith('.movie-translations-box')) return null; // KODIK-проба
    const active = sel.match(/\[data-select\^="([^"]+)"\] \.select__drop-item\.active/);
    if (active) {
      const box = boxes.find((b) => b.prefix.startsWith(active[1]));
      return box && box.active ? new FakeItem(box.active, box) : null;
    }
    const boxM = sel.match(/\[data-select\^="([^"]+)"\]$/);
    if (boxM) return boxes.find((b) => b.prefix.startsWith(boxM[1])) ?? null;
    return null;
  };
  return { querySelector: q } as unknown as Document;
}

describe('allohaBuildSig', () => {
  it('сериал: сезон+серия+озвучка в фиксированном порядке s|e|t', () => {
    expect(allohaBuildSig({ season: '3', episode: '13', translation: '10' })).toBe('alloha|s=3|e=13|t=10');
  });

  it('фильм: только озвучка (translationMovie — нет серий/сезонов)', () => {
    expect(allohaBuildSig({ season: null, episode: null, translation: '197' })).toBe('alloha|t=197');
  });

  it('сериал без сезонов: серия+озвучка', () => {
    expect(allohaBuildSig({ season: null, episode: '5', translation: '10' })).toBe('alloha|e=5|t=10');
  });

  it('ни одного измерения (плеер не готов) → null', () => {
    expect(allohaBuildSig({ season: null, episode: null, translation: null })).toBeNull();
  });
});

describe('allohaParseSig', () => {
  it('round-trip сериала', () => {
    expect(allohaParseSig('alloha|s=3|e=13|t=10')).toEqual({ season: '3', episode: '13', translation: '10' });
  });

  it('round-trip фильма', () => {
    expect(allohaParseSig('alloha|t=197')).toEqual({ season: null, episode: null, translation: '197' });
  });

  it('чужой префикс → null (не наш адаптер, напр. kodik)', () => {
    expect(allohaParseSig('kodik|e=1')).toBeNull();
    expect(allohaParseSig('e=1')).toBeNull();
  });

  it('игнорирует незнакомые/пустые куски', () => {
    expect(allohaParseSig('alloha|x=9|e=3|=')).toEqual({ season: null, episode: '3', translation: null });
  });

  it('build∘parse стабильно для всех комбинаций (включая фильм)', () => {
    for (const sel of [
      { season: '1', episode: '2', translation: '3' },
      { season: null, episode: '2', translation: '3' },
      { season: null, episode: null, translation: '3' },
    ]) {
      const sig = allohaBuildSig(sel)!;
      expect(allohaParseSig(sig)).toEqual(sel);
    }
  });
});

describe('ALLOHA.applySelection (сигнал onDone)', () => {
  function alloha(boxes: FakeBox[]) {
    const doc = fakeAllohaDoc(boxes);
    const adapter = findAdapter('some-mirror.example', doc)!; // матч по DOM (домен зеркала любой)
    expect(adapter.name).toBe('alloha');
    return { adapter, doc };
  }

  it('озвучка/серия есть → достигаем выбора → onDone(true)', () => {
    const { adapter, doc } = alloha([
      new FakeBox('seasonType1', '1', new Set(['1'])),
      new FakeBox('episodeType1', '1', new Set(['1', '5'])),
      new FakeBox('translationType1', 't10', new Set(['t10'])),
    ]);
    const onDone = vi.fn();
    adapter.applySelection!('alloha|s=1|e=5|t=10', doc, onDone);
    expect(onDone).toHaveBeenCalledWith(true);
  });

  it('чисто-озвучечный мисматч (у нас нет t=197) → по ретраям onDone(false)', () => {
    vi.useFakeTimers();
    const { adapter, doc } = alloha([
      new FakeBox('seasonType1', '1', new Set(['1'])),
      new FakeBox('episodeType1', '5', new Set(['5'])),
      new FakeBox('translationType1', 't10', new Set(['t10', 't609'])), // t197 отсутствует
    ]);
    const onDone = vi.fn();
    adapter.applySelection!('alloha|s=1|e=5|t=197', doc, onDone);
    vi.runAllTimers();
    expect(onDone).toHaveBeenCalledWith(false);
    vi.useRealTimers();
  });

  it('битая подпись → onDone(false) сразу', () => {
    const { adapter, doc } = alloha([new FakeBox('translationType1', 't10', new Set(['t10']))]);
    const onDone = vi.fn();
    adapter.applySelection!('kodik|t=10', doc, onDone);
    expect(onDone).toHaveBeenCalledWith(false);
  });
});
