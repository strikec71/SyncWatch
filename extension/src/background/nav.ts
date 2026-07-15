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
  | 'absorb'            // промежуточный репорт ВО ВРЕМЯ применения чужого NAV — молча гасим (player-scope)
  | 'broadcast';        // легитимная локальная навигация — транслировать партнёрам

/** Решение по локальному репорту URL/подписи. Порядок ветвей важен:
 *  detached и пустой baseline перехватываем ДО трансляции (см. инварианты в шапке).
 *  `absorbMidNav` (ТОЛЬКО player-scope): пока применяем чужой выбор (expected живой), любой
 *  несовпадающий промежуточный репорт — шум перестройки списков, а не действие юзера → 'absorb'
 *  (не транслируем, baseline/expected не трогаем; ретраи применения ещё могут доехать до expected).
 *  page-scope (absorbMidNav=false) сохраняет last-writer: мид-нав репорт там — реальный переход/редирект. */
export function onNavReportDecision(p: {
  reported: string;
  baseline: string;
  expected: string | null; // null, если expected отсутствует ИЛИ протух по TTL
  detached: boolean;
  canNav: boolean;
  absorbMidNav: boolean;
}): NavReportDecision {
  if (p.detached) return 'set-baseline';           // соло: следим за своей страницей молча
  if (p.baseline === '') return 'set-baseline';    // ПЕРВЫЙ репорт не транслируем (кейс /join)
  if (p.expected !== null && p.reported === p.expected) return 'confirm-expected';
  if (p.absorbMidNav && p.expected !== null) return 'absorb'; // мид-применение: гасим шум перестройки
  if (p.reported === p.baseline) return 'ignore';  // мы уже на этой странице
  return p.canNav ? 'broadcast' : 'gate-blocked';
}

/** Решение по входящему NAV партнёра. Конфликт (мы сами только что навигировали) решаем
 *  host-приоритетом — НИКОГДА по ts. Направленный снапшот (to) прилетает from=host и
 *  sentOwnNavAt≈0 у новичка → просто navigate.
 *  Fix 3 (эхо-ссылка): направленный NAV с url, который МЫ только что ПОКИНУЛИ (`leftUrl`),
 *  в окне после ухода — это отставший baseline хоста, отражённый обратно снапшотом; игнор,
 *  иначе инициатор откатывается на страницу, с которой сам ушёл. Только для направленных
 *  (`directed`): широковещательный старый NAV от хоста (реальный откат комнаты) — применяем. */
export function onIncomingNavDecision(p: {
  url: string;
  baseline: string;
  detached: boolean;
  amHost: boolean;
  fromHost: boolean;
  sentOwnNavAt: number;
  now: number;
  conflictWindowMs: number;
  directed: boolean;
  leftUrl: string;
  leftAt: number;
  leftWindowMs: number;
}): 'navigate' | 'ignore' {
  if (p.detached) return 'ignore';           // соло не следует за комнатой
  if (p.url === p.baseline) return 'ignore'; // уже там
  if (p.directed && p.leftUrl !== '' && p.url === p.leftUrl && p.now - p.leftAt < p.leftWindowMs) {
    return 'ignore'; // эхо нашего же ухода — не откатываемся на покинутую страницу
  }
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
    absorbMidNav: false, // page-scope: мид-нав репорт = реальный переход юзера/редирект (last-writer)
  });

  switch (decision) {
    case 'set-baseline':
      s.pageUrl = url;
      return;
    case 'absorb':
      return; // page-scope 'absorb' не возвращает (absorbMidNav=false) — ветка для полноты switch

    case 'confirm-expected':
      s.pageUrl = url;
      s.expectedNav = null; // доехали — луп-гард снят, STATE снова применяется
      noteActivity(s);      // марафон сериала: переход серии ≠ простой
      // Тост «переходим…» погиб с прошлым документом (reload) — досылаем свежий уже здесь.
      notifyEvent(s, s.navFromName
        ? `Перешли на страницу комнаты вслед за ${s.navFromName}`
        : 'Перешли на страницу комнаты');
      s.navFromName = '';
      return;
    case 'ignore':
      return;
    case 'gate-blocked':
      // Мы (≥3, не контроллер) кликнули серию — вкладка уже ушла. NAV не шлём, но просим
      // выравнивание: SNAPSHOT_REQ хосту → направленные NAV+STATE вернут нас на страницу комнаты.
      requestGateResync(s);
      return;
    case 'broadcast':
      s.lastLeftUrl = s.pageUrl; // покинутый URL — против эхо-отката снапшотом (Fix 3)
      s.lastLeftAt = now;
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
    absorbMidNav: true, // player-scope: гасим промежуточные репорты пока применяем чужой выбор
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
    case 'absorb':
      return; // применение ещё идёт (перестройка списков серий/озвучек) — не шумим NAV
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
    // Fix 3 не применяется к player-scope (нет reload вкладки) — покинутый url не ведём.
    directed: msg.to != null,
    leftUrl: '',
    leftAt: 0,
    leftWindowMs: EXPECTED_NAV_TTL_MS,
  });
  if (decision === 'ignore') return;
  s.expectedSig = sig;
  s.expectedSigAt = Date.now();
  s.mediaSig = sig;
  notifyEvent(s, `${peerName(s, msg.from)} переключил(а) серию/озвучку — синхронизируем`);
  sendToActiveFrame(s, { kind: 'media-apply', sig });
}

