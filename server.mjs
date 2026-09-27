// 本地控制台服务：一个页面 + 几个接口，绑定 127.0.0.1，只在本机可用。
//
// 版权 (c) 2026 ds-vs-ds.win 站长 · 使用条款见 LICENSE。
// 简言之：禁止把本软件改造成"针对他人网站的刷票工具"，禁止删除护栏与完整性自检后再分发。
// 本文件在发布版里有 SHA-256 记录（manifest.json），被修改会在启动时报告。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { LoopRunner, DEFAULTS, probeTarget, pickElement } from './lib/looper.mjs';
import { listBrowsers } from './lib/browser.mjs';
import { verifyManifest, checkGuardrails, GUARDRAILS } from './lib/integrity.mjs';

/**
 * 控制台自己的默认配置：打开面板就是真站，什么都不用填，直接开开关就能用。
 * （lib 里的 DEFAULTS 保持通用默认，方便当库用 / 跑自测。）
 */
const APP_DEFAULT = {
  url: 'https://ds-vs-ds.win/',
  key: 'ds-vs-ds-voter',
  clickMode: 'selector',
  clickValue: '[data-choice="right"]',
  requireSelector: '[data-choice="right"]', // 护栏：只允许点右边那个，解析到别的（比如左边按钮、广告位）一律中止
  waitClickableMs: 30000,          // 等 Cloudflare Turnstile 放行按钮
  confirmMs: 25000,                // 等这一票真的写进去
  confirmKeyPrefix: 'ds-vs-ds-selection-',
  clearPrefixes: 'ds-vs-ds-selection-',
  dwellMs: 1500,
  loadTimeoutMs: 20000,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(argOf('port', process.env.DS_VOTER_PORT || 8787));
const HOST = '127.0.0.1';
const OPEN_PANEL = !argv.includes('--no-open');

/* ---------- 启动自检：完整性 + 护栏 ---------- */

const integrity = await verifyManifest(__dirname);
const guardCheck = checkGuardrails(APP_DEFAULT);
const integrityReport = {
  ok: integrity.ok && guardCheck.ok,
  sealedAt: integrity.sealedAt || null,
  noManifest: !!integrity.noManifest,
  changed: integrity.changed,
  missing: integrity.missing,
  added: integrity.added,
  guardIssues: guardCheck.issues,
  guardrails: GUARDRAILS,
};

if (integrityReport.ok) {
  console.log(`[ds-voter-loop] 完整性自检通过：${integrity.count} 个文件与发布版一致，护栏完好（只允许 ${GUARDRAILS.requiredSelector}）`);
} else {
  console.warn('\n[!] ============================================================');
  console.warn('[!] 完整性自检没过：这份代码与发布版本不一致（被改过）。');
  if (integrity.noManifest) console.warn('[!]   · 找不到 manifest.json（可能被删了）');
  for (const f of integrity.changed) console.warn(`[!]   · 内容被改：${f}`);
  for (const f of integrity.missing) console.warn(`[!]   · 文件丢失：${f}`);
  for (const f of integrity.added) console.warn(`[!]   · 多出文件：${f}`);
  for (const g of guardCheck.issues) console.warn(`[!]   · 护栏异常：${g}`);
  console.warn('[!] 如果你不是作者本人，请注意 LICENSE 里禁止"改造成刷票工具"的条款。');
  console.warn('[!] 如果这是你自己改的，改完后跑： node tools/make-manifest.mjs  重新封存。');
  console.warn('[!] ============================================================\n');
  if (argv.includes('--strict')) {
    console.error('[!] 带了 --strict，拒绝在代码被修改的情况下启动。');
    process.exit(3);
  }
}

/* ---------- 运行状态 ---------- */

const state = {
  running: false,
  phase: '空闲',
  round: 0,
  clicked: 0,
  confirmed: 0,
  uuid: null,
  startedAt: null,
  elapsed: 0,
  config: { ...DEFAULTS, ...APP_DEFAULT },
  lastError: null,
  busy: false,          // 正在做试探/拾取
  probe: null,          // 最近一次试探结果（含截图）
  integrity: integrityReport,  // 启动时的完整性 / 护栏自检结果
};

let runner = null;
const logs = [];
const clients = new Set();
let mockVotes = [];

function pushLog(level, msg) {
  const entry = { t: Date.now(), level, msg };
  logs.push(entry);
  if (logs.length > 800) logs.splice(0, logs.length - 800);
  broadcast({ type: 'log', entry });
}

function setStatus(patch) {
  Object.assign(state, patch);
  broadcast({ type: 'status', state: publicState() });
}

function publicState() {
  return {
    ...state,
    // 截图很大，只在 probe 事件/hello 里单独传，避免每秒的状态推送里重复携带
    probe: state.probe ? { ...state.probe, screenshot: undefined, hasShot: !!state.probe.screenshot } : null,
    config: { ...state.config, exe: undefined },
    browsers: listBrowsers(),
    logCount: logs.length,
  };
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch { /* 断开由 close 事件处理 */ }
  }
}

