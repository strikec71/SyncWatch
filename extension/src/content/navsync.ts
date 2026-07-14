// Синхрон URL страницы (Фаза 2): верхний фрейм репортит адрес вкладки в background.
// Хаб решает, транслировать ли его партнёрам (см. background/nav.ts). Здесь — только
// наблюдение за URL: первичный репорт, вотчер SPA-навигаций (адрес меняется без полной
// перезагрузки) и периодический ре-репорт (восстановление baseline после выгрузки SW).
//
// Запускать СТРОГО после handleInvite(): тот срезает инвайт-хэш (#r=…/#syncwatch=…),
// иначе первый репорт унёс бы его в baseline (normalizeSyncUrl хэш всё равно срежет —
// это вторая линия защиты). Только верхний фрейм: адрес — свойство вкладки, не iframe.

import browser from '../shared/browser';
import type { NavReportMsg } from '../shared/messages';

const SPA_POLL_MS = 1000;      // как часто сверяем location.href (SPA-переходы без reload)
const REASSERT_MS = 5000;      // ре-репорт неизменного URL — восстановление baseline в SW

export function startNavSync(): void {
  if (window.top !== window) return;

  let last = location.href;
  let lastSentAt = 0;

  const report = (): void => {
    lastSentAt = Date.now();
    const msg: NavReportMsg = { kind: 'nav-report', url: location.href };
    browser.runtime.sendMessage(msg).catch(() => { /* SW перезапускается — дожмёт ре-репорт */ });
  };

  report(); // первичный baseline

  window.setInterval(() => {
    const now = location.href;
    if (now !== last) {
      last = now;
      report(); // SPA-переход (смена серии без полной перезагрузки)
    } else if (Date.now() - lastSentAt >= REASSERT_MS) {
      report(); // идемпотентный ре-репорт: хаб проигнорит, если baseline уже стоит
    }
  }, SPA_POLL_MS);
}
