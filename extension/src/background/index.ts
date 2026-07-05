// Background service worker — тонкая точка входа ХАБА.
// Держит единственный WebSocket к серверу (в connection.ts), принимает события плеера
// от content-скриптов любого фрейма, релеит команды. Логика разнесена по модулям:
//   state.ts      — singleton, константы, селекторы, sendWire
//   connection.ts — WS-жизнецикл, hardened reconnect, watchdog, onWire
//   roster.ts     — зеркало roster, агрегация баннера, уведомления, статус-снимок
//   sync.ts       — player-event→STATE (гейтинг+detach), applyRemote, снапшоты, дрейф
// Засыпание SW гасим WS keepalive (PING) по browser.alarms (~24с).

import browser from '../shared/browser';
import { loadSettings, saveSettings } from '../shared/settings';
import type { RuntimeMessage, NoticeMsg, SetModeMsg, SetControlMsg } from '../shared/messages';
import {
  session,
  sendWire,
  amHost,
  KEEPALIVE_ALARM,
  RECONNECT_ALARM,
} from './state';
import { connect, disconnect, cancelReconnect, checkWatchdog, reconnectTick } from './connection';
import { onPlayerEvent, onBuffering, onBeat, onAd } from './sync';
import { notifyEvent, notifyPopup, statusSnapshot } from './roster';
import { onVideoPresence, queryVideoAvailable, forgetTab } from './presence';

browser.runtime.onMessage.addListener(
  (msg: RuntimeMessage, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.kind) {
      case 'connect':
        cancelReconnect(); // явное подключение — начинаем backoff заново
        connect().then(sendResponse);
        return true; // ответ асинхронный
      case 'disconnect':
        disconnect();
        sendResponse({ ok: true });
        return;
      case 'get-status':
        sendResponse(statusSnapshot());
        return;
      case 'player-event':
        if (sender.tab?.id != null) onPlayerEvent(msg, sender.tab.id, sender.frameId ?? 0);
        return;
      case 'buffering':
        if (sender.tab?.id != null) onBuffering(msg, sender.tab.id, sender.frameId ?? 0);
        return;
      case 'beat':
        if (sender.tab?.id != null) onBeat(msg, sender.tab.id, sender.frameId ?? 0);
        return;
      case 'ad':
        if (sender.tab?.id != null) onAd(msg, sender.tab.id, sender.frameId ?? 0);
        return;
      case 'notice':
        notifyEvent((msg as NoticeMsg).text); // локальный тост от плеера
        return;
      case 'set-mode':
        setMode(msg as SetModeMsg);
        sendResponse({ ok: true });
        return;
      case 'set-control':
        setControl(msg as SetControlMsg);
        sendResponse({ ok: true });
        return;
      case 'request-control':
        // Гость просит право; `from` вставит сервер, релей — только host'у. UI гейтит
        // показ кнопки (комната ≥3 без контроля); сервер дропнет, если мы host.
        sendWire({ type: 'REQUEST_CONTROL' });
        sendResponse({ ok: true });
        return;
      case 'video-presence':
        // Любой фрейм сообщает, есть ли в нём <video>. Хаб агрегирует по вкладке и
        // пушит доступность в островок (frame 0) — чтобы он не всплывал на страницах без видео.
        if (sender.tab?.id != null) onVideoPresence(sender.tab.id, sender.frameId ?? 0, msg.present);
        return;
      case 'query-video':
        // Верхний фрейм при загрузке спрашивает: есть ли уже видео в этой вкладке
        // (дочерние фреймы могли отрепортить раньше, чем островок подписался на push).
        sendResponse({ available: sender.tab?.id != null && queryVideoAvailable(sender.tab.id) });
        return;
    }
  },
);

// Вкладка закрыта — забываем её карту присутствия видео (иначе утечёт).
browser.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

/** Переключить соло/синхрон. Detach: перестаём применять/слать (гейтится в sync.ts),
 *  но остаёмся в комнате. Un-detach: шлём MODE, снапшот прилетит направленным STATE. */
function setMode(msg: SetModeMsg): void {
  session.detached = msg.detached;
  sendWire({ type: 'MODE', detached: msg.detached });
  notifyPopup();
}

/** host выдаёт/забирает право управления участнику (иначе сервер всё равно дропнет). */
function setControl(msg: SetControlMsg): void {
  if (!amHost()) return;
  sendWire({ type: 'CONTROL', action: msg.action, target: msg.target });
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // PING (а не BEAT) — чтобы keepalive не вызывал ложную коррекцию дрейфа у партнёра.
    // Сервер PING поглощает и не релеит.
    sendWire({ type: 'PING', ts: Date.now() });
    checkWatchdog(); // тем же тиком проверяем «молчащий» сокет
    return;
  }
  if (alarm.name === RECONNECT_ALARM) {
    reconnectTick(); // персистентный фолбэк: дожать реконнект, если setTimeout был потерян при выгрузке SW
    return;
  }
});

// Авто-подключение при старте браузера/установке (Фаза 4).
async function autoConnectIfEnabled(): Promise<void> {
  const s = await loadSettings();
  if (s.autoConnect && s.room && s.serverUrl) void connect();
}

// Тумблер на иконке расширения: показывает/скрывает островок (overlayEnabled);
// content-скрипты реагируют через storage.onChanged.
browser.action.onClicked.addListener(async () => {
  const s = await loadSettings();
  await saveSettings({ overlayEnabled: !s.overlayEnabled });
});

/** Отразить состояние островка на иконке (бейдж «off» когда скрыт). */
async function syncActionBadge(): Promise<void> {
  try {
    const s = await loadSettings();
    await browser.action.setBadgeText({ text: s.overlayEnabled ? '' : 'off' });
    await browser.action.setTitle({
      title: s.overlayEnabled ? 'SyncWatch — скрыть островок' : 'SyncWatch — показать островок',
    });
  } catch { /* action API недоступно — пропускаем */ }
}

browser.runtime.onInstalled.addListener(() => {
  void autoConnectIfEnabled(); void syncActionBadge();
});
browser.runtime.onStartup.addListener(() => {
  void autoConnectIfEnabled(); void syncActionBadge();
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) void syncActionBadge();
});
void syncActionBadge(); // при инициализации service worker
