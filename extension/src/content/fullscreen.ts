import './native-fullscreen';
// MAIN-world entry, document_start, no extension API or data. Native fullscreen on
// replaced elements cannot contain interactive extension UI. Choose their existing
// parent during the original user gesture, rather than requesting fullscreen twice.
const nativeRequest = Element.prototype.requestFullscreen;
let restore: (() => void) | null = null;
Element.prototype.requestFullscreen = function(options?: FullscreenOptions): Promise<void> {
  if (!(this instanceof HTMLVideoElement || this instanceof HTMLIFrameElement) || !this.parentElement) {
    return nativeRequest.call(this, options);
  }
  const target = this, parent = this.parentElement;
  const root = parent.getRootNode() as Document | ShadowRoot;
  if (root.fullscreenElement === parent) return Promise.resolve();
  restore?.();
  const previous = [target.getAttribute('style'), parent.getAttribute('style')];
  const clean = () => {
    document.removeEventListener('fullscreenchange', onChange);
    [target, parent].forEach((el, index) => {
      if (previous[index] === null) el.removeAttribute('style'); else el.setAttribute('style', previous[index]!);
    });
    if (restore === clean) restore = null;
  };
  const onChange = () => { if (root.fullscreenElement !== parent) clean(); };
  restore = clean;
  // Call before consuming the transient activation. Restore on rejection or exit.
  let request: Promise<void>;
  try { request = nativeRequest.call(parent, options); }
  catch (error) { clean(); throw error; }
  return request.then(() => {
    if (root.fullscreenElement !== parent) { clean(); return; }
    parent.style.cssText += ';position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;margin:0!important;padding:0!important;background:#000!important;overflow:hidden!important;';
    target.style.cssText += ';position:absolute!important;inset:0!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;margin:0!important;border:0!important;object-fit:contain!important;z-index:2147483644!important;';
    document.addEventListener('fullscreenchange', onChange);
  }, error => { clean(); throw error; });
};
