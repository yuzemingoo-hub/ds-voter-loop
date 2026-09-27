// 循环引擎：清 key → 刷新 → 等新 UUID → 点一下 → 循环。
//
// 版权 (c) 2026 ds-vs-ds.win 站长 · 使用条款见 LICENSE。
// 这个文件里带着"只允许点指定元素"的护栏（requireSelector），发布版默认只允许点右边那个；
// 去掉护栏属于 LICENSE 明确禁止的用法，且会让完整性自检报出"代码已被修改"。
// 定位方式支持：auto（自动）/ right（最右）/ left（最左）/ nth（第 N 个）/ text（按文字）/ selector / js。
// 另提供两个交互能力：probeTarget（只看不点，回传截图）和 pickElement（在浏览器里点一下来指定目标）。

import { connectCDP, waitForCdpEndpoint, sleep } from './cdp.mjs';
import { launchBrowser, closeBrowser } from './browser.mjs';

export const DEFAULTS = {
  url: '',
  key: 'ds-vs-ds-voter',
  clickMode: 'auto',      // auto | right | left | nth | text | selector | js
  clickValue: '',         // nth 填序号(1 起) / text 填按钮文字 / selector 填 CSS / js 填脚本
  requireSelector: '',    // 护栏：解析出来的目标必须匹配它，否则中止不点（例如 [data-choice="right"]）
  realClick: true,        // true = CDP 真实鼠标事件，false = element.click()
  autoConfirm: true,      // 页面弹 confirm/alert 自动点确定
  flash: true,            // 点击前把目标闪一下（方便肉眼确认点的是谁）
  waitClickableMs: 20000, // 点击前最多等多久让按钮变成可点（安全验证/倒计时之类）
  confirmMs: 0,           // 点击后最多等多久确认这一票真的生效（0 = 不确认；有确认信号的站点再打开）
  confirmKeyPrefix: '',   // 确认信号：出现以它开头的新 localStorage 键（例如 ds-vs-ds-selection-）
  clearPrefixes: '',      // 每轮顺带清掉的键前缀，逗号/换行分隔（例如 ds-vs-ds-selection-）
  waitOnBlockedMs: 45000, // 被限流/验证未完成时等多久再重试（0 = 不重试，直接算失败）
  blockedRetries: 5,      // 连续被挡最多重试几次，超过就停
  dwellMs: 800,
  loadTimeoutMs: 15000,
  maxRounds: 0,
  headless: false,
  closeBrowserOnStop: true,
  attachPort: 0,
  debugPort: 9333,
  ignoreCache: false,
  exe: '',
};

const json = (v) => JSON.stringify(v);

/* ------------------------------------------------------------------ */
/* 注入页面的辅助脚本（String.raw：里面的正则反斜杠原样保留）          */
/* ------------------------------------------------------------------ */

