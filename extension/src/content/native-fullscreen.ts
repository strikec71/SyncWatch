import { tr } from '../shared/i18n';
import { setLanguage } from '../shared/i18n';
// Chrome's native video-controls button bypasses Element.requestFullscreen in JS.
// Replace that affordance with a small accessible control that uses our gesture-time
// fullscreen path. MAIN world only: no extension API or user/session data.
const controls = new Map<HTMLVideoElement, {host: HTMLElement; button: HTMLButtonElement}>();
const sheet = new CSSStyleSheet();
sheet.replaceSync('video::-webkit-media-controls-fullscreen-button{display:none!important}');
let queued = false;
function rootFullscreen(): Element | null {
  let fs = document.fullscreenElement;
  while (fs?.shadowRoot?.fullscreenElement) fs = fs.shadowRoot.fullscreenElement;
  return fs;
}
function update(): void {
  queued = false;
  if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const fs = rootFullscreen();
  for (const [video, {host, button}] of controls) {
    if (!video.isConnected || !video.controls) { host.remove(); size.unobserve(video); controls.delete(video); continue; }
    const r = video.getBoundingClientRect();
    const visible = r.width >= 160 && r.height >= 100 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
    host.style.display = visible ? 'block' : 'none';
    const parent = fs?.contains(video) ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.append(host);
    host.style.left = `${Math.max(4, Math.min(innerWidth - 36, r.left + 8))}px`;
    host.style.top = `${Math.max(4, r.top + 8)}px`;
    button.title = fs?.contains(video) ? tr('Выйти из полноэкранного режима') : tr('Во весь экран');
    button.setAttribute('aria-label', button.title);
  }
}
function schedule(): void { if (!queued) { queued = true; requestAnimationFrame(update); } }
const size = new ResizeObserver(schedule);
function add(video: HTMLVideoElement): void {
  if (!video.controls || controls.has(video)) return;
  const host = document.createElement('div');
  host.dataset.syncwatchNativeFullscreen = '';
  host.style.cssText = 'position:fixed;z-index:2147483646;width:30px;height:30px;pointer-events:auto;';
  const shadow = host.attachShadow({mode:'closed'});
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = '⛶';
  button.style.cssText = 'all:initial;display:grid;place-items:center;box-sizing:border-box;width:30px;height:30px;background:rgba(15,18,24,.8);color:white;border:1px solid #777;border-radius:6px;font:23px system-ui;cursor:pointer;';
  button.addEventListener('click', event => {
    if (!event.isTrusted) return;
    event.preventDefault(); event.stopPropagation();
    const fs = rootFullscreen();
    const request = fs?.contains(video) ? document.exitFullscreen() : video.requestFullscreen();
    void request.catch(() => { button.title = tr('Не удалось открыть полный экран — повторите нажатие'); button.setAttribute('aria-label',button.title); });
  });
  shadow.append(button); controls.set(video,{host,button}); size.observe(video); schedule();
}
function scan(node: Node | null): void {
  if (!(node instanceof Element)) return;
  if (node instanceof HTMLVideoElement) add(node);
  for (const video of node.querySelectorAll('video[controls]')) add(video as HTMLVideoElement);
}
new MutationObserver(records => {
  for (const record of records) {
    if (record.type === 'attributes') { if (record.target instanceof HTMLVideoElement) add(record.target); }
    else for (const node of record.addedNodes) scan(node);
  }
  // Host insertion is observed too; only schedule if something changed or detached.
  if ([...controls].some(([video]) => !video.isConnected || !video.controls)) schedule();
}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['controls']});
scan(document.documentElement);
addEventListener('resize',schedule); document.addEventListener('scroll',schedule,true);
document.addEventListener('fullscreenchange',schedule);
window.addEventListener('syncwatch-language', event => {
  const language = (event as CustomEvent<unknown>).detail;
  if (language === 'en' || language === 'ru') { setLanguage(language); schedule(); }
});

// Preserve the familiar mouse double-click gesture without entering replaced-element
// fullscreen through Chrome's native default action.
document.addEventListener('dblclick', event => {
  if (!event.isTrusted) return;
  const video = event.composedPath().find(node => node instanceof HTMLVideoElement && node.controls) as HTMLVideoElement | undefined;
  if (!video) return;
  event.preventDefault(); event.stopImmediatePropagation();
  void (rootFullscreen()?.contains(video) ? document.exitFullscreen() : video.requestFullscreen()).catch(() => {});
}, true);