let statusTimer = null;
function startStatusTicker() {
  if (statusTimer) return;
  statusTimer = setInterval(() => {
    if (state.running && runner) setStatus({ elapsed: runner.elapsed, round: runner.round, clicked: runner.clicked, confirmed: runner.confirmed });
    else if (state.running) setStatus({ elapsed: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0 });
  }, 1000);
}

/* ---------- 启动 / 停止 ---------- */

function normalizeConfig(rawConfig) {
  const cfg = { ...DEFAULTS, ...APP_DEFAULT };
  for (const k of Object.keys(DEFAULTS)) {
    if (rawConfig[k] !== undefined && rawConfig[k] !== null && rawConfig[k] !== '') cfg[k] = rawConfig[k];
  }
  cfg.debugPort = Number(cfg.debugPort) || 9333;
  cfg.attachPort = Number(cfg.attachPort) || 0;
  cfg.dwellMs = Math.max(0, Number(cfg.dwellMs) || 0);
  cfg.waitClickableMs = Math.max(0, Number(cfg.waitClickableMs) || 0);
  cfg.confirmMs = Math.max(0, Number(cfg.confirmMs) || 0);
  cfg.loadTimeoutMs = Math.max(1000, Number(cfg.loadTimeoutMs) || DEFAULTS.loadTimeoutMs);
  cfg.maxRounds = Math.max(0, Number(cfg.maxRounds) || 0);
  cfg.exe = cfg.exe || '';
  for (const k of ['realClick', 'headless', 'closeBrowserOnStop', 'ignoreCache', 'autoConfirm', 'flash']) {
    cfg[k] = !(cfg[k] === false || cfg[k] === 'false');
  }
  return cfg;
}

function validateConfig(cfg) {
  if (!cfg.url) throw new Error('请先填页面地址');
  if (!cfg.key) throw new Error('请先填 localStorage 键名');
  if (cfg.clickMode === 'left') throw new Error('这个应用只投右边，「最左边的那个」已经被移除了');
  if (cfg.clickMode === 'selector' && !cfg.clickValue) throw new Error('「按 CSS 选择器」需要填选择器');
  if (cfg.clickMode === 'text' && !cfg.clickValue) throw new Error('「按按钮文字」需要填按钮上的文字');
  if (cfg.clickMode === 'nth' && !cfg.clickValue) throw new Error('「第 N 个」需要填序号，比如 2');
  if (cfg.clickMode === 'js' && !cfg.clickValue) throw new Error('「自定义 JS」需要填脚本');
}

