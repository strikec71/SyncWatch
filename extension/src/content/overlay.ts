// Внутристраничная панель управления (островок) — единственный UI расширения.
// Плавающий виджет в Shadow DOM в верхнем фрейме. Содержит ВСЕ функции (бывший popup):
// комната, подключение, инвайт-ссылки, тумблеры, расширенные настройки, имя устройства,
// а с Фазы B — список участников (roster), соло/синхрон, выдача/запрос контроля и
// нотификатор обновлений. Показ/скрытие островка управляется настройкой overlayEnabled
// (тумблер — иконка расширения); см. content/index.ts. Крестика нет — только сворачивание.
//
// События: всплывающие ТОСТЫ (видны в любом состоянии, гаснут ~3.5с). Статус опрашиваем
// сами (poll) И принимаем push `status` от хаба; roster/контроль/обновления — push через
// tabs.sendMessage(frame 0) → ловим runtime.onMessage.

import browser from '../shared/browser';
import { loadSettings, saveSettings, ensureDeviceName } from '../shared/settings';
import type { StatusSnapshot, RuntimeMessage } from '../shared/messages';
import { friendlyCode, decideRowControls, detachButton, buildRosterRow } from './overlay-roster';
import { TEMPLATE } from './overlay-template';

const COLLAPSED_KEY = 'syncwatch-overlay-collapsed';
const POLL_MS = 2000;
const TOAST_MS = 3600;     // сколько висит всплывающий тост (события + подсказки)
const MAX_ROWS = 10;       // потолок отображаемых участников

export class Overlay {
  private host: HTMLDivElement | null = null;
  private shadow: ShadowRoot | null = null;
  private pollTimer: number | null = null;
  private onMsg: ((msg: RuntimeMessage) => void) | null = null;
  private onFsChange: (() => void) | null = null;
  private myName = '';
  private last: StatusSnapshot | null = null;      // последний снимок (для кнопок)
  private requesting = new Set<number>();          // connId'ы гостей с висящим запросом контроля

  private $(id: string): HTMLElement { return this.shadow!.getElementById(id)!; }
  private input(id: string): HTMLInputElement { return this.$(id) as HTMLInputElement; }

  async mount(): Promise<void> {
    if (this.host) return;

    const host = document.createElement('div');
    // popover → элемент в «top layer»: рендерится поверх любого фуллскрина (включая
    // кросс-доменный iframe плеера). Нейтрализуем дефолтные UA-стили попавера.
    host.setAttribute('popover', 'manual');
    // ВАЖНО: inset:auto идёт ДО top/right — иначе шорткат inset затирает офсеты (уезжает в угол).
    host.style.cssText =
      'position:fixed;inset:auto;margin:0;border:0;padding:0;background:transparent;' +
      'top:16px;right:16px;z-index:2147483647;pointer-events:auto;' +
      'max-width:none;max-height:none;overflow:visible;';
    this.shadow = host.attachShadow({ mode: 'open' });
    this.shadow.innerHTML = TEMPLATE;
    this.host = host;

    // Заполнить настройки.
    const s = await loadSettings();
    this.myName = await ensureDeviceName();
    this.input('room').value = s.room;
    this.input('serverUrl').value = s.serverUrl;
    this.input('drift').value = String(s.driftThreshold);
    this.input('dev').value = this.myName;
    this.input('auto').checked = s.autoConnect;

    this.$('c').addEventListener('click', async () => {
      await this.persist();
      void browser.runtime.sendMessage({ kind: 'connect' }).catch(() => {});
      window.setTimeout(() => void this.refresh(), 300);
    });
    this.$('d').addEventListener('click', () => {
      void browser.runtime.sendMessage({ kind: 'disconnect' }).catch(() => {});
      window.setTimeout(() => void this.refresh(), 300);
    });

    this.$('create').addEventListener('click', async () => {
      this.input('room').value = friendlyCode();
      await this.persist();
      this.hint(`Комната «${this.input('room').value}» создана`);
    });

    this.$('invite').addEventListener('click', () => void this.copyInvite());

    // Соло ↔ Синхрон: одна кнопка, шлём set-mode с инвертированным detached.
    this.$('mode').addEventListener('click', () => {
      const detached = !(this.last?.detached);
      void browser.runtime.sendMessage({ kind: 'set-mode', detached }).catch(() => {});
      window.setTimeout(() => void this.refresh(), 200);
    });

    // Нотификатор обновлений: в dev-mode авто-скачивания нет — подсказываем перезагрузить.
    this.$('upd').addEventListener('click', () => {
      this.hint('Обновите расширение: chrome://extensions → «Обновить»');
    });

    for (const id of ['room', 'serverUrl', 'drift', 'dev', 'auto']) {
      this.$(id).addEventListener('change', () => void this.persist());
    }

    this.$('m').addEventListener('click', () => this.toggleCollapsed());
    this.enableDrag(host, this.$('h'));
    let collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { /* ignore */ }
    this.applyCollapsed(collapsed);

    this.onMsg = (msg) => this.onPush(msg);
    browser.runtime.onMessage.addListener(this.onMsg);

    document.documentElement.appendChild(host);
    this.showInTopLayer();

    // При входе/выходе из фуллскрина пере-стекаем попавер ПОВЕРХ нового
    // фуллскрин-элемента (иначе он окажется выше попавера и скроет островок).
    this.onFsChange = () => this.showInTopLayer();
    document.addEventListener('fullscreenchange', this.onFsChange);
    document.addEventListener('webkitfullscreenchange', this.onFsChange);

    void this.refresh();
    this.pollTimer = window.setInterval(() => { void this.refresh(); this.keepOnTop(); }, POLL_MS);
  }

