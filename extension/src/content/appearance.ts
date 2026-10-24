import { normalizeAppearance, type Appearance } from '../shared/appearance';

/** Static, bundled tokens shared by every isolated UI surface. */
export const SURFACE_CSS = `
  :host {
    color-scheme: dark; --ink:#f3f1fc; --muted:#b3afc8; --line:rgba(222,211,255,.15);
    --surface-rgb:25,23,36; --raised:rgba(255,255,255,.055); --field:rgba(7,8,17,.28);
    --accent:#c0a6ff; --accent-ink:#201433; --accent-soft:rgba(172,136,250,.16);
    --gradient:linear-gradient(125deg,#9b8aff,#bda2ed 42%,#e5abc7); --glow:rgba(153,122,234,.2);
    --green:#8ae0bf; --amber:#f4d18f; --shadow:rgba(5,4,15,.35);
    --surface-opacity:.96; --blur:22px; --motion:260ms; --panel-width:344px;
    --sans:system-ui,-apple-system,'Segoe UI',sans-serif; --mono:ui-monospace,Consolas,monospace;
  }
  :host([data-theme="light"]) {
    color-scheme:light; --ink:#30283f; --muted:#6b607c; --line:rgba(65,44,104,.14);
    --surface-rgb:250,247,255; --raised:rgba(116,79,163,.065); --field:rgba(255,255,255,.7);
    --accent:#7651bd; --accent-ink:#fff; --accent-soft:rgba(130,89,190,.1);
    --gradient:linear-gradient(125deg,#7053b8,#9369b4 48%,#b76187); --glow:rgba(162,124,230,.13);
    --green:#287354; --amber:#94651b; --shadow:rgba(42,23,68,.16);
  }
  :host([data-accent="aurora"]) {--accent:#8fdfce;--accent-ink:#102e2a;--accent-soft:rgba(107,204,195,.15);--gradient:linear-gradient(125deg,#74d5c2,#93b7ed 55%,#c5a7ef);--glow:rgba(105,190,199,.18);}
  :host([data-accent="ocean"]) {--accent:#a2ccff;--accent-ink:#152b45;--accent-soft:rgba(116,175,238,.15);--gradient:linear-gradient(125deg,#75c6e1,#8ca8f2 55%,#bdacef);--glow:rgba(94,156,227,.18);}
  :host([data-accent="rose"]) {--accent:#f0b4ce;--accent-ink:#401d30;--accent-soft:rgba(231,153,188,.15);--gradient:linear-gradient(125deg,#f0afc6,#d6abea 55%,#aba7ed);--glow:rgba(219,138,185,.17);}
  :host([data-theme="light"][data-accent="aurora"]) {--accent:#236e66;--accent-ink:#fff;--gradient:linear-gradient(125deg,#347e73,#5575ac 55%,#8963b1);}
  :host([data-theme="light"][data-accent="ocean"]) {--accent:#366da5;--accent-ink:#fff;--gradient:linear-gradient(125deg,#347da1,#536bb2 55%,#8663ae);}
  :host([data-theme="light"][data-accent="rose"]) {--accent:#a34476;--accent-ink:#fff;--gradient:linear-gradient(125deg,#ab5079,#9161a9 55%,#6765b5);}
  :host([data-density="compact"]) {--panel-width:304px;}
  *,*::before,*::after {box-sizing:border-box;}
  [hidden] {display:none!important;}
  :host([data-motion="off"]) *, :host([data-motion="off"]) *::before, :host([data-motion="off"]) *::after {animation:none!important;transition:none!important;scroll-behavior:auto!important;}
  @media(prefers-reduced-motion:reduce) {*,*::before,*::after {animation:none!important;transition:none!important;scroll-behavior:auto!important;}}
`;

export function applyAppearance(host: HTMLElement, settings: Partial<Appearance>): void {
  const prefs = normalizeAppearance(settings);
  host.dataset.theme = prefs.uiTheme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : prefs.uiTheme;
  host.dataset.accent = prefs.uiAccent;
  host.dataset.density = prefs.uiDensity;
  host.dataset.motion = prefs.uiMotion ? 'on' : 'off';
  host.style.setProperty('--surface-opacity', String(prefs.uiOpacity / 100));
}