const PAGE_HELPER = String.raw`(() => {
  if (window.__dsvoter) return true;

  var SEL = 'button,[role="button"],[role="link"],input[type="submit"],input[type="button"],a,[onclick],[data-vote]';
  var AD_SEL = 'ins,[data-ad],[class*="sponsor"],[class*="banner"],[class*="advert"],[class*="ad-"],[id*="advert"],[class*="ads"]';
  var VOTE_RE = /(vote|投票|投一票|投给|支持|赞成|点赞|upvote|submit|提交|确认|选择|选它)/i;
  var STRONG_RE = /(vote|投票|upvote|支持)/i;

  var visible = function (e) {
    var r = e.getBoundingClientRect();
    var s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0.05;
  };
  var textOf = function (e) {
    return ((e.innerText || e.value || e.textContent || '') + '').replace(/\s+/g, ' ').trim();
  };
  var rectOf = function (e) {
    var r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  };
  var classOf = function (e) {
    return (typeof e.className === 'string' ? e.className : '').slice(0, 60);
  };

  var cssPath = function (el) {
    if (el.id) {
      try { if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id); } catch (e) {}
    }
    var attrs = ['data-testid', 'data-id', 'data-vote', 'name', 'aria-label'];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute && el.getAttribute(attrs[i]);
      if (v && v.length < 40) {
        var s = el.tagName.toLowerCase() + '[' + attrs[i] + '="' + v + '"]';
        try { if (document.querySelectorAll(s).length === 1) return s; } catch (e) {}
      }
    }
    var parts = [];
    var cur = el;
    var guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 6) {
      var part = cur.tagName.toLowerCase();
      var cls = classOf(cur).trim().split(/\s+/).filter(function (c) {
        return c && !/^(active|hover|selected|focus|open|show|is-|js-)/i.test(c);
      }).slice(0, 2);
      if (cls.length) part += '.' + cls.map(function (c) { return CSS.escape(c); }).join('.');
      var parent = cur.parentElement;
      if (parent) {
        var sibs = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
        if (sibs.length > 1) part += ':nth-of-type(' + (Array.prototype.indexOf.call(sibs, cur) + 1) + ')';
      }
      parts.unshift(part);
      try { if (document.querySelectorAll(parts.join(' > ')).length === 1) break; } catch (e) {}
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  var api = {
    list: [],
    marked: null,
    markedOutline: '',
    markedOffset: '',

    snapshot: function (el, i) {
      var r = rectOf(el);
      var t = textOf(el);
      var id = el.id || '';
      var cls = classOf(el);
      var blob = t + ' ' + id + ' ' + cls;
      var aria = el.getAttribute && el.getAttribute('aria-disabled');
      return {
        i: i,
        tag: el.tagName,
        id: id,
        cls: cls,
        text: t.slice(0, 40),
        vote: VOTE_RE.test(blob),
        strong: STRONG_RE.test(blob) || el.hasAttribute('data-vote') || el.type === 'submit',
        ad: !!(el.closest && el.closest(AD_SEL)),
        disabled: !!(el.disabled || aria === 'true'),
        x: r.x, y: r.y, w: r.w, h: r.h,
        selector: cssPath(el),
      };
    },

    // 页面上的「人话提示」，用来解释为什么按钮点不了（安全验证中 / 太频繁 / 失败…）
    hint: function () {
      var nodes = document.querySelectorAll('[id*="status" i],[class*="status" i],[id*="verif" i],[class*="verif" i],[role="status"],[aria-live]');
      for (var i = 0; i < nodes.length; i++) {
        var t = (nodes[i].innerText || '').replace(/\s+/g, ' ').trim();
        if (t && /(验证|频繁|失败|错误|稍后|稍候|重试|提交|等待)/.test(t)) return t.slice(0, 60);
      }
      var all = (document.body.innerText || '').replace(/\s+/g, ' ');
      var m = all.match(/[^。！!?？]{0,16}(正在进行安全验证|安全验证未完成|验证未完成|提交太频繁|太频繁|请稍后|请稍候|重试)[^。！!?？]{0,16}/g);
      return m ? m.slice(0, 2).join(' | ').trim().slice(0, 120) : '';
    },

    candidates: function () {
      var all = Array.prototype.slice.call(document.querySelectorAll(SEL)).filter(visible);
      // 去掉包裹着其它候选元素的父节点，只留最内层可点元素
      var leaf = all.filter(function (e) { return !e.querySelector(SEL); });
      var use = leaf.length ? leaf : all;
      var seen = {};
      var uniq = [];
      for (var i = 0; i < use.length; i++) {
        var s = api.snapshot(use[i], i);
        var key = s.tag + '|' + s.text + '|' + s.x + ',' + s.y;
        if (seen[key]) continue;
        seen[key] = 1;
        uniq.push(use[i]);
      }
      api.list = uniq;
      return uniq.map(function (e, i) { return api.snapshot(e, i); });
    },

    describe: function (i) {
      var el = api.list[i];
      if (!el) return { ok: false, reason: '元素已失效（页面可能已刷新）' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      var s = api.snapshot(el, i);
      s.ok = true;
      return s;
    },

    describeEl: function (el) {
      if (!el) return { ok: false, reason: '选择器没匹配到元素' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      api.list.push(el);
      var s = api.snapshot(el, api.list.length - 1);
      s.ok = true;
      return s;
    },

    clickIndex: function (i) {
      var el = api.list[i];
      if (!el) return false;
      el.click();
      return true;
    },

    unflash: function () {
      if (api.marked) {
        api.marked.style.outline = api.markedOutline;
        api.marked.style.outlineOffset = api.markedOffset;
        api.marked = null;
      }
      return true;
    },

    flash: function (i) {
      var el = api.list[i];
      if (!el) return false;
      api.unflash();
      api.marked = el;
      api.markedOutline = el.style.outline;
      api.markedOffset = el.style.outlineOffset;
      el.style.outline = '3px solid #ff3b30';
      el.style.outlineOffset = '2px';
      el.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    },

    picker: function () {
      api.unflash();
      return new Promise(function (resolve) {
        var box = document.createElement('div');
        var tip = document.createElement('div');
        box.setAttribute('style', 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #ff3b30;background:rgba(255,59,48,.14);border-radius:4px;');
        tip.setAttribute('style', 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#111827;color:#fff;padding:10px 16px;border-radius:9px;font:13px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35);pointer-events:none;');
        tip.textContent = '在页面上点一下你要点的那个按钮（按 Esc 取消）';
        document.documentElement.appendChild(box);
        document.documentElement.appendChild(tip);

        var cleanup = function () {
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('click', onClick, true);
          document.removeEventListener('keydown', onKey, true);
          if (box.parentNode) box.parentNode.removeChild(box);
          if (tip.parentNode) tip.parentNode.removeChild(tip);
        };
        var onMove = function (e) {
          var el = document.elementFromPoint(e.clientX, e.clientY);
          if (!el || el === box || el === tip) return;
          var r = el.getBoundingClientRect();
          box.style.left = r.left + 'px';
          box.style.top = r.top + 'px';
          box.style.width = r.width + 'px';
          box.style.height = r.height + 'px';
        };
        var onClick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
          var raw = document.elementFromPoint(e.clientX, e.clientY);
          var el = raw && raw.closest ? (raw.closest(SEL) || raw) : raw;
          cleanup();
          if (!el) { resolve(null); return; }
          var r = rectOf(el);
          resolve({
            ok: true,
            tag: el.tagName,
            id: el.id || '',
            cls: classOf(el),
            text: textOf(el).slice(0, 40),
            x: r.x, y: r.y, w: r.w, h: r.h,
            selector: cssPath(el),
          });
        };
        var onKey = function (e) {
          if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(null); }
        };
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
      });
    },
  };

  window.__dsvoter = api;
  return true;
})()`;

