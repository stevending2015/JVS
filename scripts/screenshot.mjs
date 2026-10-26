import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:4173';
const out = join(process.cwd(), '.verify');
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'jvs-shot-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, args: ['--no-sandbox'], viewport: { width: 1280, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => document.body.innerText.includes('已就绪'), { timeout: 45000 });

// 天气页（等真实数据）
await page.goto(`${BASE}/#/m/weather`, { waitUntil: 'load' });
await page.waitForSelector('.sky', { timeout: 45000 });
await page.waitForFunction(() => document.querySelectorAll('.wx-days li').length === 7, { timeout: 45000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, 'weather.png'), fullPage: true });

// 生日弹窗
await page.goto(`${BASE}/#/m/birthday`, { waitUntil: 'load' });
await page.waitForSelector('.panel');
const today = new Date();
// 以下人物与日期均为虚构测试数据。
const seed = [
  { n: '示例本人', r: '本人', g: 'male', y: 1990, m: 1, d: 1, lunar: true },
  { n: '示例配偶', r: '配偶', g: 'female', y: 1991, m: 2, d: 2, lunar: true },
  { n: '示例子女', r: '儿子', g: 'male', y: 2020, m: 3, d: 3, lunar: false },
];
for (const p of seed) {
  await page.getByRole('button', { name: '＋ 添加生日' }).click();
  await page.waitForSelector('.modal');
  await page.selectOption('.modal select:not([name])', { index: p.lunar ? 1 : 0 });
  await page.waitForTimeout(200);
  await page.fill('.modal input[name="name"]', p.n);
  await page.selectOption('.modal select[name="relation"]', p.r);
  await page.selectOption('.modal select[name="gender"]', p.g);
  await page.fill('.modal input[name="f_year"]', String(p.y));
  await page.fill('.modal input[name="f_month"]', String(p.m));
  await page.fill('.modal input[name="f_day"]', String(p.d));
  await page.click('.modal button[type="submit"]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
}
// 打开编辑弹窗截图
await page.click('.person-list .link--edit');
await page.waitForSelector('.modal');
await page.waitForTimeout(500);
await page.screenshot({ path: join(out, 'birthday-modal.png'), fullPage: true });
await page.keyboard.press('Escape');

// 倒计时弹窗
await page.goto(`${BASE}/#/m/countdown`, { waitUntil: 'load' });
await page.waitForSelector('.panel');
await page.getByRole('button', { name: '＋ 添加倒计时' }).click();
await page.waitForSelector('.modal');
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, 'countdown-modal.png'), fullPage: true });

// 仪表盘
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('.card');
await page.waitForTimeout(2000);
await page.screenshot({ path: join(out, 'dashboard.png'), fullPage: true });

await context.close();
console.log('screenshots written');