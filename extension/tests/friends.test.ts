// Юнит-тесты друзей + presence (Фаза «друзья»):
//   background/friends.ts  → чистые функции (httpsHostFromServer, viewToStatus, sha256Hex,
//                            mergeAcceptInbox, buildFriendLink, buildJoinUrl) + обработчики
//                            инбокса/CRUD над мок-storage (accept/decline/remove/incoming)
//                            + beatPresence (сборка `allow` = sha256-hex, гейт sharePresence)
//   shared/presence.ts     → валидаторы границы (parsePresenceBeat/Query/Friend)
//
// Storage мокается in-memory поверх stub'а webextension-polyfill; fetch — vi.stubGlobal,
// чтобы presence-обёртки не ходили в сеть.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import browser from '../src/shared/browser';
import { publicKeyId } from '../src/shared/identity';
import {
  httpsHostFromServer,
  viewToStatus,
  sha256Hex,
  mergeAcceptInbox,
  buildFriendLink,
  buildJoinUrl,
  beatPresence,
  tickPresence,
  handleAddFriendLink,
  pollPresence,
  pushFriendsStatus,
  handleAcceptFriend,
  handleDeclineFriend,
  handleRemoveFriend,
  handleFriendRequestIncoming,
} from '../src/background/friends';
import {
  parsePresenceBeat,
  parsePresenceQuery,
  parsePresenceFriend,
} from '../src/shared/presence';
import type { InboxMsg, PresenceView } from '../src/shared/presence';
import { ensureIdentity, loadSettings, updateSettings } from '../src/shared/settings';
import type { Friend } from '../src/shared/settings';
import type { FriendRequestIncomingMsg } from '../src/shared/messages';

// ── helpers ───────────────────────────────────────────────────────────────────

/** In-memory browser.storage.local поверх stub'а. Возвращает сырую Map (ключ → значение). */
function mockStorage(initial: Record<string, unknown> = {}): Map<string, unknown> {
  const store = new Map<string, unknown>(Object.entries(initial));
  vi.spyOn(browser.storage.local, 'get').mockImplementation((async (keys?: unknown) => {
    if (keys == null) return Object.fromEntries(store);
    const list =
      typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys as object);
    const out: Record<string, unknown> = {};
    for (const k of list) if (store.has(k)) out[k] = store.get(k);
    return out;
  }) as typeof browser.storage.local.get);
  vi.spyOn(browser.storage.local, 'set').mockImplementation((async (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) store.set(k, v);
  }) as typeof browser.storage.local.set);
  return store;
}

function friend(id: string, over: Partial<Friend> = {}): Friend {
  return { id, name: `имя-${id}`, addedAt: 0, ...over };
}
function accept(from: string, ts = 0): InboxMsg {
  return { from, fromName: `имя-${from}`, kind: 'accept', ts };
}
function view(over: Partial<PresenceView> = {}): PresenceView {
  return { online: true, room: '', deviceName: 'Ноут', ...over };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ok:true}) });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── httpsHostFromServer ───────────────────────────────────────────────────────

