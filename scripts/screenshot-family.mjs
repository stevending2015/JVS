import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:4173';
const out = join(process.cwd(), '.verify');
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'jvs-ftshot-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, args: ['--no-sandbox'], viewport: { width: 1360, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(`${BASE}/#/m/family`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => document.body.innerText.includes('已就绪'), undefined, { timeout: 60000 });
await page.waitForSelector('.ft, .banner');

async function fillPerson(values) {
  await page.waitForSelector('.modal');
  for (const [field, value] of Object.entries(values)) {
    const selector = `.modal input[name="${field}"], .modal select[name="${field}"]`;
    const el = await page.$(selector);
    if (el === null) continue;
    const tag = await el.evaluate((node) => node.tagName);
    if (tag === 'SELECT') await page.selectOption(selector, String(value));
    else await page.fill(selector, String(value));
  }
  await page.click('.modal button[type="submit"]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 30000 });
}

async function selectByName(name) {
  await page.locator('.ft-node').filter({ hasText: name }).first().click();
  await page.waitForSelector('.ft-detail');
}

// 以下人物、日期与籍贯均为虚构测试数据。
// 始祖
await page.getByRole('button', { name: '＋ 添加成员' }).click();
await fillPerson({ name: '示例祖辈甲', gender: 'male', generation: '1', nativePlace: '示例籍贯', f_year: '1928', f_month: '1', f_day: '1' });
await selectByName('示例祖辈甲');
await page.getByRole('button', { name: '＋ 添加配偶' }).click();
await fillPerson({ name: '示例祖辈乙', gender: 'female', f_year: '1931', f_month: '1', f_day: '1' });

// 二代
await page.locator('.ft-node').filter({ hasText: '示例祖辈甲' }).first().click();
await page.getByRole('button', { name: '＋ 添加子女' }).click();
await fillPerson({ name: '示例父辈甲', gender: 'male', f_year: '1955', f_month: '1', f_day: '1' });
await selectByName('示例父辈甲');
await page.getByRole('button', { name: '＋ 添加配偶' }).click();
await fillPerson({ name: '示例父辈乙', gender: 'female', f_year: '1958', f_month: '1', f_day: '1' });

// 三代
await page.locator('.ft-node').filter({ hasText: '示例父辈甲' }).first().click();
await page.getByRole('button', { name: '＋ 添加子女' }).click();
await fillPerson({ name: '示例成员甲', gender: 'male', f_year: '1982', f_month: '1', f_day: '1' });
await selectByName('示例成员甲');
await page.getByRole('button', { name: '＋ 添加配偶' }).click();
await fillPerson({ name: '示例成员乙', gender: 'female', f_year: '1985', f_month: '1', f_day: '1' });

// 四代
await page.locator('.ft-node').filter({ hasText: '示例成员甲' }).first().click();
await page.getByRole('button', { name: '＋ 添加子女' }).click();
await fillPerson({ name: '示例后辈', gender: 'female', f_year: '2012', f_month: '1', f_day: '1' });

// 以第三代「示例成员甲」为根：祖先在上、后代在下
await page.selectOption('.ft-focus select', { label: '示例成员甲' });
await page.waitForTimeout(800);
await page.locator('.ft-node').filter({ hasText: '示例成员甲' }).first().click();
await page.waitForSelector('.ft-detail');
await page.waitForTimeout(600);
await page.screenshot({ path: join(out, 'family-tree.png'), fullPage: true });

// 世代列表
await page.getByRole('button', { name: '世代列表' }).click();
await page.waitForSelector('.ft-gens');
await page.waitForTimeout(500);
await page.screenshot({ path: join(out, 'family-list.png'), fullPage: true });

await context.close();
console.log('screenshots written');