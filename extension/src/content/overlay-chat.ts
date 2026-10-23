// Чат-поверхность островка (Фаза 0.7.0). Вынесена из overlay.ts, чтобы держать оба файла
// < 500 строк. Отвечает за: кнопку 💬 в шапке + радиальное колесо (chatwheel), лог сообщений
// в секции «Чат», бейдж непрочитанных и disabled-состояние вне подключения.
//
// ⚠️ XSS: имя и текст сообщений рендерятся ТОЛЬКО через textContent (untrusted). Будущий
// свободный текст — тем же правилом. Время строки — ЛОКАЛЬНЫЕ часы (entry.ts штампует хаб).

import browser from '../shared/browser';
import type { StatusSnapshot, ChatEntry } from '../shared/messages';
import { quickMessageByCode, CHAT_COOLDOWN_MS, CHAT_LOG_MAX } from '../shared/quick-messages';
import { ChatWheel } from './chatwheel';

/** Видимый текст сообщения из кода каталога и/или свободного текста. */
function renderContent(entry: ChatEntry): string {
  const parts: string[] = [];
  if (entry.code) {
    const qm = quickMessageByCode(entry.code);
    if (qm) parts.push(`${qm.emoji} ${qm.text}`);
  }
  if (entry.text) parts.push(entry.text);
  return parts.join(' ');
}

