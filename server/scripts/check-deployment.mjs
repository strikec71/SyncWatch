// Check the exact deployed revision and an isolated room; never use a user room.
import { readFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const [target, expectedRevision] = process.argv.slice(2);
if (!target || !/^[a-f0-9]{40}$/.test(expectedRevision || '')) throw new Error('Usage: node scripts/check-deployment.mjs <url-or-wrangler-log> <commit-sha>');
let base;
if (/^https?:\/\//.test(target)) base = new URL(target);
else {
  const matches = readFileSync(target,'utf8').match(/https:\/\/syncwatch-signal\.[a-z0-9-]+\.workers\.dev\b/g);
  if (!matches?.length) throw new Error('Wrangler did not report its workers.dev URL; set SYNCWATCH_SERVER_URL for a custom domain');
  base = new URL(matches.at(-1));
}
if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname)))) throw new Error('Expected an HTTPS server URL (HTTP only for localhost)');
const options = { signal: AbortSignal.timeout(15_000), redirect:'error' };
const health = await fetch(new URL('/healthz',base),options);
if (!health.ok) throw new Error(`Health check failed: ${health.status}`);
const metadata = await health.json();
const version = JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
if (metadata.service !== 'syncwatch-signal' || metadata.version !== version || metadata.revision !== expectedRevision) throw new Error('Health response is not the release that was deployed');
const privacy = await fetch(new URL('/privacy',base),{...options,signal:AbortSignal.timeout(15_000)});
if (!privacy.ok || !(await privacy.text()).includes('Присутствие')) throw new Error('Privacy page unavailable');
const room = new URL('/room/release-check-'+randomUUID(),base); room.protocol=base.protocol==='https:'?'wss:':'ws:';
const socket = new WebSocket(room);
try {
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('WebSocket JOIN timed out')),15_000);
    const finish=(error)=>{clearTimeout(timeout);error?reject(error):resolve();};
    socket.addEventListener('error',()=>finish(new Error('WebSocket upgrade failed')),{once:true});
    socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'JOIN',room:room.pathname.split('/').at(-1),name:'Release verification'})),{once:true});
    socket.addEventListener('message',event=>{
      let msg;try{msg=JSON.parse(event.data);}catch{return;}
      if(msg.type==='ROSTER') finish(msg.peers?.length===1&&msg.peers[0].isHost?null:new Error('Invalid release room roster'));
    });
  });
} finally { socket.close(1000,'release check complete'); }
console.log(JSON.stringify({url:base.origin,...metadata,privacy:'ok',websocket:'ok'}));
// A release build may consume this output only after every check above passed.
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `server_url=${base.origin}\n`);
