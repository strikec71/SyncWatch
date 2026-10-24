import { tr } from '../shared/i18n';
// Центральный статус-баннер (Фаза 7) — документ показа, выбранный ContentUI.
// Дышащая плашка по центру, отражающая текущее блокирующее состояние от партнёра
// (пауза / буфер / реклама со счётом вверх). Состояние считает background и пушит
// сюда; текст и таймер рекламы баннер крутит локально. Виден поверх фуллскрина
// (popover/top-layer, как островок). Ленивый DOM: нет состояния — нет элемента.

import { showFloatingLayer, hideFloatingLayer, removeFloatingLayer } from './floating-layer';
import type { BannerMsg } from '../shared/messages';
import { DEFAULT_APPEARANCE, type Appearance } from '../shared/appearance';
import { applyAppearance, SURFACE_CSS } from './appearance';

type BannerState = BannerMsg['state'];

export class StatusBanner {
  private prefs: Appearance = DEFAULT_APPEARANCE;
  setAppearance(prefs: Appearance): void { this.prefs = prefs; if (this.host) applyAppearance(this.host, prefs); }
  private host: HTMLDivElement | null = null;
  private pill: HTMLElement | null = null;
  private textEl: HTMLElement | null = null;
  private state: BannerState = 'none';
  private since = 0;
  private name = tr('Партнёр');
  private tick: number | null = null;

  /** Применить состояние от хаба. */
  apply(msg: BannerMsg): void {
    this.state = msg.state;
    this.since = msg.since;
    this.name = msg.name || tr('Партнёр');

    if (msg.state === 'none') { this.hide(); return; }

    this.ensureHost();
    this.render();
    // Таймер нужен только рекламе (count-up); для остальных — один статичный кадр.
    if (msg.state === 'peer-ad') this.startTick();
    else this.stopTick();
  }

  private render(): void {
    if (!this.textEl) return;
    this.pill?.setAttribute('data-state', this.state);  // цвет точки-индикатора
    const who = this.name;
    switch (this.state) {
      case 'peer-paused':
        this.textEl.textContent = tr`${who} на паузе`;
        break;
      case 'peer-buffer':
        this.textEl.textContent = tr`${who} догружает видео…`;
        break;
      case 'peer-ad': {
        const sec = Math.max(0, Math.floor((Date.now() - this.since) / 1000));
        this.textEl.textContent = tr`Реклама у партнёра · ${fmt(sec)}`;
        break;
      }
    }
  }

  private startTick(): void {
    if (this.tick != null) return;
    this.tick = window.setInterval(() => this.render(), 1000);
  }

  private stopTick(): void {
    if (this.tick != null) { window.clearInterval(this.tick); this.tick = null; }
  }

  private ensureHost(): void {
    if (this.host) { this.host.style.display = ''; this.showInTopLayer(); return; }
    const host = document.createElement('div');
    applyAppearance(host, this.prefs);
    host.setAttribute('role', 'status');
    host.setAttribute('popover', 'manual');
    // ВАЖНО: inset:auto идёт ДО left/top — иначе шорткат inset затирает офсеты (уезжает в угол).
    host.style.cssText =
      'position:fixed;inset:auto;margin:0;border:0;padding:0;background:transparent;' +
      'left:50%;top:14%;transform:translateX(-50%);z-index:2147483646;' +
      'max-width:none;max-height:none;overflow:visible;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = BANNER_TEMPLATE;
    document.documentElement.appendChild(host);
    this.host = host;
    this.pill = shadow.querySelector('.pill');
    this.textEl = shadow.querySelector('.text');
    this.showInTopLayer();
  }

  private showInTopLayer(): void {
    if (this.host) showFloatingLayer(this.host, 10);
  }

  private hide(): void {
    this.stopTick();
    if (this.host) { hideFloatingLayer(this.host); this.host.style.display = 'none'; }
  }

  destroy(): void {
    this.stopTick();
    if (this.host) removeFloatingLayer(this.host);
    this.host?.remove();
    this.host = null;
  }
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const BANNER_TEMPLATE = `
<style>${SURFACE_CSS}
  :host { all: initial; }
  .pill {
    --holo: linear-gradient(90deg,#7cf5ff,#a9a0ff,#ff9be1,#7cf5ff);
    position: relative; display: inline-flex; align-items: center; gap: 10px; overflow: hidden;
    font-family:var(--sans);
    font-size:13px;font-weight:500;color:var(--ink);white-space:normal;max-width:min(480px,85vw);overflow-wrap:anywhere;
    padding: 10px 20px 11px; border-radius: 999px;
    background:linear-gradient(125deg,var(--accent-soft),transparent),rgba(var(--surface-rgb),var(--surface-opacity));
    -webkit-backdrop-filter: blur(12px) saturate(1.3); backdrop-filter: blur(12px) saturate(1.3);
    border:1px solid var(--line);
    box-shadow:0 10px 34px var(--shadow),inset 0 1px 0 rgba(255,255,255,.06);
    animation:appear var(--motion) ease-out both;
  }
  /* Точка-индикатор состояния партнёра */
  .sdot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: #a9a0ff; box-shadow: 0 0 10px rgba(169,160,255,.7); }
  .pill[data-state="peer-paused"] .sdot { background: #f5c451; box-shadow: 0 0 10px rgba(245,196,81,.7); }
  .pill[data-state="peer-buffer"] .sdot { background: #7cf5ff; box-shadow: 0 0 10px rgba(124,245,255,.7); }
  .pill[data-state="peer-ad"] .sdot { background: #ff9be1; box-shadow: 0 0 10px rgba(255,155,225,.7); animation: blink 1.1s steps(2) infinite; }
  /* Сдвигающаяся голо-линия под текстом */
  .pill::after {
    content: ''; position: absolute; left: 16px; right: 16px; bottom: 5px; height: 1.5px; border-radius: 2px;
    background:var(--gradient);opacity:.65;
  }
  @keyframes slide { to { background-position: -200% 0; } }
  @keyframes breathe { 0%, 100% { transform: scale(1); opacity: .9; } 50% { transform: scale(1.02); opacity: 1; } }
  @keyframes appear {from{opacity:0;transform:translateY(-5px) scale(.97);}to{opacity:1;transform:none;}}
  @keyframes blink { 50% { opacity: .3; } }
  @media (prefers-reduced-motion: reduce) {
    .pill, .pill::after, .sdot { animation: none !important; }
  }
</style>
<div class="pill" data-state="none"><span class="sdot"></span><span class="text"></span></div>`;
