// Run after npm run build and local wrangler dev on port 8787.
// PLAYWRIGHT_MODULE may point to an installed Playwright module.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || resolve(root,'extension/node_modules/playwright'));
const esbuild = require(resolve(root, 'extension/node_modules/esbuild'));
const results = [];
const log = (id, observed, expected, pass) => {
  const item = { id, observed, expected, pass }; results.push(item); console.log(JSON.stringify(item));
};
const bundle = await esbuild.build({
  stdin: { contents: `export { PlayerController } from './extension/src/content/player';`, resolveDir: root },
  bundle: true, write: false, format: 'iife', globalName: 'Audit',
  alias: { 'webextension-polyfill': resolve(root, 'extension/tests/stubs/webextension-polyfill.ts') },
});
const media = readFileSync(process.env.AUDIT_VIDEO || '/tmp/syncwatch-audit/video.webm');
const fixture = createServer((req, res) => {
  if (req.url.startsWith('/video.webm')) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
    res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${media.length}` } : {}) });
    res.end(media.subarray(start, end + 1)); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><head><title>SyncWatch audit</title></head><body><h1>Local audit fixture</h1><video controls muted loop width="640" src="/video.webm"></video></body></html>');
});
await new Promise(r => fixture.listen(8790, '127.0.0.1', r));
const profile = mkdtempSync(resolve(tmpdir(), 'syncwatch-browser-audit-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || undefined, headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8790/controller');
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const controls = await page.evaluate(async () => {
    const v = document.querySelector('video');
    const p = new Audit.PlayerController(); p.video = v;
    await v.play(); p.applyBufferControl(true);
    const bufferPaused = v.paused;
    p.pausedByPeerBuffer = false; await v.play(); p.applyAdControl(true);
    const adPaused = v.paused;
    p.pausedByPeerAd = false; v.pause(); p.pausedByPeerBuffer = true; p.applyBufferControl(false);
    const holdResumed = !v.paused;
    p.pausedByPeerBuffer = false; v.playbackRate = 1; p.applyRemote('play', 20, false, 1.5);
    const snapshotRate = v.playbackRate;
    return { bufferPaused, adPaused, holdResumed, snapshotRate };
  });
  log('AUD-01 browser buffering pauses', controls.bufferPaused, true, controls.bufferPaused);
  log('AUD-01 browser advertisement pauses', controls.adPaused, true, controls.adPaused);
  log('AUD-01 browser clearing hold resumes', controls.holdResumed, true, controls.holdResumed);
  log('AUD-04 browser snapshot rate', controls.snapshotRate, 1.5, controls.snapshotRate === 1.5);
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v.readyState >= 2 && !v.seeking; });
  const adSeek = await page.evaluate(async () => {
    const v = document.querySelector('video'); v.pause();
    const p = new Audit.PlayerController(); p.video = v; p.isAdActive = true;
    const before = v.currentTime;
    p.applyRemote('pause', 80, true);
    return { before, after: v.currentTime, readyState: v.readyState, pending: !!p.pendingApply };
  });
  log('AUD-05 browser ad timeline untouched', adSeek, 'same position; latest command queued until ad ends', Math.abs(adSeek.after - adSeek.before) < 1 && adSeek.pending);
  const scanBudget = await page.evaluate(async () => {
    const p = new Audit.PlayerController();
    const original = document.querySelectorAll.bind(document); let fullScans = 0;
    document.querySelectorAll = function(selector) { if (selector === '*') fullScans++; return original(selector); };
    p.start(); fullScans = 0;
    for (let i = 0; i < 200; i++) { const el = document.createElement('div'); el.textContent = 'feed update'; document.body.append(el); }
    await new Promise(r => setTimeout(r, 500)); p.stop();
    return fullScans;
  });
  log('PERF irrelevant DOM mutations avoid full scan', scanBudget, 0, scanBudget === 0);
  await page.close();

  if (process.env.AUDIT_SERVER) {
    const harness = await esbuild.build({ entryPoints: [resolve(root, 'docs/audit/playback-harness.ts')], bundle: true, write: false,
      format: 'iife', globalName: 'Playback', alias: { 'webextension-polyfill': resolve(root, 'extension/tests/stubs/webextension-polyfill.ts') } });
    const room = 'browser-' + Date.now();
    const newPeer = async () => {
      const p = await context.newPage(); await p.goto('http://127.0.0.1:8790/playback');
      await p.waitForFunction(() => document.querySelector('video').readyState >= 2);
      await p.addScriptTag({ content: harness.outputFiles[0].text });
      await p.evaluate(async ({ room, server }) => { window.peer = await Playback.startPeer(room, server); }, { room, server: process.env.AUDIT_SERVER });
      await p.waitForFunction(() => window.peer.session.phase === 'joined'); return p;
    };
    const a = await newPeer(), b = await newPeer();
    await b.waitForTimeout(800);
    await a.evaluate(async () => { const v = document.querySelector('video'); v.currentTime = 30; await v.play(); });
    await b.waitForTimeout(1000);
    const state = await b.locator('video').evaluate(v => ({ paused: v.paused, time: v.currentTime }));
    log('PLAYBACK E2E real video play/seek through Worker', state, 'playing near 30', !state.paused && state.time > 29 && state.time < 35);
    await a.locator('video').evaluate(v => v.pause()); await b.waitForTimeout(800);
    log('PLAYBACK E2E pause through Worker', await b.locator('video').evaluate(v => v.paused), true, await b.locator('video').evaluate(v => v.paused));
    await a.locator('video').evaluate(v => { v.playbackRate = 1.5; }); await b.waitForTimeout(700);
    const c = await newPeer(); await c.waitForTimeout(800);
    log('PLAYBACK E2E late join restores base speed', await c.locator('video').evaluate(v => v.playbackRate), 1.5, await c.locator('video').evaluate(v => v.playbackRate) === 1.5);
    // Technical holds do not override a manual room pause.
    await a.evaluate(() => window.peer.buffer(true)); await c.waitForTimeout(300);
    await b.evaluate(() => window.peer.buffer(true)); await a.evaluate(() => window.peer.buffer(false)); await c.waitForTimeout(400);
    log('PLAYBACK E2E overlapping buffer holds', await c.locator('video').evaluate(v => v.paused), true, await c.locator('video').evaluate(v => v.paused));
    await b.evaluate(() => window.peer.buffer(false)); await c.waitForTimeout(400);
    log('PLAYBACK E2E holds preserve manual pause', await c.locator('video').evaluate(v => v.paused), true, await c.locator('video').evaluate(v => v.paused));
    await a.evaluate(() => window.peer.send({ kind: 'player-event', action: 'play', paused: false, currentTime: 40, rate: 1.5 }));
    await b.evaluate(() => window.peer.send({ kind: 'player-event', action: 'pause', paused: true, currentTime: 900, rate: 4 }));
    await c.waitForTimeout(700);
    const converged = await Promise.all([a, b, c].map(p => p.locator('video').evaluate(v => ({ paused: v.paused, time: v.currentTime, rate: v.playbackRate }))));
    log('PLAYBACK E2E ordered guest safety pause converges', converged, 'all paused near 40 at 1.5', converged.every(v => v.paused && v.time > 39 && v.time < 43 && v.rate === 1.5));
    const text = '<img src=x onerror=alert(1)>'.padEnd(200, 'я');
    const sent = await a.evaluate(text => window.peer.text(text), text);
    await b.waitForFunction(text => window.peer.session.chatLog.at(-1)?.text === text, text);
    const logs = await Promise.all([a,b,c].map(p => p.evaluate(() => window.peer.session.chatLog.map(e=>({text:e.text,self:e.self})))));
    log('CHAT E2E 200-character text relays once to every participant', {sent,counts:logs.map(l=>l.length)}, 'one local copy, one remote copy per participant', sent.ok&&logs.every(l=>l.length===1&&l[0].text===text)&&logs[0][0].self&&!logs[1][0].self);
    await a.waitForTimeout(1100);
    await a.evaluate(async()=>{const v=document.querySelector('video');v.currentTime=50;await v.play();});
    await b.waitForFunction(()=>!document.querySelector('video').paused);
    const quick = await a.evaluate(()=>window.peer.quick('brb-sec')); await c.waitForTimeout(500);
    const paused = await Promise.all([a,b,c].map(p=>p.locator('video').evaluate(v=>({paused:v.paused,time:v.currentTime,rate:v.playbackRate}))));
    log('CHAT E2E wheel auto-pause preserves room timeline and rate', {quick,paused}, 'all paused near 50 at 1.5', quick.ok&&paused.every(v=>v.paused&&v.time>49&&v.time<54&&v.rate===1.5));
    for (const p of [a, b, c]) await p.close();
  }

  log('Extension E2E', 'NOT RUN: environment administrator disables unpacked extension loading', 'run on a permitted Chrome test environment', null);
} finally {
  writeFileSync(resolve(root, process.env.AUDIT_OUTPUT || 'docs/audit/browser-results.json'), JSON.stringify(results, null, 2) + '\n');
  await context?.close(); await new Promise(r => fixture.close(r)); rmSync(profile, { recursive: true, force: true });
}
