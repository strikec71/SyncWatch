import { tr } from '../shared/i18n';
// Радиальное колесо быстрых сообщений (chatwheel, Фаза 0.7.0). Открывается кнопкой 💬 в
// шапке островка; top-layer popover по центру экрана (виден и в фуллскрине). 8 круглых
// кнопок по кругу (эмодзи крупно + подпись), в центре ✕ «Отмена». Закрытие: ✕ / Esc /
// клик по фону / после выбора. Слушатели вешаются в open(), снимаются в close().
//
// Стиль в токенах островка (--holo). prefers-reduced-motion уважаем.

import { showFloatingLayer, removeFloatingLayer } from './floating-layer';
import { QUICK_MESSAGES } from '../shared/quick-messages';
import { DEFAULT_APPEARANCE, type Appearance } from '../shared/appearance';
import { applyAppearance, SURFACE_CSS } from './appearance';
import { bindTemplateLanguage } from '../shared/i18n';

const RADIUS = 110; // px — вынос кнопок от центра

export class ChatWheel {
  private prefs: Appearance = DEFAULT_APPEARANCE;
  private host: HTMLDivElement | null = null;
  private shadow: ShadowRoot | null = null;
  private onKey: ((e: KeyboardEvent) => void) | null = null;
  private stopLanguage: (() => void) | null = null;

  constructor(private readonly onPick: (code: string) => void) {}
  setAppearance(prefs: Appearance): void {
    this.prefs = prefs;
    if (this.host) applyAppearance(this.host, prefs);
  }

  get isOpen(): boolean { return this.host != null; }

  open(): void {
    if (this.host) return;
    const host = document.createElement('div');
    applyAppearance(host, this.prefs);
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-label', tr('Быстрые сообщения'));
    host.setAttribute('popover', 'manual');
    // ВАЖНО: inset:auto ДО inset:0 — иначе шорткат inset конфликтует с офсетами (см. проектный инвариант).
    host.style.cssText =
      'position:fixed;inset:auto;inset:0;margin:0;border:0;padding:0;background:transparent;' +
      'width:100vw;height:100vh;z-index:2147483646;pointer-events:auto;' +
      'max-width:none;max-height:none;overflow:visible;';
    const shadow = this.shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = WHEEL_TEMPLATE;
    this.stopLanguage = bindTemplateLanguage(shadow);

    const backdrop = shadow.querySelector('.backdrop') as HTMLElement;
    backdrop.addEventListener('pointerdown', () => this.close());

    const wheel = shadow.querySelector('.wheel') as HTMLElement;
    QUICK_MESSAGES.forEach((m, i) => {
      const angle = i * (360 / QUICK_MESSAGES.length); // 8 → 45° шаг
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sector';
      // rotate → translate → rotate(-) держит кнопку «прямой» на окружности.
      btn.style.transform = `rotate(${angle}deg) translate(${RADIUS}px) rotate(${-angle}deg)`;
      btn.title = m.text;
      btn.setAttribute('aria-label', m.text);

      const emoji = document.createElement('span');
      emoji.className = 'emoji';
      emoji.textContent = m.emoji;
      const label = document.createElement('span');
      label.className = 'cap';
      label.textContent = m.text; // textContent (наши строки, но правило единообразно)

      btn.append(emoji, label);
      btn.addEventListener('click', () => { this.onPick(m.code); this.close(); });
      wheel.appendChild(btn);
    });

    const cancel = shadow.querySelector('.center') as HTMLButtonElement;
    cancel.addEventListener('click', () => this.close());

    document.documentElement.appendChild(host);
    this.host = host;
    this.showInTopLayer();

    this.onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); this.close(); } };
    document.addEventListener('keydown', this.onKey, true);
  }

  close(): void {
    this.stopLanguage?.(); this.stopLanguage = null;
    if (this.onKey) { document.removeEventListener('keydown', this.onKey, true); this.onKey = null; }
    const host = this.host as (HTMLElement & { hidePopover?: () => void }) | null;
    if (host) { removeFloatingLayer(host); host.remove(); }
    this.host = null; this.shadow = null;
  }

  private showInTopLayer(): void {
    if (this.host) showFloatingLayer(this.host, 100, this.shadow);
  }
}

const WHEEL_TEMPLATE = `
<style>${SURFACE_CSS}
  :host { all: initial; }
  .backdrop {
    position: absolute; inset: 0; background: rgba(6,7,11,.42);
    -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);
    animation: fade .18s ease both;
  }
  .wheel {
    --holo: linear-gradient(90deg,#7cf5ff,#a9a0ff,#ff9be1,#7cf5ff);
    position: absolute; left: 50%; top: 50%; width: 0; height: 0;
    transform: translate(-50%,-50%); font-family: system-ui,-apple-system,sans-serif;
    animation: rise .2s ease both;
  }
  .sector {
    position: absolute; left: -37px; top: -37px; width: 74px; height: 74px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    border-radius: 24px; cursor: pointer; color: var(--ink);
    background: linear-gradient(140deg,var(--accent-soft),transparent),rgba(var(--surface-rgb),var(--surface-opacity)); border: 1px solid var(--line);
    backdrop-filter:blur(16px);box-shadow: 0 10px 30px var(--shadow), inset 0 1px 0 rgba(255,255,255,.08);
    transition: transform .08s, border-color .15s, background .15s;
  }
  .sector:hover { border-color:var(--accent); }
  .sector:hover .emoji {transform:translateY(-2px) scale(1.15);}
  .sector:active { transform: scale(.95); }
  .sector:focus-visible { outline: none; border-color: rgba(124,245,255,.7); box-shadow: 0 0 0 2px rgba(124,245,255,.3); }
  .sector .emoji { font-size: 22px; line-height: 1;transition:transform var(--motion); }
  .sector .cap { font:10px/1.1 var(--sans); max-width: 64px; text-align: center;color:var(--muted); }
  .center {
    position: absolute; left: -30px; top: -30px; width: 60px; height: 60px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; cursor: pointer;
    font-size: 20px; color:var(--accent-ink);
    background:var(--gradient); border: 1px solid var(--line);
    box-shadow: 0 8px 24px var(--shadow);
  }
  .center:hover { border-color: rgba(255,155,225,.6); color: #ffd6f1; }
  .center:focus-visible { outline: none; box-shadow: 0 0 0 2px rgba(255,155,225,.4); }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes rise { from { opacity: 0; transform: translate(-50%,-50%) scale(.9); } to { opacity: 1; transform: translate(-50%,-50%) scale(1); } }
  @media (prefers-reduced-motion: reduce) {
    .backdrop, .wheel { animation: none; }
    .sector { transition: none; }
  }
</style>
<div class="backdrop"></div>
<div class="wheel"><button type="button" class="center" title="Отмена">✕</button></div>`;
