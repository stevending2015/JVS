/**
 * 验证专注结束的**全局**提醒。
 *
 * 原来的 bug：番茄归零的检测写在专注页里，只有那个页面挂载时才跑，所以人在
 * 别的页面时到点毫无反应，回到专注页才补响一声。这里要证明的就是
 * 「人在**别的模块**里，番茄到点也立刻通知 + 持续响铃」。
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
async function skewTo(minutes) {
  await page.evaluate((ms) => window.__setClockSkew(ms), minutes * 60 * 1000);
}

/** 去一个**别的模块**页面（不是仪表盘），最贴近用户说的场景。 */
async function gotoOtherModule(route) {
  await page.goto(`${BASE}/#/m/${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.module-page', { timeout: 30000 });
  await page.waitForTimeout(500);
}

/** 关掉/打开「结束提示音」。 */
async function setSound(on) {
  const box = page.locator('.focus-sound input');
  if ((await box.isChecked()) !== on) {
    if (on) await box.check(); else await box.uncheck();
    await page.waitForTimeout(400);
  }
}

try {
  console.log('1. 开始一个番茄，然后切到别的模块');
  await page.goto(`${BASE}/#/m/focus`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('已就绪'), undefined, { timeout: 60000 });
  await page.waitForSelector('.focus-clock', { timeout: 30000 });
  await page.waitForTimeout(900);
  await page.locator('.focus-actions .primary').click();
  await page.waitForTimeout(1200);
  check('番茄已开始', (await page.locator('.focus-time.is-running').count()) === 1);

  // 关键：去「笔记」模块 —— 用户说的「在其他模块中」
  await gotoOtherModule('notes');
  check('已离开专注页（在笔记模块）', (await page.locator('.focus-clock').count()) === 0);
  check('此时还没有提醒', (await page.locator('.focus-alarm').count()) === 0);

  console.log('2. 人在笔记模块时，番茄到点');
  await skewTo(26);
  await page.waitForSelector('.focus-alarm', { timeout: 15000 });
  await page.waitForTimeout(600);

  const alarm = await page.locator('.focus-alarm').innerText();
  console.log('  提醒内容 =', alarm.replace(/\n/g, ' | '));
  check('在其他模块里也弹出了提醒', true);
  check('提醒写明专注结束', alarm.includes('专注结束'), alarm.replace(/\n/g, ' '));
  check('提醒告诉用户正在持续响铃', alarm.includes('正在持续响铃'), alarm.replace(/\n/g, ' '));
  check('有「知道了」可以停铃', (await page.locator('.focus-alarm button', { hasText: '知道了' }).count()) === 1);

  // 界面上的「正在持续响铃」只有在 AudioContext 真的 resume 成功
  // （引擎状态 'ringing'）才会出现；被自动播放策略挡住时是 'blocked'，
  // 会换成「开启提醒」按钮。所以这条断言等价于「音频链路已启动」。
  const title = await page.title();
  console.log('  标签页标题 =', title);
  check('标签页标题也变成提醒（切到别的应用也能看见）', title.includes('专注结束'), title);

  await page.screenshot({ path: join(out, 'focus-alarm-global.png'), fullPage: false });

  console.log('3. 到点后自动落库（不用回专注页手动停表）');
  await page.goto(`${BASE}/#/m/focus`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.focus-clock', { timeout: 30000 });
  await page.waitForTimeout(1000);
  check('计时已自动停止（不再显示运行中）', (await page.locator('.focus-time.is-running').count()) === 0);
  check('有「开始」按钮可继续下一个番茄', (await page.locator('.focus-actions .primary').count()) === 1);

  console.log('4. 点「知道了」停铃、收掉提醒、标题复原');
  check('提醒在专注页上仍然可见（全局浮层）', (await page.locator('.focus-alarm').count()) === 1);
  await page.locator('.focus-alarm button', { hasText: '知道了' }).first().click();
  await page.waitForTimeout(600);
  check('确认后提醒消失', (await page.locator('.focus-alarm').count()) === 0);
  const titleAfter = await page.title();
  check('标题恢复正常', !titleAfter.includes('专注结束'), titleAfter);

  console.log('5. 第二个番茄结束仍然会响（不能只响第一次）');
  await skewTo(0);
  await page.locator('.focus-actions .primary').click();
  await page.waitForTimeout(1200);
  await gotoOtherModule('weather');
  await skewTo(26);
  await page.waitForSelector('.focus-alarm', { timeout: 15000 });
  const second = await page.locator('.focus-alarm').innerText();
  check('第二轮番茄结束仍然弹出提醒', second.includes('专注结束'), second.replace(/\n/g, ' '));
  check('第二轮也真的在响铃', second.includes('正在持续响铃'), second.replace(/\n/g, ' '));
  await page.locator('.focus-alarm button', { hasText: '知道了' }).first().click();
  await page.waitForTimeout(500);

  console.log('6. 跑动中关掉「结束提示音」也必须生效');
  await skewTo(0);
  await page.goto(`${BASE}/#/m/focus`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.focus-clock', { timeout: 20000 });
  await page.waitForTimeout(600);
  await setSound(true);
  await page.locator('.focus-actions .primary').click();
  await page.waitForTimeout(1200);
  // 番茄已经在跑，此刻再关声音 —— 这曾经是 bug：定时器闭包拿着开始时的旧值
  await setSound(false);
  await gotoOtherModule('notes');
  await skewTo(26);
  await page.waitForSelector('.focus-alarm', { timeout: 15000 });
  const midMuted = await page.locator('.focus-alarm').innerText();
  console.log('  跑动中关声音 =', midMuted.replace(/\n/g, ' | '));
  check('仍然提示专注结束', midMuted.includes('专注结束'), midMuted.replace(/\n/g, ' '));
  check('跑动中关掉的声音生效：不响铃', !midMuted.includes('正在持续响铃'), midMuted.replace(/\n/g, ' '));
  await page.locator('.focus-alarm button', { hasText: '关闭' }).first().click();
  await page.waitForTimeout(400);

  console.log('7. 重新打开声音后又会响铃');
  await skewTo(0);
  await page.goto(`${BASE}/#/m/focus`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.focus-clock', { timeout: 20000 });
  await page.waitForTimeout(600);
  await setSound(true);
  await page.locator('.focus-actions .primary').click();
  await page.waitForTimeout(1200);
  await gotoOtherModule('notes');
  await skewTo(26);
  await page.waitForSelector('.focus-alarm', { timeout: 15000 });
  const back = await page.locator('.focus-alarm').innerText();
  check('重新打开声音后又会响铃', back.includes('正在持续响铃'), back.replace(/\n/g, ' '));

  await page.screenshot({ path: join(out, 'focus-alarm-muted.png'), fullPage: false });
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
