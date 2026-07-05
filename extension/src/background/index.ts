// Background service worker — тонкая точка входа ХАБА.
// Синхрон — принадлежность ВКЛАДКИ: сессия резолвится по `sender.tab.id` (реестр в
// state.ts), у каждой вкладки свой WS/комната/roster/островок. Логика по модулям:
//   state.ts      — реестр сессий по вкладкам, константы, селекторы, sendWire
//   connection.ts — WS-жизнецикл per-session, hardened reconnect, watchdog, onWire
//   roster.ts     — зеркало roster, баннер, уведомления, статус-снимок (per-session)
//   sync.ts       — player-event→STATE (гейтинг+detach), applyRemote, снапшоты, дрейф
//   presence.ts   — агрегатор наличия <video> по вкладке (гейт островка)
// Засыпание SW гасим WS keepalive (PING) по browser.alarms; аларм-тик итерирует все сессии.

import browser from '../shared/browser';
import { loadSettings, saveSettings } from '../shared/settings';
import type {
  RuntimeMessage,
  NoticeMsg,
  SetModeMsg,
  SetControlMsg,
  StatusSnapshot,
} from '../shared/messages';
import {
  type Session,
  sendWire,
  amHost,
  getSession,
  peekSession,
  forgetSession,
  allSessions,
  KEEPALIVE_ALARM,
  RECONNECT_ALARM,
} from './state';
import { connect, disconnect, cancelReconnect, checkWatchdog, checkIdle, reconnectTick } from './connection';
import { onPlayerEvent, onBuffering, onBeat, onAd } from './sync';
import { notifyEvent, notifyPopup, statusSnapshot } from './roster';
import { onVideoPresence, queryVideoAvailable, forgetTab } from './presence';

/** Снимок «вкладка не в комнате» — для get-status от ещё не подключённой вкладки. */
function emptySnapshot(): StatusSnapshot {
  return {
    connected: false, peerPresent: false, room: '', deviceName: '', peerName: '',
    peers: [], amHost: false, amController: false, detached: false, self: -1,
  };
}

browser.runtime.onMessage.addListener(
  (msg: RuntimeMessage, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;

    switch (msg.kind) {
      case 'connect': {
        if (tabId == null) { sendResponse({ ok: false, error: 'no tab' }); return; }
        const s = getSession(tabId);
        cancelReconnect(s); // явное подключение — начинаем backoff заново
        connect(s, msg.room, msg.serverUrl).then(sendResponse);
        return true; // ответ асинхронный
      }
      case 'disconnect': {
        if (tabId != null) { const s = peekSession(tabId); if (s) { disconnect(s); forgetSession(tabId); } }
        sendResponse({ ok: true });
        return;
      }
      case 'get-status':
        sendResponse(tabId != null ? (peekSession(tabId) ? statusSnapshot(peekSession(tabId)!) : emptySnapshot()) : emptySnapshot());
        return;
      case 'player-event':
        if (tabId != null) onPlayerEvent(getSession(tabId), msg, frameId);
        return;
      case 'buffering':
        if (tabId != null) onBuffering(getSession(tabId), msg, frameId);
        return;
      case 'beat':
        if (tabId != null) onBeat(getSession(tabId), msg, frameId);
        return;
      case 'ad':
        if (tabId != null) onAd(getSession(tabId), msg, frameId);
        return;
      case 'notice': {
        // Локальный тост от плеера — только если у вкладки есть сессия (иначе нечего показывать).
        if (tabId != null) { const s = peekSession(tabId); if (s) notifyEvent(s, (msg as NoticeMsg).text); }
        return;
      }
      case 'set-mode':
        if (tabId != null) { const s = peekSession(tabId); if (s) setMode(s, msg as SetModeMsg); }
        sendResponse({ ok: true });
        return;
      case 'set-control':
        if (tabId != null) { const s = peekSession(tabId); if (s) setControl(s, msg as SetControlMsg); }
        sendResponse({ ok: true });
        return;
      case 'request-control':
        // Гость просит право; `from` вставит сервер, релей — только host'у. UI гейтит
        // показ кнопки (комната ≥3 без контроля); сервер дропнет, если мы host.
        if (tabId != null) { const s = peekSession(tabId); if (s) sendWire(s, { type: 'REQUEST_CONTROL' }); }
        sendResponse({ ok: true });
        return;
      case 'video-presence':
        // Любой фрейм сообщает, есть ли в нём <video>. Хаб агрегирует по вкладке и
        // пушит доступность в островок (frame 0) — чтобы он не всплывал на страницах без видео.
        if (tabId != null) onVideoPresence(tabId, frameId, msg.present);
        return;
      case 'query-video':
        // Верхний фрейм при загрузке спрашивает: есть ли уже видео в этой вкладке
        // (дочерние фреймы могли отрепортить раньше, чем островок подписался на push).
        sendResponse({ available: tabId != null && queryVideoAvailable(tabId) });
        return;
    }
  },
);

// Вкладка закрыта — гасим её сессию и карты (иначе утечёт сокет/состояние).
browser.tabs.onRemoved.addListener((tabId) => {
  const s = peekSession(tabId);
  if (s) { disconnect(s); forgetSession(tabId); }
  forgetTab(tabId);
});

/** Переключить соло/синхрон. Detach: перестаём применять/слать (гейтится в sync.ts),
 *  но остаёмся в комнате. Un-detach: шлём MODE, снапшот прилетит направленным STATE. */
function setMode(s: Session, msg: SetModeMsg): void {
  s.detached = msg.detached;
  sendWire(s, { type: 'MODE', detached: msg.detached });
  notifyPopup(s);
}

/** host выдаёт/забирает право управления участнику (иначе сервер всё равно дропнет). */
function setControl(s: Session, msg: SetControlMsg): void {
  if (!amHost(s)) return;
  sendWire(s, { type: 'CONTROL', action: msg.action, target: msg.target });
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // PING (а не BEAT) по всем связанным сессиям — keepalive не должен вызывать ложную
    // коррекцию дрейфа. Сервер PING поглощает и не релеит. Тем же тиком — watchdog.
    let anyConnected = false;
    for (const s of allSessions()) {
      if (s.connected) { sendWire(s, { type: 'PING', ts: Date.now() }); anyConnected = true; }
      checkWatchdog(s);
      checkIdle(s); // тем же тиком (~30с) — авто-дисконнект простаивающей паузы
    }
    if (!anyConnected) void browser.alarms.clear(KEEPALIVE_ALARM); // некого пинговать
    return;
  }
  if (alarm.name === RECONNECT_ALARM) {
    // Персистентный фолбэк: дожать реконнект каждой нуждающейся сессии (setTimeout мог
    // потеряться при выгрузке SW). Аларм гасим, когда реконнект не нужен НИКОМУ.
    let anyPending = false;
    for (const s of allSessions()) {
      reconnectTick(s);
      if (!s.intentionalClose && s.autoConnect && s.room && !s.connected) anyPending = true;
    }
    if (!anyPending) void browser.alarms.clear(RECONNECT_ALARM);
    return;
  }
});

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

// Авто-подключение теперь per-tab: инвайт-хэш во вкладке (invite.ts) или ручной «Войти».
// Глобального «подключить весь браузер к одной комнате» больше нет (сессии независимы).
browser.runtime.onInstalled.addListener(() => { void syncActionBadge(); });
browser.runtime.onStartup.addListener(() => { void syncActionBadge(); });
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) void syncActionBadge();
});
void syncActionBadge(); // при инициализации service worker
