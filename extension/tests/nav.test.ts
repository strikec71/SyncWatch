// Юнит-тесты синхрона идентичности контента (background/nav.ts, Фаза 2):
//   normalizeSyncUrl        — только http/https, срез hash, host в нижний регистр
//   onNavReportDecision     — baseline-правило (первый репорт не транслируем), гейт, expected
//   onIncomingNavDecision   — host-приоритет при перекрёстных NAV (НЕ по ts)
//   onNavReport/applyRemoteNav — сайд-эффекты (NAV в сеть, expectedNav, сброс фрейма/эха)

import { describe, it, expect } from 'vitest';
import {
  normalizeSyncUrl,
  onNavReportDecision,
  onIncomingNavDecision,
  onNavReport,
  onMediaSig,
  onApplyFailedDecision,
  onMediaApplyFailed,
  applyRemoteNav,
} from '../src/background/nav';
import { createSession, EXPECTED_NAV_TTL_MS } from '../src/background/state';
import { forgetTab, onVideoPresence, framesWithVideo } from '../src/background/presence';
import { __setTabUrl, __clearTabs } from './stubs/webextension-polyfill';
import type { RosterPeer } from '../src/shared/protocol';

// ── helpers ───────────────────────────────────────────────────────────────────

function rp(id: number, over: Partial<RosterPeer> = {}): RosterPeer {
  return { id, name: `p${id}`, isHost: false, hasControl: false, detached: false, ...over };
}

/** Подключённая сессия с перехватом отправленных wire-сообщений. */
function connectedSession(tabId: number, peers: RosterPeer[], myConnId: number) {
  const s = createSession(tabId);
  s.connected = true;
  s.myConnId = myConnId;
  s.roster = new Map(peers.map((p) => [p.id, p]));
  const sent: unknown[] = [];
  s.ws = { send: (d: string) => sent.push(JSON.parse(d)) } as unknown as WebSocket;
  return { s, sent };
}

// ── normalizeSyncUrl ────────────────────────────────────────────────────────

describe('normalizeSyncUrl', () => {
  it('срезает hash (инвайт-хэш/якорь не влияет на идентичность)', () => {
    expect(normalizeSyncUrl('https://jut.su/anime/126.html#syncwatch=abc'))
      .toBe('https://jut.su/anime/126.html');
  });

  it('сохраняет query (серия/сезон могут жить там)', () => {
    expect(normalizeSyncUrl('https://ex.com/watch?e=5&s=1'))
      .toBe('https://ex.com/watch?e=5&s=1');
  });

  it('нижний регистр хоста, путь без изменений', () => {
    expect(normalizeSyncUrl('https://JUT.SU/Anime/126.html'))
      .toBe('https://jut.su/Anime/126.html');
  });

  it('отбраковывает не-http(s): javascript:/data:/about:', () => {
    expect(normalizeSyncUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeSyncUrl('data:text/html,<b>x</b>')).toBeNull();
    expect(normalizeSyncUrl('about:blank')).toBeNull();
    expect(normalizeSyncUrl('file:///etc/passwd')).toBeNull();
  });

  it('отбраковывает мусор, который не парсится как URL', () => {
    expect(normalizeSyncUrl('not a url')).toBeNull();
    expect(normalizeSyncUrl('')).toBeNull();
  });
});

// ── onNavReportDecision ─────────────────────────────────────────────────────

