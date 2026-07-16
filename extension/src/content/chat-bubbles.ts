// Плавающие чат-баблы (Фаза 0.7.0) — только верхний фрейм, независимо от островка
// (политика как у баннера: видны даже при overlayEnabled:false и в фуллскрине).
// Отдельный top-layer виджет (баннер однослотовый — сюда не годится): стек последних
// сообщений чуть НИЖЕ баннера. Своё сообщение баблом НЕ показываем (только в логе островка).
//
// ⚠️ XSS: имя и текст — недоверенные, рендерятся ТОЛЬКО через textContent.
// ⚠️ inset-ловушка: в cssText `inset:auto` идёт ДО top/left (иначе шорткат уносит в угол).

import type { ChatEntry } from '../shared/messages';
import { quickMessageByCode } from '../shared/quick-messages';

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
  private host: HTMLDivElement | null = null;
  private stack: HTMLElement | null = null;

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
    while (this.stack.childElementCount > MAX_BUBBLES) this.stack.firstElementChild?.remove();
    window.setTimeout(() => bubble.remove(), BUBBLE_TTL_MS);

    this.showInTopLayer();
  }

  private ensureHost(): void {
    if (this.host) { this.host.style.display = ''; return; }
    const host = document.createElement('div');
    host.setAttribute('popover', 'manual');
    // ВАЖНО: inset:auto ДО left/top — иначе шорткат inset затирает офсеты (уезжает в угол).
    // Ниже баннера (14% + высота плашки), по центру.
    host.style.cssText =
      'position:fixed;inset:auto;margin:0;border:0;padding:0;background:transparent;' +
      'left:50%;top:calc(14% + 52px);transform:translateX(-50%);z-index:2147483645;' +
      'max-width:none;max-height:none;overflow:visible;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = BUBBLES_TEMPLATE;
    document.documentElement.appendChild(host);
    this.host = host;
    this.stack = shadow.querySelector('.stack');
    this.showInTopLayer();
  }

  private showInTopLayer(): void {
    const host = this.host as (HTMLElement & { showPopover?: () => void }) | null;
    if (!host || typeof host.showPopover !== 'function') return;
    try { host.showPopover(); } catch { /* уже показан */ }
  }

  destroy(): void {
    this.host?.remove();
    this.host = null;
    this.stack = null;
  }
}

const BUBBLES_TEMPLATE = `
<style>
  :host { all: initial; }
  .stack { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .bubble {
    max-width: min(72vw, 460px);
    font-family: system-ui,-apple-system,sans-serif; font-size: 13px; font-weight: 500;
    line-height: 1.35; color: #eef1f8; text-align: center;
    padding: 8px 15px; border-radius: 999px;
    background: rgba(14,16,22,.72);
    -webkit-backdrop-filter: blur(12px) saturate(1.3); backdrop-filter: blur(12px) saturate(1.3);
    border: 1px solid rgba(255,255,255,.10);
    box-shadow: 0 8px 26px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06);
    animation: pop .28s ease both;
  }
  @keyframes pop { from { opacity: 0; transform: translateY(-6px) scale(.96); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .bubble { animation: none; } }
</style>
<div class="stack"></div>`;