/* ------------------------------------------------------------------ */
/* 页面会话：一个浏览器 + 一个页面                                      */
/* ------------------------------------------------------------------ */

export class BrowserSession {
  constructor(cfg, hooks = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.hooks = hooks;
    this.log = hooks.log || (() => {});
    this.cdp = null;
    this.sessionId = null;
    this.browserHandle = null;
    this.cleaning = false;
  }

  async start() {
    const cfg = this.cfg;
    const port = cfg.attachPort ? Number(cfg.attachPort) : await this.#launch();
    const info = await waitForCdpEndpoint(port, 15000);
    this.cdp = await connectCDP(info.webSocketDebuggerUrl);

    const { targetInfos } = await this.cdp.send('Target.getTargets');
    let page = targetInfos.find((t) => t.type === 'page' && /^https?:/.test(t.url));
    if (!page) page = targetInfos.find((t) => t.type === 'page');
    if (!page) {
      const created = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
      page = { targetId: created.targetId };
    }
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.sessionId = sessionId;

    await this.cdp.send('Page.enable', {}, sessionId);
    await this.cdp.send('Runtime.enable', {}, sessionId);

    this.cdp.on('Page.javascriptDialogOpening', (p, sid) => {
      if (sid && sid !== this.sessionId) return;
      const msg = String(p?.message || '').slice(0, 60);
      if (this.cfg.autoConfirm === false) {
        this.log('warn', `页面弹窗（${p?.type}）：「${msg}」，自动确认已关闭 —— 请手动处理`);
        return;
      }
      this.log('info', `页面弹窗（${p?.type}）：「${msg}」→ 自动点确定`);
      this.cdp.send('Page.handleJavaScriptDialog', { accept: true }, this.sessionId).catch(() => {});
    });
    this.cdp.on('Inspector.targetCrashed', () => this.log('error', '页面崩溃了'));
    return this;
  }

