// Коррекция дрейфа позиции (Фаза 2, доработка пункт 1): решение + плавная подстройка
// скоростью. Вынесено из player.ts, чтобы держать его <500 строк и изолировать нудж-логику.

/** Двухступенчатое решение коррекции дрейфа (чистое, тестируемое). `diff` — знаковое
 *  `v.currentTime - target`; `strikes` — сколько БИЕНИЙ подряд порог превышен (включая текущее).
 *  - в пределах порога → 'none' (не трогаем);
 *  - один выброс (strikes<2) → 'none' (сетевой/рендер-лаг гасим, ждём подтверждения);
 *  - умеренный дрейф (порог < |diff| <= hardSeekS) → 'nudge' (плавно скоростью, без рывка);
 *  - большой дрейф (> hardSeekS) → 'seek' (жёсткий переход, плавно уже не догнать). */
export function driftDecision(
  diff: number,
  threshold: number,
  hardSeekS: number,
  strikes: number,
): 'none' | 'nudge' | 'seek' {
  const abs = Math.abs(diff);
  if (abs <= threshold) return 'none';
  if (strikes < 2) return 'none';        // одиночное превышение — не дёргаем, ждём второго бита
  return abs <= hardSeekS ? 'nudge' : 'seek';
}

/** Плавная подстройка скорости плеера под опорного: впереди — замедляемся, отстаём —
 *  ускоряемся на ±factor от БАЗОВОЙ скорости (её же восстанавливаем, а не 1.0). ratechange
 *  от собственного нуджа/возврата НЕ должен транслироваться — эхо-детект по `lastSetRate`
 *  (player.ts проверяет его в обработчике ratechange), плюс держим active ещё releaseMs при
 *  возврате, чтобы отработавшее позже событие не ушло в сеть. */
export class DriftNudger {
  private active = false;
  private baseRate = 1;   // скорость до нуджа — её и восстанавливаем
  private lastSet = 0;    // последнее значение rate, выставленное нами (эхо-детект)
  private timer: number | null = null;

  get isActive(): boolean { return this.active; }
  get lastSetRate(): number { return this.lastSet; }

  private clearTimer(): void {
    if (this.timer != null) { window.clearTimeout(this.timer); this.timer = null; }
  }

  /** Начать/продолжить подстройку: dir=-1 (впереди) замедляет, +1 (отстаём) ускоряет. */
  start(v: HTMLVideoElement, diff: number, factor: number): void {
    this.clearTimer();
    if (!this.active) { this.baseRate = v.playbackRate; this.active = true; } // юзер мог смотреть ×1.25
    const target = this.baseRate * (1 + (diff > 0 ? -1 : 1) * factor);
    this.lastSet = target;
    if (Math.abs(v.playbackRate - target) > 0.001) v.playbackRate = target;
  }

  /** Снять с возвратом базовой скорости; флаг держим releaseMs (ratechange возврата не транслируем). */
  cancel(v: HTMLVideoElement | null, releaseMs: number): void {
    if (!this.active) return;
    if (!v) { this.active = false; this.clearTimer(); return; }
    this.lastSet = this.baseRate;
    if (Math.abs(v.playbackRate - this.baseRate) > 0.001) v.playbackRate = this.baseRate;
    this.clearTimer();
    this.timer = window.setTimeout(() => { this.active = false; this.timer = null; }, releaseMs);
  }

  /** Бросить БЕЗ возврата: rate уже перехватил юзер/сеть (их значение и есть цель). */
  abandon(): void {
    this.active = false;
    this.clearTimer();
  }
}
