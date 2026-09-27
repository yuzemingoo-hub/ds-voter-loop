// 面板自检：页面脚本语法 + 脚本引用的元素 id 是否存在 + 关键默认值是否是真站。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'public', 'index.html');
const html = await readFile(file, 'utf8');

const failures = [];
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(name);
};

const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
check('找到 <script> 块', !!scriptMatch);
const script = scriptMatch ? scriptMatch[1] : '';

let syntaxOk = true;
try { new Function(script); } catch (e) { syntaxOk = false; check('页面脚本语法', false, e.message); }
if (syntaxOk) check('页面脚本语法', true, script.split('\n').length + ' 行');

// 脚本里用到的 id 必须在 HTML 里存在
const htmlIds = new Set([...html.matchAll(/id="([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
const usedIds = new Set([...script.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]));
const missing = [...usedIds].filter((id) => !htmlIds.has(id));
check('脚本引用的元素 id 都存在', missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : `${usedIds.size} 个 id`);

// 新手路径：默认必须是真站
const urlInput = html.match(/id="url"[^>]*value="([^"]*)"/);
check('页面地址默认是真站', !!urlInput && urlInput[1] === 'https://ds-vs-ds.win/', urlInput ? urlInput[1] : '没找到 value');
const keyInput = html.match(/id="key"[^>]*value="([^"]*)"/);
check('键名默认 ds-vs-ds-voter', !!keyInput && keyInput[1] === 'ds-vs-ds-voter', keyInput ? keyInput[1] : '');
const selVal = html.match(/id="clickValue"[^>]*>([^<]*)</);
check('选择器默认 [data-choice="right"]', !!selVal && selVal[1].trim() === '[data-choice="right"]', selVal ? selVal[1].trim() : '');

// 一键开始：必须有主按钮
check('有一个主按钮 #btnGo', /id="btnGo"/.test(html), (html.match(/id="btnGo"[^>]*>([^<]*)</) || [])[1] || '');
// 高级设置默认折叠
check('高级设置默认折叠', /<details class="adv" id="adv">/.test(html) && !/<details class="adv" id="adv"[^>]*open/.test(html));
// 「投左边」必须彻底消失，且有护栏
check('定位方式里没有"最左边的那个"', !/value="left"/.test(html) && !/最左边的那个/.test(html));
check('默认带护栏选择器（只允许右边）', /id="requireSelector"[^>]*value='\[data-choice="right"\]'/.test(html));
check('预设 dsvsds 带护栏选择器', /requireSelector: '\[data-choice="right"\]'/.test(html));

console.log(`\n${failures.length ? '❌ 失败项：' + failures.join(' / ') : '✅ 面板自检全部通过'}`);
process.exit(failures.length ? 1 : 0);