/** Решение по сигналу «применить выбор партнёра не удалось» (чистое, тестируемое).
 *  Принимаем ТОЛЬКО пока expectedSig живой (иначе поздний/мусорный сигнал) → 'adopt'; иначе 'ignore'. */
export function onApplyFailedDecision(p: {
  expected: string | null;
  expectedAt: number;
  now: number;
  ttl: number;
}): 'adopt' | 'ignore' {
  return p.expected != null && p.now - p.expectedAt < p.ttl ? 'adopt' : 'ignore';
}

/** Content-скрипт не смог применить выбор партнёра (у нас нет такой озвучки/серии) — наборы
 *  озвучек в балансерах реально различаются. Молчаливое расхождение допустимо by design:
 *  НЕ откатываем комнату, НЕ шлём NAV. Но снимаем луп-гард (STATE/BEAT перестают дропаться —
 *  чинит «висящий expectedSig») и чиним baseline на ПРАВДУ (наш реальный выбор), чтобы хост
 *  потом не пушнул новичку несуществующий у себя sig. */
export function onMediaApplyFailed(s: Session, actualSig: string | null): void {
  const decision = onApplyFailedDecision({
    expected: s.expectedSig,
    expectedAt: s.expectedSigAt,
    now: Date.now(),
    ttl: EXPECTED_NAV_TTL_MS,
  });
  if (decision === 'ignore') return;
  s.expectedSig = null;                 // луп-гард снят: STATE/BEAT снова применяются немедленно
  if (actualSig) s.mediaSig = actualSig; // baseline = наш реальный выбор (не чужой, которого нет)
  notifyEvent(s, 'Не удалось переключить серию/озвучку за партнёром — такой опции нет в вашем плеере, остаёмся на текущей');
}

/** Входящий NAV партнёра. scope:'page' → навигация вкладки; scope:'player' → смена
 *  серии/озвучки внутри плеера. Навигируем вкладку на страницу комнаты; сбрасываем активный
 *  фрейм и анти-эхо (новый документ поднимет свои фреймы), ставим expectedNav и чистим presence.
 *  Async: перед reload сверяем РЕАЛЬНЫЙ URL вкладки (Fix 1) — если уже на нём, только baseline
 *  без перезагрузки (иначе гибнет островок у новичка, стоящего на нужной странице). */
export async function applyRemoteNav(s: Session, msg: NavMessage): Promise<void> {
  if (msg.scope === 'player') { applyRemoteMediaNav(s, msg); return; }
  if (msg.url === undefined) return;
  const url = normalizeSyncUrl(msg.url);
  if (url === null) return; // ревалидация схемы на применении (defense-in-depth)
  noteActivity(s);

  const now = Date.now();
  const decision = onIncomingNavDecision({
    url,
    baseline: s.pageUrl,
    detached: s.detached,
    amHost: amHost(s),
    fromHost: msg.from != null && s.roster.get(msg.from)?.isHost === true,
    sentOwnNavAt: s.lastNavSentAt,
    now,
    conflictWindowMs: NAV_CONFLICT_WINDOW_MS,
    directed: msg.to != null,
    leftUrl: s.lastLeftUrl,
    leftAt: s.lastLeftAt,
    leftWindowMs: EXPECTED_NAV_TTL_MS,
  });
  if (decision === 'ignore') return;

  // Fix 1 (ключевой для обоих багов): вкладка уже на нужном URL? Тогда просто фиксируем
  // baseline — БЕЗ tabs.update/reload, не сбрасывая frameId/lastSync/presence/островок.
  try {
    const tab = await browser.tabs.get(s.tabId);
    if (normalizeSyncUrl(tab.url ?? '') === url) { s.pageUrl = url; return; }
  } catch { /* вкладка ушла — обычная навигация ниже (upd тоже отвалится безопасно) */ }

  s.expectedNav = url;
  s.expectedNavAt = Date.now();
  s.pageUrl = url;
  s.navFromName = peerName(s, msg.from); // имя для тоста ПОСЛЕ reload (confirm-expected)
  s.frameId = 0;          // активный плеерный фрейм протух — новый документ переустановит
  s.lastSync = null;      // анти-эхо старого документа сбрасываем
  resetTabFrames(s.tabId); // presence старого документа больше не действует
  notifyEvent(s, `${peerName(s, msg.from)} переключил(а) страницу — переходим…`);
  browser.tabs.update(s.tabId, { url }).catch(() => { /* нет host-прав (FF) / вкладка ушла */ });
}

/** Клиентский гейт трансляции NAV — зеркалит серверный canNavigate (roomLogic.ts): без
 *  safety-исключения паузы. ≤2 → любой; ≥3 → только host/controller. */
function canNavigate(s: Session): boolean {
  if (s.roster.size <= 2) return true;
  return amHost(s) || amController(s);
}
