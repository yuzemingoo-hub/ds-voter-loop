// 调试探针：启动 Chrome，连 CDP，看连接为什么会断。
import { launchBrowser, findBrowser } from '../lib/browser.mjs';
import { waitForCdpEndpoint, sleep } from '../lib/cdp.mjs';

const PORT = 9401;
const info = await launchBrowser({ exe: findBrowser(), port: PORT, url: 'about:blank', headless: true });
console.log('launched pid', info.child.pid);
info.child.on('exit', (code, sig) => console.log('chrome exited', code, sig));

const ver = await waitForCdpEndpoint(PORT, 20000);
console.log('version ok:', ver.Browser, ver.webSocketDebuggerUrl);

const ws = new WebSocket(ver.webSocketDebuggerUrl);
ws.addEventListener('open', () => console.log('ws open'));
ws.addEventListener('close', (e) => console.log('ws CLOSE code=', e.code, 'reason=', JSON.stringify(e.reason), 'wasClean=', e.wasClean));
ws.addEventListener('error', (e) => console.log('ws ERROR', e.message || e.type));
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method) return;
  console.log('reply', m.id, m.error ? 'ERR ' + JSON.stringify(m.error) : 'ok');
});

let id = 0;
const send = (method, params = {}, sessionId) => {
  const payload = { id: ++id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  console.log('-->', method, sessionId ? `(session ${sessionId.slice(0, 6)})` : '');
  ws.send(JSON.stringify(payload));
  return payload.id;
};

await sleep(500);
send('Target.getTargets');
await sleep(600);
const res = await new Promise((resolve) => {
  const h = (e) => { const m = JSON.parse(e.data); if (m.id === 2) { ws.removeEventListener('message', h); resolve(m); } };
  ws.addEventListener('message', h);
});
const infos = res.result?.targetInfos || [];
console.log('targets:', infos.map((t) => `${t.type} ${t.url}`));
const page = infos.find((t) => t.type === 'page');
console.log('page target:', page?.targetId);

// 手动 attach
const attachId = send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const attach = await new Promise((resolve) => {
  const h = (e) => { const m = JSON.parse(e.data); if (m.id === attachId) { ws.removeEventListener('message', h); resolve(m); } };
  ws.addEventListener('message', h);
});
console.log('attach result:', JSON.stringify(attach.result || attach.error));
const sid = attach.result?.sessionId;

send('Page.enable', {}, sid);
await sleep(300);
send('Runtime.enable', {}, sid);
await sleep(300);
send('Page.navigate', { url: 'http://127.0.0.1:8787/mock.html' }, sid);
await sleep(1500);
send('Runtime.evaluate', { expression: 'localStorage.getItem("ds-vs-ds-voter")', returnByValue: true }, sid);
await sleep(600);
console.log('still open?', ws.readyState === 1 ? 'yes' : 'NO state=' + ws.readyState);

await sleep(2000);
console.log('final ws state', ws.readyState);
try { ws.close(); } catch {}
await sleep(300);