describe('onNavReportDecision', () => {
  const base = { reported: 'https://a/2', baseline: 'https://a/1', expected: null, detached: false, canNav: true, absorbMidNav: false };

  it('ПЕРВЫЙ репорт (baseline пуст) → set-baseline, НЕ транслируем (кейс /join)', () => {
    expect(onNavReportDecision({ ...base, baseline: '' })).toBe('set-baseline');
  });

  it('соло (detached) → set-baseline молча, даже при непустом baseline', () => {
    expect(onNavReportDecision({ ...base, detached: true })).toBe('set-baseline');
  });

  it('доехали до ожидаемой навигации → confirm-expected', () => {
    expect(onNavReportDecision({ ...base, expected: 'https://a/2' })).toBe('confirm-expected');
  });

  it('тот же URL, что baseline → ignore', () => {
    expect(onNavReportDecision({ ...base, reported: 'https://a/1' })).toBe('ignore');
  });

  it('легитимная локальная навигация с правами → broadcast', () => {
    expect(onNavReportDecision(base)).toBe('broadcast');
  });

  it('навигация без прав (≥3, не контроллер) → gate-blocked', () => {
    expect(onNavReportDecision({ ...base, canNav: false })).toBe('gate-blocked');
  });

  it('приоритет baseline-правила над трансляцией: пустой baseline + нет прав → set-baseline', () => {
    expect(onNavReportDecision({ ...base, baseline: '', canNav: false })).toBe('set-baseline');
  });

  it('player-scope: промежуточный репорт во время применения (expected живой, reported≠expected) → absorb', () => {
    expect(onNavReportDecision({ ...base, absorbMidNav: true, expected: 'kodik|e=5', reported: 'kodik|e=3' }))
      .toBe('absorb');
  });

  it('player-scope: точное совпадение с expected всё равно confirm-expected (absorb не перехватывает)', () => {
    expect(onNavReportDecision({ ...base, absorbMidNav: true, expected: 'kodik|e=5', reported: 'kodik|e=5' }))
      .toBe('confirm-expected');
  });

  it('page-scope (absorbMidNav=false): мид-нав репорт НЕ поглощается — остаётся broadcast (last-writer)', () => {
    expect(onNavReportDecision({ ...base, absorbMidNav: false, expected: 'https://a/9', reported: 'https://a/2' }))
      .toBe('broadcast');
  });

  it('absorb не срабатывает без живого expected (expected=null) даже в player-scope', () => {
    expect(onNavReportDecision({ ...base, absorbMidNav: true, expected: null })).toBe('broadcast');
  });
});

// ── onIncomingNavDecision ────────────────────────────────────────────────────

describe('onIncomingNavDecision', () => {
  const base = {
    url: 'https://a/2',
    baseline: 'https://a/1',
    detached: false,
    amHost: false,
    fromHost: true,
    sentOwnNavAt: 0,
    now: 10_000,
    conflictWindowMs: 4000,
    directed: false,
    leftUrl: '',
    leftAt: 0,
    leftWindowMs: 20_000,
  };

  it('навигируемся на страницу партнёра', () => {
    expect(onIncomingNavDecision(base)).toBe('navigate');
  });

  it('Fix 3: направленный NAV на покинутый нами url в окне → ignore (эхо, не откатываемся)', () => {
    expect(onIncomingNavDecision({
      ...base, directed: true, url: 'https://a/old', leftUrl: 'https://a/old', leftAt: 9000, now: 10_000,
    })).toBe('ignore');
  });

  it('Fix 3: широковещательный (не направленный) старый NAV от host → navigate (реальный откат комнаты)', () => {
    expect(onIncomingNavDecision({
      ...base, directed: false, fromHost: true, url: 'https://a/old', leftUrl: 'https://a/old', leftAt: 9000, now: 10_000,
    })).toBe('navigate');
  });

  it('Fix 3: направленный NAV на покинутый url ВНЕ окна → navigate (окно истекло)', () => {
    expect(onIncomingNavDecision({
      ...base, directed: true, url: 'https://a/old', leftUrl: 'https://a/old', leftAt: 0, now: 100_000,
    })).toBe('navigate');
  });

  it('Fix 3: направленный NAV на ДРУГОЙ url (не покинутый) → navigate', () => {
    expect(onIncomingNavDecision({
      ...base, directed: true, url: 'https://a/2', leftUrl: 'https://a/old', leftAt: 9000, now: 10_000,
    })).toBe('navigate');
  });

  it('уже на этой странице (url === baseline) → ignore', () => {
    expect(onIncomingNavDecision({ ...base, url: 'https://a/1' })).toBe('ignore');
  });

  it('соло (detached) → ignore, за комнатой не следуем', () => {
    expect(onIncomingNavDecision({ ...base, detached: true })).toBe('ignore');
  });

  it('перекрёстные NAV: мы host → ignore (наша страница авторитетна)', () => {
    expect(onIncomingNavDecision({ ...base, amHost: true, sentOwnNavAt: 9000, now: 10_000 })).toBe('ignore');
  });

  it('перекрёстные NAV: партнёр host, мы нет → navigate (следуем за host)', () => {
    expect(onIncomingNavDecision({ ...base, fromHost: true, sentOwnNavAt: 9000, now: 10_000 })).toBe('navigate');
  });

  it('перекрёстные NAV: ни один не host → ignore (без пинг-понга; досинкает снапшот)', () => {
    // now-sentOwnNavAt = 1000 < 4000 → внутри окна конфликта; amHost=false, fromHost=false.
    expect(onIncomingNavDecision({ ...base, fromHost: false, amHost: false, sentOwnNavAt: 9000, now: 10_000 }))
      .toBe('ignore');
  });

  it('вне окна конфликта старый own-NAV не мешает следовать', () => {
    // now-sentOwnNavAt = 9000 > 4000 → конфликта нет → navigate несмотря на own-NAV.
    expect(onIncomingNavDecision({ ...base, sentOwnNavAt: 1000, now: 10_000 })).toBe('navigate');
  });

  it('sentOwnNavAt=0 (мы не навигировали) → конфликта нет, следуем', () => {
    expect(onIncomingNavDecision({ ...base, sentOwnNavAt: 0, now: 10_000 })).toBe('navigate');
  });
});

