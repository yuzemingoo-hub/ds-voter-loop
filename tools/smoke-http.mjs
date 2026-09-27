// HTTP 层冒烟测试：打真实运行中的控制台接口，验证 /api/probe 与 /api/start。
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8787';
const MOCK = `${BASE}/mock2.html?confirm=1`;

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const get = async (p) => (await fetch(BASE + p)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

// 1) 试探：只看不点
console.log('=== 1) POST /api/probe（点最右，只看不点）===');
{
  const r = await post('/api/probe', { url: MOCK, key: 'ds-vs-ds-voter', clickMode: 'right', headless: true, debugPort: 9333 });
  check('接口返回 ok', r.ok === true, r.error || '');
  const res = r.result || {};
  check('定位到了右边按钮', res.ok && /右/.test(res.info?.text || ''), res.info ? `「${res.info.text}」· ${res.info.selector}` : res.reason);
  check('返回了截图', typeof res.screenshot === 'string' && res.screenshot.startsWith('data:image/jpeg'));
  if (res.screenshot) {
    const file = path.join(__dirname, '..', 'probe-shot.jpg');
    await writeFile(file, Buffer.from(res.screenshot.split(',')[1], 'base64'));
    console.log(`  （截图已存到 ${path.basename(file)}）`);
  }
  const stats = await get('/api/mock/stats');
  check('试探没有投票', stats.count === 0, `实际 ${stats.count} 票`);
}

// 2) 真跑循环
console.log('\n=== 2) POST /api/start（点最右 + confirm 弹窗，2 轮）===');
{
  await post('/api/mock/reset');
  const r = await post('/api/start', { url: MOCK, key: 'ds-vs-ds-voter', clickMode: 'right', maxRounds: 2, dwellMs: 250, headless: true, debugPort: 9333 });
  check('接口返回 ok', r.ok === true, r.error || '');

  const deadline = Date.now() + 90000;
  let s = null;
  while (Date.now() < deadline) {
    s = await get('/api/status');
    if (!s.running) break;
    await sleep(500);
  }
  check('循环已经结束', s && s.running === false, s ? `phase=${s.phase}` : '拿不到状态');
  check('轮数 = 2', s?.round === 2, `实际 ${s?.round}`);
  check('点击数 = 2', s?.clicked === 2, `实际 ${s?.clicked}`);

  const stats = await get('/api/mock/stats');
  check('服务端收到 2 票且全在右边', stats.count === 2 && stats.right === 2, `共 ${stats.count} 票，右 ${stats.right} / 左 ${stats.left}`);
  check('日志里有自动确认弹窗的记录', (s?.logs || []).some((l) => /自动点确定/.test(l.msg)));
}

console.log(`\n${failures.length ? '❌ 失败项：' + failures.join(' / ') : '✅ 全部通过'}`);
process.exit(failures.length ? 1 : 0);
