/**
 * 验证专注圆环：**剩余时间在消隐**，以及**拖动圆环头缩短时间**。
 *
 * 两个要点：
 *  1. 圆环长度 = 剩余 / 开始时的计划时长。刚开始是满圈，走一分钟少一格；
 *     而不是反过来（那看起来像正计时）。
 *  2. 番茄进行中，把圆环头往回（顺时针）拖可以把剩余时间缩短，松手落库；
 *     拖短了还能再拖回去（上限是「没缩短过」时的剩余）。
 */
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:4173';
const out = join(process.cwd(), '.verify');
mkdirSync(out, { recursive: true });

const CIRCUMFERENCE = 2 * Math.PI * 52; // ≈ 326.7

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

const profile = mkdtempSync(join(tmpdir(), 'jvs-focus-dial-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1280, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

await page.addInitScript(() => {
  const realNow = Date.now.bind(Date);
  let skew = 0;
  window.__setClockSkew = (ms) => { skew = ms; };
  Date.now = () => realNow() + skew;
});

async function skewTo(minutes) {
  await page.evaluate((ms) => window.__setClockSkew(ms), minutes * 60 * 1000);
}

/** 读出圆环当前的长度（px）与界面上的时间文本。 */
async function readDial() {
  return page.evaluate(() => {
    const value = document.querySelector('.focus-dial__value');
    const dash = value?.getAttribute('stroke-dasharray') ?? '';
    const first = Number.parseFloat(dash.split(/[\s,]+/)[0] ?? '0');
    return {
      dash: Number.isFinite(first) ? first : 0,
      time: document.querySelector('.focus-time')?.textContent ?? '',
      hint: document.querySelector('.focus-hint')?.textContent ?? '',
      hasHandle: document.querySelector('.focus-dial__handle') !== null,
      role: document.querySelector('.focus-dial')?.getAttribute('role') ?? '',
    };
  });
}

/** 把圆环头拖到「从 12 点顺时针 f 比例」的位置。 */
async function dragHeadTo(fraction) {
  const box = await page.locator('.focus-dial').boundingBox();
  if (box === null) throw new Error('找不到圆环');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radius = (box.width / 2) * (52 / 60); // viewBox 120，圆半径 52
  const angle = fraction * Math.PI * 2;
  const startX = cx;
  const startY = cy - radius;
  const endX = cx + radius * Math.sin(angle);
  const endY = cy - radius * Math.cos(angle);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(cx + Math.sin(angle / 2) * radius, cy - Math.cos(angle / 2) * radius, { steps: 6 });
  await page.mouse.move(endX, endY, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(900);
}

try {
  console.log('1. 开始时圆环应该是满圈');
  await page.goto(`${BASE}/#/m/focus`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('已就绪'), undefined, { timeout: 60000 });
  await page.waitForSelector('.focus-clock', { timeout: 30000 });
  await page.waitForTimeout(800);

  // 还没开始（只是选中「25 分钟」）也应该是完整一圈蓝，表示这一轮的额度。
  const idle = await readDial();
  console.log('  空闲 =', JSON.stringify(idle));
  check('未开始时也画满圈（不是空圈）', Math.abs(idle.dash - CIRCUMFERENCE) <= 3, String(idle.dash));
  check('未开始时没有拖拽圆点（不能拖）', !idle.hasHandle);

  await page.locator('.focus-actions .primary').click();
  await page.waitForTimeout(900);

  const start = await readDial();
  console.log('  ', JSON.stringify(start));
  check('圆形进度条几乎满圈（≈ 326.7）', Math.abs(start.dash - CIRCUMFERENCE) <= 3, String(start.dash));
  check('显示 25 分钟', start.time.startsWith('24:') || start.time.startsWith('25:'), start.time);
  check('有可拖动的圆环头', start.hasHandle);
  check('圆环是 slider 语义（可拖动）', start.role === 'slider', start.role);
  await page.screenshot({ path: join(out, 'focus-dial-start.png'), fullPage: false });

  console.log('2. 走过 5 分钟，圆环应该变短（剩余在消隐）');
  await skewTo(5);
  await page.waitForTimeout(1300);
  const after5 = await readDial();
  console.log('  ', JSON.stringify(after5));
  const expected = CIRCUMFERENCE * (20 / 25); // 剩 20 / 25
  check('圆环缩短到约 80%', Math.abs(after5.dash - expected) <= 6, `${after5.dash} vs ${Math.round(expected)}`);
  check('圆环确实变短了（不是变长）', after5.dash < start.dash, `${start.dash} → ${after5.dash}`);
  check('时间显示约 20 分钟', after5.time.startsWith('19:') || after5.time.startsWith('20:'), after5.time);

  console.log('3. 把圆环头拖到一半 → 只剩约 12–13 分钟');
  await dragHeadTo(0.5);
  const half = await readDial();
  console.log('  ', JSON.stringify(half));
  const halfMinutes = Number.parseInt(half.time.split(':')[0], 10);
  check('剩余时间被缩短到 12–14 分钟', halfMinutes >= 12 && halfMinutes <= 14, half.time);
  check('提示里说明已缩短并给出原计划', half.hint.includes('已缩短') && half.hint.includes('25'), half.hint);

  console.log('4. 缩短后刷新页面仍然生效（真的落库了）');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.focus-clock', { timeout: 30000 });
  // 刷新会把注入的时钟偏移清回 0，得重新推回 5 分钟，才和缩短时的「已过 5 分钟」对应。
  await skewTo(5);
  await page.waitForTimeout(1300);
  const reloaded = await readDial();
  console.log('  ', JSON.stringify(reloaded));
  const reloadedMinutes = Number.parseInt(reloaded.time.split(':')[0], 10);
  check('刷新后剩余时间仍是 12–14 分钟（缩短已落库）', reloadedMinutes >= 12 && reloadedMinutes <= 14, reloaded.time);

  console.log('5. 闸门：缩短后到点会提前响铃');
  await skewTo(40); // 远超缩短后的计划（约 18 分钟）
  await page.waitForSelector('.focus-alarm', { timeout: 15000 });
  const alarm = await page.locator('.focus-alarm').innerText();
  console.log('  ', alarm.replace(/\n/g, ' | '));
  check('按缩短后的时间提前结束了', alarm.includes('专注结束'), alarm.replace(/\n/g, ' '));
  await page.locator('.focus-alarm button').last().click();
  await page.waitForTimeout(500);

  console.log('5.5 番茄结束、会话复位后，圆环要恢复满圈');
  await page.goto(`${BASE}/#/m/focus`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.focus-clock', { timeout: 20000 });
  await page.waitForTimeout(900);
  const reset = await readDial();
  console.log('  复位后 =', JSON.stringify(reset));
  check('复位后圆环恢复满圈', Math.abs(reset.dash - CIRCUMFERENCE) <= 3, String(reset.dash));

  console.log('6. 能把圆环头拖回去（上限是原计划）');
  await skewTo(0);
  await page.goto(`${BASE}/#/m/focus`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.focus-clock', { timeout: 20000 });
  await page.waitForTimeout(700);
  await page.locator('.focus-actions .primary').click();
  await page.waitForTimeout(900);
  await skewTo(5);
  await page.waitForTimeout(1200);
  await dragHeadTo(0.4);
  const short = await readDial();
  console.log('  拖到 40% =', JSON.stringify(short));
  await dragHeadTo(0.999); // 推回满圈 → 只应恢复到「原计划 − 已过」
  const back = await readDial();
  console.log('  推回满圈 =', JSON.stringify(back));
  const backMinutes = Number.parseInt(back.time.split(':')[0], 10);
  check('推回满圈不会超过原计划的剩余（约 20 分钟）', backMinutes >= 18 && backMinutes <= 21, back.time);
  check('推回后确实比刚才长', backMinutes > Number.parseInt(short.time.split(':')[0], 10), `${short.time} → ${back.time}`);

  await page.screenshot({ path: join(out, 'focus-dial-dragged.png'), fullPage: false });
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
