// 极简 Chrome DevTools Protocol 客户端：只用 Node 内置能力，零第三方依赖。
// 支持 flatten 模式（Target.attachToTarget + sessionId），因此一个浏览器级连接可以驱动某个页面。

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CALL_TIMEOUT = 30000;

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;

    ws.addEventListener('message', (ev) => this.#onMessage(ev));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('CDP 连接已断开'));
      this.pending.clear();
    });
    ws.addEventListener('error', () => {
      /* close 事件里统一处理 */
    });
  }

  #onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const list = this.handlers.get(msg.method);
      if (list) for (const h of [...list]) { try { h(msg.params, msg.sessionId); } catch { /* 忽略回调异常 */ } }
    }
  }

  send(method, params = {}, sessionId, timeoutMs = CALL_TIMEOUT) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已断开'));
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 调用超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
    return () => this.handlers.get(method)?.delete(handler);
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* 已关闭 */ }
  }
}

export async function fetchJson(url, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function connectCDP(wsUrl, timeoutMs = 10000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接 CDP WebSocket 超时')), timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接 CDP WebSocket 失败')); }, { once: true });
  });
  return new CDP(ws);
}

/** 轮询 http://127.0.0.1:<port>/json/version，直到 DevTools 端点可用。 */
export async function waitForCdpEndpoint(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const info = await fetchJson(`http://127.0.0.1:${port}/json/version`, 1500);
      if (info?.webSocketDebuggerUrl) return info;
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }
  throw new Error(`等待 CDP 端口 ${port} 超时${lastErr ? `（${lastErr.message}）` : ''}`);
}
