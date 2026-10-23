// Точка входа content-скрипта. Запускается в каждом фрейме (all_frames).
// Находит плеер и принимает команды «apply» от background.

import browser from '../shared/browser';
import { PlayerController } from './player';
import { handleInvite } from './invite';
import { handleFriendInvite } from './friend-invite';
import { startNavSync } from './navsync';
import { ContentUI } from './ui';
import type { RuntimeMessage } from '../shared/messages';

const controller = new PlayerController();
controller.start();
window.addEventListener('pageshow', event => { if (event.persisted) controller.start(); });

// Инвайт-ссылка (Фаза 4): если в хэше есть room-код — сохраняем и подключаемся.
handleInvite();

// Ссылка-приглашение в друзья (#syncwatch-friend=…): кладём запрос в инбокс. Ключ хэша
// не пересекается с handleInvite(); оба срезают свой хэш до startNavSync().
handleFriendInvite();

// Синхрон URL страницы (Фаза 2): репорт адреса вкладки в хаб. СТРОГО после handleInvite()
// (тот срезает инвайт-хэш) — иначе baseline мог бы уехать на /join.
startNavSync();

new ContentUI();

browser.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  switch (msg?.kind) {
    case 'apply':
      controller.applyRemote(msg.action, msg.currentTime, msg.paused, msg.rate, msg.pauseOnly);
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
    case 'pause-local':
      controller.pauseLocal(); // автопауза быстрого сообщения — локальная пауза (Фаза 0.7.0)
      break;
    case 'get-snapshot':
      sendResponse(controller.snapshot()); // синк новичка при входе
      break;
  }
});
