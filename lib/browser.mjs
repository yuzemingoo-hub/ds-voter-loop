// 找一个本机 Chromium 内核浏览器并以「可远程调试」的方式启动它。
// 注意：spawn 必须用 stdio:'ignore'，否则在受限沙箱里管道会 EPERM。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sleep } from './cdp.mjs';

const CANDIDATES = [
  process.env.DS_VOTER_CHROME,
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function listBrowsers() {
  const seen = new Set();
  const out = [];
  for (const p of CANDIDATES) {
    if (p && !seen.has(p) && existsSync(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

export function findBrowser() {
  return listBrowsers()[0] || null;
}

export async function launchBrowser({ exe, port, url, headless = false, width = 1040, height = 840 }) {
  const binary = exe || findBrowser();
  if (!binary) throw new Error('没找到 Chrome / Edge，可用环境变量 DS_VOTER_CHROME 指定路径');

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'ds-voter-chrome-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-popup-blocking',
    '--window-size=' + width + ',' + height,
  ];
  if (headless) args.unshift('--headless=new');
  args.push(url || 'about:blank');

  const child = spawn(binary, args, { stdio: 'ignore', windowsHide: false });
  let settled = false;
  const spawnError = new Promise((_, reject) => {
    child.once('error', (e) => {
      if (settled) return;
      settled = true;
      reject(new Error(`启动浏览器失败：${e.message}`));
    });
    child.once('exit', (code) => {
      if (settled || code === null || code === 0) return;
      settled = true;
      reject(new Error(`浏览器进程提前退出（exit ${code}${code < 0 || code > 255 ? ` / 0x${(code >>> 0).toString(16)}` : ''}）。`
        + '常见原因：被安全软件或权限策略拦住（例如没有权限在临时目录创建配置、或不让启动 Chrome）。'));
    });
  });
  // 这个 Promise 可能没人 await（例如启动后就正常退出），挂个空 catch 防止未处理 rejection 炸掉进程。
  spawnError.catch(() => {});

  return { child, userDataDir, port, binary, spawnError };
}

export async function closeBrowser(handle) {
  if (!handle?.child || handle.child.exitCode !== null) return;
  const pid = handle.child.pid;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { handle.child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  await sleep(400);
}
