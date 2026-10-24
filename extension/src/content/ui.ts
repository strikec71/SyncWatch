// One visible UI per tab: top document normally; the leaf document in fullscreen.
// All frames receive passive banner/chat updates so a fullscreen iframe starts with
// the same state. Player commands still go only to the active player frame.
import browser from '../shared/browser';
import { loadSettings, saveSettings } from '../shared/settings';
import type { RuntimeMessage, BannerMsg, ChatEntry } from '../shared/messages';
import { StatusBanner } from './banner';
import { ChatBubbles } from './chat-bubbles';
import { Overlay } from './overlay';
import { DEFAULT_APPEARANCE, normalizeAppearance, type Appearance } from '../shared/appearance';
import { setLanguage, getLanguage, type LanguagePreference } from '../shared/i18n';
export function presentationDocument(): boolean {
  let fs = document.fullscreenElement;
  while (fs?.shadowRoot?.fullscreenElement) fs = fs.shadowRoot.fullscreenElement;
  if (fs instanceof HTMLIFrameElement) return false;
  return window.top === window || !!fs;
}
export class ContentUI {
  private appearance: Appearance = DEFAULT_APPEARANCE;
  private updateAppearance(settings: Partial<Appearance> & {language?: LanguagePreference}): void {
    setLanguage(settings.language);
    // MAIN-world control only receives a public locale, never settings/session data.
    window.dispatchEvent(new CustomEvent('syncwatch-language', { detail: getLanguage() }));
    this.appearance = normalizeAppearance(settings);
    this.banner.setAppearance(this.appearance); this.bubbles.setAppearance(this.appearance);
    if (this.bannerState && this.active) this.banner.apply(this.bannerState);
    this.bubbles.refreshLanguage();
  }
  private banner = new StatusBanner();
  private bubbles = new ChatBubbles();
  private overlay: Overlay | null = null;
  private enabled = false;
  private active = false;
  private videoAvailable = false;
  private bannerState: BannerMsg | null = null;
  private recent: ChatEntry[] = [];
  constructor() {
    document.addEventListener('fullscreenchange', () => this.reconcile());
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) { this.enabled = changes.settings.newValue?.overlayEnabled ?? true; this.updateAppearance(changes.settings.newValue ?? {}); this.reconcile(); }
    });
    browser.runtime.onMessage.addListener((msg: RuntimeMessage) => this.onMessage(msg));
    void loadSettings().then(settings => { this.enabled = settings.overlayEnabled; this.updateAppearance(settings); this.reconcile(); });
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      this.banner.setAppearance(this.appearance); this.bubbles.setAppearance(this.appearance);
    });
    void browser.runtime.sendMessage({kind:'query-video'}).then(r => { this.videoAvailable = !!r?.available; this.reconcile(); }).catch(() => {});
  }
  private reconcile(): void {
    const active = presentationDocument();
    if (active !== this.active) {
      this.active = active;
      if (!active) { this.banner.destroy(); this.bubbles.destroy(); }
      else {
        if (this.bannerState) this.banner.apply(this.bannerState);
        for (const entry of this.recent.filter(e => Date.now() - e.ts < 6000)) this.bubbles.push(entry);
      }
    }
    const show = active && this.enabled;
    if (show && !this.overlay) { this.overlay = new Overlay(); void this.overlay.mount(); }
    else if (!show && this.overlay) { this.overlay.unmount(); this.overlay = null; }
    this.overlay?.setVideoAvailable(this.videoAvailable || !!document.fullscreenElement);
  }
  private onMessage(msg: RuntimeMessage): void {
    if (msg?.kind === 'banner') { this.bannerState = msg; if (this.active) this.banner.apply(msg); }
    if (msg?.kind === 'chat' && !msg.entry.self) {
      this.recent = [...this.recent, msg.entry].filter(e => Date.now() - e.ts < 6000).slice(-3);
      if (this.active) this.bubbles.push(msg.entry);
    }
    if (msg?.kind === 'video-availability') { this.videoAvailable = msg.available; this.reconcile(); }
    if (msg?.kind === 'show-overlay' || msg?.kind === 'toggle-overlay') {
      this.enabled = msg.kind === 'show-overlay' || !this.enabled;
      this.reconcile(); void saveSettings({overlayEnabled:this.enabled}).catch(() => {});
    }
  }
}
