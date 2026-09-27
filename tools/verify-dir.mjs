// 校验任意目录的完整性（默认校验发布副本）。
// 用法：node tools/verify-dir.mjs [目录]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyManifest, checkGuardrails, GUARDRAILS } from '../lib/integrity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || path.join(process.env.USERPROFILE || '', 'ds-voter-loop');

const r = await verifyManifest(target);
const g = checkGuardrails({ clickMode: 'selector', requireSelector: GUARDRAILS.requiredSelector });

console.log(`目录：${target}`);
console.log(r.ok
  ? `  ✅ 完整性通过：${r.count} 个文件与 manifest.json 一致`
  : `  ❌ 完整性没过：${JSON.stringify({ changed: r.changed, missing: r.missing, added: r.added, noManifest: r.noManifest })}`);
console.log(g.ok ? '  ✅ 护栏断言通过' : `  ❌ 护栏异常：${g.issues.join('；')}`);
process.exit(r.ok && g.ok ? 0 : 1);
