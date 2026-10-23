// Two independent background module instances talking to the real local Worker.
import {createRequire} from 'node:module';
import {createContext,runInContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(import.meta.url);
const esbuild=require(resolve(root,'extension/node_modules/esbuild'));
const endpoint=process.env.AUDIT_HTTP||'http://127.0.0.1:8787',ws=endpoint.replace(/^http/,'ws');
const bundle=await esbuild.build({stdin:{resolveDir:root,contents:`
import browser from './extension/src/shared/browser';
import {getSession} from './extension/src/background/state';
export * from './extension/src/background/friends';
export {ensureIdentity,saveSettings} from './extension/src/shared/settings';
export const store=new Map(),events=[],tabs=[],alarms=[];
browser.storage.local.get=async key=>({[key]:store.get(key)});
browser.storage.local.set=async values=>{for(const [key,value]of Object.entries(values))store.set(key,value);};
browser.tabs.query=async()=>[{id:1}];browser.tabs.sendMessage=async(id,msg)=>{events.push(msg);};
browser.tabs.create=async options=>{tabs.push(options);};browser.alarms.create=(name,options)=>alarms.push({name,options});
export function room(serverUrl,room){const s=getSession(1);s.connected=true;s.room=room;s.serverUrl=serverUrl;s.intentionalClose=false;}
`},bundle:true,write:false,format:'iife',globalName:'Harness',alias:{'webextension-polyfill':resolve(root,'extension/tests/stubs/webextension-polyfill.ts')}});
function peer(name){const context=createContext({crypto:webcrypto,TextEncoder,AbortSignal,URL,console,navigator:{userAgent:'Chrome Linux'},fetch,setTimeout,clearTimeout});runInContext(bundle.outputFiles[0].text,context);const api=context.Harness;api.store.set('settings',{serverUrl:ws,deviceName:name,sharePresence:true});return api;}
const a=peer('A'),b=peer('B'),results=[];
const record=(id,observed,pass)=>{const row={id,observed,pass};results.push(row);console.log(JSON.stringify(row));};
try{
 let response;await a.handleAddFriendLink(r=>{response=r;});
 if(!response.link)throw new Error(response.error);
 const link=new URL(response.link),q=new URLSearchParams(link.hash.slice(1));
 const ai=await a.ensureIdentity(),bi=await b.ensureIdentity();
 record('first friend invitation starts polling and keeps owner key private',{alarm:a.alarms.some(x=>x.name==='syncwatch-presence'),hasToken:!!q.get('t')},a.alarms.some(x=>x.name==='syncwatch-presence')&&!response.link.includes(ai.privateKey.d));
 await b.handleFriendRequestIncoming({kind:'friend-request-incoming',id:q.get('syncwatch-friend'),name:q.get('n'),serverUrl:q.get('s'),inviteToken:q.get('t')});
 await b.handleAcceptFriend(ai.clientId);await a.pollPresence();
 const af=a.store.get('friends'),bf=b.store.get('friends');
 record('both background instances complete authenticated friendship',{a:af?.length,b:bf?.length},af?.[0]?.id===bi.clientId&&bf?.[0]?.id===ai.clientId);
 a.room(ws,'private-room');await a.beatPresence();await b.pollPresence();
 const status=b.events.filter(x=>x.kind==='friends-status').at(-1);
 record('friend receives watching status and room through real Worker',status?.friends?.map(f=>({status:f.status,room:f.room})),status?.friends?.[0]?.status==='watching'&&status.friends[0].room==='private-room');
 await b.handleJoinFriend(ai.clientId);
 record('join friend opens explicit room invitation',b.tabs.at(-1),b.tabs.at(-1)?.url.includes('/join#r=private-room&s='));
 const forged=await fetch(endpoint+'/presence/query',{method:'POST',headers:{authorization:'Signature '+'f'.repeat(128)},body:JSON.stringify({clientId:ai.clientId,friendIds:[bi.clientId]})});
 record('known public ID cannot impersonate its owner',forged.status,forged.status===401);
 await a.saveSettings({sharePresence:false});await a.revokePresence();await b.pollPresence();
 const offline=b.events.filter(x=>x.kind==='friends-status').at(-1)?.friends[0];
 record('disabling sharing revokes room visibility',offline?.status,offline?.status==='offline');
 await b.handleRemoveFriend(ai.clientId);await b.pollPresence();
 record('removed friend stays removed after subsequent query',b.store.get('friends')?.length,b.store.get('friends')?.length===0);
}catch(error){record('integration completes',String(error),false);}finally{writeFileSync(resolve(root,'docs/audit/friends-fixed-results.json'),JSON.stringify(results,null,2)+'\n');}
if(results.some(r=>!r.pass))process.exitCode=1;
