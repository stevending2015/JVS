/**
 * Pinned weather cities: the 📌 in the top-left corner of a city chip.
 *
 * Rules under test:
 *  - the row starts with exactly one default: the machine's time-zone city, and
 *    it carries no pin;
 *  - a searched city is temporary until it is pinned;
 *  - a pinned city survives a reload, with its name and country;
 *  - un-pinning removes it again.
 */
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const pinned = require('./.pinned-for-test.cjs');

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

console.log('1. 钉住城市的存储格式');
{
  const city = { name: '东京', latitude: 35.6895, longitude: 139.6917, country: '日本' };
  const parsed = pinned.parseCity('东京@日本@35.690,139.692');
  check('解析出名字', parsed !== null && parsed.name === '东京', JSON.stringify(parsed));
  check('解析出国家', parsed !== null && parsed.country === '日本', JSON.stringify(parsed));
  check('解析出坐标', parsed !== null && Math.abs(parsed.latitude - 35.69) < 0.01, JSON.stringify(parsed));
  check('坐标键能解析', pinned.parseCityKey('35.690,139.692') !== null);
  check('坏数据不炸', pinned.parseCityKey('abc,def') === null);
  check('旧格式（只有坐标）也能读', pinned.parseCity('35.690,139.692') !== null);
  check('isPinned 能认出钉住的城市',
    pinned.isPinned([city], city) === true);
  check('isPinned 能认出没钉的城市',
    pinned.isPinned([city], { name: '伦敦', latitude: 51.5, longitude: -0.13 }) === false);
}

const BASE = (process.env.JVS_BASE ?? 'http://localhost:4173/').replace(/\/$/, '');
const out = join(process.cwd(), '.verify');
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'jvs-pin-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, args: ['--no-sandbox'], viewport: { width: 1280, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text());
});

const chipTexts = async () =>
  (await page.locator('.wx-bar__cities .wx-city').allTextContents()).map((text) => text.trim());

try {
  console.log('2. 城市行与图钉');
  await page.goto(`${BASE}/#/m/weather`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('已就绪'), undefined, { timeout: 60000 });
  await page.waitForSelector('.wx-bar__cities', { timeout: 30000 });
  await page.waitForTimeout(1500);

  const initial = await chipTexts();
  check('默认只有一个城市（本机时区）', initial.length === 1, initial.join(','));
  check('默认城市没有图钉', (await page.locator('.wx-city__pin').count()) === 0,
    String(await page.locator('.wx-city__pin').count()));

  console.log('3. 搜索与钉住');
  await page.fill('input[aria-label="搜索城市"]', '东京');
  await page.getByRole('button', { name: '搜索' }).click();
  await page.waitForTimeout(5500);
  const afterSearch = await chipTexts();
  check('搜索后多出一个城市', afterSearch.length === 2, afterSearch.join(','));
  check('搜索到的城市有图钉', (await page.locator('.wx-city__pin').count()) === 1);
  check('时区城市仍然排在最前', afterSearch[0] !== undefined && !afterSearch[0].includes('东京'),
    afterSearch.join(','));

  const tokyo = page.locator('.wx-city').filter({ hasText: '东京' }).first();
  await tokyo.locator('.wx-city__pin').click();
  await page.waitForTimeout(900);
  check('钉住后 aria-pressed 为 true', (await tokyo.locator('.wx-city__pin').getAttribute('aria-pressed')) === 'true');
  check('钉住后有 is-pinned 标记', (await tokyo.getAttribute('class')).includes('is-pinned'));

  console.log('4. 刷新后仍在');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.wx-bar__cities', { timeout: 60000 });
  await page.waitForTimeout(2200);
  const afterReload = await chipTexts();
  check('钉住的城市刷新后仍在', afterReload.some((chip) => chip.includes('东京')), afterReload.join(','));
  check('刷新后仍有两个城市', afterReload.length === 2, afterReload.join(','));
  check('刷新后名字没有丢', afterReload.some((chip) => chip.includes('东京') && !chip.includes('已钉住的城市')),
    afterReload.join(','));
  check('刷新后国家还在', afterReload.some((chip) => chip.includes('日本')), afterReload.join(','));

  console.log('5. 取消钉住');
  const tokyo2 = page.locator('.wx-city').filter({ hasText: '东京' }).first();
  await tokyo2.locator('.wx-city__pin').click();
  await page.waitForTimeout(900);
  check('取消钉住后城市行只剩时区城市', (await chipTexts()).length === 1, (await chipTexts()).join(','));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.wx-bar__cities', { timeout: 60000 });
  await page.waitForTimeout(2200);
  check('刷新后被取消的城市不再出现', !(await chipTexts()).some((chip) => chip.includes('东京')),
    (await chipTexts()).join(','));

  const realErrors = errors.filter((error) => !/Download the React DevTools/i.test(error));
  check('无控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;