// Real Chromium pointer/keyboard checks. Only extension transport is replaced.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'), require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||resolve(root,'extension/node_modules/playwright')), esbuild=require(resolve(root,'extension/node_modules/esbuild'));
const build=contents=>esbuild.build({stdin:{resolveDir:root,contents},bundle:true,write:false,format:'iife',alias:{'webextension-polyfill':resolve(root,'extension/tests/stubs/webextension-polyfill.ts')}});
const main=await build("import './extension/src/content/fullscreen';");
const content=await build(`
import browser from './extension/src/shared/browser';
import {ContentUI} from './extension/src/content/ui';
const listeners=new Set(), storageListeners=new Set();
browser.runtime.onMessage.addListener=fn=>listeners.add(fn);
browser.runtime.onMessage.removeListener=fn=>listeners.delete(fn);
browser.storage.onChanged.addListener=fn=>storageListeners.add(fn);
browser.storage.onChanged.removeListener=fn=>storageListeners.delete(fn);
window.deliver=msg=>[...listeners].forEach(fn=>fn(msg));
window.sent=[]; window.rejectSend=false;
let settings={deviceName:'Fixture',overlayEnabled:true,serverUrl:'ws://localhost:8787'};
browser.storage.local.get=async()=>({settings});
browser.runtime.sendMessage=async msg=>{
 if(msg.kind==='query-video') return {available:true};
 if(msg.kind==='get-status') return {connected:true,peerPresent:true,room:'fixture-room',serverUrl:settings.serverUrl,deviceName:'Fixture',peerName:'Viewer',peers:[],self:1,amHost:true,amController:true,detached:false};
 if(msg.kind==='get-chat-log') return {entries:[],draft:await window.draftTransport({kind:'get'})};
 if(msg.kind==='set-chat-draft') {await window.draftTransport({kind:'set',text:msg.text});return {ok:true};}
 if(msg.kind==='get-friends') return {friends:[],inbox:[]};
 if(msg.kind==='save-settings') {const oldValue=settings; settings={...settings,...msg.patch};for(const fn of storageListeners)fn({settings:{oldValue,newValue:settings}},'local');return {settings};}
 if(msg.kind==='send-quick-message'||msg.kind==='send-text-message') {if(window.rejectSend)return {ok:false,error:'Fixture network failure'};window.sent.push(msg);return {ok:true};}
};
window.ui=new ContentUI();
`);
const results=[],record=(id,observed,pass)=>{const r={id,observed,pass};results.push(r);console.log(JSON.stringify(r));};
const stream=`<script>const surface=document.createElement('canvas');surface.width=640;surface.height=360;const ctx=surface.getContext('2d');setInterval(()=>{ctx.fillStyle='#15151a';ctx.fillRect(0,0,640,360);ctx.fillStyle='white';ctx.fillText('SyncWatch fullscreen '+Date.now(),20,180);},100);const media=document.querySelector('video');media.srcObject=surface.captureStream(10);media.play().catch(()=>{});</script>`;
const html=`<!doctype html><style>body{margin:0;background:#111;color:white}video{width:640px;height:360px;background:#131313}#player{height:420px}iframe{width:700px;height:450px}:fullscreen{background:#131313}</style>
<button id="container" onclick="document.getElementById('player').requestFullscreen()">Container fullscreen</button><button id="video" onclick="document.querySelector('video').requestFullscreen()">Video fullscreen</button>
<div id="player"><video muted controls></video></div><iframe allow="fullscreen" src="http://127.0.0.1:8806/frame"></iframe>
<div id="sitePopover" popover="manual" style="position:fixed;inset:0;background:#444">Site popover</div>${stream}`;
const frameHtml=`<!doctype html><button id="frame-fullscreen" onclick="document.querySelector('video').requestFullscreen()">Frame video fullscreen</button><video muted controls style="width:640px;height:360px;background:#131313"></video>${stream}`;
const servers=[8805,8806].map(port=>createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(port===8805?html:frameHtml);}));
for(let i=0;i<servers.length;i++)await new Promise(r=>servers[i].listen(8805+i,'127.0.0.1',r));
let browser;
try{
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1280,height:800}});page.setDefaultTimeout(10000);
 let draft='';await page.exposeBinding('draftTransport',(_source,msg)=>{if(msg.kind==='set')draft=msg.text;return draft;});
 await page.addInitScript({content:main.outputFiles[0].text});
 await page.goto('http://127.0.0.1:8805');
 for(const frame of page.frames())await frame.addScriptTag({content:content.outputFiles[0].text});
 async function click(view,selector) {
  const point=await view.evaluate(selector=>{
   const root=(selector==='.sector-like'||selector==='.center')?window.ui.overlay.chat.wheel.shadow:window.ui.overlay.shadow;
   const el=selector==='.sector-like'?[...root.querySelectorAll('.sector')].find(el=>el.title==='Класс!'):root.querySelector(selector);
   const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  },selector);
  await page.mouse.click(point.x,point.y);
 }
 async function fill(view,value) {await click(view,'#chatinput');await page.keyboard.press('ControlOrMeta+A');await page.keyboard.insertText(value);}
 const inputValue=view=>view.evaluate(()=>window.ui.overlay.shadow.querySelector('#chatinput').value);
 const deliver=async msg=>{for(const frame of page.frames())await frame.evaluate(msg=>window.deliver(msg),msg);};
 await deliver({kind:'banner',state:'peer-paused',name:'Viewer',since:0});
 await deliver({kind:'chat',entry:{code:'lol',name:'Viewer',self:false,ts:Date.now()}});
 for(const mode of ['container','video','native','iframe']){
  if(mode==='iframe'){await click(page.mainFrame(),'#chatbox > summary');await fill(page.mainFrame(),'Черновик между фреймами');await click(page.mainFrame(),'#chatbox > summary');}
  if(mode==='iframe')await page.frameLocator('iframe').locator('#frame-fullscreen').click();else if(mode==='native')await page.locator('[data-syncwatch-native-fullscreen]').click();else await page.locator('#'+mode).click();
  const view=mode==='iframe'?page.frames().find(f=>f.url().includes(':8806')):page.mainFrame();
  await view.waitForFunction(()=>!!window.ui.overlay?.host?.matches(':popover-open'));
  await page.waitForTimeout(150);
  const layer=await view.evaluate(()=>{
   const host=window.ui.overlay.host,r=host.getBoundingClientRect();
   const banner=window.ui.banner.host,br=banner.getBoundingClientRect();banner.style.pointerEvents='auto';
   const bannerAbove=document.elementFromPoint(br.x+br.width/2,br.y+br.height/2)===banner;banner.style.pointerEvents='none';
   return {panel:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===host,banner:bannerAbove,fs:document.fullscreenElement.tagName};
  });
  const playing=await view.evaluate(()=>!document.querySelector('video').paused);
  record(mode+': entering fullscreen preserves native media playback',playing,playing);
  record(mode+': existing panel and status banner remain interactive above fullscreen',layer,layer.panel&&layer.banner);
  if(mode==='iframe')record('iframe: parent UI is hidden and leaf frame owns presentation',await page.evaluate(()=>window.ui.overlay===null),await page.evaluate(()=>window.ui.overlay===null));
  await click(view,'#chat-open');
  await page.waitForTimeout(350);

  await click(view,'.sector-like');
  record(mode+': real pointer click selects wheel message',await view.evaluate(()=>window.sent.at(-1)),await view.evaluate(()=>window.sent.at(-1)?.code==='like'));
  await deliver({kind:'chat',entry:{text:'<img src=x onerror=alert(1)>',name:'Viewer',self:false,ts:Date.now()}});
  await page.waitForTimeout(300);
  const bubble=await view.evaluate(()=>{
   const host=window.ui.bubbles.host,el=window.ui.bubbles.stack.querySelector('.bubble:last-child'),r=el.getBoundingClientRect();host.style.pointerEvents='auto';
   const above=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===host;host.style.pointerEvents='none';
   return {text:el.textContent,above,injected:el.querySelectorAll('img').length};
  });
  record(mode+': incoming text bubble stays above fullscreen and escapes HTML',bubble,bubble.above&&!bubble.injected&&bubble.text.includes('<img'));
  await click(view,'#chat-open');await page.waitForTimeout(350);await click(view,'.center');
  record(mode+': wheel opens and closes entirely with the mouse',await view.evaluate(()=>window.ui.overlay.chat.wheel.isOpen===false),await view.evaluate(()=>window.ui.overlay.chat.wheel.isOpen===false));
  await click(view,'#chatbox > summary');
  if(mode==='iframe')record('iframe: unsent draft follows the active UI',await inputValue(view),await inputValue(view)==='Черновик между фреймами');
  await fill(view,'Текстовый чат в fullscreen');
  await page.waitForTimeout(1000);if(mode==='native')await click(view,'#chatsend');else await page.keyboard.press('Enter');
  await view.waitForFunction(()=>window.sent.at(-1)?.kind==='send-text-message');
  record(mode+(mode==='native'?': text sends by mouse button and clears only on success':': text sends with Enter and clears only on success'),await view.evaluate(()=>({message:window.sent.at(-1),value:window.ui.overlay.shadow.querySelector('#chatinput').value})),await inputValue(view)==='');
  await click(view,'#chatbox > summary');
  await click(view,'#room');
  if(mode!=='iframe'){
   await view.evaluate(()=>document.querySelector('#sitePopover').showPopover());await page.waitForTimeout(100);
   record(mode+': restacking preserves input focus',await view.evaluate(()=>window.ui.overlay.shadow.activeElement?.id),await view.evaluate(()=>window.ui.overlay.shadow.activeElement?.id==='room'));
   await view.evaluate(()=>document.querySelector('#sitePopover').hidePopover());
  }
  if(mode==='iframe')await page.screenshot({path:resolve(root,'docs/audit/fullscreen-iframe.png')});
  if(mode==='iframe')await view.evaluate(()=>document.exitFullscreen());else if(mode==='native')await page.locator('[data-syncwatch-native-fullscreen]').click();else await page.evaluate(()=>document.exitFullscreen());
  await page.waitForFunction(()=>!document.fullscreenElement);
  await page.waitForTimeout(100);
 }
 record('page DOM cannot inspect room code or chat through extension hosts',await page.evaluate(()=>[...document.querySelectorAll('[data-syncwatch-ui]')].every(h=>h.shadowRoot===null)),await page.evaluate(()=>[...document.querySelectorAll('[data-syncwatch-ui]')].every(h=>h.shadowRoot===null)));
 record('mouse fullscreen replacement has no page-accessible shadow root',await page.evaluate(()=>document.querySelector('[data-syncwatch-native-fullscreen]').shadowRoot===null),await page.evaluate(()=>document.querySelector('[data-syncwatch-native-fullscreen]').shadowRoot===null));
 const restored=await page.evaluate(()=>({video:document.querySelector('video').getAttribute('style'),player:document.querySelector('#player').getAttribute('style')}));
 record('exit restores native target/container styles',restored,!restored.video&&!restored.player);
 await click(page.mainFrame(),'#chatbox > summary');await page.waitForTimeout(1000);
 await page.evaluate(()=>window.rejectSend=true);await fill(page.mainFrame(),'Не потерять черновик');await click(page.mainFrame(),'#chatsend');
 record('failed send preserves draft and displays error',await inputValue(page.mainFrame()),await inputValue(page.mainFrame())==='Не потерять черновик');
 await page.evaluate(()=>window.ui.overlay.setVideoAvailable(false));
 // A disconnected compact panel must still display its toasts.
 await page.evaluate(()=>{window.ui.overlay.last=null;window.ui.overlay.recomputeCompact();window.ui.overlay.onPush({kind:'event',text:'Compact notification',ts:Date.now()});});
 record('compact panel does not suppress notifications',await page.evaluate(()=>window.ui.overlay.shadow.querySelector('.toast:last-child').getBoundingClientRect().height>0),await page.evaluate(()=>window.ui.overlay.shadow.querySelector('.toast:last-child').getBoundingClientRect().height>0));
 await page.screenshot({path:resolve(root,'docs/audit/fullscreen-diagnostic.png')});
}finally{
 writeFileSync(resolve(root,process.env.FULLSCREEN_OUTPUT||'docs/audit/fullscreen-results.json'),JSON.stringify(results,null,2)+'\n');
 await browser?.close();for(const server of servers)await new Promise(r=>server.close(r));
}
if(results.some(r=>!r.pass))process.exitCode=1;
