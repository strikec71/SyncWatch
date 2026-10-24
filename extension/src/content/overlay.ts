import { tr } from '../shared/i18n';
// Внутристраничная панель управления (островок) — единственный UI расширения.
// Плавающий виджет в Shadow DOM в верхнем фрейме. Содержит ВСЕ функции (бывший popup):
// комната, подключение, инвайт-ссылки, тумблеры, расширенные настройки, имя устройства,
// а с Фазы B — список участников (roster), соло/синхрон, выдача/запрос контроля и
// нотификатор обновлений. Показ/скрытие островка управляется настройкой overlayEnabled
// (тумблер — иконка расширения); см. content/index.ts. Крестика нет — только сворачивание.
//
// События: всплывающие ТОСТЫ (видны в любом состоянии, гаснут ~3.5с). Статус опрашиваем
// сами (poll) И принимаем push `status` от хаба; roster/контроль/обновления — push через
// tabs.sendMessage (все фреймы вкладки) → ловим runtime.onMessage.

import browser from '../shared/browser';
import { showFloatingLayer, removeFloatingLayer } from './floating-layer';
import { loadSettings, saveSettings, ensureDeviceName, type Settings } from '../shared/settings';
import type { StatusSnapshot, RuntimeMessage } from '../shared/messages';
import { friendlyCode, decideRowControls, detachButton, buildRosterRow, peersLabel } from './overlay-roster';
import { TEMPLATE } from './overlay-template';
import { OverlayChat } from './overlay-chat';
import { FriendsPanel } from './overlay-friends';
import { OverlayShell } from './overlay-shell';
import { bindTemplateLanguage, onLanguageChange, localizeError } from '../shared/i18n';

const COLLAPSED_KEY = 'syncwatch-overlay-collapsed';
const POLL_MS = 2000;
const TOAST_MS = 3600;     // сколько висит всплывающий тост (события + подсказки)
const MAX_ROWS = 10;       // потолок отображаемых участников

export class Overlay {
  private host: HTMLDivElement | null = null;
  private shadow: ShadowRoot | null = null;
  private pollTimer: number | null = null;
  private onMsg: ((msg: RuntimeMessage) => void) | null = null;
  private onStorage: Parameters<typeof browser.storage.onChanged.addListener>[0] | null = null;
  private chat: OverlayChat | null = null;         // чат-поверхность (кнопка 💬 + колесо + лог)
  private friends: FriendsPanel | null = null;     // раздел «Друзья» (presence, приглашения)
  private shell: OverlayShell | null = null;
  private videoAvailable = false;                  // есть ли видео на вкладке (подсказка компактного режима)
  private userExpandedCompact = false;             // пользователь развернул пилюлю вручную (тап по шапке)

  private myName = '';
  private last: StatusSnapshot | null = null;      // последний снимок (для кнопок)
  private requesting = new Set<number>();          // connId'ы гостей с висящим запросом контроля
  private mounted = false;
  private stopTemplateLanguage: (() => void) | null = null;
  private stopLanguage: (() => void) | null = null;

  private $(id: string): HTMLElement { return this.shadow!.getElementById(id)!; }
  private input(id: string): HTMLInputElement { return this.$(id) as HTMLInputElement; }