  /** Push от хаба (frame 0): статус, события, запрос контроля, доступное обновление. */
  private onPush(msg: RuntimeMessage): void {
    switch (msg?.kind) {
      case 'event': this.toast(msg.text, false); break;
      case 'status': this.render(msg); break; // мгновенное обновление roster без ожидания poll
      case 'control-request': this.onControlRequest(msg.from, msg.name); break;
      case 'update-available': this.onUpdateAvailable(msg.version); break;
    }
  }

  /** Показать/пере-показать островок в top layer (popover). Грейсфул для старых браузеров. */
  private showInTopLayer(): void {
    const host = this.host as (HTMLElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!host || typeof host.showPopover !== 'function') return;
    try { host.hidePopover?.(); } catch { /* не был показан */ }
    try { host.showPopover(); } catch { /* уже показан / не подключён */ }
  }

  /** Периодически возвращаем островок на самый верх top-layer: сайт мог открыть СВОЙ
   *  popover/<dialog>/fullscreen ПОСЛЕ нас. Не дёргаем, если пользователь печатает. */
  private keepOnTop(): void {
    const ae = this.shadow?.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    this.showInTopLayer();
  }

  /** Снять островок (когда overlayEnabled выключен тумблером на иконке). */
  unmount(): void {
    if (this.pollTimer) { window.clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.onMsg) { browser.runtime.onMessage.removeListener(this.onMsg); this.onMsg = null; }
    if (this.onFsChange) {
      document.removeEventListener('fullscreenchange', this.onFsChange);
      document.removeEventListener('webkitfullscreenchange', this.onFsChange);
      this.onFsChange = null;
    }
    this.host?.remove();
    this.host = null;
    this.shadow = null;
  }

  private async persist(): Promise<void> {
    this.myName = this.input('dev').value.trim() || this.myName;
    await saveSettings({
      room: this.input('room').value.trim(),
      serverUrl: this.input('serverUrl').value.trim(),
      driftThreshold: parseFloat(this.input('drift').value) || 1.0,
      deviceName: this.myName,
      autoConnect: this.input('auto').checked,
    });
  }

  /** «Позвать» = ссылка на текущее видео с кодом комнаты (#syncwatch=…). Открывается прямо
   *  на странице плеера и подключает партнёра к той же комнате. */
  private async copyInvite(): Promise<void> {
    const room = this.input('room').value.trim();
    if (!room) { this.hint('Сначала задайте комнату'); return; }
    const link = `${location.href.split('#')[0]}#syncwatch=${encodeURIComponent(room)}`;
    await this.copy(link, 'Ссылка-приглашение скопирована');
  }

  private async copy(text: string, ok: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); this.hint(ok); }
    catch { this.hint('Скопируйте вручную: ' + text); }
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
    btn.textContent = collapsed ? '▸' : '▾';
    btn.title = collapsed ? 'Развернуть' : 'Свернуть';
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
    const connected = !!st?.connected;
    (this.$('c') as HTMLElement).style.display = connected ? 'none' : '';
    (this.$('d') as HTMLElement).style.display = connected ? '' : 'none';

    let dot = 'off';
    let text = 'Не подключено';
    if (st?.connected && st.peerPresent) { dot = 'on'; text = `«${st.room}» · на связи`; }
    else if (st?.connected) { dot = 'wait'; text = `«${st.room}» · ждём…`; }
    this.$('dot').setAttribute('data-state', dot);
    this.$('sync').setAttribute('data-state', dot);   // сигнатурная линия связи
    this.$('s').textContent = text;

    this.renderRoster(st);
    this.renderMode(st);
  }

  /** Список участников (≤10). Имена — только textContent (см. buildRosterRow). */
  private renderRoster(st: StatusSnapshot | null): void {
    const box = this.$('roster');
    box.textContent = '';
    const peers = st?.peers ?? [];
    if (!st?.connected || peers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'prow empty';
      empty.textContent = 'ждём…';
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
    this.hint('Запрос отправлен хосту');
  }

  /** Host получил запрос контроля: тост + подсветка строки (кнопка «Контроль» уже на ней). */
  private onControlRequest(from: number, name: string): void {
    this.requesting.add(from);
    this.toast(`${name || 'Гость'} просит управление`, true);
    void this.refresh();
  }

  /** Доступна новая сборка: ненавязчивая плашка с версией и кнопкой «Обновить». */
  private onUpdateAvailable(version: string): void {
    if (!this.shadow) return;
    this.$('uver').textContent = `v${version}`;
    (this.$('update') as HTMLElement).style.display = '';
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
      host.style.left = `${baseLeft + (e.clientX - startX)}px`;
      host.style.top = `${baseTop + (e.clientY - startY)}px`;
    });
    handle.addEventListener('pointerup', (e) => {
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    });
  }
}

