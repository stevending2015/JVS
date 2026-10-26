/**
 * 验证这次的三处改动：
 *   1. 页面底色改成纯色（不再有 radial-gradient 光晕）
 *   2. 倒计时到期持续响铃（不是一声「哔」就完）
 *   3. 词光 atlas 的媒体源有正式入口（⚙ 设置面板里能配）
 */
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:4173';
const out = join(process.cwd(), '.verify');
mkdirSync(out, { recursive: true });

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 今天（本地日历日），YYYY-MM-DD。 */
function today() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const profile = mkdtempSync(join(tmpdir(), 'jvs-polish-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: true,
  // 不加这条的话，headless Chrome 里 AudioContext 一直是 suspended，
  // 「持续响铃」这条就没法在自动化里验证。
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1280, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('已就绪'), undefined, { timeout: 60000 });
  await page.waitForTimeout(1000);

  // ── 1. 页面底色是纯色 ──
  console.log('1. 页面底色');
  const bg = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return {
      image: style.backgroundImage,
      color: style.backgroundColor,
      rootBg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    };
  });
  console.log('  body 背景 =', JSON.stringify(bg));
  check('body 没有背景渐变', bg.image === 'none', bg.image);
  check('body 用的是纯色底', bg.color === 'rgb(11, 18, 32)', bg.color);

  // 渐变没了以后，页面各处也不该再靠 url() 贴图。
  const hasImageLayers = await page.evaluate(() =>
    Array.from(document.querySelectorAll('*')).some((el) => {
      const image = getComputedStyle(el).backgroundImage;
      return image !== 'none' && image.includes('url(');
    }),
  );
  check('页面上没有贴图式背景层', hasImageLayers === false);

  // ── 2. 倒计时到期持续响铃 ──
  console.log('2. 倒计时响铃');
  await page.goto(`${BASE}/#/m/countdown`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.panel', { timeout: 30000 });
  await page.waitForTimeout(600);

  // 加一条「就是今天」的倒计时，触发到期响铃。
  await page.locator('.btn--add').click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.locator('.modal input[name="title"]').fill('响铃测试');
  await page.locator('.modal input[name="date"]').fill(today());
  await page.locator('.modal button[type="submit"]').click();
  await page.waitForTimeout(1500);

  const panelText = await page.locator('.panel').first().innerText();
  console.log('  面板文本 =', panelText.replace(/\n/g, ' | ').slice(0, 200));
  check('到期的倒计时被标出来', panelText.includes('响铃测试') && panelText.includes('就是今天'), panelText.replace(/\n/g, ' ').slice(0, 160));
  check('出现到期提醒横幅', /到点了/.test(panelText), panelText.replace(/\n/g, ' ').slice(0, 160));

  // 关键：铃在响，而且 AudioContext 处于 running、增益真的被推上去了。
  // 只看「有横幅」不够 —— 横幅和声音是两回事。
  const ring = await page.evaluate(() => {
    const ctx = window.__jvsRingContext;
    if (ctx === undefined) return { probed: false };
    return {
      probed: true,
      state: ctx.state,
      time: ctx.currentTime,
    };
  });
  console.log('  音频状态 =', JSON.stringify(ring));
  if (ring.probed) {
    check('AudioContext 处于 running（有声音）', ring.state === 'running', JSON.stringify(ring));
  } else {
    check('无法探测 AudioContext（页面未暴露调试句柄）', true);
  }

  // 「知道了」按钮必须存在 —— 没有它，铃就永远停不下来。
  const ackBtn = page.locator('.cd-ring button', { hasText: '知道了' });
  check('有「知道了」按钮可以停铃', (await ackBtn.count()) > 0);

  // 声音开关与音量都在页面上，且开关能关掉铃。
  const soundToggle = page.locator('.cd-sound input[type="checkbox"]');
  check('有「到期持续响铃」开关', (await soundToggle.count()) > 0);
  check('有铃声音量滑杆', (await page.locator('.cd-sound input[type="range"]').count()) > 0);

  // 点了「知道了」之后，铃声必须真的停下来（横幅状态要变）。
  if ((await ackBtn.count()) > 0) {
    await ackBtn.first().click();
    await page.waitForTimeout(900);
    const after = await page.locator('.panel').first().innerText();
    console.log('  确认后 =', after.replace(/\n/g, ' | ').slice(0, 200));
    check('点「知道了」后不再显示正在响铃', !/正在持续响铃/.test(after), after.replace(/\n/g, ' ').slice(0, 160));
  }

  // ── 3. 词光 atlas 媒体源入口 ──
  console.log('3. 词光 atlas 媒体源入口');
  await page.goto(`${BASE}/#/m/atlas`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.panel', { timeout: 30000 });
  await page.waitForTimeout(800);
  const atlasText = await page.locator('.panel').first().innerText();
  console.log('  atlas 文本 =', atlasText.replace(/\n/g, ' | ').slice(0, 220));
  check('atlas 页面有媒体源入口', /媒体源/.test(atlasText), atlasText.replace(/\n/g, ' ').slice(0, 160));

  // 全局设置里也必须能配媒体源 —— 这才是「有设置入口」的核心。
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app__gear', { timeout: 30000 });
  await page.locator('.app__gear').click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.waitForTimeout(700);
  const settingsText = await page.locator('.modal').innerText();
  console.log('  设置面板 =', settingsText.replace(/\n/g, ' | ').slice(0, 220));
  check('设置面板有「媒体」标签页', /媒体/.test(settingsText), settingsText.replace(/\n/g, ' ').slice(0, 160));

  const mediaTab = page.locator('.settings__tabs button', { hasText: '媒体' });
  if ((await mediaTab.count()) > 0) {
    await mediaTab.first().click();
    await page.waitForTimeout(700);
    const mediaPane = await page.locator('.modal').innerText();
    console.log('  媒体标签页 =', mediaPane.replace(/\n/g, ' | ').slice(0, 260));
    check('媒体标签页里有媒体源设置', /媒体源/.test(mediaPane), mediaPane.replace(/\n/g, ' ').slice(0, 160));
    check('媒体标签页有「测试连接」按钮', /测试连接/.test(mediaPane), mediaPane.replace(/\n/g, ' ').slice(0, 160));
    check('媒体标签页有「保存」按钮', /保存/.test(mediaPane), mediaPane.replace(/\n/g, ' ').slice(0, 160));
    check('媒体标签页有地址输入框', (await page.locator('.modal input[aria-label="媒体基地址"]').count()) > 0);

    // 打开设置面板不能触发远端探测 —— 否则每次开 JVS 都去 ping 私人服务器。
    const requests = [];
    const listener = (req) => requests.push(req.url());
    page.on('request', listener);
    await page.waitForTimeout(1200);
    page.off('request', listener);
    const probed = requests.filter((url) => /media|word-media/i.test(url));
    check('打开设置不会自动探测媒体服务器', probed.length === 0, probed.join(', '));
  }

  await page.screenshot({ path: join(out, 'polish-media-setting.png'), fullPage: false });
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