// ── onNavReport — сайд-эффекты ────────────────────────────────────────────────

describe('onNavReport (side effects)', () => {
  it('первый репорт: ставит baseline, НЕ шлёт NAV', () => {
    const { s, sent } = connectedSession(10, [rp(1, { isHost: true }), rp(2)], 2);
    onNavReport(s, 'https://jut.su/1.html');
    expect(s.pageUrl).toBe('https://jut.su/1.html');
    expect(sent).toEqual([]);
  });

  it('второй репорт (≤2, права есть): шлёт NAV{scope:page} и двигает baseline', () => {
    const { s, sent } = connectedSession(11, [rp(1, { isHost: true }), rp(2)], 2);
    onNavReport(s, 'https://jut.su/1.html'); // baseline
    onNavReport(s, 'https://jut.su/2.html'); // навигация
    expect(s.pageUrl).toBe('https://jut.su/2.html');
    expect(sent).toContainEqual(expect.objectContaining({ type: 'NAV', scope: 'page', url: 'https://jut.su/2.html' }));
    expect(s.lastNavSentAt).toBeGreaterThan(0);
  });

  it('репорт == expectedNav: подтверждает (снимает луп-гард), НЕ шлёт NAV', () => {
    const { s, sent } = connectedSession(12, [rp(1, { isHost: true }), rp(2)], 2);
    s.pageUrl = 'https://jut.su/1.html';
    s.expectedNav = 'https://jut.su/2.html';
    s.expectedNavAt = Date.now();
    onNavReport(s, 'https://jut.su/2.html');
    expect(s.expectedNav).toBeNull();
    expect(s.pageUrl).toBe('https://jut.su/2.html');
    expect(sent).toEqual([]);
  });

  it('≥3 без контроля: gate-blocked → шлёт MODE{detached:false} (resync), НЕ NAV', () => {
    const { s, sent } = connectedSession(13, [rp(1, { isHost: true }), rp(2), rp(3)], 2);
    s.pageUrl = 'https://jut.su/1.html';
    onNavReport(s, 'https://jut.su/9.html');
    expect(sent).toContainEqual(expect.objectContaining({ type: 'MODE', detached: false }));
    expect(sent.find((m) => (m as { type: string }).type === 'NAV')).toBeUndefined();
    expect(s.pageUrl).toBe('https://jut.su/1.html'); // baseline не двигаем при блоке
  });

  it('не-http(s) страница игнорируется целиком', () => {
    const { s, sent } = connectedSession(14, [rp(1, { isHost: true }), rp(2)], 2);
    s.pageUrl = 'https://jut.su/1.html';
    onNavReport(s, 'about:blank');
    expect(s.pageUrl).toBe('https://jut.su/1.html');
    expect(sent).toEqual([]);
  });
});

// ── applyRemoteNav — сайд-эффекты ─────────────────────────────────────────────