async function start(rawConfig) {
  if (state.running) throw new Error('已经在跑了，先关掉开关');

  const cfg = normalizeConfig(rawConfig);
  validateConfig(cfg);

  logs.length = 0;
  mockVotes = [];
  state.config = cfg;
  state.lastError = null;
  runner = new LoopRunner(cfg, {
    log: pushLog,
    status: (patch) => setStatus(patch),
  });

  setStatus({ running: true, phase: '运行中', round: 0, clicked: 0, confirmed: 0, uuid: null, startedAt: Date.now(), elapsed: 0 });
  startStatusTicker();
  pushLog('info', `开始：${cfg.url} · 键名 ${cfg.key} · 点击方式 ${cfg.clickMode}${cfg.maxRounds ? ` · 最多 ${cfg.maxRounds} 轮` : ' · 不限轮数'}`);

  runner.run()
    .catch((e) => {
      state.lastError = e.message;
      pushLog('error', `中断：${e.message}`);
    })
    .finally(() => {
      runner = null;
      setStatus({ running: false, phase: '空闲', elapsed: 0 });
      broadcast({ type: 'logs-done' });
    });
}

async function stop() {
  if (!runner) throw new Error('现在是停的');
  setStatus({ phase: '停止中…' });
  runner.stop();
  pushLog('info', '收到停止指令');
}

