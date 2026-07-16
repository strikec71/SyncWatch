// Юнит-тесты чата (Фаза 0.7.0), чистые функции — ни браузера, ни WS.
//   quick-messages.ts → каталог быстрых сообщений (коды/автопауза/поиск)
//   background/chat.ts → appendChat (кап лога), canSendChat (антиспам-кулдаун)
//   overlay-roster.ts  → peersLabel (русская плюрализация «участник(а/ов)»)

import { describe, it, expect } from 'vitest';
import {
  QUICK_MESSAGES,
  quickMessageByCode,
  CHAT_COOLDOWN_MS,
  CHAT_LOG_MAX,
} from '../src/shared/quick-messages';
import { appendChat, canSendChat } from '../src/background/chat';
import { peersLabel } from '../src/content/overlay-roster';
import type { ChatEntry } from '../src/shared/messages';

function entry(over: Partial<ChatEntry> = {}): ChatEntry {
  return { code: 'like', name: 'A', self: false, ts: 0, ...over };
}

describe('quick-messages catalog', () => {
  it('holds exactly 8 messages', () => {
    expect(QUICK_MESSAGES).toHaveLength(8);
  });

  it('has unique codes', () => {
    const codes = QUICK_MESSAGES.map((m) => m.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every message has a non-empty emoji and text', () => {
    for (const m of QUICK_MESSAGES) {
      expect(m.emoji.length).toBeGreaterThan(0);
      expect(m.text.length).toBeGreaterThan(0);
    }
  });

  it('marks exactly the three brb-* messages as autoPause', () => {
    const paused = QUICK_MESSAGES.filter((m) => m.autoPause).map((m) => m.code).sort();
    expect(paused).toEqual(['brb-5min', 'brb-away', 'brb-sec']);
  });

  it('resolves a known code, undefined for unknown (forward-compat)', () => {
    expect(quickMessageByCode('brb-sec')?.text).toBe('Секундочку!');
    expect(quickMessageByCode('nope')).toBeUndefined();
  });
});

describe('appendChat — capped log', () => {
  it('appends within the cap', () => {
    const log = appendChat([], entry({ text: 'a' }), CHAT_LOG_MAX);
    expect(log).toHaveLength(1);
  });

  it('drops the oldest entries once over max (keeps the newest max)', () => {
    let log: ChatEntry[] = [];
    for (let i = 0; i < CHAT_LOG_MAX + 5; i++) log = appendChat(log, entry({ text: `m${i}` }), CHAT_LOG_MAX);
    expect(log).toHaveLength(CHAT_LOG_MAX);
    expect(log[0].text).toBe('m5');                       // 0..4 dropped
    expect(log[log.length - 1].text).toBe(`m${CHAT_LOG_MAX + 4}`);
  });

  it('does not mutate the input array', () => {
    const orig: ChatEntry[] = [];
    appendChat(orig, entry(), 50);
    expect(orig).toHaveLength(0);
  });
});

describe('canSendChat — cooldown boundary', () => {
  it('blocks below the cooldown, allows at/after it', () => {
    expect(canSendChat(0, CHAT_COOLDOWN_MS - 1, CHAT_COOLDOWN_MS)).toBe(false); // 999ms
    expect(canSendChat(0, CHAT_COOLDOWN_MS, CHAT_COOLDOWN_MS)).toBe(true);      // 1000ms
    expect(canSendChat(0, CHAT_COOLDOWN_MS + 50, CHAT_COOLDOWN_MS)).toBe(true);
  });

  it('allows the very first send (lastSentAt 0, now large)', () => {
    expect(canSendChat(0, 999999, CHAT_COOLDOWN_MS)).toBe(true);
  });
});

describe('peersLabel — Russian pluralization', () => {
  it.each([
    [1, '1 участник'],
    [2, '2 участника'],
    [5, '5 участников'],
    [11, '11 участников'],
    [21, '21 участник'],
    [22, '22 участника'],
    [25, '25 участников'],
  ])('%i → %s', (n, label) => {
    expect(peersLabel(n)).toBe(label);
  });
});
