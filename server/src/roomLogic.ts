// Чистая логика комнаты — БЕЗ WebSocket, чтобы юнит-тесты гоняли решения без живого сокета.
// room.ts — тонкая обвязка сокетов — импортирует отсюда host-election, roster-shaping и
// permission-гейт. Всё детерминированно: последовательности add/remove однозначно
// определяют host, а `decide`/`canSendState` — что делать с входящим сообщением.

import type {
  PlayerAction,
  RosterMessage,
  RosterPeer,
  WireMessage,
} from '../../extension/src/shared/protocol';

/** Внутреннее состояние участника (в room.ts живёт рядом с его ws). */
export interface PeerState {
  connId: number;
  name: string;
  isHost: boolean;
  hasControl: boolean;
  detached: boolean;
}

/**
 * Host = самый старший (наименьший connId) НЕ-detached участник; если все detached —
 * откат к самому старшему вообще; null для пустой комнаты. Детерминировано → тестируемо.
 */
export function electHost(peers: PeerState[]): number | null {
  if (peers.length === 0) return null;
  let host: number | null = null;
  let fallback = Infinity;
  for (const p of peers) {
    if (p.connId < fallback) fallback = p.connId;
    if (!p.detached && (host === null || p.connId < host)) host = p.connId;
  }
  return host !== null ? host : fallback;
}

/** internal peers → wire ROSTER (self включён в peers). */
export function shapeRoster(peers: PeerState[], self: number): RosterMessage {
  const shaped: RosterPeer[] = peers.map((p) => ({
    id: p.connId,
    name: p.name,
    isHost: p.isHost,
    hasControl: p.hasControl,
    detached: p.detached,
  }));
  return { type: 'ROSTER', self, peers: shaped };
}

/**
 * STATE-гейт. Сигнатура совпадает с тест-контрактом.
 * ≤2 участника → любой управляет; ≥3 → только host/controller, плюс любой может `pause`.
 */
export function canSendState(
  action: PlayerAction,
  size: number,
  isHost: boolean,
  hasControl: boolean,
): boolean {
  if (size <= 2) return true;
  return isHost || hasControl || action === 'pause';
}

/** Что сделать с входящим сообщением. Side-effects (ROSTER, снапшоты) — в room.ts. */
export type RelayDecision =
  | { kind: 'drop' }
  | { kind: 'consume' } // PING/JOIN/MODE/CONTROL — не релеится (обработка в room.ts)
  | { kind: 'broadcast'; inject: boolean } // всем кроме отправителя; inject → вставить from
  | { kind: 'directed'; target: number; inject: boolean } // STATE.to
  | { kind: 'toHost'; target: number }; // зарезервировано; SNAPSHOT_REQ формирует room.ts

/**
 * Зонтичное решение о релее (defense-in-depth; то же гейтится и на клиенте).
 * JOIN/MODE/CONTROL возвращают `consume`/`drop` — их stateful-обработку делает room.ts,
 * `decide` отвечает лишь за релей-измерение (эти сообщения никогда не транслируются как есть).
 */
export function decide(msg: WireMessage, sender: PeerState, size: number): RelayDecision {
  switch (msg.type) {
    case 'PING':
    case 'JOIN':
    case 'MODE':
      return { kind: 'consume' };

    case 'CONTROL':
      return sender.isHost ? { kind: 'consume' } : { kind: 'drop' };

    case 'STATE':
      if (msg.to !== undefined) {
        // Направленный снапшот — только host, только адресату.
        return sender.isHost
          ? { kind: 'directed', target: msg.to, inject: true }
          : { kind: 'drop' };
      }
      if (sender.detached) return { kind: 'drop' };
      return canSendState(msg.action, size, sender.isHost, sender.hasControl)
        ? { kind: 'broadcast', inject: true }
        : { kind: 'drop' };

    case 'BEAT':
      return sender.isHost && !sender.detached
        ? { kind: 'broadcast', inject: true }
        : { kind: 'drop' };

    case 'BUFFER':
    case 'AD':
      return sender.detached ? { kind: 'drop' } : { kind: 'broadcast', inject: true };

    case 'REQUEST_CONTROL':
      // host сам себе право не просит; без host — некому. Иначе направляем host'у,
      // target = connId просителя (его вставим как `from`). Размер НЕ гейтим — UI сам
      // показывает «Запросить» только в комнате ≥3 без контроля; сервер лишь релеит.
      return sender.isHost ? { kind: 'drop' } : { kind: 'toHost', target: sender.connId };

    // ROSTER / SNAPSHOT_REQ — server→client; во входящем потоке недопустимы.
    default:
      return { kind: 'drop' };
  }
}
