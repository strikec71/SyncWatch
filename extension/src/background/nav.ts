// Синхрон идентичности контента (Фаза 2): URL страницы вкладки в пределах комнаты.
// Аниме-/видео-сайты меняют серию сменой адреса (напр. jut.su) — а протокол синхрона
// command-only и «идентичности контента» не знает, поэтому приглашённый попадал на
// дефолтную серию. Здесь хаб ведёт baseline страницы, транслирует локальную навигацию
// партнёрам (NAV) и применяет входящую (browser.tabs.update). Ядро — чистые функции.
//
// Инварианты (см. CLAUDE.md, раздел «Синхрон контента»):
//  • ПЕРВЫЙ репорт НИКОГДА не транслируем (baseline==='') — иначе /join-приглашённый
//    уволок бы всю комнату на страницу /join.
//  • Перекрёстные NAV разбираем по host-приоритету, НИКОГДА по ts (кросс-машинные часы
//    рассинхронны — тот же запрет, что в коррекции дрейфа).
//  • Пока навигируемся (expectedNav) — входящий STATE дропаем (адресован старому документу).

import browser from '../shared/browser';
import type { NavMessage } from '../shared/protocol';
import {
  type Session,
  sendWire,
  amHost,
  amController,
  peerName,
  noteActivity,
  EXPECTED_NAV_TTL_MS,
} from './state';
import { requestGateResync, sendToActiveFrame } from './sync';
import { resetTabFrames } from './presence';
import { notifyEvent } from './roster';

// Окно разбора перекрёстных навигаций: если МЫ сами отправили NAV не дольше этого назад,
// а тут прилетает встречный — это гонка, решаем по host-приоритету (не по времени).
const NAV_CONFLICT_WINDOW_MS = 4000;

// ── Чистые функции (unit-testable) ───────────────────────────────────────────

/** Нормализация URL для сравнения идентичности страницы: только http/https (иначе null —
 *  javascript:/data:/about: не навигируем), срезаем hash (инвайт-хэш, якоря), host в нижний
 *  регистр. Query СОХРАНЯЕМ (серия/сезон могут жить в нём). */
export function normalizeSyncUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  return u.href;
}

export type NavReportDecision =
  | 'set-baseline'      // просто запомнить как baseline (НЕ транслировать)
  | 'confirm-expected'  // мы доехали до ожидаемой навигации — снять expectedNav, запомнить
  | 'ignore'            // reported === baseline — ничего не делаем
  | 'gate-blocked'      // навигировали, но прав нет (≥3, не контроллер) — выровнять
  | 'broadcast';        // легитимная локальная навигация — транслировать партнёрам

/** Решение по локальному репорту URL. Порядок ветвей важен:
 *  detached и пустой baseline перехватываем ДО трансляции (см. инварианты в шапке). */
export function onNavReportDecision(p: {
  reported: string;
  baseline: string;
  expected: string | null; // null, если expectedNav отсутствует ИЛИ протух по TTL
  detached: boolean;
  canNav: boolean;
}): NavReportDecision {
  if (p.detached) return 'set-baseline';           // соло: следим за своей страницей молча
  if (p.baseline === '') return 'set-baseline';    // ПЕРВЫЙ репорт не транслируем (кейс /join)
  if (p.expected !== null && p.reported === p.expected) return 'confirm-expected';
  if (p.reported === p.baseline) return 'ignore';  // мы уже на этой странице
  return p.canNav ? 'broadcast' : 'gate-blocked';
}

/** Решение по входящему NAV партнёра. Конфликт (мы сами только что навигировали) решаем
 *  host-приоритетом — НИКОГДА по ts. Направленный снапшот (to) прилетает from=host и
 *  sentOwnNavAt≈0 у новичка → просто navigate. */
export function onIncomingNavDecision(p: {
  url: string;
  baseline: string;
  detached: boolean;
  amHost: boolean;
  fromHost: boolean;
  sentOwnNavAt: number;
  now: number;
  conflictWindowMs: number;
}): 'navigate' | 'ignore' {
  if (p.detached) return 'ignore';           // соло не следует за комнатой
  if (p.url === p.baseline) return 'ignore'; // уже там
  const conflict = p.sentOwnNavAt > 0 && p.now - p.sentOwnNavAt < p.conflictWindowMs;
  if (conflict) {
    // Оба навигировали ~одновременно — детерминированный победитель host.
    if (p.amHost) return 'ignore';           // мы host: наша страница авторитетна
    return p.fromHost ? 'navigate' : 'ignore'; // партнёр host → следуем; иначе не дёргаемся
  }
  return 'navigate';
}

// ── Хендлеры хаба ─────────────────────────────────────────────────────────────

/** expectedNav с учётом TTL (протухший → null). */
function liveExpected(s: Session, now: number): string | null {
  return s.expectedNav && now - s.expectedNavAt < EXPECTED_NAV_TTL_MS ? s.expectedNav : null;
}