  async mount(): Promise<void> {
    if (this.host) return;

    const host = document.createElement('div');
    // popover → элемент в «top layer»: рендерится поверх любого фуллскрина (включая
    // кросс-доменный iframe плеера). Нейтрализуем дефолтные UA-стили попавера.
    host.setAttribute('popover', 'manual');
    host.dataset.syncwatchUi = '';
    this.mounted = true;
    // ВАЖНО: inset:auto идёт ДО top/right — иначе шорткат inset затирает офсеты (уезжает в угол).
    host.style.cssText =
      'position:fixed;inset:auto;margin:0;border:0;padding:0;background:transparent;' +
      'top:16px;right:16px;z-index:2147483647;pointer-events:auto;' +
      'max-width:none;max-height:none;overflow:visible;';
    this.shadow = host.attachShadow({ mode: 'closed' });
    this.shadow.innerHTML = TEMPLATE;
    this.host = host;

    // Заполнить настройки.
    const s = await loadSettings();
    this.myName = await ensureDeviceName();
    if (!this.mounted || this.host !== host) return;
    this.stopTemplateLanguage = bindTemplateLanguage(this.shadow!);
    (this.$('language') as HTMLSelectElement).value = s.language;
    this.$('language').addEventListener('change', () => {
      void saveSettings({ language: (this.$('language') as HTMLSelectElement).value as Settings['language'] }).catch(() => this.hint(tr('Не удалось сохранить настройки')));
    });
    this.input('room').value = s.room;
    this.input('serverUrl').value = s.serverUrl;
    this.input('drift').value = String(s.driftThreshold);
    this.input('dev').value = this.myName;
    this.input('auto').checked = s.autoConnect;
    this.input('share-presence').checked = s.sharePresence;

    this.$('c').addEventListener('click', async () => {
      const room = this.input('room').value.trim();
      if (!room) { this.hint(tr('Сначала задайте код комнаты')); return; }
      try { await this.persistForConnect(); } catch (e) { this.hint(String(e)); return; }
      this.sendConnect();
      window.setTimeout(() => void this.refresh(), 300);
    });
    this.$('d').addEventListener('click', () => {
      void browser.runtime.sendMessage({ kind: 'disconnect' }).catch(() => {});
      window.setTimeout(() => void this.refresh(), 300);
    });

    this.$('create').addEventListener('click', async () => {
      const code = friendlyCode();
      this.input('room').value = code;
      await saveSettings({ room: code });
      // Код комнаты — только договорённость об имени; без адреса сервера подключаться некуда.
      if (!this.input('serverUrl').value.trim()) {
        this.hint(tr`Комната «${code}» создана — укажите адрес сервера в «Настройках»`);
      } else {
        this.hint(tr('Код сгенерирован. Нажмите «Войти», затем «Позвать»'));
      }
    });

    this.$('invite').addEventListener('click', () => void this.copyInvite());

    // Соло ↔ Синхрон: одна кнопка, шлём set-mode с инвертированным detached.
    this.$('mode').addEventListener('click', () => {
      const detached = !(this.last?.detached);
      void browser.runtime.sendMessage({ kind: 'set-mode', detached }).catch(() => {});
      window.setTimeout(() => void this.refresh(), 200);
    });

    for (const id of ['room', 'serverUrl', 'drift', 'dev', 'auto', 'share-presence']) {
      this.$(id).addEventListener('change', () => { void this.persistField(id).catch(e => this.hint(String(e))); });
    }

    // Настройки глобальны на все вкладки: если их поменял другой островок / инвайт-ссылка,
    // подтягиваем в наши поля — иначе этот островок остаётся со старыми (пустыми) значениями
    // и при следующем persist затёр бы чужое. Поле в фокусе не трогаем (пользователь печатает).
    this.onStorage = (changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const next = changes.settings.newValue as Partial<Settings> | undefined;
      if (!next) return;
      // Room and server belong to this tab, never copy another tab's defaults here.
      this.syncField('drift', next.driftThreshold);
      this.syncField('auto', next.autoConnect);
      this.syncField('share-presence', next.sharePresence);
      if (next.deviceName) { this.myName = next.deviceName; this.syncField('dev', next.deviceName); }
      this.shell?.update(next);
      this.syncField('language', next.language);
    };
    browser.storage.onChanged.addListener(this.onStorage);

    this.$('m').addEventListener('click', () => this.toggleCollapsed());
    this.$('launcher').addEventListener('click', () => {
      if (!this.expandIfCompact()) this.toggleCollapsed();
    });
    this.enableDrag(host, this.$('h'));
    let collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { /* ignore */ }
    this.applyCollapsed(collapsed);

    // Чат-поверхность (кнопка 💬 в шапке + колесо + лог секции «Чат»). Лог подтягиваем
    // из сессии хаба (переживает ремаунт островка/перезагрузку вкладки).
    (this.$('update') as HTMLAnchorElement).href = `https://chromewebstore.google.com/detail/${browser.runtime.id}`;
    this.chat = new OverlayChat(this.shadow, (t) => this.hint(t));
    this.chat.loadLog();
    this.shell = new OverlayShell(this.shadow, host, s, () => this.chat?.resetUnreadIfVisible(), prefs => this.chat?.setAppearance(prefs), t => this.hint(t));

    // Раздел «Друзья» (presence, приглашения) — глобальные данные, приходят через
    // friends-status в onPush; список запрашиваем сразу.
    this.friends = new FriendsPanel(this.shadow, (t) => this.hint(t), (t, ok) => void this.copy(t, ok));
    this.friends.load();
    this.stopLanguage = onLanguageChange(() => {
      this.render(this.last); this.updateLauncher();
      this.$('m').title = this.shadow?.querySelector('.panel')?.classList.contains('collapsed') ? tr('Развернуть') : tr('Свернуть');
      this.friends?.refreshLanguage(); this.chat?.refreshLanguage();
    });

    this.onMsg = (msg) => this.onPush(msg);
    browser.runtime.onMessage.addListener(this.onMsg);

    document.documentElement.appendChild(host);
    this.showInTopLayer();

    void this.refresh();
    this.recomputeCompact();
    this.pollTimer = window.setInterval(() => { void this.refresh(); }, POLL_MS);
  }