  async #launch() {
    const cfg = this.cfg;
    this.log('info', `启动浏览器：${cfg.exe || '(自动查找 Chrome/Edge)'} · 调试端口 ${cfg.debugPort}${cfg.headless ? ' · 无头模式' : ''}`);
    const handle = await launchBrowser({ exe: cfg.exe || undefined, port: cfg.debugPort, url: cfg.url, headless: cfg.headless });
    this.browserHandle = handle;
    if (handle.child) {
      handle.child.on('exit', (code) => {
        if (!this.cleaning) this.log('warn', `浏览器进程退出了（exit ${code}）`);
      });
    }
    const info = await Promise.race([waitForCdpEndpoint(cfg.debugPort, 25000), handle.spawnError]);
    this.log('info', `浏览器就绪：${info.Browser || 'Chromium'}`);
    return cfg.debugPort;
  }

  async eval(expression, { awaitPromise = false, swallow = false, timeoutMs } = {}) {
    try {
      const res = await this.cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise, userGesture: true,
      }, this.sessionId, timeoutMs);
      if (res.exceptionDetails) {
        const text = res.exceptionDetails.exception?.description || res.exceptionDetails.text || '页面脚本异常';
        throw new Error(String(text).split('\n')[0]);
      }
      return res.result?.value;
    } catch (e) {
      if (swallow) return undefined;
      throw e;
    }
  }

  injectHelper() {
    return this.eval(PAGE_HELPER, { swallow: true });
  }

  once(method, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const off = this.cdp.on(method, (_p, sid) => {
        if (sid && this.sessionId && sid !== this.sessionId) return;
        clearTimeout(timer);
        off();
        resolve(true);
      });
      const timer = setTimeout(() => { off(); resolve(null); }, timeoutMs);
    });
  }

  async open(url) {
    this.log('info', `打开 ${url}`);
    const loaded = this.once('Page.loadEventFired', this.cfg.loadTimeoutMs);
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
    await loaded;
    await this.waitReady(Math.min(3000, this.cfg.loadTimeoutMs));
    await this.injectHelper();
  }

  async reload() {
    const loaded = this.once('Page.loadEventFired', this.cfg.loadTimeoutMs);
    try {
      await this.cdp.send('Page.reload', { ignoreCache: this.cfg.ignoreCache }, this.sessionId);
    } catch (e) {
      this.log('warn', `刷新调用异常（继续等待）：${e.message}`);
    }
    await loaded;
    await this.waitReady(Math.min(3000, this.cfg.loadTimeoutMs));
    await this.injectHelper();
  }

  async waitReady(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let stable = 0;
    while (Date.now() < deadline) {
      const state = await this.eval('document.readyState', { swallow: true });
      if (state === 'complete') {
        stable += 1;
        if (stable >= 2) { await sleep(120); return true; }
      } else {
        stable = 0;
      }
      await sleep(150);
    }
    return false;
  }

  readKey() { return this.eval(`localStorage.getItem(${json(this.cfg.key)})`, { swallow: true }); }

  /** 清掉投票身份键，顺带清掉配置里指定的残留前缀键 */
  clearKey() {
    const prefixes = String(this.cfg.clearPrefixes || '').split(/[\s,，;；]+/).filter(Boolean);
    return this.eval(`(() => {
      try {
        localStorage.removeItem(${json(this.cfg.key)});
        var pre = ${json(prefixes)};
        var removed = [];
        for (var i = localStorage.length - 1; i >= 0; i--) {
          var k = localStorage.key(i);
          for (var j = 0; j < pre.length; j++) {
            if (k && k.indexOf(pre[j]) === 0) { localStorage.removeItem(k); removed.push(k); break; }
          }
        }
        return { value: localStorage.getItem(${json(this.cfg.key)}), removed: removed };
      } catch (e) { return { error: e.message }; }
    })()`, { swallow: true });
  }

  /** 当前目标按钮 + 确认键的快照，用作「点击后有没有变化」的基线 */
  statusSnapshot(t) {
    const prefix = String(this.cfg.confirmKeyPrefix || '').trim();
    return this.eval(`(() => {
      var el = ${t.i >= 0 ? `window.__dsvoter.list[${t.i}]` : 'null'};
      var pre = ${json(prefix)};
      var keys = [];
      if (pre) { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(pre) === 0) keys.push(k); } }
      return { keys: keys.length, text: el ? ((el.innerText || '') + '').replace(/\s+/g, ' ').trim().slice(0, 24) : null, disabled: el ? !!el.disabled : null };
    })()`, { swallow: true });
  }

  /** 点击前：等目标按钮变成可点（安全验证中 / disabled 的按钮点了等于没点） */
  async waitClickable(i, timeoutMs, onFirstWait) {
    if (i < 0 || !timeoutMs || timeoutMs <= 0) return { ok: true };
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    while (Date.now() < deadline) {
      const d = await this.eval(`window.__dsvoter.describe(${i})`, { swallow: true });
      if (!d || !d.ok) return { ok: false, reason: d?.reason || '目标元素不见了' };
      if (!d.disabled) return { ok: true, target: d };
      if (!announced) { announced = true; onFirstWait?.(); }
      await sleep(250);
    }
    const hint = await this.eval('window.__dsvoter.hint()', { swallow: true });
    return { ok: false, hint, reason: `等了 ${Math.round(timeoutMs / 1000)}s 按钮还是不可点${hint ? `（页面提示：${hint}）` : ''}` };
  }

  /** 点击后：确认这一票真的生效了 */
  async confirmVote(t, before, onFirstWait) {
    const prefix = String(this.cfg.confirmKeyPrefix || '').trim();
    const timeoutMs = Number(this.cfg.confirmMs) || 0;
    if (t.i < 0 || timeoutMs <= 0) return { ok: true, signal: '未开启确认' };
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    while (Date.now() < deadline) {
      const st = await this.statusSnapshot(t);
      if (st) {
        if (prefix && st.keys > (before?.keys || 0)) return { ok: true, signal: `出现新的 ${prefix}* 键` };
        if (before?.text && st.text && st.text !== before.text && /(已投|已选|谢谢|成功|voted)/i.test(st.text)) {
          return { ok: true, signal: `按钮变成「${st.text}」` };
        }
      }
      if (!announced) { announced = true; onFirstWait?.(); }
      await sleep(300);
    }
    const hint = await this.eval('window.__dsvoter.hint()', { swallow: true });
    return { ok: false, hint, reason: `点了但 ${Math.round(timeoutMs / 1000)}s 内没确认到生效${hint ? `（页面提示：${hint}）` : ''}` };
  }

  async waitForNewUuid(prev, timeoutMs, shouldStop = () => false) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (shouldStop()) return null;
      const v = await this.readKey();
      if (typeof v === 'string' && v.length > 0 && v !== prev) return v;
      await sleep(200);
    }
    return null;
  }

  /** 护栏：第 i 个候选元素是否满足「必须匹配选择器」 */
  async hitsGuard(i) {
    const must = String(this.cfg.requireSelector || '').trim();
    if (!must || i < 0) return null;
    const ok = await this.eval(`(() => { const el = window.__dsvoter.list[${i}]; try { return !!(el && el.matches(${json(must)})); } catch (e) { return 'BAD_SELECTOR'; } })()`, { swallow: true });
    if (ok === 'BAD_SELECTOR') return `护栏选择器写法有问题：${must}`;
    if (ok) return null;
    return `解析出来的目标不匹配护栏「${must}」，已中止 —— 说明当前定位方式会点到别的元素（比如广告位或另一边），请改用「按 CSS 选择器」并填右边那个的选择器`;
  }

  /** 找出「要点哪个按钮」。返回 { ok, i, tag, text, x, y, w, h, selector, candidates, pool } */
  async resolveTarget() {
    const cfg = this.cfg;
    await this.injectHelper();

    if (cfg.clickMode === 'selector') {
      const r = await this.eval(`window.__dsvoter.describeEl(document.querySelector(${json(cfg.clickValue)}))`, { swallow: true });
      if (!r || !r.ok) return { ok: false, reason: r?.reason || `选择器没匹配到：${cfg.clickValue}` };
      const forbidden = await this.hitsGuard(r.i);
      if (forbidden) return { ok: false, reason: forbidden };
      r.candidates = [];
      r.chosenFrom = 'selector';
      return r;
    }
    if (cfg.clickMode === 'js') {
      return { ok: true, i: -1, tag: 'JS', id: '', text: '自定义脚本', x: 0, y: 0, w: 0, h: 0, selector: '', candidates: [], chosenFrom: 'js' };
    }

    const cands = await this.eval('window.__dsvoter.candidates()', { swallow: true });
    if (!Array.isArray(cands) || cands.length === 0) return { ok: false, reason: '页面上没找到任何可点元素（可能还在加载）' };

    // 广告位（横幅/推广链接）先排除掉，别把广告当成投票按钮
    const ads = cands.filter((c) => c.ad);
    const real = cands.filter((c) => !c.ad);
    const usable = real.length ? real : cands;
    const votePool = usable.filter((c) => c.vote || c.strong);
    const pool = votePool.length ? votePool : usable;
    const rowOf = (c) => Math.round(c.y / 40);
    const readingOrder = [...pool].sort((a, b) => (rowOf(a) - rowOf(b)) || (a.x - b.x));
    let chosen = null;

    if (cfg.clickMode === 'text') {
      const want = String(cfg.clickValue || '').trim();
      chosen = cands.find((c) => c.text === want) || cands.find((c) => c.text.includes(want));
      if (!chosen) return { ok: false, reason: `没找到文字为「${want}」的可点元素（候选：${summarize(cands)}）` };
    } else if (cfg.clickMode === 'right') {
      chosen = [...pool].sort((a, b) => b.x - a.x)[0];
    } else if (cfg.clickMode === 'left') {
      chosen = [...pool].sort((a, b) => a.x - b.x)[0];
    } else if (cfg.clickMode === 'nth') {
      const n = Math.max(1, parseInt(cfg.clickValue, 10) || 1);
      if (n > readingOrder.length) return { ok: false, reason: `候选只有 ${readingOrder.length} 个，取不到第 ${n} 个` };
      chosen = readingOrder[n - 1];
    } else {
      // auto：先看「像投票按钮」的、再看 strong 标记、最后按阅读顺序；广告位已经排除
      chosen = [...usable].sort((a, b) => (Number(b.strong) - Number(a.strong)) || (Number(b.vote) - Number(a.vote)) || (rowOf(a) - rowOf(b)) || (a.x - b.x))[0];
    }

    const detail = await this.eval(`window.__dsvoter.describe(${chosen.i})`, { swallow: true });
    if (!detail || !detail.ok) return { ok: false, reason: detail?.reason || '元素已失效' };

    // 护栏：解析出来的目标必须匹配「必须匹配选择器」（例如只允许点右边那个）
    const forbidden = await this.hitsGuard(chosen.i);
    if (forbidden) return { ok: false, reason: forbidden };

    detail.candidates = cands;
    detail.pool = pool.length;
    detail.excludedAds = ads.length;
    detail.chosenFrom = votePool.length ? 'vote' : 'all';
    return detail;
  }

  async clickTarget(t) {
    const cfg = this.cfg;
    if (cfg.clickMode === 'js') {
      const out = await this.eval(cfg.clickValue || 'undefined', { awaitPromise: true, swallow: true });
      return { ok: true, tag: 'JS', id: '', text: `自定义脚本 → ${short(out)}`, confirmed: true };
    }

    // 1) 等按钮变成可点（安全验证没过时按钮是 disabled 的，点了等于没点）
    const waited = await this.waitClickable(t.i, cfg.waitClickableMs, () => {
      this.log('info', `目标按钮当前不可点${t.text ? `（「${t.text}」）` : ''} —— 正在等它变可点…`);
    });
    if (!waited.ok) return { ok: false, reason: waited.reason };
    if (waited.target) t = { ...t, ...waited.target };

    const before = await this.statusSnapshot(t);

    if (cfg.flash && t.i >= 0) await this.eval(`window.__dsvoter.flash(${t.i})`, { swallow: true });

    if (cfg.realClick && t.x > 0 && t.y > 0 && t.w > 0 && t.h > 0) {
      const point = { x: t.x, y: t.y, button: 'left', clickCount: 1 };
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, this.sessionId);
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point }, this.sessionId);
      await sleep(40);
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point }, this.sessionId);
    } else {
      const done = await this.eval(`window.__dsvoter.clickIndex(${t.i})`, { swallow: true });
      if (!done) return { ok: false, reason: '取到了元素但点击没生效' };
    }
    if (cfg.flash && t.i >= 0) {
      await sleep(350);
      await this.eval('window.__dsvoter.unflash()', { swallow: true });
    }

    // 2) 确认这一票真的生效（没配确认信号时直接跳过，不白等）
    if (t.i < 0 || !(Number(cfg.confirmMs) > 0)) return { ok: true, tag: t.tag, id: t.id, text: t.text, confirmed: true, signal: '未开启确认' };
    const conf = await this.confirmVote(t, before, () => this.log('info', '已点击，正在等投票生效…'));
    return {
      ok: true, tag: t.tag, id: t.id, text: t.text,
      confirmed: conf.ok, signal: conf.signal, note: conf.reason, hint: conf.hint,
    };
  }

  async screenshot() {
    try {
      const res = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 72 }, this.sessionId);
      return res?.data ? `data:image/jpeg;base64,${res.data}` : null;
    } catch {
      return null;
    }
  }

  async close() {
    this.cleaning = true;
    if (this.cdp) { this.cdp.close(); this.cdp = null; }
    if (this.browserHandle && this.cfg.closeBrowserOnStop && !this.cfg.attachPort) {
      this.log('info', '关闭浏览器窗口');
      await closeBrowser(this.browserHandle);
      this.browserHandle = null;
    } else if (this.browserHandle) {
      this.log('info', '浏览器窗口保留（可在里面手动操作）');
      this.browserHandle = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 循环                                                                 */
/* ------------------------------------------------------------------ */

export class LoopRunner {
  constructor(cfg, hooks = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.hooks = hooks;
    this.stopped = false;
    this.round = 0;
    this.clicked = 0;
    this.confirmed = 0;
    this.lastUuid = null;
    this.startedAt = Date.now();
    this.session = null;
  }

  get elapsed() { return Math.round((Date.now() - this.startedAt) / 1000); }

  stop() { this.stopped = true; }

  log(level, msg) { this.hooks.log?.(level, msg); }

  async run() {
    const cfg = this.cfg;
    if (!cfg.url) throw new Error('请先填页面地址');

    this.session = new BrowserSession(cfg, { log: (l, m) => this.log(l, m) });
    const s = this.session;
    try {
      await s.start();
      await s.open(cfg.url);
      this.log('info', `已进入页面：${(await s.eval('location.href', { swallow: true })) || cfg.url}`);

      let firstTargetLogged = false;
      let failStreak = 0;
      let aborted = false;
      while (!this.stopped && (cfg.maxRounds === 0 || this.round < cfg.maxRounds)) {
        this.round += 1;
        this.hooks.status?.({ round: this.round });
        const t0 = Date.now();

        const cleared = await s.clearKey();
        const extra = Array.isArray(cleared?.removed) && cleared.removed.length ? ` · 顺带清了 ${cleared.removed.length} 个残留键` : '';
        this.log('info', `第 ${this.round} 轮 · 已清 ${cfg.key}（原值 ${short(cleared?.value)}）${extra}`);

        await s.reload();
        const uuid = await s.waitForNewUuid(this.lastUuid, cfg.loadTimeoutMs, () => this.stopped);
        if (uuid) {
          this.lastUuid = uuid;
          this.hooks.status?.({ uuid });
          this.log('ok', `新 UUID：${uuid}`);
        } else if (!this.stopped) {
          this.log('warn', `${cfg.loadTimeoutMs}ms 内没读到新的 ${cfg.key}，本轮照常点击`);
        }
        if (this.stopped) break;

        // 定位 → 点击；被限流/安全验证挡住时，在【同一个页面】上等一会儿重点，不重新加载
        let clickRes = null;
        let blockedAttempts = 0;
        while (!this.stopped) {
          const target = await s.resolveTarget();
          if (!target.ok) {
            this.log('error', `找不到要点的按钮：${target.reason}`);
            this.log('warn', '提示：改用「最右的那个」/「按按钮文字」/「按 CSS 选择器」，或点「拾取按钮」在页面上直接指给它');
            clickRes = { ok: false, reason: `找不到要点的按钮：${target.reason}` };
            if (this.round === 1) aborted = true;
            break;
          }
          if (!firstTargetLogged) {
            firstTargetLogged = true;
            const cands = target.candidates || [];
            if (cands.length) this.log('info', `候选可点元素 ${cands.length} 个${target.chosenFrom === 'vote' ? '（其中像投票按钮的 ' + target.pool + ' 个）' : ''}${target.excludedAds ? `（已排除 ${target.excludedAds} 个广告位）` : ''}：${summarize(cands.filter((c) => !c.ad))}`);
            this.log('info', `定位方式 ${labelOfMode(cfg)} → 选中 <${String(target.tag).toLowerCase()}${target.id ? '#' + target.id : ''}>「${target.text}」 · ${target.selector}${target.disabled ? '（当前不可点，会等它变可点）' : ''}`);
          }

          clickRes = await s.clickTarget(target);
          const blockedText = `${clickRes.reason || ''} ${clickRes.note || ''} ${clickRes.hint || ''}`;
          const blocked = /(频繁|稍后|稍候|重试|限流|验证)/.test(blockedText);
          if ((clickRes.ok && clickRes.confirmed) || !blocked || !(cfg.waitOnBlockedMs > 0)) break;

          blockedAttempts += 1;
          if (blockedAttempts > (Number(cfg.blockedRetries) || 5)) {
            this.log('error', `连续 ${blockedAttempts} 次都被站点挡住（限流 / 安全验证），先停下来。`);
            break;
          }
          this.log('warn', `${clickRes.ok ? '已点击但没确认生效' : '没点成'}：${clickRes.reason || clickRes.note}`);
          this.log('warn', `像是限流或安全验证没完成 —— 等 ${Math.round(cfg.waitOnBlockedMs / 1000)}s 后在同一个页面上重试（第 ${blockedAttempts}/${cfg.blockedRetries} 次，不重新加载）`);
          await this.sleepInterruptible(cfg.waitOnBlockedMs);
        }

        if (this.stopped) break;

        if (!clickRes || !clickRes.ok) {
          failStreak += 1;
          this.log('error', `本轮失败：${clickRes?.reason || '未知原因'}`);
          if (failStreak >= 2) {
            this.log('error', '连续两轮都没点成，先停下来。常见原因：安全验证（Turnstile 之类）没过、按钮被禁用、或需要人工点一下验证框。');
            aborted = true;
            break;
          }
          continue;
        }

        failStreak = 0;
        this.clicked += 1;
        this.hooks.status?.({ clicked: this.clicked });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (clickRes.confirmed) {
          this.confirmed += 1;
          this.hooks.status?.({ confirmed: this.confirmed });
          this.log('ok', `已点击 <${String(clickRes.tag).toLowerCase()}${clickRes.id ? '#' + clickRes.id : ''}>「${clickRes.text}」 · 已确认生效（${clickRes.signal}）· 本轮 ${secs}s`);
        } else {
          this.log('warn', `已点击 <${String(clickRes.tag).toLowerCase()}${clickRes.id ? '#' + clickRes.id : ''}>「${clickRes.text}」 · 但没确认生效：${clickRes.note} · 本轮 ${secs}s`);
        }

        if (!this.stopped && cfg.dwellMs > 0) await this.sleepInterruptible(cfg.dwellMs);
      }
      this.log('info', this.stopped ? '已停止'
        : aborted ? `已停止（原计划 ${cfg.maxRounds || '无限'} 轮，连续失败提前退出）`
        : `已跑满 ${cfg.maxRounds} 轮，自动停止`);
    } finally {
      await this.session?.close();
      this.session = null;
    }
  }

  sleepInterruptible(ms) {
    const deadline = Date.now() + ms;
    return (async () => {
      while (Date.now() < deadline && !this.stopped) await sleep(Math.min(120, deadline - Date.now()));
    })();
  }
}

/* ------------------------------------------------------------------ */
/* 试探：打开页面 → 定位 → 高亮 → 截图（不点，除非 doClick）             */
/* ------------------------------------------------------------------ */

export async function probeTarget(cfg, hooks = {}) {
  const merged = { ...DEFAULTS, ...cfg, closeBrowserOnStop: true };
  const session = new BrowserSession(merged, hooks);
  try {
    await session.start();
    await session.open(merged.url);
    const target = await session.resolveTarget();
    if (!target.ok) return { ok: false, reason: target.reason };

    if (target.i >= 0) await session.eval(`window.__dsvoter.flash(${target.i})`, { swallow: true });
    await sleep(400);
    const shot = await session.screenshot();
    const pageUrl = await session.eval('location.href', { swallow: true });
    const uuid = await session.readKey();

    let clicked = false;
    if (cfg.doClick) {
      const res = await session.clickTarget(target);
      clicked = !!res.ok;
      if (!res.ok) return { ok: false, reason: res.reason, info: target, candidates: target.candidates, screenshot: shot };
    }
    return { ok: true, info: publicTarget(target), candidates: (target.candidates || []).map(publicTarget), screenshot: shot, pageUrl, uuid, clicked };
  } finally {
    await session.close();
  }
}

/* ------------------------------------------------------------------ */
/* 拾取：让你在浏览器窗口里点一下，我用它当目标                          */
/* ------------------------------------------------------------------ */

export async function pickElement(cfg, hooks = {}) {
  const merged = { ...DEFAULTS, ...cfg, headless: false, closeBrowserOnStop: true };
  const session = new BrowserSession(merged, hooks);
  try {
    await session.start();
    await session.open(merged.url);
    hooks.log?.('info', '请在弹出的浏览器窗口里，点一下你要点的那个按钮（按 Esc 取消）');
    const picked = await session.eval('window.__dsvoter.picker()', { awaitPromise: true, swallow: true, timeoutMs: 180000 });
    if (!picked || !picked.ok) return { ok: false, reason: '已取消（或没点到元素）' };
    await session.eval(`window.__dsvoter.describeEl(document.querySelector(${json(picked.selector)}))`, { swallow: true });
    await session.eval(`window.__dsvoter.flash(window.__dsvoter.list.length - 1)`, { swallow: true });
    await sleep(400);
    const shot = await session.screenshot();
    return { ok: true, info: picked, screenshot: shot };
  } finally {
    await session.close();
  }
}

/* ------------------------------------------------------------------ */

function publicTarget(t) {
  return { tag: t.tag, id: t.id, cls: t.cls, text: t.text, selector: t.selector, x: t.x, y: t.y, w: t.w, h: t.h, vote: t.vote, strong: t.strong };
}

function summarize(cands) {
  return cands.slice(0, 8)
    .map((c, i) => `${i + 1}.「${(c.text || c.tag).slice(0, 14)}」${c.vote || c.strong ? '*' : ''}`)
    .join(' ')
    + (cands.length > 8 ? ` …共 ${cands.length} 个` : '')
    + '（带 * 的像投票按钮）';
}

function labelOfMode(cfg) {
  const map = { auto: '自动识别', right: '最右的那个', left: '最左的那个', nth: `第 ${cfg.clickValue} 个`, text: `文字「${cfg.clickValue}」`, selector: `选择器 ${cfg.clickValue}`, js: '自定义脚本' };  return map[cfg.clickMode] || cfg.clickMode;
}

function short(v) {
  if (v === null || v === undefined) return 'null';
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return s.length > 20 ? s.slice(0, 16) + '…' : s;
}
