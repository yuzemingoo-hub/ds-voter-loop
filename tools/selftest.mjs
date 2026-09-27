// 端到端自测：起假投票页 + 真 Chrome + 真点击，断言「轮数 == 票数」「点的是右边」。
// 用法：node tools/selftest.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoopRunner, probeTarget, BrowserSession } from '../lib/looper.mjs';
import { sleep } from '../lib/cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = 8899;
const KEY = 'ds-vs-ds-voter';

let votes = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/mock.html' || url.pathname === '/mock2.html' || url.pathname === '/mock3.html') {
    const buf = await readFile(path.join(PUBLIC_DIR, url.pathname.slice(1)));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(buf);
  }
  if (url.pathname === '/api/mock/vote' && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    votes.push({ uuid: body.uuid || null, side: body.side || null });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      count: votes.length,
      right: votes.filter((v) => v.side === 'right').length,
      left: votes.filter((v) => v.side === 'left').length,
    }));
  }
  res.writeHead(404).end('404');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`假投票页: http://127.0.0.1:${PORT}/mock.html · /mock2.html\n`);

const failures = [];
function check(name, cond, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
}

function mk(cfg) {
  return new LoopRunner({
    key: KEY,
    dwellMs: 250,
    loadTimeoutMs: 12000,
    headless: true,
    closeBrowserOnStop: true,
    ...cfg,
  }, { log: (l, m) => console.log(`  [${l}] ${m}`), status: () => {} });
}

async function scenario({ title, url, rounds, ...cfg }) {
  console.log(`\n=== ${title} ===`);
  votes = [];
  const runner = mk({ url: `http://127.0.0.1:${PORT}${url}`, maxRounds: rounds, ...cfg });
  const t0 = Date.now();
  await runner.run();
  check(`跑满 ${rounds} 轮`, runner.round === rounds, `实际 ${runner.round} 轮`);
  check(`${rounds} 次点击全部落到页面上`, votes.length === rounds, `服务端收到 ${votes.length} 票`);
  check('每轮用的是不同 UUID', new Set(votes.map((v) => v.uuid)).size === votes.length, `${new Set(votes.map((v) => v.uuid)).size} 个不同值`);
  console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return votes;
}

// A：单按钮页，自动识别
await scenario({ title: '场景 A：单按钮页 · 自动识别 · 3 轮', url: '/mock.html', rounds: 3, clickMode: 'auto', debugPort: 9411 });

// B：单按钮页，按文字
await scenario({ title: '场景 B：单按钮页 · 按文字「投票」· 2 轮', url: '/mock.html', rounds: 2, clickMode: 'text', clickValue: '投票', debugPort: 9412 });

// C：双按钮页（左边浅色 / 右边蓝色）+ confirm 弹窗，必须点右边
console.log('\n=== 场景 C：双按钮页 · 点最右 · 带 confirm 弹窗 · 3 轮 ===');
votes = [];
{
  const runner = mk({
    url: `http://127.0.0.1:${PORT}/mock2.html?confirm=1`,
    clickMode: 'right',
    maxRounds: 3,
    debugPort: 9413,
  });
  await runner.run();
  check('跑满 3 轮', runner.round === 3, `实际 ${runner.round} 轮`);
  check('收到 3 票', votes.length === 3, `实际 ${votes.length} 票`);
  check('3 票全投给右边', votes.filter((v) => v.side === 'right').length === 3, `右边 ${votes.filter((v) => v.side === 'right').length} / 左边 ${votes.filter((v) => v.side === 'left').length}`);
  check('confirm 弹窗被自动确认（否则一票都不会有）', votes.length === 3);
  check('每轮 UUID 都不同', new Set(votes.map((v) => v.uuid)).size === 3);
}

// D：第 N 个（1 = 左边）
await scenario({ title: '场景 D：双按钮页 · 取第 1 个（应该点左边）· 2 轮', url: '/mock2.html?confirm=0', rounds: 2, clickMode: 'nth', clickValue: '1', debugPort: 9414 });
check('2 票全投给左边', votes.filter((v) => v.side === 'left').length === 2, `左边 ${votes.filter((v) => v.side === 'left').length}`);

// E：试探（只看不点）—— 应该圈中右边那个，并且不产生票
console.log('\n=== 场景 E：试探（只看不点）===');
votes = [];
{
  const r = await probeTarget({
    url: `http://127.0.0.1:${PORT}/mock2.html`,
    key: KEY,
    clickMode: 'right',
    headless: true,
    debugPort: 9415,
  }, { log: (l, m) => console.log(`  [${l}] ${m}`) });
  check('试探成功', r.ok === true, r.ok ? '' : r.reason);
  check('圈中的是右边按钮', r.ok && /右/.test(r.info.text), r.ok ? `「${r.info.text}」· ${r.info.selector}` : '');
  check('拿到了截图', !!(r.ok && r.screenshot && r.screenshot.startsWith('data:image/jpeg')));
  check('候选里同时看到左右两个按钮', (r.candidates || []).length >= 2, (r.candidates || []).map((c) => c.text).join(' / '));
  check('试探没有投票', votes.length === 0, `实际 ${votes.length} 票`);
}