  /** Подсказка из content/index.ts: есть ли на вкладке видео. Влияет только на компактную
   *  «пилюлю» (нет видео И не подключены → узкий вид). Не условие монтирования. */
  setVideoAvailable(available: boolean): void {
    if (available === this.videoAvailable) return;
    this.videoAvailable = available;
    if (available) this.userExpandedCompact = false; // видео пришло — вернёмся к обычному виду
    this.recomputeCompact();
  }

  /** Пилюля ↔ полный вид. Авто-состояние `.compact`, НЕ трогает ручной `.collapsed`. */
  private recomputeCompact(): void {
    const panel = this.shadow?.querySelector('.panel');
    if (!panel) return;
    const auto = !this.videoAvailable && !this.last?.connected; // «по смыслу свёрнуто в пилюлю»
    if (!auto) this.userExpandedCompact = false;                // видео/подключение — пилюля не нужна
    panel.classList.toggle('compact', auto && !this.userExpandedCompact);
    this.updateLauncher();
  }

  /** Тап по шапке в режиме пилюли — развернуть (не тащить). Возвращает true, если сработало. */
  private expandIfCompact(): boolean {
    if (!this.shadow?.querySelector('.panel')?.classList.contains('compact')) return false;
    this.userExpandedCompact = true;
    this.applyCollapsed(false);
    this.recomputeCompact();
    return true;
  }

  /** Push от хаба для вкладки: статус, события, запрос контроля, доступное обновление. */
  private onPush(msg: RuntimeMessage): void {
    switch (msg?.kind) {
      case 'event': this.toast(msg.text, false); break;
      case 'status': this.render(msg); break; // мгновенное обновление roster без ожидания poll
      case 'control-request': this.onControlRequest(msg.from, msg.name); break;
      case 'chat': this.chat?.onChat(msg.entry); break;
      case 'friends-status': this.friends?.onStatus(msg.friends, msg.inbox); break;
    }
  }

  /** Показать/пере-показать островок в top layer (popover). Грейсфул для старых браузеров. */
  private showInTopLayer(): void {
    if (this.host) showFloatingLayer(this.host, 0, this.shadow);
  }

  /** Снять островок (когда overlayEnabled выключен тумблером на иконке). */
  unmount(): void {
    this.stopTemplateLanguage?.(); this.stopTemplateLanguage = null;
    this.stopLanguage?.(); this.stopLanguage = null;
    this.shell?.destroy(); this.shell = null;
    this.chat?.destroy(); this.chat = null;
    this.friends = null; // без глобальных слушателей/таймеров — уходит вместе с shadow
    this.mounted = false;

    if (this.pollTimer) { window.clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.onMsg) { browser.runtime.onMessage.removeListener(this.onMsg); this.onMsg = null; }
    if (this.onStorage) { browser.storage.onChanged.removeListener(this.onStorage); this.onStorage = null; }
    if (this.host) removeFloatingLayer(this.host);
    this.host?.remove();
    this.host = null;
    this.shadow = null;
  }

