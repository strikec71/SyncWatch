// Точка входа content-скрипта. Запускается в каждом фрейме (all_frames).
// Находит плеер и принимает команды «apply» от background.

import browser from '../shared/browser';
import { PlayerController } from './player';
import { StatusBanner } from './banner';
import { handleInvite } from './invite';
import { Overlay } from './overlay';
import { loadSettings } from '../shared/settings';
import type { RuntimeMessage } from '../shared/messages';

const controller = new PlayerController();
controller.start();

// Инвайт-ссылка (Фаза 4): если в хэше есть room-код — сохраняем и подключаемся.
handleInvite();

// Центральный статус-баннер (Фаза 7): только верхний фрейм, независимо от островка.
const banner = window.top === window ? new StatusBanner() : null;

// Островок (единственный UI): одна панель на вкладку — только в верхнем фрейме.
// Показ/скрытие управляется настройкой overlayEnabled (тумблер — иконка расширения).
if (window.top === window) {
  let overlay: Overlay | null = null;
  let overlayEnabled = false;

  const apply = (enabled: boolean) => {
    if (enabled === overlayEnabled) return;
    overlayEnabled = enabled;
    if (enabled) { overlay = new Overlay(); void overlay.mount(); }
    else { overlay?.unmount(); overlay = null; }
  };

  void loadSettings().then((s) => apply(s.overlayEnabled));

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const next = (changes.settings.newValue as { overlayEnabled?: boolean } | undefined);
    apply(next?.overlayEnabled ?? true);
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
    case 'banner':
      banner?.apply(msg); // центральный статус-баннер — только верхний фрейм (Фаза 7)
      break;
    case 'get-snapshot':
      sendResponse(controller.snapshot()); // синк новичка при входе
      break;
  }
});
