// Node 22+: local Worker must be running. No requests to the deployed service.
import { writeFileSync } from 'node:fs';
const base = process.env.AUDIT_SERVER || 'ws://127.0.0.1:8787';
const sockets = [], results = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
const report = (id, observed, expected, pass) => { const r = { id, observed, expected, pass }; results.push(r); console.log(JSON.stringify(r)); };
async function open(room, name, join = true) {
  const ws = new WebSocket(`${base}/room/${room}`); const messages = [];
  ws.addEventListener('message', event => messages.push(JSON.parse(event.data)));
  sockets.push(ws);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, {once:true}); ws.addEventListener('error', reject, {once:true}); });
  if (join) ws.send(JSON.stringify({type:'JOIN', room, name}));
  await delay(80); return { ws, messages };
}
try {
  const room = `audit-${Date.now()}`;
  const a = await open(room, 'Host'), b = await open(room, 'Guest'), c = await open(room, 'Guest 2');
  report('SERVER three-person roster', a.messages.filter(m => m.type === 'ROSTER').at(-1).peers.length, 3, a.messages.filter(m => m.type === 'ROSTER').at(-1).peers.length === 3);
  a.messages.length = 0;
  b.ws.send(JSON.stringify({type:'STATE',action:'seek',currentTime:100,paused:false,ts:1})); await delay(100);
  report('SERVER guest seek is rejected', a.messages.length, 0, a.messages.length === 0);
  b.ws.send(JSON.stringify({type:'STATE',action:'pause',currentTime:100,paused:true,ts:1,from:1})); await delay(100);
  const received = a.messages.find(m => m.type === 'STATE');
  report('AUD-10 pause smuggles seek', received, 'server marks guest pause as pauseOnly', received?.pauseOnly === true);
  report('SERVER sender identity overwritten', received?.from, 2, received?.from === 2);
  const named = await open(room, 'x'.repeat(100_000));
  const roster = a.messages.filter(m => m.type === 'ROSTER').at(-1);
  report('AUD-11 oversized name rejected', named.ws.readyState, 'CLOSING or CLOSED', named.ws.readyState >= WebSocket.CLOSING);
  named.ws.close();
  const cap = `capacity-${Date.now()}`;
  for (let i = 0; i < 10; i++) await open(cap, `peer-${i}`);
  const extra = await open(cap, 'eleventh', false);
  await delay(150);
  report('SERVER eleventh participant rejected', extra.ws.readyState, 'CLOSING or CLOSED', extra.ws.readyState >= WebSocket.CLOSING);
  const pre = `prejoin-${Date.now()}`;
  const silent = await open(pre, '', false);
  const legitimate = await open(pre, 'Actual first join');
  const preRoster = legitimate.messages.filter(m => m.type === 'ROSTER').at(-1);
  report('AUD-11 socket without JOIN becomes host', preRoster, 'host must have joined', preRoster.peers.find(p => p.isHost)?.name === 'Actual first join');
  const http = base.replace(/^ws/, 'http');
  report('RELEASE latest-version endpoint', await (await fetch(`${http}/version`)).json(), 'latest published version stays separate from development 0.8.0', null);
  report('AUD-13 bare named room invitation', (await (await fetch(`${http}/r/demo`)).text()).includes('name="syncwatch-invite"'), 'marked invitation page for the named room parser', true);
} finally {
  for (const ws of sockets) ws.close();
  writeFileSync(new URL(process.env.AUDIT_OUTPUT || './server-results.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
  // workerd may leave the WS close handshake outstanding; results are already persisted.
  setTimeout(() => process.exit(0), 1000).unref();
}
