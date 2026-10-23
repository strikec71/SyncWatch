// Чистая логика presence — БЕЗ Durable Object / Worker API, чтобы юнит-тесты гоняли
// решения без живого хранилища (как roomLogic.ts). presence.ts — тонкая обвязка HTTP +
// state.storage — импортирует отсюда прунинг по TTL, взаимный гейт видимости и дедуп
// инбокса. Всё детерминированно.

import type { InboxMsg, PresenceView } from '../../extension/src/shared/presence';

export const PRESENCE_TTL_MS = 150_000; // 2.5 мин: пропущенный beat (~1 мин) не роняет статус
export const INBOX_TTL_MS = 14 * 24 * 3600_000; // 14 дней: непринятый accept протухает

/** Серверная запись presence. В shared не нужна — расширение её никогда не видит
 *  (наружу отдаётся только PresenceView через visibleView). */
export interface PresenceRecord {
  room: string;
  deviceName: string;
  at: number;
  allow: string[];
}

/** Новая Map без записей, чей `at` старше ttl. Порог `>=` (как staleConnIds). */
export function prunePresence(
  map: Map<string, PresenceRecord>,
  now: number,
  ttlMs: number,
): Map<string, PresenceRecord> {
  const out = new Map<string, PresenceRecord>();
  for (const [k, rec] of map) if (now - rec.at < ttlMs) out.set(k, rec);
  return out;
}

/** Новая Map: каждый список отфильтрован по `ts`, опустевшие ключи выброшены. */
export function pruneInbox(
  map: Map<string, InboxMsg[]>,
  now: number,
  ttlMs: number,
): Map<string, InboxMsg[]> {
  const out = new Map<string, InboxMsg[]>();
  for (const [k, list] of map) {
    const kept = list.filter((m) => now - m.ts < ttlMs);
    if (kept.length > 0) out.set(k, kept);
  }
  return out;
}

/**
 * Взаимный гейт видимости. Presence друга отдаётся, только если наш sha256(clientId) в
 * его `allow` (он подтвердил дружбу и шлёт нас в beat). Иначе — offline-заглушка:
 * утёкшая friend-ссылка не даёт слежки. Протухшая/несуществующая запись → тоже offline.
 */
export function visibleView(
  record: PresenceRecord | undefined,
  callerHashHex: string,
): PresenceView {
  if (record && record.allow.includes(callerHashHex)) {
    return { online: true, room: record.room, deviceName: record.deviceName };
  }
  return { online: false, room: '', deviceName: '' };
}

/** Дедуп по `from`: выкидываем прежнюю запись того же отправителя, добавляем свежую в хвост. */
export function dedupInbox(list: InboxMsg[], msg: InboxMsg): InboxMsg[] {
  return [...list.filter((m) => m.from !== msg.from), msg];
}