/** Верхний фрейм отрепортил URL вкладки → решаем и (если нужно) транслируем/выравниваем. */
export function onNavReport(s: Session, rawUrl: string): void {
  const url = normalizeSyncUrl(rawUrl);
  if (url === null) return; // не-http(s) страница — синхронизировать нечего
  const now = Date.now();
  const decision = onNavReportDecision({
    reported: url,
    baseline: s.pageUrl,
    expected: liveExpected(s, now),
    detached: s.detached,
    canNav: canNavigate(s),
  });

  switch (decision) {
    case 'set-baseline':
      s.pageUrl = url;
      return;
    case 'confirm-expected':
      s.pageUrl = url;
      s.expectedNav = null; // доехали — луп-гард снят, STATE снова применяется
      noteActivity(s);      // марафон сериала: переход серии ≠ простой
      return;
    case 'ignore':
      return;
    case 'gate-blocked':
      // Мы (≥3, не контроллер) кликнули серию — вкладка уже ушла. NAV не шлём, но просим
      // выравнивание: SNAPSHOT_REQ хосту → направленные NAV+STATE вернут нас на страницу комнаты.
      requestGateResync(s);
      return;
    case 'broadcast':
      s.pageUrl = url;
      s.lastNavSentAt = now;
      noteActivity(s);
      sendWire(s, { type: 'NAV', scope: 'page', url, ts: now });
      return;
  }
}

// ── Синхрон серии/озвучки внутри плеера (Фаза 3, scope:'player') ───────────────
// Переиспользуем ту же машину решений (onNavReportDecision/onIncomingNavDecision) над
// АБСТРАКТНЫМИ строками-подписями: baseline=mediaSig, expected=expectedSig. Отдельные
// поля/окно (lastSigSentAt), чтобы смена страницы и смена серии не глушили друг друга.

/** Фрейм плеера отрепортил текущий выбор серии/сезона/озвучки → решаем и транслируем. */
export function onMediaSig(s: Session, sig: string): void {
  const now = Date.now();
  const expected = s.expectedSig && now - s.expectedSigAt < EXPECTED_NAV_TTL_MS ? s.expectedSig : null;
  const decision = onNavReportDecision({
    reported: sig,
    baseline: s.mediaSig,
    expected,
    detached: s.detached,
    canNav: canNavigate(s),
  });
  switch (decision) {
    case 'set-baseline':
      s.mediaSig = sig;
      return;
    case 'confirm-expected':
      s.mediaSig = sig;
      s.expectedSig = null;
      noteActivity(s);
      return;
    case 'ignore':
      return;
    case 'gate-blocked':
      requestGateResync(s); // ≥3 без контроля переключил серию — вернём к выбору комнаты
      return;
    case 'broadcast':
      s.mediaSig = sig;
      s.lastSigSentAt = now;
      noteActivity(s);
      sendWire(s, { type: 'NAV', scope: 'player', sig, ts: now });
      return;
  }
}

/** Входящий player-NAV: применяем выбор партнёра, драйвя родной UI плеера через адаптер.
 *  Плеер сменит источник НА МЕСТЕ (без перезагрузки вкладки) → новый video-ready добьёт
 *  позицию (resync Фазы 1). expectedSig — луп-гард (свой репорт подтвердит, не транслируем;
 *  STATE до готовности дропаем). */
function applyRemoteMediaNav(s: Session, msg: NavMessage): void {
  if (msg.sig === undefined) return;
  const sig = msg.sig;
  noteActivity(s);
  const decision = onIncomingNavDecision({
    url: sig,
    baseline: s.mediaSig,
    detached: s.detached,
    amHost: amHost(s),
    fromHost: msg.from != null && s.roster.get(msg.from)?.isHost === true,
    sentOwnNavAt: s.lastSigSentAt,
    now: Date.now(),
    conflictWindowMs: NAV_CONFLICT_WINDOW_MS,
  });
  if (decision === 'ignore') return;
  s.expectedSig = sig;
  s.expectedSigAt = Date.now();
  s.mediaSig = sig;
  notifyEvent(s, `${peerName(s, msg.from)} переключил серию/озвучку — синхронизируем`);
  sendToActiveFrame(s, { kind: 'media-apply', sig });
}

/** Входящий NAV партнёра. scope:'page' → навигация вкладки; scope:'player' → смена
 *  серии/озвучки внутри плеера. Навигируем вкладку на страницу комнаты; сбрасываем активный
 *  фрейм и анти-эхо (новый документ поднимет свои фреймы), ставим expectedNav и чистим presence. */
export function applyRemoteNav(s: Session, msg: NavMessage): void {
  if (msg.scope === 'player') { applyRemoteMediaNav(s, msg); return; }
  if (msg.url === undefined) return;
  const url = normalizeSyncUrl(msg.url);
  if (url === null) return; // ревалидация схемы на применении (defense-in-depth)
  noteActivity(s);

  const decision = onIncomingNavDecision({
    url,
    baseline: s.pageUrl,
    detached: s.detached,
    amHost: amHost(s),
    fromHost: msg.from != null && s.roster.get(msg.from)?.isHost === true,
    sentOwnNavAt: s.lastNavSentAt,
    now: Date.now(),
    conflictWindowMs: NAV_CONFLICT_WINDOW_MS,
  });
  if (decision === 'ignore') return;

  s.expectedNav = url;
  s.expectedNavAt = Date.now();
  s.pageUrl = url;
  s.frameId = 0;          // активный плеерный фрейм протух — новый документ переустановит
  s.lastSync = null;      // анти-эхо старого документа сбрасываем
  resetTabFrames(s.tabId); // presence старого документа больше не действует
  notifyEvent(s, `${peerName(s, msg.from)} переключил страницу — переходим…`);
  browser.tabs.update(s.tabId, { url }).catch(() => { /* нет host-прав (FF) / вкладка ушла */ });
}

/** Клиентский гейт трансляции NAV — зеркалит серверный canNavigate (roomLogic.ts): без
 *  safety-исключения паузы. ≤2 → любой; ≥3 → только host/controller. */
function canNavigate(s: Session): boolean {
  if (s.roster.size <= 2) return true;
  return amHost(s) || amController(s);
}
