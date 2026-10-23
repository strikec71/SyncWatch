// Агрегатор присутствия <video> по вкладке. Плеер целевых сайтов часто сидит в
// кросс-доменном iframe, а островок живёт в ВЕРХНЕМ фрейме, где видео может не быть.
// Поэтому каждый фрейм шлёт `video-presence`, а мы сводим это по вкладке и пушим
// `video-availability` в frame 0 — островок монтируется только когда видео реально есть.
//
// MV3-заметка: карты живут в памяти SW и теряются при выгрузке. Восстановление —
// периодический ре-репорт `present:true` из content-скрипта (см. player.ts) + запрос
// `query-video` при монтировании островка. Всё идемпотентно (пушим только на смену).

import browser from '../shared/browser';
import type { VideoAvailabilityMsg } from '../shared/messages';

// tabId → (frameId → есть ли <video>).
const tabs = new Map<number, Map<number, boolean>>();
// tabId → последняя доступность, отправленная в frame 0 (чтобы не спамить одинаковым).
const lastPushed = new Map<number, boolean>();
// tabId → таймер дебаунса «видео пропало» (гасит мигание при подмене <video>).
const absenceTimers = new Map<number, number>();

const PRESENCE_ALARM = 'syncwatch-presence';
let alarmStarted = false;
const seen = new Map<string, number>();
const ABSENCE_DEBOUNCE_MS = 2000; // столько ждём перед тем, как признать «видео пропало»

/** Есть ли в этой вкладке хоть один фрейм с видео. */
export function queryVideoAvailable(tabId: number): boolean {
  const frames = tabs.get(tabId);
  if (frames) for (const id of frames.keys()) if (Date.now() - (seen.get(`${tabId}:${id}`) ?? 0) > 90000) frames.delete(id);
  if (!frames) return false;
  for (const present of frames.values()) if (present) return true;
  return false;
}

/** frameId всех фреймов вкладки, где сейчас есть <video> (для выбора фрейма снапшота). */
export function framesWithVideo(tabId: number): number[] {
  const frames = tabs.get(tabId);
  if (frames) for (const id of frames.keys()) if (Date.now() - (seen.get(`${tabId}:${id}`) ?? 0) > 90000) frames.delete(id);
  if (!frames) return [];
  const out: number[] = [];
  for (const [frameId, present] of frames) if (present) out.push(frameId);
  return out;
}

/** Фрейм сообщил своё присутствие видео. Обновляем карту и, при смене доступности
 *  по вкладке, пушим в островок (frame 0). Появление — сразу, пропадание — с дебаунсом. */
export function onVideoPresence(tabId: number, frameId: number, present: boolean): void {
  if (present && !alarmStarted) { alarmStarted = true; browser.alarms.create(PRESENCE_ALARM, { periodInMinutes: 0.5 }); }
  let frames = tabs.get(tabId);
  if (!frames) { frames = new Map(); tabs.set(tabId, frames); }
  seen.set(`${tabId}:${frameId}`, Date.now());
  frames.set(frameId, present);

  const available = queryVideoAvailable(tabId);
  const clearAbsence = () => {
    const t = absenceTimers.get(tabId);
    if (t != null) { clearTimeout(t); absenceTimers.delete(tabId); }
  };

  if (available) {
    clearAbsence(); // видео снова есть — отменяем отложенное «пропало»
    pushAvailability(tabId, true);
  } else if (lastPushed.get(tabId) && absenceTimers.get(tabId) == null) {
    // Было доступно, стало нет — не гасим сразу: подмена <video> даёт короткий провал.
    const timer = setTimeout(() => {
      absenceTimers.delete(tabId);
      if (!queryVideoAvailable(tabId)) pushAvailability(tabId, false);
    }, ABSENCE_DEBOUNCE_MS) as unknown as number;
    absenceTimers.set(tabId, timer);
  }
}

/** Отправить доступность в frame 0 вкладки, только если она изменилась. */
function pushAvailability(tabId: number, available: boolean): void {
  if (lastPushed.get(tabId) === available) return;
  lastPushed.set(tabId, available);
  const msg: VideoAvailabilityMsg = { kind: 'video-availability', available };
  browser.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => { /* фрейм ещё не готов/закрыт */ });
}

/** Вкладка НАВИГИРУЕТСЯ на новый документ (Фаза 2): старые фреймы (кросс-доменные iframe
 *  прежней серии/страницы) вот-вот умрут, но webNavigation мы не слушаем — карта копила бы
 *  мёртвые frameId (островок висел бы на странице без видео; снапшот целился бы в дохлый
 *  фрейм). Чистим карту фреймов и absence-таймер; новый документ отрепортит присутствие
 *  заново. `lastPushed` НЕ трогаем — пуш доступности пойдёт на реальную смену. */
export function resetTabFrames(tabId: number): void {
  tabs.delete(tabId);
  for (const key of seen.keys()) if (key.startsWith(`${tabId}:`)) seen.delete(key);
  const t = absenceTimers.get(tabId);
  if (t != null) { clearTimeout(t); absenceTimers.delete(tabId); }
}

/** Вкладка закрыта — вычищаем всё её состояние. */
export function forgetTab(tabId: number): void {
  tabs.delete(tabId);
  for (const key of seen.keys()) if (key.startsWith(`${tabId}:`)) seen.delete(key);
  lastPushed.delete(tabId);
  const t = absenceTimers.get(tabId);
  if (t != null) { clearTimeout(t); absenceTimers.delete(tabId); }
}

// An unloaded iframe may not deliver pagehide; expire its lease independently.
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== PRESENCE_ALARM) return;
  for (const tabId of [...tabs.keys()]) if (!queryVideoAvailable(tabId)) { pushAvailability(tabId, false); forgetTab(tabId); }
  if (!tabs.size) { alarmStarted = false; void browser.alarms.clear(PRESENCE_ALARM); }
});
