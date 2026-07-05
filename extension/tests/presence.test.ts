// Юнит-тесты агрегатора присутствия видео (background/presence.ts): сведение
// per-frame статусов в доступность по вкладке + пуш в frame 0 (появление сразу,
// пропадание с дебаунсом против мигания при подмене <video>) + очистка на закрытии.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import browser from '../src/shared/browser';
import { onVideoPresence, queryVideoAvailable, forgetTab } from '../src/background/presence';

const TAB = 100;

function lastPush(spy: ReturnType<typeof vi.spyOn>): boolean | undefined {
  const calls = spy.mock.calls;
  if (calls.length === 0) return undefined;
  const [, msg] = calls[calls.length - 1] as [number, { available: boolean }, unknown];
  return msg.available;
}

describe('presence aggregator', () => {
  let send: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    forgetTab(TAB); // изоляция: модуль-синглтон переживает тесты
  });
  afterEach(() => {
    forgetTab(TAB);
    send.mockRestore();
    vi.useRealTimers();
  });

  it('видео в любом фрейме делает вкладку доступной', () => {
    expect(queryVideoAvailable(TAB)).toBe(false);
    onVideoPresence(TAB, 0, false); // верхний фрейм без видео
    onVideoPresence(TAB, 3, true);  // дочерний iframe с плеером
    expect(queryVideoAvailable(TAB)).toBe(true);
  });

  it('появление видео сразу пушит available:true в frame 0', () => {
    onVideoPresence(TAB, 2, true);
    expect(send).toHaveBeenCalledWith(TAB, { kind: 'video-availability', available: true }, { frameId: 0 });
    expect(lastPush(send)).toBe(true);
  });

  it('одинаковую доступность повторно не пушит', () => {
    onVideoPresence(TAB, 2, true);
    onVideoPresence(TAB, 5, true); // ещё один фрейм с видео — доступность не изменилась
    const pushes = send.mock.calls.filter(([, m]) => (m as { kind: string }).kind === 'video-availability');
    expect(pushes).toHaveLength(1);
  });

  it('пропадание видео пушит false только после дебаунса', () => {
    onVideoPresence(TAB, 2, true);
    send.mockClear();
    onVideoPresence(TAB, 2, false); // видео пропало
    expect(send).not.toHaveBeenCalled(); // сразу не гасим (защита от подмены <video>)
    vi.advanceTimersByTime(2000);
    expect(lastPush(send)).toBe(false);
  });

  it('вернувшееся в окне дебаунса видео отменяет гашение (нет мигания)', () => {
    onVideoPresence(TAB, 2, true);
    send.mockClear();
    onVideoPresence(TAB, 2, false); // мелькнул провал при смене качества
    vi.advanceTimersByTime(1000);
    onVideoPresence(TAB, 2, true);  // новый <video> подхватился
    vi.advanceTimersByTime(2000);
    expect(send).not.toHaveBeenCalled(); // доступность так и не менялась → пушей нет
    expect(queryVideoAvailable(TAB)).toBe(true);
  });

  it('forgetTab очищает состояние вкладки', () => {
    onVideoPresence(TAB, 2, true);
    expect(queryVideoAvailable(TAB)).toBe(true);
    forgetTab(TAB);
    expect(queryVideoAvailable(TAB)).toBe(false);
  });
});
