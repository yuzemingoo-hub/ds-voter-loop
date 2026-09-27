// 护栏回归测试：确保这个应用"只会投右边，绝不投左边"。
// 用法：node tools/check-guard.mjs [http://127.0.0.1:8787]
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

console.log(`护栏测试目标：${BASE}\n`);

// 1) 接口层面直接拒绝 clickMode=left
console.log('=== 1) 传入 clickMode=left ===');
{
  const r = await post('/api/start', { clickMode: 'left' });
  check('被拒绝（HTTP 400）', r.status === 400, 'HTTP ' + r.status);
  check('提示说清了原因', /只投右边|左边/.test(r.json.error || ''), r.json.error || '');
}

// 2) 会落到别处的方式（自动识别在真站上会认到广告位）+ 护栏 → 必须中止，且不能点
console.log('\n=== 2) 真站 + 定位方式=自动识别（会认到广告位/左边）+ 护栏 ===');
{
  const r = await post('/api/probe', { clickMode: 'auto', requireSelector: '[data-choice="right"]', headless: false });
  const res = r.json.result || {};
  check('没有点下去', !res.clicked, res.clicked ? '点了！' : '已中止');
  check('被护栏拦下并说明原因', res.ok === false && /护栏/.test(res.reason || ''), res.reason || '(没有原因)');
}

// 3) 默认配置（空 body）→ 应该正常定位到右边
console.log('\n=== 3) 空 body（用服务器默认配置）→ 应该定位到右边 ===');
{
  const r = await post('/api/probe', {});
  const res = r.json.result || {};
  check('试探成功', r.json.ok === true && res.ok === true, res.reason || '');
  check('目标是右边（不是左边/广告）', res.info?.selector && /nth-of-type\(2\)|right/i.test(res.info.selector), res.info?.selector || '');
  check('没有投票', !res.clicked, res.clicked ? '投了！' : '只看不点');
}

console.log(`\n${failures.length ? '❌ 失败项：' + failures.join(' / ') : '✅ 护栏全部生效'}`);
process.exit(failures.length ? 1 : 0);
