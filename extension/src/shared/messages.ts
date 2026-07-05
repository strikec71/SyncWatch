// Внутренние сообщения между частями расширения (content ⇆ background ⇆ popup).
// Это НЕ то же самое, что WireMessage из protocol.ts (тот — формат поверх WebSocket).

import type { PlayerAction, RosterPeer } from './protocol';

/** content-скрипт → background: локальное действие пользователя в плеере. */
export interface PlayerEventMsg {
  kind: 'player-event';
  action: PlayerAction;
  currentTime: number;
  rate?: number;
  paused: boolean; // намерение паузы (полный снимок)
}

/** background → content-скрипт: применить удалённую команду. */
export interface ApplyMsg {
  kind: 'apply';
  action: PlayerAction;
  currentTime: number;
  rate?: number;
  paused: boolean; // намерение паузы партнёра
}

/** background → content-скрипт активного фрейма: вернуть текущий снимок плеера. */
export interface GetSnapshotMsg { kind: 'get-snapshot'; }
/** Ответ на get-snapshot. */
export interface PlayerSnapshot { paused: boolean; currentTime: number; rate: number; }

/** content-скрипт → background: показать тост в оверлее (напр. «партнёр на паузе»). */
export interface NoticeMsg { kind: 'notice'; text: string; }

/** content-скрипт → background: начало/конец буферизации (Фаза 2). */
export interface BufferingMsg {
  kind: 'buffering';
  buffering: boolean;
  currentTime: number;
}

/** content-скрипт → background: периодическое биение позиции (Фаза 2). */
export interface BeatMsg {
  kind: 'beat';
  currentTime: number;
  playing: boolean;
}

/** background → content-скрипт: партнёр буферизуется — встать/сняться с паузы (Фаза 2). */
export interface BufferControlMsg {
  kind: 'buffer-control';
  buffering: boolean;
}

/** background → content-скрипт (Slave): подтянуть позицию к Master при дрейфе (Фаза 2). */
export interface SyncTimeMsg {
  kind: 'sync-time';
  currentTime: number;
  ts: number;
  driftThreshold: number;
}

/** content-скрипт → background: у нас началась/закончилась реклама (Фаза 3). */
export interface AdMsg {
  kind: 'ad';
  ad: boolean;
}

/** background → content-скрипт: у партнёра реклама — держать/снять паузу (Фаза 3). */
export interface AdControlMsg {
  kind: 'ad-control';
  ad: boolean;
}

/** background → оверлей (верхний фрейм): событие активности для ленты (Фаза 5+). */
export interface EventMsg {
  kind: 'event';
  text: string;
  ts: number;
}

/** background → оверлей (верхний фрейм): текущее блокирующее состояние от партнёра
 *  для центрального баннера (Фаза 7). Текст/таймер баннер считает сам. */
export interface BannerMsg {
  kind: 'banner';
  state: 'none' | 'peer-paused' | 'peer-ad' | 'peer-buffer';
  since: number; // ts начала состояния (для count-up таймера рекламы)
  name: string;  // имя партнёра
}

/** popup → background. */
export interface ConnectMsg { kind: 'connect'; }
export interface DisconnectMsg { kind: 'disconnect'; }
export interface GetStatusMsg { kind: 'get-status'; }

/** overlay/тест → background: переключить соло/синхрон (detach). Фаза A. */
export interface SetModeMsg { kind: 'set-mode'; detached: boolean; }

/** host → background: выдать/забрать право управления участнику. Фаза A. */
export interface SetControlMsg {
  kind: 'set-control';
  action: 'grant' | 'revoke';
  target: number;
}

/** overlay → background: гость просит право управления. bg шлёт REQUEST_CONTROL. Фаза B. */
export interface RequestControlMsg { kind: 'request-control'; }

/** background → overlay (frame 0): host получил REQUEST_CONTROL — предложить выдать право.
 *  `from` = connId просителя (совпадает со строкой roster), `name` — его имя для тоста/подсветки. */
export interface ControlRequestMsg { kind: 'control-request'; from: number; name: string; }

/** background → overlay (frame 0): доступна новая сборка (нотификатор). Фаза B; авто-скачивания нет. */
export interface UpdateAvailableMsg { kind: 'update-available'; version: string; }

/** background → оверлей: снимок состояния (roster-based, Фаза A).
 *  `peerPresent`/`peerName` сохранены для обратной совместимости с оверлеем
 *  (миграция на `peers` — Фаза B); `peerPresent = peers.length > 1`. */
export interface StatusMsg {
  kind: 'status';
  connected: boolean;
  peerPresent: boolean;
  room: string;
  deviceName: string;
  peerName: string;
  peers: RosterPeer[];
  amHost: boolean;
  amController: boolean;
  detached: boolean;
  /** Наш connId (== session.myConnId, -1 вне комнаты) — оверлей метит строку «вы». */
  self: number;
}

export type RuntimeMessage =
  | PlayerEventMsg
  | ApplyMsg
  | BufferingMsg
  | BeatMsg
  | BufferControlMsg
  | SyncTimeMsg
  | AdMsg
  | AdControlMsg
  | EventMsg
  | BannerMsg
  | GetSnapshotMsg
  | NoticeMsg
  | ConnectMsg
  | DisconnectMsg
  | GetStatusMsg
  | SetModeMsg
  | SetControlMsg
  | RequestControlMsg
  | ControlRequestMsg
  | UpdateAvailableMsg
  | StatusMsg;

/** Снимок состояния хаба для оверлея/теста. Roster-based (Фаза A + `self` Фаза B). */
export interface StatusSnapshot {
  connected: boolean;
  peerPresent: boolean;
  room: string;
  deviceName: string;
  peerName: string;
  peers: RosterPeer[];
  amHost: boolean;
  amController: boolean;
  detached: boolean;
  /** Наш connId (== session.myConnId, -1 вне комнаты) — оверлей метит строку «вы». */
  self: number;
}
