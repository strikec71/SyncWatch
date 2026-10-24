import { tr } from '../shared/i18n';
import { DEFAULT_APPEARANCE, normalizeAppearance, type Appearance } from '../shared/appearance';
import { saveSettings } from '../shared/settings';
import { applyAppearance } from './appearance';

/** Local navigation and persisted visual preferences, separate from sync actions. */
export class OverlayShell {
  private prefs: Appearance;
  private scheme = matchMedia('(prefers-color-scheme: light)');
  private onScheme = () => this.paint();
  private onResize = () => this.keepInView();
  private sizeObserver = new ResizeObserver(() => this.keepInView());
  constructor(private shadow: ShadowRoot, private host: HTMLElement, settings: Partial<Appearance>, private onView: () => void, private onAppearance: (prefs: Appearance) => void, private hint: (message: string) => void) {
    this.prefs = normalizeAppearance(settings);
    for (const tab of shadow.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      tab.addEventListener('click', () => this.select(tab.dataset.view!));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...shadow.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        this.select(tabs[index].dataset.view!); tabs[index].focus();
      });
    }
    for (const key of ['uiTheme', 'uiDensity', 'uiDockSide', 'uiOpacity', 'uiMotion'] as const) {
      const input = shadow.getElementById(key) as HTMLInputElement | HTMLSelectElement;
      input.addEventListener('change', () => {
        const value = key === 'uiMotion' ? (input as HTMLInputElement).checked : key === 'uiOpacity' ? Number(input.value) : input.value;
        void this.save({ [key]: value });
      });
      if (key === 'uiOpacity') input.addEventListener('input', () => { this.prefs.uiOpacity = Number(input.value); this.paint(); });
    }
    for (const choice of shadow.querySelectorAll<HTMLButtonElement>('[data-accent-choice]')) choice.addEventListener('click', () => void this.save({ uiAccent: choice.dataset.accentChoice as Appearance['uiAccent'] }));
    shadow.getElementById('appearance-reset')!.addEventListener('click', () => void this.save(DEFAULT_APPEARANCE));
    this.scheme.addEventListener('change', this.onScheme); window.addEventListener('resize', this.onResize);
    this.sizeObserver.observe(host);
    this.place(); this.paint();
  }
  select(view: string): void {
    for (const tab of this.shadow.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      const selected = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      this.shadow.getElementById(tab.getAttribute('aria-controls')!)!.hidden = !selected;
    }
    this.onView(); this.keepInView();
  }
  update(settings: Partial<Appearance>): void {
    const next = normalizeAppearance(settings), moved = next.uiDockSide !== this.prefs.uiDockSide;
    this.prefs = next; if (moved) this.place(); this.paint(); this.keepInView();
  }
  private async save(patch: Partial<Appearance>): Promise<void> {
    try { const saved = await saveSettings(patch); this.update(saved); }
    catch { this.hint(tr('Не удалось сохранить оформление. Повторите изменение.')); }
  }
  private paint(): void {
    applyAppearance(this.host, this.prefs);
    for (const key of ['uiTheme', 'uiDensity', 'uiDockSide', 'uiOpacity', 'uiMotion'] as const) {
      const input = this.shadow.getElementById(key) as HTMLInputElement | HTMLSelectElement;
      if (key === 'uiMotion') (input as HTMLInputElement).checked = this.prefs.uiMotion;
      else input.value = String(this.prefs[key]);
    }
    this.shadow.getElementById('opacity-value')!.textContent = `${this.prefs.uiOpacity}%`;
    for (const button of this.shadow.querySelectorAll<HTMLButtonElement>('[data-accent-choice]')) button.setAttribute('aria-pressed', String(button.dataset.accentChoice === this.prefs.uiAccent));
    this.onAppearance(this.prefs);
  }
  private place(): void {
    this.host.style.left = this.prefs.uiDockSide === 'left' ? '16px' : 'auto';
    this.host.style.right = this.prefs.uiDockSide === 'right' ? '16px' : 'auto';
    this.host.style.top = '16px'; this.host.dataset.side = this.prefs.uiDockSide;
  }
  keepInView(): void {
    requestAnimationFrame(() => {
      if (!this.host.isConnected) return;
      const rect = this.host.getBoundingClientRect();
      this.host.dataset.side = rect.left < innerWidth / 2 ? 'left' : 'right';
      if (rect.left < 8 || rect.right > innerWidth - 8) {
        this.host.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, rect.left))}px`; this.host.style.right = 'auto';
      }
      if (rect.top < 8 || rect.bottom > innerHeight - 8) this.host.style.top = `${Math.max(8, Math.min(innerHeight - rect.height - 8, rect.top))}px`;
    });
  }
  destroy(): void { this.sizeObserver.disconnect(); this.scheme.removeEventListener('change', this.onScheme); window.removeEventListener('resize', this.onResize); }
}
