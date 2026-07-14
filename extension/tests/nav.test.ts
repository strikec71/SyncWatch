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
  applyRemoteNav,
} from '../src/background/nav';
import { createSession, EXPECTED_NAV_TTL_MS } from '../src/background/state';
import { forgetTab, onVideoPresence, framesWithVideo } from '../src/background/presence';
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
  const base = { reported: 'https://a/2', baseline: 'https://a/1', expected: null, detached: false, canNav: true };

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
  };

  it('навигируемся на страницу партнёра', () => {
    expect(onIncomingNavDecision(base)).toBe('navigate');
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
  it('навигирует: ставит expectedNav, сбрасывает frameId/lastSync, чистит presence', () => {
    const TAB = 20;
    forgetTab(TAB);
    onVideoPresence(TAB, 5, true); // presence старого документа
    const { s } = connectedSession(TAB, [rp(1, { isHost: true }), rp(2)], 2);
    s.pageUrl = 'https://jut.su/1.html';
    s.frameId = 5;
    s.lastSync = { action: 'play', currentTime: 42 };
    applyRemoteNav(s, { type: 'NAV', scope: 'page', url: 'https://jut.su/2.html', ts: 1, from: 1 });
    expect(s.expectedNav).toBe('https://jut.su/2.html');
    expect(s.pageUrl).toBe('https://jut.su/2.html');
    expect(s.frameId).toBe(0);
    expect(s.lastSync).toBeNull();
    expect(framesWithVideo(TAB)).toEqual([]); // presence старого документа очищена
    forgetTab(TAB);
  });

  it('url === baseline → ничего не делает (не навигируемся повторно)', () => {
    const { s } = connectedSession(21, [rp(1, { isHost: true }), rp(2)], 2);
    s.pageUrl = 'https://jut.su/2.html';
    applyRemoteNav(s, { type: 'NAV', scope: 'page', url: 'https://jut.su/2.html', ts: 1, from: 1 });
    expect(s.expectedNav).toBeNull();
  });

  it('player-scope НЕ трогает page-состояние (обрабатывается отдельной веткой)', () => {
    const { s } = connectedSession(22, [rp(1, { isHost: true }), rp(2)], 2);
    s.pageUrl = 'https://jut.su/1.html';
    applyRemoteNav(s, { type: 'NAV', scope: 'player', sig: 'kodik|e=5', ts: 1, from: 1 });
    expect(s.expectedNav).toBeNull();       // page-навигация не запущена
    expect(s.pageUrl).toBe('https://jut.su/1.html'); // baseline страницы не тронут
    expect(s.expectedSig).toBe('kodik|e=5'); // но media-выбор поставлен на применение
  });

  it('перекрёстная навигация: мы host → игнорируем встречный NAV', () => {
    const { s } = connectedSession(23, [rp(1, { isHost: true }), rp(2)], 1); // мы host (connId 1)
    s.pageUrl = 'https://jut.su/1.html';
    s.lastNavSentAt = Date.now(); // мы только что сами навигировали
    applyRemoteNav(s, { type: 'NAV', scope: 'page', url: 'https://jut.su/3.html', ts: 1, from: 2 });
    expect(s.expectedNav).toBeNull(); // не пошли за не-host партнёром
    expect(s.pageUrl).toBe('https://jut.su/1.html');
  });

  it('невалидная схема во входящем NAV отбрасывается на применении', () => {
    const { s } = connectedSession(24, [rp(1, { isHost: true }), rp(2)], 2);
    s.pageUrl = 'https://jut.su/1.html';
    applyRemoteNav(s, { type: 'NAV', scope: 'page', url: 'javascript:alert(1)', ts: 1, from: 1 });
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
});
