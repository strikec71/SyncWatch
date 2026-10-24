// Плавающие чат-баблы (Фаза 0.7.0) — документ показа, выбранный ContentUI, независимо от островка
// (политика как у баннера: видны даже при overlayEnabled:false и в фуллскрине).
// Отдельный top-layer виджет (баннер однослотовый — сюда не годится): стек последних
// сообщений чуть НИЖЕ баннера. Своё сообщение баблом НЕ показываем (только в логе островка).
//
// ⚠️ XSS: имя и текст — недоверенные, рендерятся ТОЛЬКО через textContent.
// ⚠️ inset-ловушка: в cssText `inset:auto` идёт ДО top/left (иначе шорткат уносит в угол).

import { showFloatingLayer, hideFloatingLayer, removeFloatingLayer } from './floating-layer';
import type { ChatEntry } from '../shared/messages';
import { quickMessageByCode } from '../shared/quick-messages';
import { DEFAULT_APPEARANCE, type Appearance } from '../shared/appearance';
import { applyAppearance, SURFACE_CSS } from './appearance';

const MAX_BUBBLES = 3;
const BUBBLE_TTL_MS = 6000;

/** Собрать видимый текст сообщения из кода каталога и/или свободного текста. */
function renderContent(entry: ChatEntry): string {
  const parts: string[] = [];
  if (entry.code) {
    const qm = quickMessageByCode(entry.code);
    if (qm) parts.push(`${qm.emoji} ${qm.text}`);
  }
  if (entry.text) parts.push(entry.text);
  return parts.join(' ');
}

export class ChatBubbles {
  private prefs: Appearance = DEFAULT_APPEARANCE;
  setAppearance(prefs: Appearance): void { this.prefs = prefs; if (this.host) applyAppearance(this.host, prefs); }
  private host: HTMLDivElement | null = null;
  private stack: HTMLElement | null = null;
  private timers = new Map<HTMLElement, number>();

  /** Показать бабл для входящего сообщения. Своё (self) пропускаем — оно только в логе. */
  push(entry: ChatEntry): void {
    if (entry.self) return;
    const content = renderContent(entry);
    if (!content) return; // неизвестный код без текста — нечего показывать

    this.ensureHost();
    if (!this.stack) return;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = `💬 ${entry.name}: ${content}`; // ← textContent ONLY (XSS-гейт)
    this.stack.appendChild(bubble);
    while (this.stack.childElementCount > MAX_BUBBLES) {
      const oldest = this.stack.firstElementChild as HTMLElement;
      clearTimeout(this.timers.get(oldest)); this.timers.delete(oldest); oldest.remove();
    }
    this.timers.set(bubble, window.setTimeout(() => {
      this.timers.delete(bubble); bubble.remove();
      if (!this.stack?.childElementCount && this.host) hideFloatingLayer(this.host);
    }, BUBBLE_TTL_MS));

    this.showInTopLayer();
  }

  private ensureHost(): void {
    if (this.host) { this.host.style.display = ''; return; }
    const host = document.createElement('div');
    applyAppearance(host, this.prefs);
    host.setAttribute('popover', 'manual');
    // ВАЖНО: inset:auto ДО left/top — иначе шорткат inset затирает офсеты (уезжает в угол).
    // Ниже баннера (14% + высота плашки), по центру.
    host.style.cssText =
      'position:fixed;inset:auto;margin:0;border:0;padding:0;background:transparent;' +
      'left:50%;top:calc(14% + 52px);transform:translateX(-50%);z-index:2147483645;' +
      'max-width:none;max-height:none;overflow:visible;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = BUBBLES_TEMPLATE;
    document.documentElement.appendChild(host);
    this.host = host;
    this.stack = shadow.querySelector('.stack');
    this.showInTopLayer();
  }

  private showInTopLayer(): void {
    if (this.host) showFloatingLayer(this.host, 20);
  }

  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.host) removeFloatingLayer(this.host);
    this.host?.remove();
    this.host = null;
    this.stack = null;
  }
}

const BUBBLES_TEMPLATE = `
<style>${SURFACE_CSS}
  :host { all: initial; }
  .stack { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .bubble {
    max-width: min(72vw, 460px);
    font-family: system-ui,-apple-system,sans-serif; font-size: 13px; font-weight: 500;
    line-height:1.5;color:var(--ink);text-align:center;overflow-wrap:anywhere;
    padding:10px 16px;border-radius:18px;
    background:linear-gradient(125deg,var(--accent-soft),transparent),rgba(var(--surface-rgb),var(--surface-opacity));
    -webkit-backdrop-filter: blur(12px) saturate(1.3); backdrop-filter: blur(12px) saturate(1.3);
    border:1px solid var(--line);
    box-shadow:0 8px 26px var(--shadow),inset 0 1px 0 rgba(255,255,255,.06);
    animation:pop var(--motion) ease both;
  }
  @keyframes pop { from { opacity: 0; transform: translateY(-6px) scale(.96); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .bubble { animation: none; } }
</style>
<div class="stack"></div>`;
