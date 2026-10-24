/** Presentation preferences only; room and server state never live here. */
export interface Appearance {
  uiTheme: 'dark' | 'light' | 'system';
  uiAccent: 'lounge' | 'aurora' | 'ocean' | 'rose';
  uiDensity: 'comfortable' | 'compact';
  uiOpacity: number;
  uiMotion: boolean;
  uiDockSide: 'left' | 'right';
}

export const DEFAULT_APPEARANCE: Appearance = {
  uiTheme: 'dark', uiAccent: 'lounge', uiDensity: 'comfortable',
  uiOpacity: 96, uiMotion: true, uiDockSide: 'right',
};

export function normalizeAppearance(raw: Partial<Appearance> = {}): Appearance {
  return {
    uiTheme: ['dark', 'light', 'system'].includes(raw.uiTheme ?? '') ? raw.uiTheme! : DEFAULT_APPEARANCE.uiTheme,
    uiAccent: ['lounge', 'aurora', 'ocean', 'rose'].includes(raw.uiAccent ?? '') ? raw.uiAccent! : DEFAULT_APPEARANCE.uiAccent,
    uiDensity: raw.uiDensity === 'compact' ? 'compact' : 'comfortable',
    uiOpacity: typeof raw.uiOpacity === 'number' && Number.isFinite(raw.uiOpacity) ? Math.round(Math.max(85, Math.min(100, raw.uiOpacity))) : DEFAULT_APPEARANCE.uiOpacity,
    uiMotion: typeof raw.uiMotion === 'boolean' ? raw.uiMotion : DEFAULT_APPEARANCE.uiMotion,
    uiDockSide: raw.uiDockSide === 'left' ? 'left' : 'right',
  };
}
