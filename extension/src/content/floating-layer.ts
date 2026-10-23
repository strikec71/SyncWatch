// Keep all extension surfaces in a single ordered top-layer stack. Chrome only.
const layers = new Map<HTMLElement, { visible: boolean; parent: Node; next: Node | null; priority: number; shadow: ShadowRoot | null }>();
let frame: number | null = null;
let listening = false;

function focusedElement(): HTMLElement | null {
  let el = document.activeElement;
  while (el) {
    const root = el.shadowRoot || layers.get(el as HTMLElement)?.shadow;
    if (!root?.activeElement) break;
    el = root.activeElement;
  }
  return el instanceof HTMLElement ? el : null;
}

export function raiseFloatingLayers(): void {
  stopIfUnused();
  const focused = focusedElement();
  let fullscreen = document.fullscreenElement;
  while (fullscreen?.shadowRoot?.fullscreenElement) fullscreen = fullscreen.shadowRoot.fullscreenElement;
  const ordered = [...layers].sort((a, b) => a[1].priority - b[1].priority);
  for (const [host, layer] of ordered) {
    // Fullscreen makes nodes outside its subtree inert, even when their popovers paint.
    // fullscreen.ts ensures replaced targets use a container during the gesture.
    const parent = fullscreen || (layer.parent.isConnected ? layer.parent : document.documentElement);
    if (host.parentNode !== parent) {
      if (host.matches(':popover-open')) host.hidePopover();
      parent.insertBefore(host, !fullscreen && layer.next?.parentNode === parent ? layer.next : null);
    }
    if (!layer.visible || !host.isConnected) continue;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch { /* the document can be navigating */ }
  }
  if (focused?.isConnected && focusedElement() !== focused) focused.focus({ preventScroll: true });
}

function scheduleRaise(): void {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => { frame = null; raiseFloatingLayers(); });
}
function onExternalToggle(event: Event): void {
  if ((event as ToggleEvent).newState === 'open' && !layers.has(event.target as HTMLElement)) scheduleRaise();
}

export function showFloatingLayer(host: HTMLElement, priority = 0, shadow: ShadowRoot | null = host.shadowRoot): void {
  if (!listening) {
    document.addEventListener('fullscreenchange', scheduleRaise);
    document.addEventListener('toggle', onExternalToggle, true);
    listening = true;
  }
  host.dataset.syncwatchUi = '';
  host.setAttribute('popover', 'manual');
  const wasVisible = layers.get(host)?.visible;
  const layer = layers.get(host) || { visible: true, parent: host.parentNode || document.documentElement, next: host.nextSibling, priority, shadow };
  layer.visible = true;
  layers.set(host, layer);
  if (!wasVisible || !host.matches(':popover-open')) raiseFloatingLayers();
}

export function hideFloatingLayer(host: HTMLElement): void {
  const layer = layers.get(host);
  if (layer) layer.visible = false;
  try { if (host.matches(':popover-open')) host.hidePopover(); } catch {}
}

export function removeFloatingLayer(host: HTMLElement): void {
  hideFloatingLayer(host); layers.delete(host);
  stopIfUnused();
}
function stopIfUnused(): void {
  if (!layers.size && listening) {
    document.removeEventListener('fullscreenchange', scheduleRaise);
    document.removeEventListener('toggle', onExternalToggle, true);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null; listening = false;
  }
}