/** Локальные часы получателя → HH:MM. */
function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export class OverlayChat {
  private wheel: ChatWheel;
  private connected = false;
  private unread = 0;
  private cooldownUntil = 0;
  private sending = false;
  private destroyed = false;
  private loading = false;
  private draftTouched = false;
  private pending: ChatEntry[] = [];
  private onToggle: () => void;

  constructor(
    private shadow: ShadowRoot,
    private hint: (text: string) => void,
  ) {
    this.wheel = new ChatWheel((code) => this.pick(code));
    this.$('chatinput').addEventListener('input', () => { this.draftTouched = true; this.saveDraft(); });
    this.$('chatsend').addEventListener('click', () => void this.sendText());
    this.$('chatinput').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void this.sendText(); }
    });
    this.$('chat-open').addEventListener('click', () => this.toggleWheel());
    // Раскрытие секции «Чат» — прочитано: сбрасываем счётчик непрочитанных.
    this.onToggle = () => this.resetUnreadIfVisible();
    this.$('chatbox').addEventListener('toggle', this.onToggle);
  }

  private $(id: string): HTMLElement { return this.shadow.getElementById(id)!; }

  private toggleWheel(): void {
    if (!this.connected) { this.hint('Подключитесь, чтобы отправлять сообщения'); return; }
    if (this.wheel.isOpen) this.wheel.close();
    else this.wheel.open();
  }

  /** Выбор фразы в колесе → отправка (с UI-кулдауном; бэкграунд гейтит повторно). */
  private pick(code: string): void {
    void this.send({ kind: 'send-quick-message', code });
  }
  private async sendText(): Promise<void> {
    const input = this.$('chatinput') as HTMLInputElement;
    const text = input.value;
    if (!text.trim() || text.length > 200) { this.hint('Введите от 1 до 200 символов'); return; }
    if (await this.send({ kind: 'send-text-message', text }) && input.value === text) { input.value = ''; this.saveDraft(); }
  }
  private saveDraft(): void {
    const text = (this.$('chatinput') as HTMLInputElement).value;
    void browser.runtime.sendMessage({kind:'set-chat-draft',text}).catch(() => {});
  }
  private async send(message: { kind: 'send-quick-message'; code: string } | { kind: 'send-text-message'; text: string }): Promise<boolean> {
    if (this.sending || Date.now() < this.cooldownUntil) { this.hint('Подождите секунду перед следующим сообщением'); return false; }
    this.sending = true;
    try {
      const response = await browser.runtime.sendMessage(message) as { ok?: boolean; error?: string } | undefined;
      if (this.destroyed) return false;
      if (!response?.ok) { this.hint(response?.error || 'Не удалось отправить сообщение'); return false; }
      this.cooldownUntil = Date.now() + CHAT_COOLDOWN_MS;
      return true;
    } catch { if (!this.destroyed) this.hint('Соединение прервано — повторите отправку'); return false; }
    finally { this.sending = false; }
  }

  /** Подтянуть лог сессии при маунте (переживает ремаунт островка/перезагрузку вкладки). */
  loadLog(): void {
    this.loading = true;
    void browser.runtime
      .sendMessage({ kind: 'get-chat-log' })
      .then((r: unknown) => {
        const entries = (r as { entries?: ChatEntry[] } | undefined)?.entries ?? [];
        if (this.destroyed) return;
        if (!this.draftTouched) (this.$('chatinput') as HTMLInputElement).value = (r as {draft?:string})?.draft || '';
        const counts = new Map<string, number>();
        for (const e of entries) { this.appendRow(e); const key = JSON.stringify(e); counts.set(key, (counts.get(key) || 0) + 1); }
        for (const e of this.pending) {
          const key = JSON.stringify(e), count = counts.get(key) || 0;
          if (count) counts.set(key, count - 1); else this.appendRow(e);
        }
        this.pending = []; this.loading = false;
      })
      .catch(() => { if (!this.destroyed) for (const entry of this.pending) this.appendRow(entry); this.pending = []; this.loading = false; });
  }

  /** Новая строка чата (push от хаба). Непрочитанные растут, только если строка не наша
   *  и чат сейчас не виден (свёрнут островок ИЛИ закрыта секция «Чат»). */
  onChat(entry: ChatEntry): void {
    if (this.destroyed) return;
    if (this.loading) this.pending.push(entry); else this.appendRow(entry);
    if (!entry.self && !this.isVisible()) { this.unread++; this.renderBadge(); }
  }

  private appendRow(entry: ChatEntry): void {
    const log = this.$('chatlog');
    const content = renderContent(entry);
    if (!content) return;
    const row = document.createElement('div');
    row.className = 'crow' + (entry.self ? ' self' : '');
    const who = entry.self ? 'вы' : entry.name;
    row.textContent = `${who} · ${fmtClock(entry.ts)} · ${content}`; // ← textContent ONLY
    log.appendChild(row);
    while (log.childElementCount > CHAT_LOG_MAX) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight; // автоскролл к последнему
  }

  /** Обновить disabled-состояние 💬 из статуса (недоступно вне подключения). */
  setStatus(st: StatusSnapshot | null): void {
    this.connected = !!st?.connected;
    const btn = this.$('chat-open');
    (btn as HTMLButtonElement).disabled = !this.connected;
    (this.$('chatinput') as HTMLInputElement).disabled = !this.connected;
    (this.$('chatsend') as HTMLButtonElement).disabled = !this.connected;
    btn.classList.toggle('disabled', !this.connected);
    btn.title = this.connected ? 'Быстрые сообщения' : 'Подключитесь, чтобы отправлять сообщения';
    if (!this.connected) this.wheel.close();
  }

  /** Чат виден = островок развёрнут И секция «Чат» открыта. */
  private isVisible(): boolean {
    const panel = this.shadow.querySelector('.panel');
    const collapsed = panel?.classList.contains('collapsed') ?? true;
    const box = this.$('chatbox') as HTMLDetailsElement;
    return !collapsed && !panel?.classList.contains('compact') && box.open;
  }

  /** Сброс непрочитанных, если чат сейчас виден (зовётся на toggle секции и разворот панели). */
  resetUnreadIfVisible(): void {
    if (this.isVisible()) { this.unread = 0; this.renderBadge(); }
  }

  private renderBadge(): void {
    const badge = this.$('chatbadge');
    if (this.unread <= 0) { badge.hidden = true; return; }
    badge.hidden = false;
    badge.textContent = this.unread > 9 ? '9+' : String(this.unread);
  }

  destroy(): void {
    this.destroyed = true; this.pending = [];
    this.$('chatbox').removeEventListener('toggle', this.onToggle);
    this.wheel.close();
  }
}
