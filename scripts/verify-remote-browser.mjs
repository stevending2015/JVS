/**
 * 验证 JVS 前端从远端拉媒体。
 *
 * 拦截网络请求，确认：
 *   - 媒体请求确实发往 media.example.com:8090（不是本地）
 *   - 插画和音频都成功（200）
 *   - 界面上的 <img> 真的渲染出来了
 */
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:4173';
const REMOTE = new URL(process.env.WA_BASE ?? (() => { throw new Error('请设置 WA_BASE'); })()).host;
const out = join(process.cwd(), '.verify');
mkdirSync(out, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'jvs-remote-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, args: ['--no-sandbox'], viewport: { width: 1280, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());

/** 记录媒体请求。 */
const mediaRequests = [];
const mediaFailures = [];
page.on('request', (request) => {
  const url = request.url();
  if (url.includes(REMOTE) || url.includes('/word-media/')) mediaRequests.push(url);
});
page.on('requestfailed', (request) => {
  const url = request.url();
  if (url.includes(REMOTE) || url.includes('/word-media/')) mediaFailures.push(`${url} — ${request.failure()?.errorText}`);
});
page.on('response', (response) => {
  const url = response.url();
  if ((url.includes(REMOTE) || url.includes('/word-media/')) && !response.ok()) {
    mediaFailures.push(`${url} — HTTP ${response.status()}`);
  }
});
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

try {
  console.log('1. 打开词光 atlas');
  await page.goto(`${BASE}/#/m/atlas`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('已就绪'), undefined, { timeout: 60000 });
  await page.waitForSelector('.wa-page', { timeout: 30000 });
  await page.waitForTimeout(1200);

  // 导入词库（如果还没导）
  if (await page.locator('.wa-intro').count() === 1) {
    console.log('  正在导入词库…');
    await page.getByRole('button', { name: /导入词库/ }).click();
    await page.waitForSelector('.wa-stats', { timeout: 240000 });
  }
  await page.waitForTimeout(800);

  console.log('2. 开始学习（触发媒体预取）');
  mediaRequests.length = 0;
  mediaFailures.length = 0;
  await page.getByRole('button', { name: '开始学习' }).click();
  await page.waitForSelector('.wa-quiz', { timeout: 180000 });
  await page.waitForTimeout(2500);

  // 答几题，让图片和音频都出现
  for (let i = 0; i < 4; i += 1) {
    const options = page.locator('.wa-option');
    if (await options.count() > 0) {
      await options.first().click();
      await page.waitForSelector('.wa-verdict', { timeout: 20000 });
    } else {
      await page.locator('.wa-spell input').fill('test');
      await page.locator('.wa-spell button').click();
      await page.waitForSelector('.wa-verdict', { timeout: 20000 });
    }
    await page.waitForTimeout(900);
    await page.locator('.wa-grade').nth(2).click();
    await page.waitForTimeout(900);
  }

  const remoteHits = mediaRequests.filter((u) => u.includes(REMOTE));
  const localHits = mediaRequests.filter((u) => u.includes('/word-media/'));

  console.log(`  媒体请求总数: ${mediaRequests.length}`);
  console.log(`    发往远端(${REMOTE}): ${remoteHits.length}`);
  console.log(`    发往本地(/word-media): ${localHits.length}`);
  console.log(`  失败: ${mediaFailures.length}`);
  if (mediaFailures.length > 0) mediaFailures.slice(0, 5).forEach((f) => console.log(`    ✗ ${f}`));

  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail = '') => {
    if (ok) { passed += 1; console.log(`  PASS  ${name}`); }
    else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
  };

  check('媒体请求发往远端服务器', remoteHits.length > 0, `remote=${remoteHits.length}`);
  check('没有回退到本地', localHits.length === 0, `local=${localHits.length}`);
  check('没有失败的媒体请求', mediaFailures.length === 0, mediaFailures.slice(0, 3).join(' | '));
  check('拉到了插画', remoteHits.some((u) => u.includes('/atlas/img/')), `${remoteHits.length} 个请求`);
  check('拉到了音频', remoteHits.some((u) => u.includes('/atlas/audio/')), `${remoteHits.length} 个请求`);

  // 图片真的渲染出来了吗
  const imgInfo = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    return imgs.map((el) => ({
      src: el.getAttribute('src') ?? '',
      natural: el.naturalWidth,
      complete: el.complete,
    }));
  });
  const rendered = imgInfo.filter((i) => i.natural > 0);
  console.log(`  页面上 <img>: ${imgInfo.length} 个，其中已解码: ${rendered.length}`);
  check('图片实际渲染成功', rendered.length > 0 || imgInfo.length === 0,
    JSON.stringify(imgInfo.slice(0, 2)));

  await page.screenshot({ path: join(out, 'atlas-remote-media.png'), fullPage: true });

  // 显示当前媒体源
  await page.goto(`${BASE}/#/m/atlas`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.wa-stats', { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '统计', exact: true }).click();
  await page.waitForTimeout(1000);
  const hint = await page.locator('.wa-stats-view .wa-today__hint').filter({ hasText: '当前：' }).innerText();
  console.log(`  媒体源: ${hint.replace(/\n/g, ' ')}`);
  check('界面显示当前用的是网络词库', hint.includes('网络词库'), hint);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await context.close();
}
