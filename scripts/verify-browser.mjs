/**
 * Browser verification.
 *
 * Everything rests on SQLite persisting in the browser, so records are written,
 * edited, then the browser is QUIT and relaunched with the same profile.
 *
 * Also covers the dialog-based input (adding a countdown and a note used to throw
 * "Cannot read properties of null (reading 'reset')" because the handler touched
 * the event object after awaiting) and the weather module.
 */

import { chromium } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.JVS_BASE ?? 'http://localhost:4173';
const NAME = '持久化验证甲';
const EDITED = '持久化验证甲改';
const OTHER = '第二人乙';
const PREF_TZ = 'America/New_York';
const COUNTDOWN = '期末考试';
const NOTE = '购物清单';

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

const profile = mkdtempSync(join(tmpdir(), 'jvs-profile-'));
const errors = [];
const networkIssues = [];

async function withBrowser(run) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !/open-meteo/.test(r.url())) networkIssues.push(r.status() + ' ' + r.url());
  });
  try {
    return await run(page);
  } finally {
    await context.close();
  }
}

const today = new Date();
const year = today.getFullYear();
const month = today.getMonth() + 1;
const day = today.getDate();
const otherMonth = month >= 6 ? month - 5 : month + 5;

async function gotoModule(page, id) {
  await page.goto(`${BASE}/#/m/${id}`, { waitUntil: 'load' });
  await page.waitForSelector('.panel, .wx', { timeout: 20000 });
}

