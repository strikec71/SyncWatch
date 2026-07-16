// Чат / быстрые сообщения хаба (Фаза 0.7.0). Ядро — чистые функции (кулдаун, кап лога);
// сессионные обработчики шлют CHAT в сеть, кладут запись в лог сессии и пушат её островку.
//
// ⚠️ XSS: имена/текст здесь только ХРАНЯТСЯ; рендер строго через textContent (overlay-chat/
// chat-bubbles). ⚠️ Время записи — ЛОКАЛЬНЫЕ часы получателя (Date.now()), НИКОГДА wire-ts:
// стенные часы двух машин не синхронны (тот же инвариант, что в коррекции дрейфа).

import type { ChatMessage } from '../shared/protocol';
import type { ChatEntry, ChatPushMsg } from '../shared/messages';
import {
  quickMessageByCode,
  CHAT_COOLDOWN_MS,
  CHAT_LOG_MAX,
} from '../shared/quick-messages';
import { type Session, sendWire, noteActivity, peerName } from './state';
import { sendToActiveFrame } from './sync';
import { sendToOverlays } from './roster';

// ── Чистые функции (unit-testable) ───────────────────────────────────────────

/** Прошёл ли антиспам-кулдаун с последней отправки (граница — ровно cooldownMs). */
export function canSendChat(lastSentAt: number, now: number, cooldownMs: number): boolean {
  return now - lastSentAt >= cooldownMs;
}

/** Дописать запись, обрезав лог до `max` (дропаем старейшие). Чистая — возвращает новый массив. */
export function appendChat(log: ChatEntry[], entry: ChatEntry, max: number): ChatEntry[] {
  const next = [...log, entry];
  if (next.length > max) next.splice(0, next.length - max);
  return next;
}

// ── Сессионные обработчики ────────────────────────────────────────────────────

/** Добавить запись в лог сессии и запушить её островку (frame 0). */
function pushChat(s: Session, entry: ChatEntry): void {
  s.chatLog = appendChat(s.chatLog, entry, CHAT_LOG_MAX);
  const msg: ChatPushMsg = { kind: 'chat', entry };
  sendToOverlays(s, msg);
}

/** островок попросил отправить быстрое сообщение по коду каталога.
 *  Валидируем код+connected, гейтим кулдауном, шлём CHAT в сеть РАНЬШЕ автопаузы (чтобы у
 *  партнёров бабл появился до баннера «на паузе»), затем — при autoPause — ставим ЛОКАЛЬНУЮ
 *  паузу (штатный STATE{pause} уйдёт комнате сам), кладём своё сообщение в лог. */
export function onSendQuickMessage(s: Session, code: string): void {
  const qm = quickMessageByCode(code);
  if (!qm || !s.connected) return;
  const now = Date.now();
  if (!canSendChat(s.lastChatSentAt, now, CHAT_COOLDOWN_MS)) return;
  s.lastChatSentAt = now;

  sendWire(s, { type: 'CHAT', code, ts: now });
  if (qm.autoPause) sendToActiveFrame(s, { kind: 'pause-local' });
  noteActivity(s);

  const entry: ChatEntry = { code, name: s.deviceName || 'Вы', self: true, ts: now };
  pushChat(s, entry);
}

/** Входящее CHAT от партнёра. Неизвестный код без свободного текста — молча игнорируем
 *  (forward-compat). Время штампуем СВОЁ (wire-ts не доверяем). */
export function onRemoteChat(s: Session, msg: ChatMessage): void {
  if (msg.code != null && !quickMessageByCode(msg.code) && !msg.text) return;
  noteActivity(s);
  const entry: ChatEntry = {
    ...(msg.code != null ? { code: msg.code } : {}),
    ...(msg.text != null ? { text: msg.text } : {}),
    name: peerName(s, msg.from),
    self: false,
    ts: Date.now(),
  };
  pushChat(s, entry);
}
