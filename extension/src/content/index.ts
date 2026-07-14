// Точка входа content-скрипта. Запускается в каждом фрейме (all_frames).
// Находит плеер и принимает команды «apply» от background.

import browser from '../shared/browser';
import { PlayerController } from './player';
import { StatusBanner } from './banner';
import { handleInvite } from './invite';
import { startNavSync } from './navsync';
import { Overlay } from './overlay';
import { loadSettings } from '../shared/settings';
import type { RuntimeMessage } from '../shared/messages';

const controller = new PlayerController();
controller.start();

// Инвайт-ссылка (Фаза 4): если в хэше есть room-код — сохраняем и подключаемся.
handleInvite();

// Синхрон URL страницы (Фаза 2): репорт адреса вкладки в хаб. СТРОГО после handleInvite()
// (тот срезает инвайт-хэш) — иначе baseline мог бы уехать на /join.
startNavSync();

// Центральный статус-баннер (Фаза 7): только верхний фрейм, независимо от островка.
const banner = window.top === window ? new StatusBanner() : null;

// Островок (единственный UI): одна панель на вкладку — только в верхнем фрейме.
// Показ = настройка overlayEnabled (тумблер на иконке) И наличие видео в этой вкладке
// (хотя бы в одном фрейме) — чтобы островок не всплывал на страницах без плеера.
if (window.top === window) {
  let overlay: Overlay | null = null;
  let overlayEnabled = false;
  let videoAvailable = false;
  let mounted = false;

  const reconcile = () => {
    const show = overlayEnabled && videoAvailable;
    if (show === mounted) return;
    mounted = show;
    if (show) { overlay = new Overlay(); void overlay.mount(); }
    else { overlay?.unmount(); overlay = null; }
  };

  void loadSettings().then((s) => { overlayEnabled = s.overlayEnabled; reconcile(); });

  // Текущая доступность видео в этой вкладке (дочерний фрейм мог отрепортить раньше,
  // чем мы подписались на push) — спрашиваем background напрямую.
  void browser.runtime.sendMessage({ kind: 'query-video' })
    .then((r: unknown) => {
      videoAvailable = (r as { available?: boolean } | undefined)?.available ?? false;
      reconcile();
    })
    .catch(() => { /* SW перезапускается — придёт push */ });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const next = (changes.settings.newValue as { overlayEnabled?: boolean } | undefined);
    overlayEnabled = next?.overlayEnabled ?? true;
    reconcile();
  });

  // Живой push доступности видео от background (агрегатор presence.ts).
  browser.runtime.onMessage.addListener((msg: RuntimeMessage) => {
    if (msg?.kind === 'video-availability') { videoAvailable = msg.available; reconcile(); }
  });
}

browser.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  switch (msg?.kind) {
    case 'apply':
      controller.applyRemote(msg.action, msg.currentTime, msg.paused, msg.rate);
      break;
    case 'buffer-control':
      controller.applyBufferControl(msg.buffering);
      break;
    case 'sync-time':
      controller.applyDriftCorrection(msg.currentTime, msg.ts, msg.driftThreshold);
      break;
    case 'ad-control':
      controller.applyAdControl(msg.ad);
      break;
    case 'media-apply':
      controller.applyMediaSelection(msg.sig); // синхрон серии/озвучки (Фаза 3)
      break;
    case 'banner':
      banner?.apply(msg); // центральный статус-баннер — только верхний фрейм (Фаза 7)
      break;
    case 'get-snapshot':
      sendResponse(controller.snapshot()); // синк новичка при входе
      break;
  }
});
