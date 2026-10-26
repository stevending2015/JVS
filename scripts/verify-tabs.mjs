/**
 * Two-tab behaviour of an exclusively-held OPFS database.
 *
 * OPFS sync access handles are exclusive per origin, so:
 *   - tab 1 opens the database and owns it
 *   - tab 2 must NOT crash with a raw DOM exception; it should explain the state
 *   - closing tab 1 must let tab 2 take over automatically, with the data tab 1
 *     wrote still visible
 */

import { chromium } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.JVS_BASE ?? 'http://localhost:5173/';
const NAME = '跨标签页甲';

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

const profile = mkdtempSync(join(tmpdir(), 'jvs-tabs-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox'],
});

const errors = [];
function watch(page, tag) {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${tag}] ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => errors.push(`[${tag}:pageerror] ${String(e).slice(0, 200)}`));
}

// --- tab 1: owns the database and writes a record ---------------------------------
const tab1 = context.pages()[0] ?? (await context.newPage());
watch(tab1, 'tab1');
await tab1.goto(BASE, { waitUntil: 'load' });
await tab1.waitForFunction(() => document.body.innerText.includes('已就绪'), { timeout: 45000 });
check('tab 1 owns the database', true);

await tab1.goto(`${BASE}#/m/birthday`, { waitUntil: 'load' });
await tab1.waitForSelector('.panel', { timeout: 20000 });
// Records are added through a dialog now.
await tab1.getByRole('button', { name: '＋ 添加生日' }).click();
await tab1.waitForSelector('.modal', { timeout: 10000 });
const today = new Date();
await tab1.fill('.modal input[name="name"]', NAME);
await tab1.fill('.modal input[name="f_year"]', String(today.getFullYear() - 30));
await tab1.fill('.modal input[name="f_month"]', String(today.getMonth() + 1));
await tab1.fill('.modal input[name="f_day"]', '15');
await tab1.click('.modal button[type="submit"]');
await tab1.waitForFunction((n) => document.body.innerText.includes(n), NAME, { timeout: 20000 });
await tab1.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
check('tab 1 writes a record', true);

// --- tab 2: must report the conflict readably, not crash --------------------------
const tab2 = await context.newPage();
watch(tab2, 'tab2');
await tab2.goto(BASE, { waitUntil: 'load' });
await tab2.waitForTimeout(4000);

const tab2Text = await tab2.locator('body').innerText();
check('tab 2 explains that another tab owns the database', tab2Text.includes('另一个标签页'), tab2Text.slice(0, 160));
check('tab 2 offers a retry action', (await tab2.locator('.banner__action').count()) === 1);
const rawDomErrors = errors.filter((e) => /NoModificationAllowedError|createSyncAccessHandle|removeVfs/.test(e));
check('no raw OPFS exception reaches the user', rawDomErrors.length === 0, rawDomErrors.slice(0, 2).join(' | '));

// --- close tab 1: tab 2 must take over by itself ----------------------------------
await tab1.close();
await tab2.waitForFunction(() => document.body.innerText.includes('已就绪'), { timeout: 45000 });
check('tab 2 takes over automatically once tab 1 closes', true);

const tab2After = await tab2.locator('body').innerText();
check('data written by tab 1 is visible in tab 2', tab2After.includes(NAME), tab2After.slice(0, 200));

await tab2.goto(`${BASE}#/m/birthday`, { waitUntil: 'load' });
await tab2.waitForSelector('.person-list', { timeout: 20000 });
const listText = await tab2.locator('body').innerText();
check('tab 2 can read the record list', listText.includes(NAME), listText.slice(0, 200));

const remaining = errors.filter((e) => !/Failed to load resource/.test(e));
check('no console errors overall', remaining.length === 0, remaining.slice(0, 3).join(' | '));

await context.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