describe('applyRemoteNav (side effects)', () => {
  it('навигирует: ставит expectedNav, сбрасывает frameId/lastSync, чистит presence', async () => {
    const TAB = 20;
    forgetTab(TAB); __clearTabs();
    onVideoPresence(TAB, 5, true); // presence старого документа
    const { s } = connectedSession(TAB, [rp(1, { isHost: true }), rp(2)], 2);
    s.pageUrl = 'https://jut.su/1.html';
    s.frameId = 5;
    s.lastSync = { action: 'play', currentTime: 42 };
    await applyRemoteNav(s, { type: 'NAV', scope: 'page', url: 'https://jut.su/2.html', ts: 1, from: 1 });
    expect(s.expectedNav).toBe('https://jut.su/2.html');
    expect(s.pageUrl).toBe('https://jut.su/2.html');
    expect(s.frameId).toBe(0);
    expect(s.lastSync).toBeNull();
    expect(s.navFromName).toBe('p1'); // имя инициатора запомнено для тоста после reload
    expect(framesWithVideo(TAB)).toEqual([]); // presence старого документа очищена
    forgetTab(TAB);
  });

  it('Fix 1: вкладка УЖЕ на нужном URL → только baseline, без reload (frameId/presence целы)', async () => {
    const TAB = 25;
    forgetTab(TAB); __clearTabs();
    onVideoPresence(TAB, 7, true); // видео/островок живого документа
    __setTabUrl(TAB, 'https://jut.su/2.html'); // реальный URL вкладки совпадёт с NAV
    const { s } = connectedSession(TAB, [rp(1, { isHost: true }), rp(2)], 2);
    s.pageUrl = 'https://jut.su/1.html'; // baseline отстал (новичок только вошёл)
    s.frameId = 7;
    s.lastSync = { action: 'play', currentTime: 10 };
    await applyRemoteNav(s, { type: 'NAV', scope: 'page', url: 'https://jut.su/2.html', ts: 1, from: 1, to: 2 });
    expect(s.pageUrl).toBe('https://jut.su/2.html'); // baseline подтянут
    expect(s.expectedNav).toBeNull();               // reload НЕ запущен
    expect(s.frameId).toBe(7);                       // активный фрейм не сброшен
    expect(s.lastSync).not.toBeNull();               // анти-эхо не сброшено
    expect(framesWithVideo(TAB)).toEqual([7]);       // presence островка жив
    forgetTab(TAB); __clearTabs();
  });

  it('url === baseline → ничего не делает (не навигируемся повторно)', async () => {
    __clearTabs();
    const { s } = connectedSession(21, [rp(1, { isHost: true }), rp(2)], 2);
    s.pageUrl = 'https://jut.su/2.html';
    await applyRemoteNav(s, { type: 'NAV', scope: 'page', url: 'https://jut.su/2.html', ts: 1, from: 1 });
    expect(s.expectedNav).toBeNull();
  });

  it('Fix 3: направленный NAV на покинутый нами url в окне → НЕ откатываемся', async () => {
    __clearTabs();
    const { s } = connectedSession(26, [rp(1, { isHost: true }), rp(2)], 2);
    s.pageUrl = 'https://jut.su/2.html'; // мы уже на новой странице
    s.lastLeftUrl = 'https://jut.su/1.html'; // а это покинутый url
    s.lastLeftAt = Date.now();
    await applyRemoteNav(s, { type: 'NAV', scope: 'page', url: 'https://jut.su/1.html', ts: 1, from: 1, to: 2 });
    expect(s.expectedNav).toBeNull();
    expect(s.pageUrl).toBe('https://jut.su/2.html'); // остались на новой
  });

  it('player-scope НЕ трогает page-состояние (обрабатывается отдельной веткой)', async () => {
    const { s } = connectedSession(22, [rp(1, { isHost: true }), rp(2)], 2);
    s.pageUrl = 'https://jut.su/1.html';
    await applyRemoteNav(s, { type: 'NAV', scope: 'player', sig: 'kodik|e=5', ts: 1, from: 1 });
    expect(s.expectedNav).toBeNull();       // page-навигация не запущена
    expect(s.pageUrl).toBe('https://jut.su/1.html'); // baseline страницы не тронут
    expect(s.expectedSig).toBe('kodik|e=5'); // но media-выбор поставлен на применение
  });

  it('перекрёстная навигация: мы host → игнорируем встречный NAV', async () => {
    __clearTabs();
    const { s } = connectedSession(23, [rp(1, { isHost: true }), rp(2)], 1); // мы host (connId 1)
    s.pageUrl = 'https://jut.su/1.html';
    s.lastNavSentAt = Date.now(); // мы только что сами навигировали
    await applyRemoteNav(s, { type: 'NAV', scope: 'page', url: 'https://jut.su/3.html', ts: 1, from: 2 });
    expect(s.expectedNav).toBeNull(); // не пошли за не-host партнёром
    expect(s.pageUrl).toBe('https://jut.su/1.html');
  });

  it('невалидная схема во входящем NAV отбрасывается на применении', async () => {
    const { s } = connectedSession(24, [rp(1, { isHost: true }), rp(2)], 2);
    s.pageUrl = 'https://jut.su/1.html';
    await applyRemoteNav(s, { type: 'NAV', scope: 'page', url: 'javascript:alert(1)', ts: 1, from: 1 });
    expect(s.expectedNav).toBeNull();
    expect(s.pageUrl).toBe('https://jut.su/1.html');
  });

  it('expectedNav имеет разумный TTL (защита от залипания)', () => {
    expect(EXPECTED_NAV_TTL_MS).toBeGreaterThanOrEqual(10000);
  });
});

