// 完整性自检的自动化测试：在临时副本里"篡改"文件，看能不能被抓出来。
// 用法：node tools/check-integrity.mjs
import { cp, mkdtemp, rm, appendFile, unlink, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyManifest, checkGuardrails, GUARDRAILS } from '../lib/integrity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

// 1) 正式目录应当自检通过
console.log('=== 1) 发布版本自身 ===');
{
  const r = await verifyManifest(ROOT);
  check('完整性自检通过', r.ok, r.ok ? `${r.count} 个文件` : JSON.stringify({ changed: r.changed, missing: r.missing, noManifest: r.noManifest }));
  const g = checkGuardrails({ clickMode: 'selector', requireSelector: GUARDRAILS.requiredSelector });
  check('护栏断言通过', g.ok, g.issues.join('；'));
}

// 2) 在临时副本里篡改，必须被抓出来
console.log('\n=== 2) 篡改检测（在临时副本里做，不动正式文件）===');
const tmp = await mkdtemp(path.join(tmpdir(), 'dsvoter-tamper-'));
const copy = path.join(tmp, 'app');
try {
  await cp(ROOT, copy, { recursive: true, filter: (src) => !/runtime|\.zip$/.test(src) });

  const r0 = await verifyManifest(copy);
  check('副本本身是干净的', r0.ok, r0.ok ? '' : JSON.stringify(r0.changed));

  await appendFile(path.join(copy, 'lib', 'looper.mjs'), '\n// 有人偷偷加了一行\n');
  const r1 = await verifyManifest(copy);
  check('改了 lib/looper.mjs 会被发现', !r1.ok && r1.changed.includes('lib/looper.mjs'), r1.changed.join(', '));

  await unlink(path.join(copy, 'LICENSE'));
  const r2 = await verifyManifest(copy);
  check('删掉 LICENSE 会被发现', r2.missing.includes('LICENSE'), r2.missing.join(', '));

  await unlink(path.join(copy, 'manifest.json'));
  const r3 = await verifyManifest(copy);
  check('删掉 manifest.json 会被发现', r3.ok === false && r3.noManifest === true);

  // 把护栏拆掉（比如把 requireSelector 清空）也要能被断言抓到
  const g = checkGuardrails({ clickMode: 'left', requireSelector: '' });
  check('拆掉护栏会被断言抓到', !g.ok && g.issues.length >= 2, g.issues.join('；'));

  // 伪造清单：改完文件后重新生成清单，这种"自己封自己"就只能靠 LICENSE 约束了
  const { buildManifest } = await import('../lib/integrity.mjs');
  const forged = await buildManifest(copy);
  await writeFile(path.join(copy, 'manifest.json'), JSON.stringify(forged));
  const r4 = await verifyManifest(copy);
  check('（已知局限）重新自封后自检会通过 —— 这正是需要 LICENSE 的原因', r4.ok === true);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\n${failures.length ? '❌ 失败项：' + failures.join(' / ') : '✅ 完整性自检全部符合预期'}`);
process.exit(failures.length ? 1 : 0);
