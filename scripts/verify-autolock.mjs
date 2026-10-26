/**
 * 验证「空闲自动上锁」。
 *
 * 用 1 分钟档位实测（默认是 10 分钟，跑测试等不起），确认：
 *   1. 设置里能选自动锁时长并持久化
 *   2. 解锁后无操作超过阈值 → 自动锁上，受保护卡片重新被盖住
 *   3. 有操作会重置计时（活动后不该被误锁）
 *   4. 锁上时有提示条
 *   5. 「不自动锁」选项下不会被锁
 */
import { chromium } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:4173';
const PASSWORD = 'auto-1234';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function ready(page) {
  await page.waitForFunction(
    () => document.body.innerText.includes('SQLite · OPFS 已就绪'),
    undefined,
    { timeout: 90000 },
  );
}

async function openSettings(page) {
  await page.locator('.app__gear').click();
  const dialog = page.locator('.lockdialog');
  if (await dialog.count() > 0) {
    await page.locator('.lockdialog input[type="password"]').fill(PASSWORD);
    await page.locator('.lockdialog button[type="submit"]').click();
    await page.waitForTimeout(1200);
  }
  await page.waitForSelector('.settings__tabs', { timeout: 15000 });
}

async function closeSettings(page) {
  await page.locator('.modal__close').click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
}

async function isLocked(page) {
  return (await page.locator('.app__lock.is-locked').count()) === 1;
}

const profile = mkdtempSync(join(tmpdir(), 'jvs-idle-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, args: ['--no-sandbox'],
  viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ready(page);
  await page.waitForTimeout(1000);

  console.log('1. 设置里能选自动锁时长');
  await openSettings(page);
  await page.locator('.settings__scope .settings__grid .settings__check').filter({ hasText: '笔记' }).locator('input').check();
  const select = page.locator('.settings__form select').first();
  check('有自动锁下拉框', (await select.count()) === 1);
  const options = await select.locator('option').allTextContents();
  console.log('  可选 =', options.join(' / '));
  check('默认 10 分钟', (await select.inputValue()) === String(10 * 60 * 1000), await select.inputValue());
  check('有 1 分钟档位（便于实测）', options.some((o) => o.includes('1 分钟')), options.join(','));
  check('有「不自动锁」选项', options.some((o) => o.includes('不自动锁')), options.join(','));

  const pw = page.locator('.settings__form input[type="password"]');
  await pw.nth(0).fill(PASSWORD);
  await pw.nth(1).fill(PASSWORD);
  await select.selectOption(String(60_000));
  await page.getByRole('button', { name: '启用应用锁' }).click();
  await page.waitForTimeout(1800);
  await closeSettings(page);
  await page.waitForSelector('.app__lock', { timeout: 15000 });
  await page.waitForTimeout(500);
  check('启用后处于锁定', await isLocked(page));

  console.log('2. 解锁');
  await page.locator('.app__lock').click();
  await page.waitForSelector('.lockdialog', { timeout: 15000 });
  await page.locator('.lockdialog input[type="password"]').fill(PASSWORD);
  await page.locator('.lockdialog button[type="submit"]').click();
  await page.waitForTimeout(1800);
  check('解锁成功', !(await isLocked(page)));

  console.log('3. 活动会重置计时（35s 后有操作，再等 40s 仍不该锁）');
  await page.waitForTimeout(35_000);
  check('35s 未到阈值仍未锁', !(await isLocked(page)));
  // 制造一次交互
  await page.mouse.click(640, 300);
  await page.waitForTimeout(40_000);
  check('活动后 40s 仍在解锁（说明计时被重置）', !(await isLocked(page)));

  console.log('4. 继续无操作 → 超过 1 分钟自动锁上');
  await page.waitForTimeout(26_000);
  check('无操作累计超过 1 分钟已自动锁', await isLocked(page));
  check('出现自动上锁提示', (await page.locator('.autolock-notice').count()) === 1);
  const notice = await page.locator('.autolock-notice').innerText();
  console.log('  提示 =', notice);
  check('提示文案说明原因', notice.includes('自动'), notice);

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card', { timeout: 20000 });
  await page.waitForTimeout(900);
  check('自动锁后受保护卡片重新盖锁', (await page.locator('.card--locked').count()) === 1);

  console.log('5. 改成「不自动锁」→ 不该被锁');
  await openSettings(page);
  const select2 = page.locator('.settings__form select').first();
  await select2.selectOption('0');
  await page.getByRole('button', { name: '保存范围' }).click();
  await page.waitForTimeout(1400);
  await closeSettings(page);
  // 解锁
  await page.locator('.app__lock').click();
  await page.waitForSelector('.lockdialog', { timeout: 15000 });
  await page.locator('.lockdialog input[type="password"]').fill(PASSWORD);
  await page.locator('.lockdialog button[type="submit"]').click();
  await page.waitForTimeout(1600);
  check('不自动锁时已解锁', !(await isLocked(page)));
  console.log('  等 75 秒观察是否会被锁…');
  await page.waitForTimeout(75_000);
  check('设为不自动锁后长时空闲仍保持解锁', !(await isLocked(page)));

  console.log('6. 设置持久化');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.waitForTimeout(1500);
  await openSettings(page);
  const saved = await page.locator('.settings__form select').first().inputValue();
  check('刷新后自动锁设置仍为「不自动锁」', saved === '0', saved);
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
