// 直接打印 /api/probe 的原始响应，用来确认护栏到底拦没拦住。
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const body = { clickMode: 'auto', forbidSelector: '[data-choice="left"]', headless: false };
const r = await fetch(BASE + '/api/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const j = await r.json();
console.log('HTTP', r.status);
console.log(JSON.stringify({ ok: j.ok, error: j.error, result: { ok: j.result?.ok, reason: j.result?.reason, info: j.result?.info, clicked: j.result?.clicked } }, null, 1));
