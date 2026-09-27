// 扫描本机常见 DevTools 端口，找可以直接接管的浏览器。
const ports = [];
for (let p = 9200; p <= 9400; p++) ports.push(p);
for (const p of [9111, 9444, 9515, 2222, 1234, 49948]) ports.push(p);

const hits = await Promise.all(ports.map(async (port) => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 350);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return j.webSocketDebuggerUrl ? { port, browser: j.Browser, ws: j.webSocketDebuggerUrl } : null;
  } catch {
    return null;
  }
}));

const found = hits.filter(Boolean);
console.log(found.length ? JSON.stringify(found, null, 2) : '没找到开着的 DevTools 端口');
