// Раздел «Друзья» островка (Фаза «друзья + presence»). Вынесен из overlay.ts, чтобы
// держать оба файла < 500 строк и дать tester'у юнит-тест логики без DOM-обвязки панели.
//
// Две части:
//   • чистые билдеры строк (buildFriendsSection / friendsOnlineCount) — имена ТОЛЬКО через
//     textContent (untrusted: приходят из ссылки-приглашения и с сервера presence);
//   • FriendsPanel — тонкий контроллер (как OverlayChat): кнопка «Добавить друга»,
//     запрос списка, рендер, отправка accept/decline/remove/join в background.
//
// Данные ГЛОБАЛЬНЫ (не per-tab): background рассылает `friends-status` через
// browser.runtime.sendMessage; overlay.ts форвардит его сюда из onPush.

import browser from '../shared/browser';
import type { FriendRow, InboxRow, RuntimeMessage } from '../shared/messages';

export interface FriendsData {
  friends: FriendRow[];
  inbox: InboxRow[];
}

export interface FriendsCallbacks {
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  onRemove: (id: string) => void;
  onJoin: (id: string) => void;
}

/** Сколько друзей сейчас онлайн/смотрят — для бейджа пилюли. */
export function friendsOnlineCount(data: FriendsData): number {
  return data.friends.filter((f) => f.status !== 'offline').length;
}

/** Подпись под именем друга по статусу. */
export function subLabel(status: FriendRow['status']): string {
  return status === 'watching' ? 'смотрит' : status === 'online' ? 'онлайн' : 'не в сети';
}

/** Содержимое раздела: блок входящих запросов сверху + список друзей. Имена — textContent. */
export function buildFriendsSection(data: FriendsData, cb: FriendsCallbacks): DocumentFragment {
  const frag = document.createDocumentFragment();

  for (const req of data.inbox) frag.appendChild(buildInboxRow(req, cb));

  if (data.friends.length === 0) {
    if (data.inbox.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'frow empty';
      empty.textContent = 'друзей пока нет — «Добавить друга» создаст ссылку';
      frag.appendChild(empty);
    }
    return frag;
  }

  for (const f of data.friends) frag.appendChild(buildFriendRow(f, cb));
  return frag;
}

function buildInboxRow(req: InboxRow, cb: FriendsCallbacks): HTMLElement {
  const row = document.createElement('div');
  row.className = 'frow frq';

  const text = document.createElement('span');
  text.className = 'fname';
  text.textContent = `${req.name || 'Кто-то'} хочет добавить вас`; // ← textContent ONLY

  row.append(
    text,
    miniBtn('Принять', () => cb.onAccept(req.id), true),
    miniBtn('Отклонить', () => cb.onDecline(req.id), false),
  );
  return row;
}

function buildFriendRow(f: FriendRow, cb: FriendsCallbacks): HTMLElement {
  const row = document.createElement('div');
  row.className = 'frow';

  const dot = document.createElement('i');
  dot.className = 'fdot';
  dot.setAttribute('data-state', f.status);

  const name = document.createElement('span');
  name.className = 'fname';
  name.textContent = f.name || 'друг'; // ← textContent ONLY

  const sub = document.createElement('span');
  sub.className = 'fsub';
  sub.textContent = subLabel(f.status);

  row.append(dot, name, sub);

  if (f.status === 'watching') row.appendChild(miniBtn('Войти', () => cb.onJoin(f.id), true));

  const rm = miniBtn('✕', () => cb.onRemove(f.id), false);
  rm.classList.add('frm');
  rm.title = 'Удалить из друзей';
  row.appendChild(rm);
  return row;
}

function miniBtn(label: string, onClick: () => void, accent: boolean): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn micro' + (accent ? ' on' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// ── Контроллер раздела ───────────────────────────────────────────────────────

export class FriendsPanel {
  private data: FriendsData = { friends: [], inbox: [] };

  constructor(
    private shadow: ShadowRoot,
    private hint: (text: string) => void,
    private copy: (text: string, ok: string) => void,
  ) {
    this.$('friend-add').addEventListener('click', () => void this.addLink());
    this.render();
  }

  private $(id: string): HTMLElement { return this.shadow.getElementById(id)!; }

  /** Запросить актуальный список при маунте (background также кикнёт presence-тик). */
  load(): void {
    void browser.runtime
      .sendMessage({ kind: 'get-friends' })
      .then((r: unknown) => {
        const d = r as Partial<FriendsData> | undefined;
        this.data = { friends: d?.friends ?? [], inbox: d?.inbox ?? [] };
        this.render();
      })
      .catch(() => { /* SW перезапускается — придёт friends-status */ });
  }

  /** Push `friends-status` от background (через overlay.onPush). */
  onStatus(friends: FriendRow[], inbox: InboxRow[]): void {
    this.data = { friends, inbox };
    this.render();
  }

  /** Друзей онлайн — для бейджа пилюли (overlay.ts дёргает при рендере статуса). */
  onlineCount(): number { return friendsOnlineCount(this.data); }

  private render(): void {
    const box = this.$('friends');
    box.textContent = '';
    box.appendChild(buildFriendsSection(this.data, {
      onAccept: (id) => this.send({ kind: 'accept-friend', id }),
      onDecline: (id) => this.send({ kind: 'decline-friend', id }),
      onRemove: (id) => this.send({ kind: 'remove-friend', id }),
      onJoin: (id) => this.send({ kind: 'join-friend', id }),
    }));
    this.renderBadge();
  }

  private renderBadge(): void {
    const n = this.onlineCount();
    const b = this.$('fbadge');
    b.hidden = n <= 0;
    b.textContent = String(n);
    b.title = `Друзей онлайн: ${n}`;
  }

  /** Мутации — fire-and-forget: background рассылает свежий `friends-status` после каждой. */
  private send(msg: RuntimeMessage): void {
    void browser.runtime.sendMessage(msg).catch(() => {});
  }

  private async addLink(): Promise<void> {
    const r = (await browser.runtime
      .sendMessage({ kind: 'add-friend-link' })
      .catch(() => null)) as { link?: string; error?: string } | null;
    if (r?.link) this.copy(r.link, 'Ссылка для друга скопирована');
    else this.hint(r?.error || 'Не удалось создать ссылку — укажите адрес сервера в «Настройках»');
  }
}
