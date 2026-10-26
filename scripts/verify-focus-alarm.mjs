/**
 * 验证专注结束的**全局**提醒。
 *
 * 这个功能原来的 bug：番茄归零的检测写在专注页里，只有那个页面挂载时才跑，
 * 所以人在别的页面时到点毫无反应，回到专注页才补响一声。这里要证明的就是
 * 「人在仪表盘/笔记页时，番茄到点也会立刻响，并且持续响到用户确认」。
 *
 * 怎么在几秒内模拟一个 25 分钟的番茄：往页面里注入一个可控的时间偏移，
 * 让应用看到的 Date.now() 往后跳 26 分钟。应用所有时间都由时间戳推导，
 * 所以它和真的过去了 26 分钟表现一致。
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

const profile = mkdtempSync(join(tmpdir(), 'jvs-focus-alarm-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: true,
  // 允许自动播放，否则音频上下文永远 suspended，测不到「正在响铃」
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1280, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

/** 让应用看到的 Date.now() 可控地往后跳。 */
await page.addInitScript(() => {
  const realNow = Date.now.bind(Date);
  let skew = 0;
  window.__setClockSkew = (ms) => { skew = ms; };
  Date.now = () => realNow() + skew;
});

/** 把应用时钟往后推 minutes 分钟。 */
async function fastForwardMinutes(minutes) {
  await page.evaluate((ms) => window.__setClockSkew(ms), minutes * 60 * 1000);
}

try {
  console.log('1. 开始一个番茄，然后离开专注页');
  await page.goto(`${BASE}/#/m/focus`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('已就绪'), undefined, { timeout: 60000 });
  await page.waitForSelector('.focus-clock', { timeout: 30000 });
  await page.waitForTimeout(900);

  await page.locator('.focus-actions .primary').click();
  await page.waitForTimeout(1200);
  check('番茄已开始', (await page.locator('.focus-time.is-running').count()) === 1);

  // 关键：切到仪表盘 —— 模拟「人不在专注页」
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card-grid', { timeout: 30000 });
  await page.waitForTimeout(800);
  check('已离开专注页', (await page.locator('.focus-clock').count()) === 0);
  check('此时还没有提醒', (await page.locator('.focus-alarm').count()) === 0);

  console.log('2. 人还在仪表盘时，番茄到点');
  await fastForwardMinutes(26);
  // 全局轮询是 1 Hz，留两拍
  await page.waitForSelector('.focus-alarm', { timeout: 15000 });
  await page.waitForTimeout(600);

  const alarm = await page.locator('.focus-alarm').innerText();
  console.log('  提醒内容 =', alarm.replace(/\n/g, ' | '));
  check('没有回到专注页也弹出了提醒', true);
  check('提醒写明专注结束', alarm.includes('专注结束'), alarm.replace(/\n/g, ' '));
  check('提醒告诉用户正在持续响铃', alarm.includes('正在持续响铃'), alarm.replace(/\n/g, ' '));
  check('有「知道了」可以停铃', (await page.locator('.focus-alarm button', { hasText: '知道了' }).count()) === 1);

  // 界面上的「正在持续响铃」不是靠猜的：引擎只有在 AudioContext 真的
  // resume 成功（state === 'ringing'）时才会这么显示；被自动播放策略挡住时
  // 是 'blocked'，会换成「开启提醒」按钮。所以这条断言等价于「音频链路已启动」。

  await page.screenshot({ path: join(out, 'focus-alarm-global.png'), fullPage: false });

  console.log('3. 到点后自动落库（不用回专注页手动停表）');
  await page.goto(`${BASE}/#/m/focus`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.focus-clock', { timeout: 30000 });
  await page.waitForTimeout(1000);
  const clockText = await page.locator('.focus-clock').innerText();
  console.log('  专注页 =', clockText.replace(/\n/g, ' | ').slice(0, 120));
  check('计时已自动停止（不再显示运行中）', (await page.locator('.focus-time.is-running').count()) === 0);
  check('有「开始」按钮可继续下一个番茄', (await page.locator('.focus-actions .primary').count()) === 1);

  console.log('4. 点「知道了」停铃并收掉提醒');
  const ack = page.locator('.focus-alarm button', { hasText: '知道了' });
  check('提醒在专注页上仍然可见（全局浮层）', (await page.locator('.focus-alarm').count()) === 1);
  await ack.first().click();
  await page.waitForTimeout(600);
  check('确认后提醒消失', (await page.locator('.focus-alarm').count()) === 0);

  console.log('5. 第二个番茄结束仍然会响（不能只响第一次）');
  await fastForwardMinutes(0);
  await page.locator('.focus-actions .primary').click();
  await page.waitForTimeout(1200);
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card-grid', { timeout: 20000 });
  await page.waitForTimeout(600);
  await fastForwardMinutes(26);
  await page.waitForSelector('.focus-alarm', { timeout: 15000 });
  const second = await page.locator('.focus-alarm').innerText();
  check('第二轮番茄结束仍然弹出提醒', second.includes('专注结束'), second.replace(/\n/g, ' '));
  check('第二轮也真的在响铃', second.includes('正在持续响铃'), second.replace(/\n/g, ' '));
  await page.locator('.focus-alarm button', { hasText: '知道了' }).first().click();
  await page.waitForTimeout(500);

  console.log('6. 关掉「结束提示音」时：仍然提示，但不响');
  await page.goto(`${BASE}/#/m/focus`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.focus-clock', { timeout: 20000 });
  await page.waitForTimeout(800);
  const soundBox = page.locator('.focus-sound input');
  if (await soundBox.isChecked()) await soundBox.uncheck();
  await page.waitForTimeout(400);
  await fastForwardMinutes(0);
  await page.locator('.focus-actions .primary').click();
  await page.waitForTimeout(1200);
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card-grid', { timeout: 20000 });
  await page.waitForTimeout(600);
  await fastForwardMinutes(26);
  await page.waitForSelector('.focus-alarm', { timeout: 15000 });
  const silent = await page.locator('.focus-alarm').innerText();
  console.log('  静音时提醒 =', silent.replace(/\n/g, ' | '));
  check('关掉声音后仍提示「专注结束」', silent.includes('专注结束'), silent.replace(/\n/g, ' '));
  check('关掉声音后不进入响铃状态', !silent.includes('正在持续响铃'), silent.replace(/\n/g, ' '));
  check('说明提示音是关闭的', silent.includes('关闭'), silent.replace(/\n/g, ' '));

  await page.screenshot({ path: join(out, 'focus-alarm-muted.png'), fullPage: false });
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
