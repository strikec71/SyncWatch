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
window.settings={language:'ru',deviceName:'Алекс',overlayEnabled:true,serverUrl:'wss://fixture.test',room:'watch-fixture'};
window.fixtureStatus={connected:true,peerPresent:true,room:'watch-fixture',serverUrl:'wss://fixture.test',deviceName:'Алекс',self:1,amHost:true,amController:true,detached:false,peers:[{id:1,name:'Алекс',isHost:true,hasControl:false,detached:false},{id:2,name:'Мира',isHost:false,hasControl:false,detached:false},{id:3,name:'Лео',isHost:false,hasControl:true,detached:false}]};
window.fixtureFriends=[{id:'mira',name:'Мира',status:'watching'},{id:'leo',name:'Лео',status:'online'}];
window.deliver=msg=>[...listeners].forEach(fn=>fn(msg));
const entries=[{name:'Мира',text:'Все готовы? Я уже с попкорном 🍿',self:false,ts:Date.now()-120000},{name:'Алекс',text:'Да! Смотрим вместе.',self:true,ts:Date.now()-60000},{name:'Лео',text:'Обожаю этот момент.',self:false,ts:Date.now()}];
let draft='';
window.fixtureEntries=entries;window.fixtureClearDraft=()=>{draft='';};
browser.storage.local.get=async()=>({settings:window.settings});
browser.runtime.sendMessage=async msg=>{
 if(msg.kind==='query-video')return {available:true};
 if(msg.kind==='get-status')return window.fixtureStatus;
 if(msg.kind==='get-chat-log')return {entries,draft};
 if(msg.kind==='set-chat-draft'){draft=msg.text;return {ok:true};}
 if(msg.kind==='get-friends')return {friends:window.fixtureFriends,inbox:[]};
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
  // The closed shadow root needs coordinate input. Wait for reflow/animations
  // before measuring, just as a locator click waits for a stable target.
  await page.waitForFunction(async selector => {
   const el=window.ui.overlay.shadow.querySelector(selector);el.scrollIntoView({block:'nearest'});
   let previous='',stable=0;
   for(let i=0;i<30;i++){
    await new Promise(requestAnimationFrame);const r=el.getBoundingClientRect();
    const current=[r.x,r.y,r.width,r.height].join(',');stable=current===previous?stable+1:0;previous=current;
    if(stable>=3&&r.width&&r.height)return true;
   }
   return false;
  }, selector);
  const point = await page.evaluate(selector => { const el=window.ui.overlay.shadow.querySelector(selector);el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden control: '+selector);return {x:r.x+r.width/2,y:r.y+r.height/2}; }, selector);
  await page.mouse.click(point.x, point.y);
 }
 async function select(selector, value) {
  const index = await page.evaluate(({selector,value}) => [...window.ui.overlay.shadow.querySelector(selector).options].findIndex(o=>o.value===value), {selector,value});
  await click(selector); await page.keyboard.press('Home'); for(let i=0;i<index;i++)await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await page.waitForFunction(({selector,value})=>window.settings[window.ui.overlay.shadow.querySelector(selector).id]===value,{selector,value});
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
 await click('#uiOpacity');await page.keyboard.press('Home');
 await page.waitForFunction(()=>window.settings.uiOpacity===85);
 await click('#uiMotion');
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
 await page.setViewportSize({width:1280,height:800});
 await click('#tab-appearance'); await select('#language','en');
 record('English selection updates static labels, placeholders and live room status',true,await read(()=>{
  const root=window.ui.overlay.shadow;
  return root.querySelector('#tab-room').textContent==='Room'&&root.querySelector('#tab-chat').textContent.startsWith('Chat')&&root.querySelector('#participant-count').textContent==='3 participants / 10'&&root.querySelector('#room').placeholder==='Paste a code or create one'&&root.querySelector('#s').textContent==='In sync · watching together'&&window.ui.overlay.host.lang==='en';
 }));
 await click('#tab-chat'); await click('#chatinput'); await page.keyboard.insertText('Комната <b>do not translate</b>');
 await click('#tab-appearance'); await select('#language','ru'); await select('#language','en'); await click('#tab-chat');
 record('switching language preserves the draft and room connection',true,await read(()=>window.ui.overlay.shadow.querySelector('#chatinput').value==='Комната <b>do not translate</b>'&&window.fixtureStatus.connected&&window.settings.room==='watch-fixture'&&window.settings.serverUrl==='wss://fixture.test'));
 await read(()=>window.deliver({kind:'chat',entry:{name:'Комната',text:'Класс! <b>user content</b>',self:false,ts:Date.now()}}));
 record('Russian names and free text stay verbatim in English',true,await read(()=>window.ui.overlay.shadow.querySelector('#chatlog').lastElementChild.textContent.includes('Комната')&&window.ui.overlay.shadow.querySelector('#chatlog').lastElementChild.textContent.includes('Класс! <b>user content</b>')&&!window.ui.overlay.shadow.querySelector('#chatlog').lastElementChild.querySelector('b')));
 await read(()=>window.deliver({kind:'chat',entry:{name:'Maya',code:'like',self:false,ts:Date.now()}}));
 record('coded quick messages use the receiving language',true,await read(()=>window.ui.overlay.shadow.querySelector('#chatlog').lastElementChild.textContent.includes('Nice!')));
 await click('#tab-friends');
 record('friend controls and status use English',true,await read(()=>window.ui.overlay.shadow.querySelector('#friend-add').textContent==='Add friend'&&window.ui.overlay.shadow.querySelector('.fsub').textContent==='watching'));
 await click('#tab-appearance'); await click('#appearance-reset');
 record('appearance reset preserves language selection',await read(()=>window.settings.language),await read(()=>window.settings.language==='en'));
 await read(()=>{window.ui.overlay.unmount();window.ui.overlay=null;window.ui.reconcile();});
 await page.waitForFunction(()=>window.ui.overlay?.host?.lang==='en'&&window.ui.overlay.shadow.querySelector('#tab-room').textContent==='Room');
 record('saved English preference survives a full panel remount',true,await read(()=>window.ui.overlay.shadow.querySelector('#language').value==='en'));
 if(process.env.STORE_SCREENSHOTS){
  const store=resolve(process.env.STORE_SCREENSHOTS);mkdirSync(store,{recursive:true});
  await page.emulateMedia({reducedMotion:'reduce'});
  await read(()=>{
   window.settings={...window.settings,deviceName:'Avery',room:'watch-demo'};
   window.fixtureFriends=[{id:'mira',name:'Maya',status:'watching'},{id:'leo',name:'Leo',status:'online'}];
   window.ui.bubbles.destroy();window.ui.recent=[];
   window.fixtureStatus={...window.fixtureStatus,room:'watch-demo',deviceName:'Avery',peers:[{id:1,name:'Avery',isHost:true,hasControl:false,detached:false},{id:2,name:'Maya',isHost:false,hasControl:false,detached:false},{id:3,name:'Leo',isHost:false,hasControl:true,detached:false}]};
   window.fixtureEntries.splice(0,window.fixtureEntries.length,{name:'Maya',text:'Ready? I brought popcorn 🍿',self:false,ts:Date.now()-120000},{name:'Avery',text:'Ready! Let’s watch together.',self:true,ts:Date.now()-60000},{name:'Leo',text:'Love this scene.',self:false,ts:Date.now()});
   window.fixtureClearDraft();window.ui.overlay.unmount();window.ui.overlay=null;window.ui.reconcile();
   document.body.insertAdjacentHTML('beforeend',`<main id="store-scene"><div class="store-brand">SYNCWATCH <span>WATCH TOGETHER, WHEREVER YOU ARE</span></div><h1 id="store-title">Your people.<br>Your movie night.</h1><p id="store-copy">Synchronized playback, a room for your friends,<br>and a little more togetherness.</p><div class="demo-film"><div class="orb"></div><div class="film-caption"><small>A SHARED MOMENT</small><h2>Beyond the evening</h2><div class="timeline"><i></i></div><span>▶ &nbsp; 12:34 / 48:20 &nbsp; &nbsp; ⛶</span></div></div><footer>Up to 10 participants · English & Русский · No SyncWatch account needed<br><small>Illustrative room data. Everyone opens the original video on their own device.</small></footer></main><style>body{margin:0;background:radial-gradient(ellipse at 10% 12%,#40335b 0,transparent 55%),#10131c;color:#f6f3ff;font:16px system-ui}#store-scene{width:calc(100% - 440px);padding:36px 38px;box-sizing:border-box}.store-brand{font-size:14px;letter-spacing:3px;font-weight:700;color:#d7caff}.store-brand span{display:block;font-size:9px;letter-spacing:2px;margin-top:10px;font-weight:500;color:#c2b7cc}h1{font-size:50px;line-height:1.08;letter-spacing:-2px;margin:36px 0 16px}#store-copy{font-size:17px;line-height:1.6;color:#c8bfd9;margin:0 0 26px}.demo-film{height:275px;background:radial-gradient(ellipse at 75% 10%,#8075a4,transparent 45%),linear-gradient(160deg,#34384b,#1c2e38 65%,#343048);border-radius:20px;position:relative;overflow:hidden;border:1px solid #ffffff18;box-shadow:0 18px 50px #0003}.orb{position:absolute;width:170px;height:170px;border-radius:50%;background:linear-gradient(135deg,#c3a6be,#5f658b 70%,#293e4a);box-shadow:0 0 80px #d8aed633;right:70px;top:30px}.film-caption{position:absolute;inset:auto 22px 18px}.film-caption small{font-size:9px;letter-spacing:3px;color:#e9d9ee}.film-caption h2{margin:6px 0 36px;font-weight:400;font-size:25px}.timeline{height:3px;background:#ffffff40;margin-bottom:12px}.timeline i{display:block;width:28%;height:3px;background:#d6b6ed}.film-caption span{font-size:11px;color:#e7deed}footer{font-size:12px;color:#c0b4ce;line-height:1.8;margin-top:22px}footer small{font-size:10px;color:#948ca2}</style>`);
  });
  await page.waitForFunction(()=>window.ui.overlay?.shadow?.querySelector('#participant-count').textContent==='3 participants / 10');
  async function storeShot(name,title,copy,tab){
   await click('#tab-'+tab);
   await page.evaluate(({title,copy})=>{document.querySelector('#store-title').innerHTML=title;document.querySelector('#store-copy').textContent=copy;},{title,copy});
   await page.waitForTimeout(350);await page.screenshot({path:resolve(store,name+'.png')});
  }
  await storeShot('01-watch-together','Your people.<br>Your movie night.','Synchronized playback, shared controls, and one room for up to 10 participants.','room');
  await storeShot('02-room-chat','A conversation.<br>Right beside the film.','Chat in your room, keep your draft, and see unread messages at a glance.','chat');
  await storeShot('03-make-it-yours','Your lounge.<br>Your language.','English or Русский. Choose your theme, gradient, size, opacity, motion and screen side.','appearance');
  await storeShot('04-friends','Keep your<br>people close.','Invite a friend with a link, see their presence, and join the room they are watching in.','friends');
  await storeShot('05-mini-launcher','Small icon.<br>Still connected.','Minimize the panel and keep connection and unread indicators within reach.','room');
  await click('#m'); await page.waitForFunction(()=>Math.abs(window.ui.overlay.host.getBoundingClientRect().width-52)<.1);
  await page.screenshot({path:resolve(store,'05-mini-launcher.png')});
 }
} finally {
 writeFileSync(resolve(out,'results.json'),JSON.stringify(results,null,2)+'\n');
 await browser?.close();await new Promise(r=>server.close(r));
}