  /** Сохранить ТОЛЬКО изменённое поле. Раньше писались все поля разом — устаревший
   *  островок другой вкладки (с пустым serverUrl в инпуте) затирал сохранённый сервер
   *  при любом change/создании комнаты. Это был баг «сервер сбрасывается». */
  private async persistField(id: string): Promise<void> {
    switch (id) {
      case 'room':
        await saveSettings({ room: this.input('room').value.trim() });
        return;
      case 'serverUrl':
        await saveSettings({ serverUrl: this.input('serverUrl').value.trim() });
        return;
      case 'drift':
        await saveSettings({ driftThreshold: parseFloat(this.input('drift').value) || 1.0 });
        return;
      case 'dev':
        this.myName = this.input('dev').value.trim() || this.myName;
        await saveSettings({ deviceName: this.myName });
        return;
      case 'auto':
        await saveSettings({ autoConnect: this.input('auto').checked });
        return;
      case 'share-presence':
        // background's storage.onChanged сам пере-взводит/гасит presence-аларм.
        await saveSettings({ sharePresence: this.input('share-presence').checked });
        return;
    }
  }

  /** Перед «Подключиться»: сохранить комнату и НЕПУСТОЙ сервер (пустой не пишем — не затираем
   *  сохранённый адрес, если это поле в данной вкладке ещё не заполнялось). */
  private async persistForConnect(): Promise<void> {
    await saveSettings({ room: this.input('room').value.trim() });
    const server = this.input('serverUrl').value.trim();
    if (server) await saveSettings({ serverUrl: server });
  }

  /** Подтянуть значение поля из настроек (изменённых другой вкладкой), не трогая фокус. */
  private syncField(id: string, value: string | number | boolean | undefined): void {
    if (value === undefined || !this.shadow) return;
    const el = this.input(id);
    if (this.shadow.activeElement === el) return; // пользователь печатает — не мешаем
    if (typeof value === 'boolean') el.checked = value;
    else el.value = String(value);
  }

  /** «Пригласить» = ссылка на текущее видео с кодом комнаты И сервером (#syncwatch=…&s=…).
   *  Сервер обязателен: без него у приглашённого с чистой установкой подключаться некуда
   *  (дефолтного публичного релея нет) — это был баг «ссылка не подключает». */
  private async copyInvite(): Promise<void> {
    const room = this.last?.room || this.input('room').value.trim();
    if (!room) { this.hint(tr('Сначала задайте комнату')); return; }
    const server = this.last?.serverUrl || this.input('serverUrl').value.trim();
    if (!server) { this.hint(tr('Укажите адрес сервера в «Настройках» — без него приглашение не сработает')); return; }

    const link =
      `${location.href.split('#')[0]}#syncwatch=${encodeURIComponent(room)}` +
      `&s=${encodeURIComponent(server)}`;
    await this.copy(link, tr('Ссылка-приглашение скопирована'));
  }

