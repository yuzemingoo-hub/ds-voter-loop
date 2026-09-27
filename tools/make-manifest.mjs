// 生成 manifest.json（发布前跑一次；package.ps1 会自动调用）。
// 用法：node tools/make-manifest.mjs
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../lib/integrity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const manifest = await buildManifest(ROOT);
await writeFile(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');

const n = Object.keys(manifest.files).length;
console.log(`已封存 ${n} 个文件的 SHA-256 → manifest.json`);
console.log(`护栏：禁止 clickMode=${manifest.guardrails.forbiddenClickMode} · 必须匹配 ${manifest.guardrails.requiredSelector}`);