// F：拾取按钮 —— 模拟「你在浏览器里点一下右边那个按钮」
console.log('\n=== 场景 F：拾取按钮（在页面上点一下来指定目标）===');
votes = [];
{
  const s = new BrowserSession({
    url: `http://127.0.0.1:${PORT}/mock2.html?confirm=0`,
    key: KEY,
    clickMode: 'right',
    headless: true,
    debugPort: 9416,
    closeBrowserOnStop: true,
  }, { log: () => {} });
  await s.start();
  await s.open(`http://127.0.0.1:${PORT}/mock2.html?confirm=0`);

  const picking = s.eval('window.__dsvoter.picker()', { awaitPromise: true, swallow: true, timeoutMs: 30000 });
  await sleep(500);
  const target = await s.resolveTarget();          // 右边那个按钮
  await s.clickTarget(target);                     // 用真实鼠标点它 —— 会被拾取层吃掉
  const picked = await picking;
  check('拾取到了元素', !!(picked && picked.ok), picked ? `「${picked.text}」` : '没拾取到');
  check('拾取到的正是右边按钮', !!(picked && picked.ok && picked.selector === '#rightBtn'), picked?.selector || '');
  check('拾取时的这一下没有真的投票', votes.length === 0, `实际 ${votes.length} 票`);
  await s.close();
}

// G：仿真站（ds-vs-ds.win 同款结构）—— 按钮先禁用=安全验证，投完写 selection 键
console.log('\n=== 场景 G：仿真站 · [data-choice="right"] · 按钮需等验证 · 3 轮 ===');
votes = [];
{
  const runner = mk({
    url: `http://127.0.0.1:${PORT}/mock3.html?verify=1500`,
    clickMode: 'selector',
    clickValue: '[data-choice="right"]',
    waitClickableMs: 9000,     // 等「安全验证」把按钮放出来
    confirmMs: 9000,           // 等这一票真的写进去
    confirmKeyPrefix: 'ds-vs-ds-selection-',
    clearPrefixes: 'ds-vs-ds-selection-',
    maxRounds: 3,
    dwellMs: 200,
    debugPort: 9417,
  });
  await runner.run();
  check('跑满 3 轮', runner.round === 3, `实际 ${runner.round} 轮`);
  check('收到 3 票', votes.length === 3, `实际 ${votes.length} 票`);
  check('3 票全投给右边', votes.filter((v) => v.side === 'right').length === 3, `右 ${votes.filter((v) => v.side === 'right').length} / 左 ${votes.filter((v) => v.side === 'left').length}`);
  check('3 轮都确认生效（等到了 selection 键）', runner.confirmed === 3, `确认 ${runner.confirmed} 次`);
  check('每轮 UUID 都不同', new Set(votes.map((v) => v.uuid)).size === 3);
}

// H：确认关闭时，禁用按钮应该被等待逻辑挡住（不该误报成功）
console.log('\n=== 场景 H：按钮一直禁用（安全验证永远不过）· 应该失败而不是假成功 ===');
{
  const runner = mk({
    url: `http://127.0.0.1:${PORT}/mock3.html?verify=60000`,
    clickMode: 'selector',
    clickValue: '[data-choice="right"]',
    waitClickableMs: 2500,
    confirmMs: 3000,
    confirmKeyPrefix: 'ds-vs-ds-selection-',
    waitOnBlockedMs: 0,        // 关掉「被挡住就重试」，测硬失败路径
    maxRounds: 5,
    dwellMs: 100,
    debugPort: 9418,
  });
  await runner.run();
  check('没有产生假投票', runner.clicked === 0, `clicked=${runner.clicked}`);
  check('在连续失败后自己停了（没有空转到第 5 轮）', runner.round === 2, `停在第 ${runner.round} 轮`);
}

// I：验证太慢 —— 第一次等不够，应该在同一页面上等一会儿重点，而不是重新加载
console.log('\n=== 场景 I：安全验证比等待时间慢 · 同页面重试后成功 ===');
votes = [];
{
  const runner = mk({
    url: `http://127.0.0.1:${PORT}/mock3.html?verify=6000`,   // 验证要 6s 才放行
    clickMode: 'selector',
    clickValue: '[data-choice="right"]',
    waitClickableMs: 1500,     // 第一轮只等 1.5s，等不到
    waitOnBlockedMs: 1500,     // 被挡住 → 1.5s 后在同页面重点
    blockedRetries: 6,
    confirmMs: 10000,
    confirmKeyPrefix: 'ds-vs-ds-selection-',
    clearPrefixes: 'ds-vs-ds-selection-',
    maxRounds: 1,
    debugPort: 9419,
  });
  await runner.run();
  check('只跑了 1 轮（重试没有重新加载页面）', runner.round === 1, `实际 ${runner.round} 轮`);
  check('最终点成功了', runner.clicked === 1, `clicked=${runner.clicked}`);
  check('并且确认生效', runner.confirmed === 1, `confirmed=${runner.confirmed}`);
  check('票投给了右边', votes.length === 1 && votes[0].side === 'right', JSON.stringify(votes));
}

server.close();
console.log(`\n${failures.length ? '❌ 失败项：' + failures.join(' / ') : '✅ 全部通过'}`);
process.exit(failures.length ? 1 : 0);