  private async copy(text: string, ok: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); this.hint(ok); }
    catch { this.hint(tr('Скопируйте вручную: ') + text); }
  }

  /** Подсказка/подтверждение действия — акцентный тост. */
  private hint(text: string): void { this.toast(text, true); }

  private toggleCollapsed(): void {
    const next = !this.shadow!.querySelector('.panel')!.classList.contains('collapsed');
    this.applyCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  }

  private applyCollapsed(collapsed: boolean): void {
    this.shadow!.querySelector('.panel')!.classList.toggle('collapsed', collapsed);
    const btn = this.$('m');
    btn.title = collapsed ? tr('Развернуть') : tr('Свернуть');
    this.updateLauncher();
    this.shell?.keepInView();
    if (collapsed) this.$('launcher').focus({ preventScroll: true });
    if (!collapsed) this.chat?.resetUnreadIfVisible(); // разворот панели = чат прочитан
  }

  private updateLauncher(): void {
    if (!this.shadow) return;
    const panel = this.shadow.querySelector('.panel')!;
    const small = panel.classList.contains('collapsed') || panel.classList.contains('compact');
    const launcher = this.$('launcher');
    const label = small ? tr('Открыть SyncWatch') : tr('Свернуть SyncWatch');
    launcher.setAttribute('aria-expanded', String(!small));
    launcher.setAttribute('aria-label', label); launcher.title = label;
    this.$('panel-body').toggleAttribute('inert', small);
  }

  /** Отправить connect с комнатой ЭТОЙ вкладки (room per-tab едет в сообщении).
   *  Ошибку от background (нет сервера/комнаты) показываем тостом — раньше ответ молча
   *  игнорировался, и «Подключиться» без сервера выглядело как «ничего не произошло». */
  private sendConnect(): void {
    const room = this.input('room').value.trim();
    if (!room) return;
    const serverUrl = this.input('serverUrl').value.trim() || undefined;
    void browser.runtime
      .sendMessage({ kind: 'connect', room, serverUrl })
      .then((r: unknown) => {
        const res = r as { ok?: boolean; error?: string } | undefined;
        if (res && res.ok === false && res.error) {
          this.hint(res.error);
        }
      })
      .catch(() => {});
  }

  private async refresh(): Promise<void> {
    const st = (await browser.runtime.sendMessage({ kind: 'get-status' }).catch(() => null)) as
      | StatusSnapshot
      | null;
    this.render(st);
  }

  private render(st: StatusSnapshot | null): void {
    if (!this.shadow) return;
    this.last = st;
    this.recomputeCompact(); // подключение/отключение меняет право на «пилюлю»
    this.$('update').style.display = st?.updateVersion ? '' : 'none';
    this.$('update').textContent = st?.updateVersion ? tr`Доступна версия ${st.updateVersion}` : '';

    const connected = !!st?.connected;
    if (st?.room) this.syncField('room', st.room);
    if (st?.serverUrl) this.syncField('serverUrl', st.serverUrl);
    const active = connected || st?.phase === 'connecting' || st?.phase === 'retrying';
    (this.$('c') as HTMLElement).style.display = active ? 'none' : '';
    (this.$('d') as HTMLElement).style.display = active ? '' : 'none';
    this.input('room').readOnly = active; this.input('serverUrl').readOnly = active;
    (this.$('create') as HTMLButtonElement).disabled = active;

    let dot = 'off';
    let text = tr('Не подключено');
    if (st?.connected && st.peerPresent) { dot = 'on'; text = tr('Синхрон включён · смотрим вместе'); }
    else if (st?.connected) { dot = 'wait'; text = tr('Вы в комнате · ждём друзей'); }
    if (st?.detached) { dot = 'wait'; text = tr('Режим соло · смотрите в своём темпе'); }
    if (st?.phase === 'connecting') { dot = 'wait'; text = tr('Подключаемся…'); }
    if (st?.phase === 'retrying') { dot = 'wait'; text = tr('Связь потеряна — повторяем подключение…'); }
    if (st?.error) { dot = 'wait'; text = localizeError(st.error); }
    if (st?.contentMismatch) { dot = 'wait'; text = tr('Контент не совпадает — выберите серию комнаты или включите соло'); }

    this.$('dot').setAttribute('data-state', dot);
    this.$('launcher-dot').setAttribute('data-state', dot);
    this.$('sync').setAttribute('data-state', dot);   // сигнатурная линия связи
    this.$('s').textContent = text;
    this.$('session-title').textContent = connected ? tr('Хорошая компания') : tr('Ваша комната');
    this.$('participant-count').textContent = connected ? `${peersLabel(st!.peers.length)} / 10` : tr('До 10 участников');
    this.$('session-role').textContent = connected ? (st?.amHost ? tr('Вы — хост') : st?.amController ? tr('Есть управление') : tr('Вы — зритель')) : tr('Без аккаунта');
    this.$('room-role-hint').textContent = connected ? (st!.peers.length <= 2 ? tr('Управление общее') : tr('Управляет хост / контроллер')) : tr('Один контент у всех');

    this.renderRoster(st);
    this.renderMode(st);
    this.chat?.setStatus(st);
  }

  /** Список участников (≤10). Имена — только textContent (см. buildRosterRow). */
  private renderRoster(st: StatusSnapshot | null): void {
    const box = this.$('roster');
    box.textContent = '';
    const peers = st?.peers ?? [];
    if (!st?.connected || peers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'prow empty';
      empty.textContent = st?.connected ? tr('Пока вы здесь одни. Пригласите друга по ссылке.') : tr('Откройте одно видео с друзьями и подключитесь к комнате.');
      box.appendChild(empty);
      return;
    }
    // Снять отработавшие запросы: участник ушёл или уже получил контроль.
    for (const id of [...this.requesting]) {
      const p = peers.find((x) => x.id === id);
      if (!p || p.hasControl) this.requesting.delete(id);
    }
    for (const peer of peers.slice(0, MAX_ROWS)) {
      const ctl = decideRowControls(st, peer.id);
      box.appendChild(buildRosterRow(peer, ctl, this.requesting.has(peer.id), {
        onGrantToggle: (id, grant) => this.setControl(id, grant),
        onRequest: () => this.requestControl(),
      }));
    }
  }

  /** Кнопка Соло/Синхрон: видна только когда есть с кем синхронизироваться (≥2 в комнате). */
  private renderMode(st: StatusSnapshot | null): void {
    const btn = this.$('mode');
    const active = !!st?.connected && (st?.peers.length ?? 0) >= 2;
    btn.style.display = active ? '' : 'none';
    const d = detachButton(!!st?.detached);
    btn.textContent = d.label;
    btn.title = d.title;
    btn.classList.toggle('solo', !!st?.detached);
  }

  private setControl(target: number, grant: boolean): void {
    void browser.runtime
      .sendMessage({ kind: 'set-control', action: grant ? 'grant' : 'revoke', target })
      .catch(() => {});
    if (grant) this.requesting.delete(target);
    window.setTimeout(() => void this.refresh(), 200);
  }

  private requestControl(): void {
    void browser.runtime.sendMessage({ kind: 'request-control' }).catch(() => {});
    this.hint(tr('Запрос отправлен хосту'));
  }

  /** Host получил запрос контроля: тост + подсветка строки (кнопка «Контроль» уже на ней). */
  private onControlRequest(from: number, name: string): void {
    this.requesting.add(from);
    this.toast(tr`${name || tr('Гость')} просит управление`, true);
    void this.refresh();
  }

  /** Единый показ эфемерного сообщения: события (нейтральные) и подсказки (accent). */
  private toast(text: string, accent: boolean): void {
    if (!this.shadow) return;
    const toasts = this.$('toasts');
    const el = document.createElement('div');
    el.className = accent ? 'toast accent' : 'toast';
    el.textContent = text;
    toasts.appendChild(el);
    window.setTimeout(() => el.remove(), TOAST_MS);
    while (toasts.childElementCount > 3) toasts.firstElementChild?.remove();
  }

  /** Перетаскивание панели за заголовок (клики по кнопкам заголовка не двигают). */
  private enableDrag(host: HTMLElement, handle: HTMLElement): void {
    let startX = 0, startY = 0, baseLeft = 0, baseTop = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (this.expandIfCompact()) return; // в пилюле тап по шапке разворачивает, не тащит
      dragging = true;
      const rect = host.getBoundingClientRect();
      baseLeft = rect.left; baseTop = rect.top;
      startX = e.clientX; startY = e.clientY;
      host.style.right = 'auto';
      host.style.left = `${baseLeft}px`;
      host.style.top = `${baseTop}px`;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      host.style.left = `${Math.max(0, Math.min(window.innerWidth - host.offsetWidth, baseLeft + e.clientX - startX))}px`;
      host.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, baseTop + e.clientY - startY))}px`;
    });
    handle.addEventListener('pointerup', (e) => {
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    });
  }
}

