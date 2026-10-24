// Real UI modules with extension transport replaced. Pointer/keyboard actions
// exercise closed-shadow UI; no React/UI imitation is substituted.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), require = createRequire(import.meta.url);
const { chromium } = require(resolve(root, 'extension/node_modules/playwright'));
const esbuild = require(resolve(root, 'extension/node_modules/esbuild'));
const out = resolve(root, process.env.DESIGN_OUTPUT || 'docs/audit/design'); mkdirSync(out, { recursive: true });
const bundle = await esbuild.build({ stdin: { resolveDir: root, contents: `
import browser from './extension/src/shared/browser';
import {ContentUI} from './extension/src/content/ui';
const listeners=new Set(),storageListeners=new Set();
browser.runtime.onMessage.addListener=fn=>listeners.add(fn);
browser.runtime.onMessage.removeListener=fn=>listeners.delete(fn);
browser.storage.onChanged.addListener=fn=>storageListeners.add(fn);
browser.storage.onChanged.removeListener=fn=>storageListeners.delete(fn);
window.settings={deviceName:'Алекс',overlayEnabled:true,serverUrl:'wss://fixture.test',room:'watch-fixture'};
window.fixtureStatus={connected:true,peerPresent:true,room:'watch-fixture',serverUrl:'wss://fixture.test',deviceName:'Алекс',self:1,amHost:true,amController:true,detached:false,peers:[{id:1,name:'Алекс',isHost:true,hasControl:false,detached:false},{id:2,name:'Мира',isHost:false,hasControl:false,detached:false},{id:3,name:'Лео',isHost:false,hasControl:true,detached:false}]};
window.deliver=msg=>[...listeners].forEach(fn=>fn(msg));
const entries=[{name:'Мира',text:'Все готовы? Я уже с попкорном 🍿',self:false,ts:Date.now()-120000},{name:'Алекс',text:'Да! Смотрим вместе.',self:true,ts:Date.now()-60000},{name:'Лео',text:'Обожаю этот момент.',self:false,ts:Date.now()}];
let draft='';
browser.storage.local.get=async()=>({settings:window.settings});
browser.runtime.sendMessage=async msg=>{
 if(msg.kind==='query-video')return {available:true};
 if(msg.kind==='get-status')return window.fixtureStatus;
 if(msg.kind==='get-chat-log')return {entries,draft};
 if(msg.kind==='set-chat-draft'){draft=msg.text;return {ok:true};}
 if(msg.kind==='get-friends')return {friends:[{id:'mira',name:'Мира',status:'watching'},{id:'leo',name:'Лео',status:'online'}],inbox:[]};
 if(msg.kind==='save-settings'){const oldValue=window.settings;window.settings={...window.settings,...msg.patch};for(const fn of storageListeners)fn({settings:{oldValue,newValue:window.settings}},'local');return {settings:window.settings};}
 if(msg.kind==='send-text-message')return {ok:true};
};
window.ui=new ContentUI();` }, bundle: true, write: false, format: 'iife', alias: { 'webextension-polyfill': resolve(root, 'extension/tests/stubs/webextension-polyfill.ts') } });
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:linear-gradient(135deg,#111722,#28213c);height:100vh}</style><title>SyncWatch UI acceptance fixture</title>'); });
await new Promise(r => server.listen(8811, '127.0.0.1', r));
const results = [], record = (id, observed, pass) => { results.push({ id, observed, pass }); console.log(JSON.stringify(results.at(-1))); if (!pass) throw Error(id); };
let browser;
try {
 browser = await chromium.launch({ headless: true });
 const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, reducedMotion: 'no-preference' });
 page.setDefaultTimeout(10000); await page.goto('http://127.0.0.1:8811'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
 await page.waitForFunction(() => window.ui?.overlay?.host?.matches(':popover-open') && !window.ui.overlay.shadow.querySelector('.panel').classList.contains('compact'));
 const read = fn => page.evaluate(fn);
 async function click(selector) {
  const point = await page.evaluate(selector => { const el=window.ui.overlay.shadow.querySelector(selector);el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden control: '+selector);return {x:r.x+r.width/2,y:r.y+r.height/2}; }, selector);
  await page.mouse.click(point.x, point.y);
 }
 async function select(selector, value) {
  const index = await page.evaluate(({selector,value}) => [...window.ui.overlay.shadow.querySelector(selector).options].findIndex(o=>o.value===value), {selector,value});
  await click(selector); await page.keyboard.press('Home'); for(let i=0;i<index;i++)await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
 }
 async function screenshot(name) {
  await page.waitForTimeout(320);
  const rect=await read(()=>{const r=window.ui.overlay.host.getBoundingClientRect();return {x:Math.max(0,r.x-10),y:Math.max(0,r.y-10),width:r.width+20,height:r.height+20};});
  const size=page.viewportSize();rect.width=Math.min(rect.width,size.width-rect.x);rect.height=Math.min(rect.height,size.height-rect.y);
  await page.screenshot({ path: resolve(out, name+'.png'), clip: rect });
 }
 await screenshot('room');
 record('room summary reflects real roster and permissions',await read(()=>window.ui.overlay.shadow.querySelector('#participant-count').textContent),await read(()=>window.ui.overlay.shadow.querySelector('#participant-count').textContent==='3 участника / 10'));
 await click('#m'); await page.waitForFunction(()=>Math.abs(window.ui.overlay.host.getBoundingClientRect().width-52)<.1);
 record('mini launcher collapses to 52px and excludes hidden controls',await read(()=>window.ui.overlay.host.getBoundingClientRect().width),await read(()=>window.ui.overlay.shadow.querySelector('#panel-body').hasAttribute('inert')));
 await read(()=>window.deliver({kind:'chat',entry:{name:'Мира',text:'Ещё одно сообщение',self:false,ts:Date.now()}}));
 record('mini launcher shows unread messages',await read(()=>window.ui.overlay.shadow.querySelector('#mini-unread').textContent),await read(()=>!window.ui.overlay.shadow.querySelector('#mini-unread').hidden));
 await screenshot('launcher'); await click('#launcher'); await page.waitForFunction(()=>window.ui.overlay.host.getBoundingClientRect().width>330);
 await click('#tab-chat');
 record('opening chat clears unread and reveals the composer',await read(()=>window.ui.overlay.shadow.querySelector('#mini-unread').hidden),await read(()=>window.ui.overlay.shadow.querySelector('#mini-unread').hidden&&!window.ui.overlay.shadow.querySelector('#chatbox').hidden));
 await click('#chatinput');await page.keyboard.insertText('Черновик');await read(()=>window.ui.overlay.refresh());
 record('status polling preserves typing focus and draft',true,await read(()=>window.ui.overlay.shadow.activeElement.id==='chatinput'&&window.ui.overlay.shadow.querySelector('#chatinput').value==='Черновик'&&window.ui.overlay.shadow.querySelector('#chat-count').textContent==='8 / 200'));
 await page.keyboard.press('ControlOrMeta+A');await page.keyboard.press('Backspace');await click('#tab-chat');
 await screenshot('chat');
 await read(()=>window.deliver({kind:'chat',entry:{name:'<b>guest</b>',text:'<img src=x onerror=alert(1)>',self:false,ts:Date.now()}}));
 record('redesigned messages still render untrusted content as text',true,await read(()=>window.ui.overlay.shadow.querySelector('#chatlog').querySelectorAll('img,b').length===0));
 await page.keyboard.press('ArrowRight');
 record('tabs support arrow-key navigation',await read(()=>window.ui.overlay.shadow.activeElement.id),await read(()=>!window.ui.overlay.shadow.querySelector('#friendsbox').hidden));
 await screenshot('friends'); await click('#tab-appearance'); await screenshot('appearance');
 await click('[data-accent-choice="ocean"]'); await select('#uiTheme','light'); await select('#uiDensity','compact'); await select('#uiDockSide','left');
 await click('#uiOpacity');await page.keyboard.press('Home');await click('#uiMotion');
 await page.waitForFunction(()=>window.settings.uiOpacity===85&&window.settings.uiMotion===false);
 record('appearance controls persist together with connection settings',await read(()=>window.settings),await read(()=>window.settings.uiAccent==='ocean'&&window.settings.uiTheme==='light'&&window.settings.uiDensity==='compact'&&window.settings.uiDockSide==='left'&&window.settings.serverUrl==='wss://fixture.test'&&window.settings.room==='watch-fixture'));
 record('theme, size, side and reduced motion apply immediately',await read(()=>({theme:window.ui.overlay.host.dataset.theme,x:window.ui.overlay.host.getBoundingClientRect().x,width:window.ui.overlay.host.getBoundingClientRect().width})),await read(()=>window.ui.overlay.host.dataset.theme==='light'&&window.ui.overlay.host.dataset.motion==='off'&&window.ui.overlay.host.getBoundingClientRect().x<20));
 await screenshot('light');
 await read(()=>{window.ui.overlay.unmount();window.ui.overlay=null;window.ui.reconcile();});
 await page.waitForFunction(()=>window.ui.overlay?.host?.dataset.theme==='light');
 record('appearance survives remounts and retains the chosen dock side',true,await read(()=>window.ui.overlay.host.dataset.accent==='ocean'&&window.ui.overlay.host.dataset.side==='left'));
 await click('#tab-appearance');await click('#appearance-reset');
 await page.waitForFunction(()=>window.settings.uiAccent==='lounge'&&window.settings.uiTheme==='dark');
 record('appearance reset preserves room, server, and user identity',true,await read(()=>window.settings.room==='watch-fixture'&&window.settings.deviceName==='Алекс'&&window.settings.serverUrl==='wss://fixture.test'));
 await page.setViewportSize({width:320,height:640});await page.waitForTimeout(320);
 record('320px viewport keeps the entire panel within the screen',await read(()=>{const r=window.ui.overlay.host.getBoundingClientRect();return {x:r.x,right:r.right,bottom:r.bottom};}),await read(()=>{const r=window.ui.overlay.host.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
 await screenshot('narrow');
 await page.emulateMedia({reducedMotion:'reduce'});
 record('system reduced-motion preference overrides animation setting',await read(()=>getComputedStyle(window.ui.overlay.shadow.querySelector('.view:not([hidden])')).animationName),await read(()=>getComputedStyle(window.ui.overlay.shadow.querySelector('.view:not([hidden])')).animationName==='none'));
 await select('#uiDensity','compact');await click('#m');
 await page.waitForFunction(()=>Math.abs(window.ui.overlay.host.getBoundingClientRect().width-52)<.1);
 record('compact density retains the 52px launcher and keyboard focus',true,await read(()=>window.ui.overlay.shadow.activeElement.id==='launcher'&&window.ui.overlay.shadow.querySelector('#launcher').getBoundingClientRect().width===38));
 await page.setViewportSize({width:240,height:520});await page.keyboard.press('Enter');await page.waitForTimeout(350);
 record('expanding after a viewport resize stays on screen',await read(()=>window.ui.overlay.host.getBoundingClientRect().right),await read(()=>{const r=window.ui.overlay.host.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}));
} finally {
 writeFileSync(resolve(out,'results.json'),JSON.stringify(results,null,2)+'\n');
 await browser?.close();await new Promise(r=>server.close(r));
}
