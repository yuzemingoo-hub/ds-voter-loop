// 用一个全新 Chrome 配置（模拟"第一次打开"的浏览器）打开控制台，读出默认表单值。
// 用法：node tools/check-default.mjs [面板地址]
import { launchBrowser, closeBrowser } from '../lib/browser.mjs';
import { connectCDP, waitForCdpEndpoint, sleep } from '../lib/cdp.mjs';

const PANEL = process.argv[2] || 'http://127.0.0.1:8787/';
const PORT = 9421;

const handle = await launchBrowser({ port: PORT, url: PANEL, headless: true });
let cdp = null;
try {
  const info = await waitForCdpEndpoint(PORT, 20000);
  cdp = await connectCDP(info.webSocketDebuggerUrl);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith('http'));
  if (!page) throw new Error('没找到面板页面');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await sleep(3000);   // 等页面脚本 + SSE hello

  const expr = `(() => {
    const v = (id) => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; };
    return JSON.stringify({
      url: v('url'), key: v('key'), clickMode: v('clickMode'), clickValue: v('clickValue'),
      clickModeOptions: [...document.getElementById('clickMode').options].map((o) => o.value),
      requireSelector: v('requireSelector'),
      waitClickableMs: v('waitClickableMs'), confirmMs: v('confirmMs'),
      confirmKeyPrefix: v('confirmKeyPrefix'), clearPrefixes: v('clearPrefixes'),
      dwellMs: v('dwellMs'), maxRounds: v('maxRounds'), headless: v('headless'),
      presetDropdown: v('preset'),
      savedForm: localStorage.getItem('ds-voter-loop-form'),
      phase: document.getElementById('stPhase') ? document.getElementById('stPhase').textContent : null,
    }, null, 1);
  })()`;
  const res = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
  console.log(res.result?.value ?? JSON.stringify(res));
} finally {
  if (cdp) cdp.close();
  await closeBrowser(handle);
}