// ── onMediaSig — синхрон серии/озвучки (Фаза 3, scope:'player') ────────────────

describe('onMediaSig (side effects)', () => {
  it('первый репорт: ставит mediaSig baseline, НЕ шлёт NAV (дефолтную серию не транслируем)', () => {
    const { s, sent } = connectedSession(30, [rp(1, { isHost: true }), rp(2)], 2);
    onMediaSig(s, 'kodik|s=1|e=1|t=609');
    expect(s.mediaSig).toBe('kodik|s=1|e=1|t=609');
    expect(sent).toEqual([]);
  });

  it('смена серии (≤2, права есть): шлёт NAV{scope:player}', () => {
    const { s, sent } = connectedSession(31, [rp(1, { isHost: true }), rp(2)], 2);
    onMediaSig(s, 'kodik|s=1|e=1|t=609'); // baseline
    onMediaSig(s, 'kodik|s=1|e=5|t=609'); // переключили серию
    expect(s.mediaSig).toBe('kodik|s=1|e=5|t=609');
    expect(sent).toContainEqual(expect.objectContaining({ type: 'NAV', scope: 'player', sig: 'kodik|s=1|e=5|t=609' }));
    expect(s.lastSigSentAt).toBeGreaterThan(0);
  });

  it('репорт == expectedSig: подтверждает (снимает луп-гард), НЕ шлёт NAV', () => {
    const { s, sent } = connectedSession(32, [rp(1, { isHost: true }), rp(2)], 2);
    s.mediaSig = 'kodik|e=1';
    s.expectedSig = 'kodik|e=5';
    s.expectedSigAt = Date.now();
    onMediaSig(s, 'kodik|e=5');
    expect(s.expectedSig).toBeNull();
    expect(s.mediaSig).toBe('kodik|e=5');
    expect(sent).toEqual([]);
  });

  it('≥3 без контроля: gate-blocked → MODE resync, НЕ player-NAV', () => {
    const { s, sent } = connectedSession(33, [rp(1, { isHost: true }), rp(2), rp(3)], 2);
    s.mediaSig = 'kodik|e=1';
    onMediaSig(s, 'kodik|e=9');
    expect(sent).toContainEqual(expect.objectContaining({ type: 'MODE', detached: false }));
    expect(sent.find((m) => (m as { type: string }).type === 'NAV')).toBeUndefined();
    expect(s.mediaSig).toBe('kodik|e=1'); // baseline не двигаем при блоке
  });

  it('page- и player-навигация не глушат друг друга (раздельные окна отправки)', () => {
    const { s } = connectedSession(34, [rp(1, { isHost: true }), rp(2)], 1); // мы host
    s.pageUrl = 'https://jut.su/1.html';
    s.mediaSig = 'kodik|e=1';
    onNavReport(s, 'https://jut.su/1.html'); // ре-репорт своей страницы (lastNavSentAt не ставится — ignore)
    // Встречная смена серии от партнёра: НЕ должна попасть под конфликт page-навигации.
    applyRemoteNav(s, { type: 'NAV', scope: 'player', sig: 'kodik|e=5', ts: 1, from: 2 });
    // мы host → onIncomingNavDecision вернёт ignore при конфликте; но конфликта нет
    // (lastSigSentAt=0), так что применяем.
    expect(s.expectedSig).toBe('kodik|e=5');
  });

  it('absorb: промежуточный репорт во время применения чужого выбора НЕ шлёт NAV и не трогает baseline/expected', () => {
    const { s, sent } = connectedSession(35, [rp(1, { isHost: true }), rp(2)], 2);
    s.mediaSig = 'kodik|s=1|e=5|t=10';   // baseline = целевой выбор партнёра
    s.expectedSig = 'kodik|s=1|e=5|t=10'; // применяем его
    s.expectedSigAt = Date.now();
    onMediaSig(s, 'kodik|s=1|e=3|t=10'); // промежуточное состояние перестройки списков
    expect(sent).toEqual([]);                       // шум не транслируем
    expect(s.expectedSig).toBe('kodik|s=1|e=5|t=10'); // луп-гард жив (ретраи ещё доедут)
    expect(s.mediaSig).toBe('kodik|s=1|e=5|t=10');    // baseline не сбит промежуточным
  });
});