async function addPerson(page, { name, y, m, d }) {
  await page.getByRole('button', { name: '＋ 添加生日' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.fill('.modal input[name="name"]', name);
  await page.fill('.modal input[name="f_year"]', String(y));
  await page.fill('.modal input[name="f_month"]', String(m));
  await page.fill('.modal input[name="f_day"]', String(d));
  await page.click('.modal button[type="submit"]');
  await page.waitForFunction((n) => document.body.innerText.includes(n), name, { timeout: 20000 });
  // The list updates before the dialog unmounts, so wait for the dialog too.
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
}

console.log('1. 首次访问：弹窗输入、编辑、搜索、分组、天气');
await withBrowser(async (page) => {
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(
    () => document.body.innerText.includes('SQLite') && document.body.innerText.includes('已就绪'),
    { timeout: 45000 },
  );
  check('UI thread reports SQLite ready', true);
  check('dashboard renders one card per module', (await page.locator('.card').count()) >= 6);

  await gotoModule(page, 'birthday');
  check('birthday list has no inline form', (await page.locator('.panel form').count()) === 0);

  await page.getByRole('button', { name: '＋ 添加生日' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  const tzTag = await page.locator('.modal select[name="timezone"]').count();
  const tzValue = tzTag === 1 ? await page.locator('.modal select[name="timezone"]').inputValue() : null;
  check('timezone is a select', tzTag === 1, `selects=${tzTag}`);
  check('timezone defaults to Asia/Shanghai on a fresh database', tzValue === 'Asia/Shanghai', String(tzValue));

  const sameRow = await page.evaluate(() => {
    const row = document.querySelector('.modal .form__row--date');
    if (row === null) return { ok: false, reason: 'no .form__row--date' };
    const tops = [...row.querySelectorAll('input[type="number"]')].map((el) => el.getBoundingClientRect().top);
    if (tops.length < 3) return { ok: false, reason: 'fewer than 3 number inputs' };
    const firstThree = tops.slice(0, 3);
    return { ok: Math.max(...firstThree) - Math.min(...firstThree) < 2, tops: firstThree };
  });
  check('year/month/day sit on one row', sameRow.ok, JSON.stringify(sameRow));

  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
  check('Escape closes the dialog', (await page.locator('.modal').count()) === 0);

  await addPerson(page, { name: NAME, y: year, m: month, d: day });
  check('record written through the dialog', (await page.locator('.modal').count()) === 0);
  check('derived values computed (星座/生肖)', /座|属/.test(await page.locator('body').innerText()));

  await page.click('.person-list .link--edit');
  await page.waitForSelector('.modal', { timeout: 10000 });
  const dialogTitle = await page.locator('.modal__head h3').innerText();
  check('edit opens the dialog prefilled', dialogTitle.includes('编辑'), dialogTitle);
  await page.fill('.modal input[name="name"]', EDITED);
  await page.click('.modal button[type="submit"]');
  await page.waitForFunction((n) => document.body.innerText.includes(n), EDITED, { timeout: 20000 });
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
  check('edit saves in place', true);
  check('edit did not duplicate the record', ((await page.locator('body').innerText()).match(/删除/g) ?? []).length === 1);

  await page.getByRole('button', { name: '＋ 添加生日' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.selectOption('.modal select[name="timezone"]', PREF_TZ);
  await page.fill('.modal input[name="name"]', `${OTHER}丙`);
  await page.fill('.modal input[name="f_year"]', String(year - 20));
  await page.fill('.modal input[name="f_month"]', String(otherMonth));
  await page.fill('.modal input[name="f_day"]', '16');
  await page.click('.modal button[type="submit"]');
  await page.waitForFunction((n) => document.body.innerText.includes(n), `${OTHER}丙`, { timeout: 20000 });
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });

  check('list is grouped by month', (await page.locator('.month-group').count()) >= 2);
  check('month group header shows year and month', /\d{4}\s*年\s*\d{1,2}\s*月/.test(await page.locator('.month-group__head').first().innerText()));

  await page.fill('input.search', EDITED);
  await page.waitForTimeout(300);
  check('search narrows the list to one record', (await page.locator('.person-list li').count()) === 1);
  await page.fill('input.search', '');
  await page.waitForTimeout(300);
  check('clearing search restores every record', (await page.locator('.person-list li').count()) === 2);

  await page.getByRole('button', { name: '＋ 添加生日' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  check('chosen timezone becomes the new form default', (await page.locator('.modal select[name="timezone"]').inputValue()) === PREF_TZ);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });

  await gotoModule(page, 'countdown');
  await page.getByRole('button', { name: '＋ 添加倒计时' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.fill('.modal input[name="title"]', COUNTDOWN);
  await page.fill('.modal input[name="date"]', `${year}-12-20`);
  await page.click('.modal button[type="submit"]');
  await page.waitForFunction((n) => document.body.innerText.includes(n), COUNTDOWN, { timeout: 20000 });
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
  check('countdown added through the dialog (no reset crash)', true);

  await gotoModule(page, 'notes');
  await page.waitForSelector('.note-composer', { timeout: 30000 });
  await page.fill('.note-composer__title', NOTE);
  await page.fill('.note-composer__body', '牛奶、鸡蛋、面包');
  await page.click('.note-composer__right .primary');
  await page.waitForFunction((n) => document.body.innerText.includes(n), NOTE, { timeout: 20000 });
  check('note added through the quick composer', true);

  await gotoModule(page, 'weather');
  await page.waitForSelector('.sky', { timeout: 45000 });
  check('weather sky rendered', true);
  const shortcutChips = (await page.locator('.wx-bar__cities .wx-city').allTextContents()).map((t) => t.trim());
  check('city shortcuts rendered', shortcutChips.length >= 1, shortcutChips.join(','));
  // 城市行只有一个默认：本机时区所在的城市，其余靠图钉钉住。
  check('the default row is the time zone city only', shortcutChips.length === 1, shortcutChips.join(','));
  check('the time zone city carries no pin',
    (await page.locator('.wx-city__pin').count()) === 0,
    String(await page.locator('.wx-city__pin').count()));

  // A searched city is a temporary look-up: it must not survive a reload.
  await page.fill('input[aria-label="搜索城市"]', '曼谷');
  await page.getByRole('button', { name: '搜索' }).click();
  await page.waitForTimeout(4500);
  const afterSearch = (await page.locator('.wx-bar__cities .wx-city').allTextContents()).map((t) => t.trim());
  check('searching adds a temporary chip', afterSearch.some((chip) => chip.includes('曼谷')), afterSearch.join(','));

  // A Chinese name for a foreign city has to actually resolve. 「纽约」 used to return
  // nothing (zh-only search) while 「New York」 resolved to York, Nebraska.
  await page.fill('input[aria-label="搜索城市"]', '纽约');
  await page.getByRole('button', { name: '搜索' }).click();
  await page.waitForTimeout(5000);
  const foreignChips = (await page.locator('.wx-bar__cities .wx-city').allTextContents()).map((t) => t.trim());
  check('a Chinese name for a foreign city resolves (纽约)', foreignChips.some((chip) => chip.includes('纽约')), foreignChips.join(','));
  const skyCity = await page.locator('.sky__city').innerText();
  check('the resolved foreign city becomes the scene city', skyCity.includes('纽约') && skyCity.includes('美国'), skyCity.replace(/\n/g, ' '));
  check('the foreign city has real coordinates', (await page.locator('.sky__clock').innerText()).includes('UTC'), '');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sky', { timeout: 60000 });
  await page.waitForTimeout(2500);
  const afterReload = (await page.locator('.wx-bar__cities .wx-city').allTextContents()).map((t) => t.trim());
  check('the searched city is dropped on reload', !afterReload.some((chip) => chip.includes('曼谷')), afterReload.join(','));
  await page.waitForFunction(() => document.querySelectorAll('.wx-days li').length === 7, { timeout: 45000 });
  check('7-day forecast rendered', true);
  const skyText = await page.locator('.sky').innerText();
  check('hero shows a temperature', /\d+\s*°/.test(skyText), skyText.slice(0, 120));
  check('hero shows the city local clock', /\d{2}:\d{2}:\d{2}/.test(skyText), skyText.slice(0, 120));
  const sunCount = await page.locator('.sky__sun').count();
  const moonCount = await page.locator('.sky__moon').count();
  check('never more than one celestial body is drawn', sunCount + moonCount <= 1, `sun=${sunCount} moon=${moonCount}`);
  // The body is positioned from real altitude/azimuth now, so it may legitimately
  // be absent: the sun is only drawn while it is up, the moon only while it is up.
  const bodyConsistent = await page.evaluate(() => {
    const sky = document.querySelector('.sky');
    const isDay = sky !== null && sky.className.includes('sky--day');
    const suns = document.querySelectorAll('.sky__sun').length;
    const moons = document.querySelectorAll('.sky__moon').length;
    return isDay ? suns === 1 : suns === 0 && moons <= 1;
  });
  check('drawn body matches day/night', bodyConsistent);
  if (moonCount === 1) {
    const moonPath = await page.locator('.sky__moon-lit').getAttribute('d');
    check('moon is a phase path, not a flat disc', typeof moonPath === 'string' && moonPath.startsWith('M 0 '), String(moonPath).slice(0, 60));
  }
  // The disc can sit right behind the readout at sunrise/moonset, so the text
  // needs a feathered scrim plus a same-direction halo to stay legible.
  const readability = await page.evaluate(() => {
    const content = document.querySelector('.sky__content');
    if (content === null) return null;
    const before = getComputedStyle(content, '::before');
    return {
      scrim: before.backgroundImage,
      shadow: getComputedStyle(content).textShadow,
      scrimTone: getComputedStyle(document.querySelector('.sky')).getPropertyValue('--sky-scrim').trim(),
    };
  });
  check('hero readout has a feathered scrim', readability !== null && readability.scrim.includes('gradient'), String(readability?.scrim).slice(0, 70));
  check('hero readout has a halo text-shadow', readability !== null && readability.shadow !== 'none', String(readability?.shadow).slice(0, 70));
  check('scrim tone follows the day/night theme', readability !== null && readability.scrimTone !== '', String(readability?.scrimTone));
  const facts = await page.locator('.wx-facts').innerText();
  check('moon phase reported in the facts', facts.includes('月相') && /\d+%/.test(facts), facts.replace(/\n/g, ' ').slice(0, 160));

  await page.goto(`${BASE}/#/m/almanac`, { waitUntil: 'load' });
  await page.waitForSelector('.almanac__grid', { timeout: 20000 });
  check('birthday marked on the grid', (await page.locator('.almanac__cell.is-birthday').count()) >= 1);
  check('almanac shows the edited name', (await page.locator('.almanac__detail').innerText()).includes(EDITED));
});

console.log('2. 关闭浏览器后重新打开：全部数据是否都还在');
await withBrowser(async (page) => {
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(
    () => document.body.innerText.includes('SQLite') && document.body.innerText.includes('已就绪'),
    { timeout: 45000 },
  );
  const dashboard = await page.locator('body').innerText();
  check('edited birthday survived a full browser restart', dashboard.includes(EDITED), dashboard.slice(0, 160));

  await gotoModule(page, 'birthday');
  const list = await page.locator('body').innerText();
  check('both people still listed', list.includes(EDITED) && list.includes(`${OTHER}丙`), list.slice(0, 200));

  await page.getByRole('button', { name: '＋ 添加生日' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  check('timezone preference survived a full browser restart', (await page.locator('.modal select[name="timezone"]').inputValue()) === PREF_TZ);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });

  await gotoModule(page, 'notes');
  check('note survived a full browser restart', (await page.locator('body').innerText()).includes(NOTE));

  await gotoModule(page, 'countdown');
  check('countdown survived a full browser restart', (await page.locator('body').innerText()).includes(COUNTDOWN));

  await gotoModule(page, 'weather');
  await page.waitForSelector('.sky', { timeout: 45000 });
  check('weather renders again after restart', true);

  // ---- 生日模块的删除：需要确认，且删除后不会复活（硬删除）----
  await gotoModule(page, 'birthday');
  const victim = `${OTHER}丙`;
  const deleteButtons = () => page.locator('.person-list li').filter({ hasText: victim }).getByRole('button', { name: '删除' });
  await deleteButtons().click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  check('birthday delete asks for confirmation', (await page.locator('.modal__head h3').innerText()).includes('删除'));
  await page.getByRole('button', { name: '取消' }).click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
  check('cancelling keeps the record', (await page.locator('body').innerText()).includes(victim));

  await deleteButtons().click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.getByRole('button', { name: '确认删除' }).click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
  await page.waitForTimeout(900);
  check('record deleted for good', !(await page.locator('body').innerText()).includes(victim));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.body.innerText.includes('SQLite') && document.body.innerText.includes('已就绪'),
    undefined,
    { timeout: 60000 },
  );
  await page.waitForTimeout(800);
  check('deleted record does not come back after reload', !(await page.locator('body').innerText()).includes(victim));

  // ---- 从生日模块的人里选：关联而不是新建，避免同一个人两行 ----
  await page.getByRole('button', { name: '＋ 添加生日' }).click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.fill('.modal input[name="name"]', '王同事');
  await page.fill('.modal input[name="f_year"]', '1970');
  await page.fill('.modal input[name="f_month"]', '5');
  await page.fill('.modal input[name="f_day"]', '20');
  await page.click('.modal button[type="submit"]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 20000 });

  await page.goto(`${BASE}/#/m/family`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ft, .banner', { timeout: 20000 });
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: '世代列表' }).click();
  await page.waitForSelector('.ft-gens');
  const peopleBefore = await page.locator(".ft-name").count();

  await page.getByRole('button', { name: '世系图' }).click();
  await page.locator('.ft-node').filter({ hasText: EDITED }).first().click();
  await page.waitForSelector('.ft-detail');
  await page.getByRole('button', { name: '＋ 添加配偶' }).click();
  await page.waitForSelector('.modal');
  await page.getByRole('button', { name: '从已有成员中选择' }).click();
  await page.waitForSelector('.modal');
  await page.fill('input[aria-label="搜索已有成员"]', '王');
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /王同事/ }).click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
  await page.waitForTimeout(1000);
  const treeNames = await page.locator(".ft-node__name").allTextContents();
  check('picking an existing person links them into the tree', treeNames.includes('王同事'), treeNames.join(','));
  check('the picked person keeps their birthday data', (await page.locator('body').innerText()).includes('王同事'));

  await page.getByRole('button', { name: '世代列表' }).click();
  await page.waitForSelector('.ft-gens');
  const peopleAfter = await page.locator(".ft-name").count();
  check('linking did not create a duplicate person', peopleAfter === peopleBefore, 'before=' + peopleBefore + ' after=' + peopleAfter);
});

check('no failing network requests', networkIssues.length === 0, networkIssues.slice(0, 3).join(' | '));
const ignorable = /Download the React DevTools/i;
const realErrors = errors.filter((e) => !ignorable.test(e));
check('no console/page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;