/* ---------- HTTP ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

async function serveStatic(res, rel) {
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') return void await serveStatic(res, 'index.html');
    if (p === '/mock.html' || p === '/mock2.html' || p === '/mock3.html') return void await serveStatic(res, p.slice(1));

    if (p === '/api/status') return sendJson(res, 200, { ...publicState(), logs: logs.slice(-400) });

    // 现场重新校验完整性（不依赖启动时的结果）
    if (p === '/api/integrity') {
      const now = await verifyManifest(__dirname);
      const guards = checkGuardrails(state.config);
      const appGuards = checkGuardrails(APP_DEFAULT);
      return sendJson(res, 200, {
        ok: now.ok && appGuards.ok,
        sealedAt: now.sealedAt, count: now.count,
        changed: now.changed, missing: now.missing, added: now.added, noManifest: now.noManifest,
        guardIssues: [...appGuards.issues, ...guards.issues],
        guardrails: GUARDRAILS,
        license: '见 LICENSE：禁止改造成针对他人网站的刷票工具、禁止去除护栏与自检后再分发',
      });
    }

    if (p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'hello', state: publicState(), logs: logs.slice(-400), probeShot: state.probe?.screenshot || null })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (p === '/api/start' && req.method === 'POST') {
      const cfg = await readBody(req);
      await start(cfg);
      return sendJson(res, 200, { ok: true, state: publicState() });
    }

    if (p === '/api/stop' && req.method === 'POST') {
      await stop();
      return sendJson(res, 200, { ok: true });
    }

    // 试探：打开页面 → 定位 → 高亮 → 截图（默认不点）
    if (p === '/api/probe' && req.method === 'POST') {
      if (state.running) throw new Error('循环正在跑，先关掉开关再试探');
      if (state.busy) throw new Error('正在忙，稍等一下');
      const raw = await readBody(req);
      const cfg = normalizeConfig(raw);
      validateConfig(cfg);
      state.config = cfg;
      state.busy = true;
      logs.length = 0;
      setStatus({ phase: '试探中…' });
      pushLog('info', `试探：${cfg.url} · 定位方式 ${cfg.clickMode}${cfg.clickValue ? ' = ' + cfg.clickValue : ''}${cfg.doClick ? ' · 会真点一次' : ' · 只看不点'}`);
      try {
        const result = await probeTarget(cfg, { log: pushLog });
        state.probe = result.ok ? { ...result, at: Date.now() } : null;
        if (result.ok) {
          pushLog('ok', `定位到 <${String(result.info.tag).toLowerCase()}${result.info.id ? '#' + result.info.id : ''}>「${result.info.text}」 · ${result.info.selector}`);
          if (result.candidates?.length) {
            pushLog('info', `页面上的候选可点元素：${result.candidates.map((c, i) => `${i + 1}.「${(c.text || c.tag).slice(0, 14)}」`).join(' ')}`);
          }
          const votes = result.candidates?.filter((c) => c.vote) || [];
          if (votes.length >= 2) pushLog('warn', `注意：有 ${votes.length} 个候选都像投票按钮 —— 确认高亮截图里框的是你要的那一个，不是就换「最右的那个」或「拾取按钮」`);
          if (result.clicked) pushLog('ok', '已按你的要求真点了一次');
        } else {
          pushLog('error', `试探失败：${result.reason}`);
        }
        broadcast({ type: 'probe', result: state.probe, ok: result.ok, error: result.ok ? null : result.reason });
        return sendJson(res, 200, { ok: true, result });
      } finally {
        state.busy = false;
        setStatus({ phase: '空闲' });
      }
    }

    // 拾取：浏览器里点一下，把它当目标
    if (p === '/api/pick' && req.method === 'POST') {
      if (state.running) throw new Error('循环正在跑，先关掉开关再拾取');
      if (state.busy) throw new Error('正在忙，稍等一下');
      const raw = await readBody(req);
      const cfg = normalizeConfig(raw);
      if (!cfg.url) throw new Error('请先填页面地址');
      state.config = cfg;
      state.busy = true;
      logs.length = 0;
      setStatus({ phase: '等你点…' });
      pushLog('info', '会开一个浏览器窗口，请在页面里点一下你要点的那个按钮');
      try {
        const result = await pickElement(cfg, { log: pushLog });
        if (result.ok) {
          state.probe = { ...result, at: Date.now() };
          pushLog('ok', `已拾取 <${String(result.info.tag).toLowerCase()}${result.info.id ? '#' + result.info.id : ''}>「${result.info.text}」 → ${result.info.selector}`);
        } else {
          pushLog('warn', `拾取结束：${result.reason}`);
        }
        broadcast({ type: 'probe', result: state.probe, ok: result.ok, error: result.ok ? null : result.reason });
        return sendJson(res, 200, { ok: true, result });
      } finally {
        state.busy = false;
        setStatus({ phase: '空闲' });
      }
    }

    // 自测用的假页面接口
    if (p === '/api/mock/vote' && req.method === 'POST') {
      const body = await readBody(req);
      mockVotes.push({ t: Date.now(), uuid: body.uuid || null, side: body.side || null });
      const right = mockVotes.filter((v) => v.side === 'right').length;
      const left = mockVotes.filter((v) => v.side === 'left').length;
      return sendJson(res, 200, { ok: true, count: mockVotes.length, right, left, votes: mockVotes.slice(-20) });
    }
    if (p === '/api/mock/stats') {
      return sendJson(res, 200, {
        count: mockVotes.length,
        right: mockVotes.filter((v) => v.side === 'right').length,
        left: mockVotes.filter((v) => v.side === 'left').length,
        votes: mockVotes,
      });
    }
    if (p === '/api/mock/reset' && req.method === 'POST') {
      mockVotes = [];
      return sendJson(res, 200, { ok: true });
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[!] 端口 ${PORT} 已经被占用了 —— 很可能你已经开着一个了。`);
    console.error(`    直接在浏览器打开：http://${HOST}:${PORT}/`);
    console.error(`    或者换个端口启动：node server.mjs --port ${PORT + 1}\n`);
    process.exit(2);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  const panel = `http://${HOST}:${PORT}/`;
  console.log(`[ds-voter-loop] 控制台：${panel}`);
  console.log(`[ds-voter-loop] 自测页：${panel}mock.html`);
  if (OPEN_PANEL) {
    try { spawn('cmd', ['/c', 'start', '', panel], { stdio: 'ignore', windowsHide: true }); } catch { /* 打不开就算了 */ }
  }
});

const bye = async () => {
  if (runner) { runner.stop(); }
  await new Promise((r) => setTimeout(r, 300));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