// ── onApplyFailedDecision / onMediaApplyFailed (нет такой озвучки/серии у нас) ──

describe('onApplyFailedDecision', () => {
  const base = { expected: 'kodik|t=10' as string | null, expectedAt: 5_000, now: 10_000, ttl: 20_000 };

  it('живой expected → adopt (принимаем реальный выбор, снимаем луп-гард)', () => {
    expect(onApplyFailedDecision(base)).toBe('adopt');
  });

  it('нет expected (уже подтвердился/не применяли) → ignore', () => {
    expect(onApplyFailedDecision({ ...base, expected: null })).toBe('ignore');
  });

  it('expected протух по TTL → ignore (поздний/мусорный сигнал)', () => {
    expect(onApplyFailedDecision({ ...base, expectedAt: 0, now: 20_000 })).toBe('ignore');
  });
});

describe('onMediaApplyFailed (side effects)', () => {
  it('живой expectedSig: снимает луп-гард, чинит baseline на реальный выбор, тост, НЕ шлёт NAV', () => {
    const { s, sent } = connectedSession(36, [rp(1, { isHost: true }), rp(2)], 2);
    s.mediaSig = 'kodik|s=1|e=5|t=10';   // чужой (Anilibria) — у нас его нет
    s.expectedSig = 'kodik|s=1|e=5|t=10';
    s.expectedSigAt = Date.now();
    onMediaApplyFailed(s, 'kodik|s=1|e=5|t=197'); // наш реальный выбор (Студийная Банда)
    expect(s.expectedSig).toBeNull();                  // STATE/BEAT снова применяются
    expect(s.mediaSig).toBe('kodik|s=1|e=5|t=197');    // baseline = правда
    expect(sent.find((m) => (m as { type: string }).type === 'NAV')).toBeUndefined(); // комнату не откатываем
  });

  it('actualSig=null (плеер не готов): луп-гард снят, baseline не трогаем', () => {
    const { s } = connectedSession(37, [rp(1, { isHost: true }), rp(2)], 2);
    s.mediaSig = 'kodik|t=10';
    s.expectedSig = 'kodik|t=10';
    s.expectedSigAt = Date.now();
    onMediaApplyFailed(s, null);
    expect(s.expectedSig).toBeNull();
    expect(s.mediaSig).toBe('kodik|t=10'); // без actualSig baseline остаётся как есть
  });

  it('expectedSig уже снят (null): сигнал игнорируется целиком', () => {
    const { s } = connectedSession(38, [rp(1, { isHost: true }), rp(2)], 2);
    s.mediaSig = 'kodik|t=10';
    s.expectedSig = null;
    onMediaApplyFailed(s, 'kodik|t=197');
    expect(s.mediaSig).toBe('kodik|t=10'); // baseline не тронут (ничего не применяли)
  });
});
