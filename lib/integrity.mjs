// 完整性自检：把发布版本的文件算成 SHA-256 存进 manifest.json，启动时校验。
// 目的不是"防止"修改（开源代码永远能被改），而是让任何改动**立刻可见**：
// 面板和日志会直接报「代码已被修改，与发布版本不一致」。
// 同时提供护栏断言：检查"只允许点指定一侧"的护栏还在不在。

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** 会被封存（参与校验）的文件与目录 */
export const SEALED = ['start.cmd', 'server.mjs', 'LICENSE', 'lib', 'public'];

/** 这个应用的护栏：发布版必须满足，否则报警 */
export const GUARDRAILS = {
  /** 不允许出现的定位方式（投左边的能力） */
  forbiddenClickMode: 'left',
  /** 目标必须匹配这个选择器，才允许点击（只有右边那条鱼） */
  requiredSelector: '[data-choice="right"]',
};

export async function sha256(file) {
  const buf = await readFile(file);
  return createHash('sha256').update(buf).digest('hex');
}

async function walk(root, rel) {
  const abs = path.join(root, rel);
  let info;
  try { info = await stat(abs); } catch { return []; }
  if (info.isFile()) return [rel.replace(/\\/g, '/')];
  const out = [];
  for (const name of (await readdir(abs)).sort()) out.push(...await walk(root, path.join(rel, name)));
  return out;
}

export async function collectFiles(rootDir) {
  const files = [];
  for (const item of SEALED) files.push(...await walk(rootDir, item));
  return files.sort();
}

export async function buildManifest(rootDir, extra = {}) {
  const files = {};
  for (const rel of await collectFiles(rootDir)) files[rel] = await sha256(path.join(rootDir, rel));
  return {
    schema: 'ds-voter-loop/manifest/v1',
    sealedAt: new Date().toISOString(),
    algorithm: 'sha256',
    guardrails: GUARDRAILS,
    files,
    ...extra,
  };
}

/**
 * 校验 rootDir 下的文件是否与 manifest.json 一致。
 * @returns {{ ok:boolean, sealedAt?:string, changed:Array, missing:Array, added:Array, noManifest:boolean }}
 */
export async function verifyManifest(rootDir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(rootDir, 'manifest.json'), 'utf8'));
  } catch {
    return { ok: false, noManifest: true, changed: [], missing: [], added: [] };
  }
  const changed = [];
  const missing = [];
  for (const [rel, want] of Object.entries(manifest.files || {})) {
    try {
      const got = await sha256(path.join(rootDir, rel));
      if (got !== want) changed.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  const listed = new Set(Object.keys(manifest.files || {}));
  const added = (await collectFiles(rootDir)).filter((rel) => !listed.has(rel));
  return {
    ok: changed.length === 0 && missing.length === 0 && added.length === 0,
    sealedAt: manifest.sealedAt,
    count: Object.keys(manifest.files || {}).length,
    changed, missing, added,
    noManifest: false,
  };
}

/** 护栏断言：默认配置里必须带"只允许右边"的护栏，且不能有投左边的入口 */
export function checkGuardrails(appDefault = {}) {
  const issues = [];
  if (appDefault.clickMode === GUARDRAILS.forbiddenClickMode) issues.push('默认定位方式被改成了「最左边」');
  if (!appDefault.requireSelector) issues.push(`护栏选择器（requireSelector）被清空了，应该保持 ${GUARDRAILS.requiredSelector}`);
  else if (appDefault.requireSelector !== GUARDRAILS.requiredSelector) issues.push(`护栏选择器被改成了 ${appDefault.requireSelector}（发布版是 ${GUARDRAILS.requiredSelector}）`);
  return { ok: issues.length === 0, issues };
}
