/**
 * Focus module verification (browser).
 *
 * Covers what masuka's focus feature guarantees plus the JVS additions:
 *  - six modes (25/45/60/90/120 pomodoro + stopwatch)
 *  - the timer is derived from start_time, so a reload must not reset it
 *  - only one session may run at a time
 *  - finishing records the session and updates today's total, streak and heat map
 *  - the daily goal and the sound preference survive a reload
 */
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.JVS_BASE ?? 'http://localhost:4173/';
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

const profile = mkdtempSync(join(tmpdir(), 'jvs-focus-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, args: ['--no-sandbox'], viewport: { width: 1280, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
    errors.push(message.text());
  }
});

try {
  console.log('1. 模式与初始状态');
  await page.goto(`${BASE}#/m/focus`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => document.body.innerText.includes('SQLite') && document.body.innerText.includes('已就绪'),
    undefined,
    { timeout: 60000 },
  );
  await page.waitForSelector('.focus-clock', { timeout: 30000 });
  check('focus page renders', (await page.locator('.focus-clock').count()) === 1);

  const modes = (await page.locator('.focus-modes button').allTextContents()).map((t) => t.trim());
  check('five pomodoro lengths plus a stopwatch',
    ['25', '45', '60', '90', '120'].every((m) => modes.some((label) => label.includes(m)))
    && modes.some((label) => label.includes('正计时')),
    modes.join(','));
  check('default reading is a full 25 minutes', (await page.locator('.focus-time').innerText()) === '25:00',
    await page.locator('.focus-time').innerText());

  console.log('2. 计时与刷新');
  await page.locator('.focus-modes button', { hasText: '45 分钟' }).click();
  check('selecting a length changes the reading', (await page.locator('.focus-time').innerText()) === '45:00',
    await page.locator('.focus-time').innerText());

  await page.fill('.focus-task', '写测试');
  await page.locator('.focus-actions .primary').click();
  await page.waitForTimeout(2500);

  const running = await page.locator('.focus-time').innerText();
  check('starting counts down from the plan', running !== '45:00' && running.startsWith('44:'), running);
  check('the running reading is highlighted', (await page.locator('.focus-time').evaluate((n) => n.className)).includes('is-running'));
  check('the task label shows while running', (await page.locator('.focus-current').innerText()).includes('写测试'));

  await page.waitForTimeout(3200);
  const later = await page.locator('.focus-time').innerText();
  check('the clock keeps ticking', later !== running, `${running} -> ${later}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.focus-clock', { timeout: 60000 });
  await page.waitForTimeout(2000);
  const afterReload = await page.locator('.focus-time').innerText();
  check('a reload does NOT reset the timer (timestamp-based)', afterReload !== '45:00' && afterReload.startsWith('44:'), afterReload);
  check('the task survives the reload', (await page.locator('.focus-current').innerText()).includes('写测试'));

  console.log('3. 同时只允许一个会话');
  await page.locator('.focus-actions .primary').count();
  check('start is replaced by stop while running', (await page.locator('.focus-actions .btn--danger').count()) === 1);

  await page.screenshot({ path: join(out, 'focus-running.png'), fullPage: true });

  console.log('4. 结束与统计');
  await page.locator('.focus-actions .btn--danger').click();
  await page.waitForTimeout(2200);
  check('stopping returns to the idle reading', (await page.locator('.focus-time').innerText()) === '25:00',
    await page.locator('.focus-time').innerText());
  check('the finished session is listed', (await page.locator('.focus-history__list li').count()) === 1,
    String(await page.locator('.focus-history__list li').count()));
  check("today's total is no longer zero", (await page.locator('.focus-today').innerText()).includes('今日完成 1 次'),
    await page.locator('.focus-today').innerText());
  check('the streak counts today', (await page.locator('.focus-streak').innerText()).includes('1 天'),
    await page.locator('.focus-streak').innerText());
  check('the heat map has 35 cells', (await page.locator('.focus-heat__cell').count()) === 35);
  check('the heat map marks today', (await page.locator('.focus-heat__cell--1, .focus-heat__cell--2, .focus-heat__cell--3').count()) >= 1);

  console.log('5. 正计时');
  await page.locator('.focus-modes button', { hasText: '正计时' }).click();
  await page.locator('.focus-actions .primary').click();
  await page.waitForTimeout(3200);
  const stopwatch = await page.locator('.focus-time').innerText();
  check('the stopwatch counts up', stopwatch.startsWith('00:0') && stopwatch !== '00:00', stopwatch);
  check('the stopwatch is labelled', (await page.locator('.focus-hint').innerText()).includes('正计时'),
    await page.locator('.focus-hint').innerText());
  await page.locator('.focus-actions .btn--danger').click();
  await page.waitForTimeout(1500);
  check('history now has both sessions', (await page.locator('.focus-history__list li').count()) === 2,
    String(await page.locator('.focus-history__list li').count()));

  console.log('6. 偏好持久化');
  await page.fill('.focus-goal__set input', '12');
  await page.waitForTimeout(900);
  await page.locator('.focus-sound input').uncheck();
  await page.waitForTimeout(900);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.focus-goal__set input', { timeout: 60000 });
  await page.waitForTimeout(1600);
  check('the daily goal survives a reload', (await page.locator('.focus-goal__set input').inputValue()) === '12',
    await page.locator('.focus-goal__set input').inputValue());
  check('the sound preference survives a reload', (await page.locator('.focus-sound input').isChecked()) === false);

  await page.screenshot({ path: join(out, 'focus-page.png'), fullPage: true });

  const ignorable = /Download the React DevTools/i;
  const realErrors = errors.filter((error) => !ignorable.test(error));
  check('no console/page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;