describe('httpsHostFromServer', () => {
  it.each([
    ['wss://sig.example.dev', 'https://sig.example.dev'],
    ['ws://localhost:8787', 'http://localhost:8787'],
    ['https://sig.example.dev/', 'https://sig.example.dev'],
    ['http://localhost:8787//', 'http://localhost:8787'],
    ['sig.example.dev', 'https://sig.example.dev'],
    ['  wss://sig.example.dev  ', 'https://sig.example.dev'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(httpsHostFromServer(input)).toBe(expected);
  });
});

// ── viewToStatus ─────────────────────────────────────────────────────────────

describe('viewToStatus — PresenceView → строка статуса', () => {
  it('нет записи → offline', () => {
    expect(viewToStatus(undefined)).toBe('offline');
  });
  it('{online:false} → offline', () => {
    expect(viewToStatus(view({ online: false }))).toBe('offline');
  });
  it('{online:true, room:""} → online (в сети, вне комнаты)', () => {
    expect(viewToStatus(view({ online: true, room: '' }))).toBe('online');
  });
  it('{online:true, room:"кино"} → watching', () => {
    expect(viewToStatus(view({ online: true, room: 'кино' }))).toBe('watching');
  });
});

// ── sha256Hex ────────────────────────────────────────────────────────────────

describe('sha256Hex — строчный hex, ровно как держит сервер в allow', () => {
  it('известный вектор', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('64 hex-символа в нижнем регистре', async () => {
    const h = await sha256Hex('какой-то-clientId');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── mergeAcceptInbox — accept → авто-добавление друга ─────────────────────────

describe('mergeAcceptInbox', () => {
  it('accept для нового id → друг добавлен, имя из fromName', () => {
    const { friends, added } = mergeAcceptInbox([], [accept('anya')], 123);
    expect(friends).toEqual([{ id: 'anya', name: 'имя-anya', addedAt: 123 }]);
    expect(added).toEqual(['имя-anya']);
  });

  it('accept для уже-друга → не дублируется', () => {
    const existing = [friend('anya')];
    const { friends, added } = mergeAcceptInbox(existing, [accept('anya')], 1);
    expect(friends).toHaveLength(1);
    expect(added).toEqual([]);
  });

  it('два accept от одного from → друг добавлен один раз', () => {
    const { friends, added } = mergeAcceptInbox([], [accept('anya', 1), accept('anya', 2)], 5);
    expect(friends).toHaveLength(1);
    expect(added).toEqual(['имя-anya']);
  });

  it('несколько разных from → все добавлены, порядок сохранён', () => {
    const { friends, added } = mergeAcceptInbox([friend('bob')], [accept('anya'), accept('cid')], 0);
    expect(friends.map((f) => f.id)).toEqual(['bob', 'anya', 'cid']);
    expect(added).toEqual(['имя-anya', 'имя-cid']);
  });

  it('пустой fromName → запасное имя «Друг»', () => {
    const { friends } = mergeAcceptInbox([], [{ from: 'x', fromName: '', kind: 'accept', ts: 0 }], 0);
    expect(friends[0].name).toBe('Друг');
  });

  it('не мутирует входной список друзей', () => {
    const input = [friend('bob')];
    mergeAcceptInbox(input, [accept('anya')], 0);
    expect(input).toEqual([friend('bob')]);
  });

  it('игнорирует записи с kind !== "accept"', () => {
    const weird = { from: 'x', fromName: 'X', kind: 'reject', ts: 0 } as unknown as InboxMsg;
    const { friends, added } = mergeAcceptInbox([], [weird], 0);
    expect(friends).toEqual([]);
    expect(added).toEqual([]);
  });
});

// ── buildFriendLink / buildJoinUrl ───────────────────────────────────────────

describe('buildFriendLink', () => {
  it('кладёт clientId/имя/сервер в хэш /join, всё url-энкодит', () => {
    const link = buildFriendLink('https://h.dev', 'id 1', 'Аня Ноут', 'wss://h.dev');
    expect(link).toBe(
      'https://h.dev/join#syncwatch-friend=id%201&n=%D0%90%D0%BD%D1%8F%20%D0%9D%D0%BE%D1%83%D1%82&s=wss%3A%2F%2Fh.dev',
    );
  });
});

describe('buildJoinUrl — «Войти к другу»', () => {
  it('строит /join#r=<room>&s=<server> с энкодингом', () => {
    expect(buildJoinUrl('https://h.dev', 'ro om', 'wss://h.dev')).toBe(
      'https://h.dev/join#r=ro%20om&s=wss%3A%2F%2Fh.dev',
    );
  });

  it('простой случай без спецсимволов', () => {
    expect(buildJoinUrl('https://h.dev', 'movie42', 'wss://h.dev')).toBe(
      'https://h.dev/join#r=movie42&s=wss%3A%2F%2Fh.dev',
    );
  });
});

// ── beatPresence — сборка allow из sha256, гейт sharePresence ─────────────────

describe('beatPresence', () => {
  it('POST /presence/beat: allow = sha256-hex каждого друга, room пустой вне комнаты', async () => {
    mockStorage({
      settings: { serverUrl: 'wss://sig.example.dev', sharePresence: true },
      identity: { clientId: 'me-1' },
      friends: [friend('aaa'), friend('bbb')],
    });

    await beatPresence();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sig.example.dev/presence/beat');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.clientId).toBe((await ensureIdentity()).clientId);
    expect((init.headers as Record<string,string>).authorization).toMatch(/^Signature [a-f0-9]{128}$/);
    expect(JSON.stringify(init.headers)).not.toContain((await ensureIdentity()).privateKey.d);
    expect(body.room).toBe('');
    expect(body.allow).toEqual([await sha256Hex('aaa'), await sha256Hex('bbb')]);
    expect(body.allow.every((h: string) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
  });

  it('sharePresence:false → beat не шлётся вовсе', async () => {
    mockStorage({
      settings: { serverUrl: 'wss://sig.example.dev', sharePresence: false },
      identity: { clientId: 'me-1' },
      friends: [friend('aaa')],
    });
    await beatPresence();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('пустой serverUrl → beat не шлётся (некуда)', async () => {
    mockStorage({
      settings: { serverUrl: '', sharePresence: true },
      identity: { clientId: 'me-1' },
      friends: [friend('aaa')],
    });
    await beatPresence();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('нет друзей → allow пустой', async () => {
    mockStorage({
      settings: { serverUrl: 'wss://sig.example.dev', sharePresence: true },
      identity: { clientId: 'me-1' },
      friends: [],
    });
    await beatPresence();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).allow).toEqual([]);
  });
});

// ── Обработчики инбокса / CRUD (over mock storage) ────────────────────────────

describe('handleAcceptFriend', () => {
  it('инбокс-запись → друг + очистка записи инбокса', async () => {
    const store = mockStorage({
      settings: { serverUrl: 'wss://sig.example.dev', sharePresence: true },
      identity: { clientId: 'me' },
      friends: [],
      friendInbox: [{ id: 'anya', name: 'Аня', serverUrl: 'wss://sig.example.dev', inviteToken: '2'.repeat(64), ts: 0 }],
    });

    await handleAcceptFriend('anya');

    expect((store.get('friends') as Friend[]).map((f) => f.id)).toEqual(['anya']);
    expect(store.get('friendInbox')).toEqual([]);
  });

  it('уже друг → не дублируется, запись инбокса всё равно снимается', async () => {
    const store = mockStorage({
      settings: { serverUrl: 'wss://sig.example.dev', sharePresence: true },
      identity: { clientId: 'me' },
      friends: [friend('anya')],
      friendInbox: [{ id: 'anya', name: 'Аня', serverUrl: 'wss://sig.example.dev', inviteToken: '2'.repeat(64), ts: 0 }],
    });

    await handleAcceptFriend('anya');

    expect(store.get('friends')).toHaveLength(1);
    expect(store.get('friendInbox')).toEqual([]);
  });

  it('нет такой записи в инбоксе → ничего не делает', async () => {
    const store = mockStorage({
      settings: { serverUrl: 'wss://sig.example.dev', sharePresence: true },
      identity: { clientId: 'me' },
      friends: [],
      friendInbox: [],
    });
    await handleAcceptFriend('ghost');
    expect(store.get('friends')).toEqual([]);
  });
});

describe('handleDeclineFriend', () => {
  it('убирает запись из инбокса, друзей не трогает', async () => {
    const store = mockStorage({
      friends: [friend('bob')],
      friendInbox: [
        { id: 'anya', name: 'Аня', serverUrl: '', ts: 0 },
        { id: 'cid', name: 'C', serverUrl: '', ts: 0 },
      ],
    });

    await handleDeclineFriend('anya');

    expect((store.get('friendInbox') as { id: string }[]).map((e) => e.id)).toEqual(['cid']);
    expect(store.get('friends')).toHaveLength(1);
  });
});

describe('handleRemoveFriend', () => {
  it('удаляет друга по id', async () => {
    const store = mockStorage({
      settings: { serverUrl: '', sharePresence: true },
      friends: [friend('anya'), friend('bob')],
    });

    await handleRemoveFriend('anya');

    expect((store.get('friends') as Friend[]).map((f) => f.id)).toEqual(['bob']);
  });

  it('несуществующий id → список без изменений', async () => {
    const store = mockStorage({
      settings: { serverUrl: '', sharePresence: true },
      friends: [friend('anya')],
    });
    await handleRemoveFriend('ghost');
    expect((store.get('friends') as Friend[]).map((f) => f.id)).toEqual(['anya']);
  });
});

describe('handleFriendRequestIncoming', () => {
  const msg = (over: Partial<FriendRequestIncomingMsg> = {}): FriendRequestIncomingMsg => ({
    kind: 'friend-request-incoming',
    id: 'a'.repeat(64),
    name: 'Аня',
    inviteToken: '2'.repeat(64),
    serverUrl: 'wss://sig.example.dev',
    ...over,
  });

  it('новая ссылка → запись в инбоксе', async () => {
    const store = mockStorage({ friends: [], friendInbox: [] });
    await handleFriendRequestIncoming(msg());
    const inbox = store.get('friendInbox') as { id: string; name: string; serverUrl: string }[];
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ id: 'a'.repeat(64), name: 'Аня', serverUrl: 'wss://sig.example.dev' });
  });

  it('уже друг → повторная ссылка игнорируется (инбокс не растёт)', async () => {
    const store = mockStorage({ friends: [friend('a'.repeat(64))], friendInbox: [] });
    await handleFriendRequestIncoming(msg());
    expect(store.get('friendInbox')).toEqual([]);
  });

  it('дубликат запроса → освежает имя/сервер, не плодит записи', async () => {
    const store = mockStorage({
      friends: [],
      friendInbox: [{ id: 'a'.repeat(64), name: 'старое', serverUrl: '', ts: 111 }],
    });

    await handleFriendRequestIncoming(msg({ name: 'Аня-новое', serverUrl: 'wss://new.dev' }));

    const inbox = store.get('friendInbox') as { name: string; serverUrl: string; ts: number }[];
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ name: 'Аня-новое', serverUrl: 'wss://new.dev', ts: 111 });
  });
});

// ── shared/presence.ts — валидаторы границы ───────────────────────────────────

describe('parsePresenceBeat', () => {
  const ok = { clientId: 'c1', room: 'r1', deviceName: 'Ноут', allow: ['a'.repeat(64)] };

  it('пропускает валидное тело (строка и объект)', () => {
    expect(parsePresenceBeat(ok)).toEqual(ok);
    expect(parsePresenceBeat(JSON.stringify(ok))).toEqual(ok);
  });

  it('room:"" допустим (онлайн вне комнаты)', () => {
    expect(parsePresenceBeat({ ...ok, room: '' })?.room).toBe('');
  });

  it.each([
    ['не-JSON строка', 'not json'],
    ['не объект', 42],
    ['null', null],
    ['нет clientId', { room: '', deviceName: 'd', allow: [] }],
    ['пустой clientId', { ...ok, clientId: '' }],
    ['clientId длиннее 64', { ...ok, clientId: 'x'.repeat(65) }],
    ['room длиннее 128', { ...ok, room: 'x'.repeat(129) }],
    ['deviceName не строка', { ...ok, deviceName: 5 }],
    ['allow не массив', { ...ok, allow: 'nope' }],
    ['allow длиннее 64 элементов', { ...ok, allow: Array(65).fill('a'.repeat(64)) }],
    ['элемент allow не 64-hex', { ...ok, allow: ['ABCDEF'] }],
    ['элемент allow в верхнем регистре', { ...ok, allow: ['A'.repeat(64)] }],
  ])('отбраковывает: %s', (_label, input) => {
    expect(parsePresenceBeat(input)).toBeNull();
  });
});

describe('parsePresenceQuery', () => {
  it('пропускает валидное тело', () => {
    const q = { clientId: 'c1', friendIds: ['a', 'b'] };
    expect(parsePresenceQuery(q)).toEqual(q);
  });

  it.each([
    ['нет clientId', { friendIds: [] }],
    ['friendIds не массив', { clientId: 'c1', friendIds: {} }],
    ['friendIds длиннее 64', { clientId: 'c1', friendIds: Array(65).fill('x') }],
    ['пустой id внутри friendIds', { clientId: 'c1', friendIds: [''] }],
    ['нестроковый id внутри friendIds', { clientId: 'c1', friendIds: [1] }],
  ])('отбраковывает: %s', (_label, input) => {
    expect(parsePresenceQuery(input)).toBeNull();
  });
});

describe('parsePresenceFriend', () => {
  it('пропускает валидное тело', () => {
    const f = { from: 'a', fromName: 'Аня', to: 'b' };
    expect(parsePresenceFriend(f)).toEqual(f);
  });

  it('fromName:"" допустим', () => {
    expect(parsePresenceFriend({ from: 'a', fromName: '', to: 'b' })).toEqual({
      from: 'a',
      fromName: '',
      to: 'b',
    });
  });

  it.each([
    ['нет from', { fromName: 'x', to: 'b' }],
    ['нет to', { from: 'a', fromName: 'x' }],
    ['fromName не строка', { from: 'a', fromName: 5, to: 'b' }],
    ['fromName длиннее 64', { from: 'a', fromName: 'x'.repeat(65), to: 'b' }],
    ['from длиннее 64', { from: 'x'.repeat(65), fromName: 'x', to: 'b' }],
  ])('отбраковывает: %s', (_label, input) => {
    expect(parsePresenceFriend(input)).toBeNull();
  });
});

describe('friends regressions from the current source audit', () => {
  it('creates one identity during concurrent first use and binds its public ID to the private key', async () => {
    mockStorage();
    const identities = await Promise.all(Array.from({length:8}, () => ensureIdentity()));
    expect(new Set(identities.map(i => i.clientId)).size).toBe(1);
    expect(identities[0].clientId).toBe(await publicKeyId(identities[0].publicKey));
    expect(identities[0].privateKey.d).not.toBe(identities[0].clientId);
  });
  it('preserves the presence preference through normalized settings writes', async () => {
    mockStorage({settings:{sharePresence:false,serverUrl:'wss://h.dev'}});
    await updateSettings({deviceName:'A'});
    expect((await loadSettings()).sharePresence).toBe(false);
    await updateSettings({sharePresence:true});
    expect((await loadSettings()).sharePresence).toBe(true);
  });
  it('polls for the FIRST friend acceptance, without requiring an existing friend', async () => {
    const store = mockStorage({settings:{serverUrl:'wss://h.dev',sharePresence:true,deviceName:'A'},friends:[]});
    fetchMock.mockResolvedValue({ok:true,json:async()=>({token:'f'.repeat(64)})});
    const create = vi.spyOn(browser.alarms,'create');
    let response: any;
    await handleAddFriendLink(r => { response = r; });
    expect(response.link).toContain('&t='+'f'.repeat(64));
    expect(response.link).not.toContain((await ensureIdentity()).privateKey.d);
    expect(store.get('friendInviteUntil')).toBeGreaterThan(Date.now());
    expect(create).toHaveBeenCalledWith('syncwatch-presence',expect.any(Object));
  });
  it('keeps a failed acceptance in the inbox so the user can retry', async () => {
    const store = mockStorage({settings:{serverUrl:'wss://h.dev'},friends:[],friendInbox:[{id:'a'.repeat(64),name:'A',serverUrl:'wss://h.dev',inviteToken:'f'.repeat(64),ts:1}]});
    fetchMock.mockResolvedValue({ok:false});
    await expect(handleAcceptFriend('a'.repeat(64))).rejects.toThrow('Не удалось принять');
    expect(store.get('friends')).toEqual([]);
    expect(store.get('friendInbox')).toHaveLength(1);
  });
  it('serializes simultaneous inbox updates instead of losing requests', async () => {
    const store = mockStorage({friends:[],friendInbox:[]});
    await Promise.all(['a','b'].map(x => handleFriendRequestIncoming({kind:'friend-request-incoming',id:x.repeat(64),name:x,serverUrl:'wss://h.dev',inviteToken:'f'.repeat(64)})));
    expect(store.get('friendInbox')).toHaveLength(2);
  });
  it('delivers status changes to content scripts in tabs, not runtime.sendMessage', async () => {
    mockStorage({friends:[],friendInbox:[]});
    vi.spyOn(browser.tabs,'query').mockResolvedValue([{id:10},{id:20}] as chrome.tabs.Tab[]);
    const send = vi.spyOn(browser.tabs,'sendMessage').mockResolvedValue(undefined);
    await pushFriendsStatus();
    expect(send).toHaveBeenCalledWith(10,expect.objectContaining({kind:'friends-status'}));
    expect(send).toHaveBeenCalledWith(20,expect.objectContaining({kind:'friends-status'}));
  });
  it('does not poll status when sharing is disabled', async () => {
    mockStorage({settings:{serverUrl:'wss://h.dev',sharePresence:false},friends:[friend('a')]});
    await tickPresence(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('stops polling after the first unused invitation expires', async () => {
    mockStorage({settings:{serverUrl:'wss://h.dev',sharePresence:true},friends:[],friendInviteUntil:Date.now()-1});
    const clear = vi.spyOn(browser.alarms,'clear');
    await tickPresence();
    expect(clear).toHaveBeenCalledWith('syncwatch-presence');
  });
  it('does not resurrect a removed friend when acknowledgement was lost', async () => {
    const store = mockStorage({settings:{serverUrl:'wss://h.dev',sharePresence:true},friends:[]});
    const message = {from:'a'.repeat(64),fromName:'A',kind:'accept',ts:123};
    fetchMock.mockImplementation(async (url: string) => ({ok:!url.endsWith('/ack'),json:async()=>({views:{},inbox:[message]})}));
    await pollPresence(); expect(store.get('friends')).toHaveLength(1);
    await handleRemoveFriend(message.from);
    await pollPresence(); expect(store.get('friends')).toEqual([]);
  });
});
