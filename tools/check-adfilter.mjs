// 等真站的广告位加载出来，再看候选列表里它有没有被标成"广告"。
import { BrowserSession } from '../lib/looper.mjs';
import { sleep } from '../lib/cdp.mjs';

const URL_ = 'https://ds-vs-ds.win/';
const s = new BrowserSession({ url: URL_, key: 'ds-vs-ds-voter', headless: true, debugPort: 9432, closeBrowserOnStop: true },
  { log: (l, m) => console.log(`  [${l}] ${m}`) });

try {
  await s.start();
  await s.open(URL_);

  const AD_PROBE = 'document.querySelectorAll(\'a.sponsor-banner,[class*="sponsor"],[class*="banner"]\').length';
  let adCount = 0;
  for (let i = 0; i < 60; i++) {
    adCount = (await s.eval(AD_PROBE, { swallow: true })) || 0;
    if (adCount > 0) break;
    await sleep(400);
  }
  console.log(`\n页面上广告类元素：${adCount} 个`);

  const cands = await s.eval('window.__dsvoter.candidates()', { swallow: true });
  console.log(`候选可点元素 ${cands.length} 个：`);
  for (const c of cands) {
    console.log(`  ${c.ad ? '🚫 广告' : '  ✅ 正常'}  <${c.tag.toLowerCase()}> 「${c.text.slice(0, 26)}」 ${c.selector.slice(0, 60)}`);
  }
  const ads = cands.filter((c) => c.ad).length;
  console.log(`\n被识别为广告并会排除的：${ads} 个`);
  console.log(ads > 0 ? '✅ 广告过滤生效' : '⚠️ 这次页面上没有广告，或没识别出来');
} finally {
  await s.close();
}
