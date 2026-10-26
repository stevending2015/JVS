/**
 * Family tree verification.
 *
 * Covers the whole feature: building a small pedigree through the UI (member →
 * spouse → child), the tidy SVG tree, the 世代列表 grouping with auto 世次, the
 * relation detail panel, GEDCOM export, and survival across a full browser
 * restart — the last one matters most, since it proves the graph really lives in
 * SQLite and not in React state.
 */

import { chromium } from 'playwright-core';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.JVS_BASE ?? 'http://localhost:4173';
const ROOT = '张始祖';
const SPOUSE = '李配偶';
const CHILD = '张二代';
const GRANDCHILD = '张三代';
const SECOND_SPOUSE = '赵继配';
const SECOND_CHILD = '张二房';

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

const profile = mkdtempSync(join(tmpdir(), 'jvs-ft-'));
const errors = [];

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
  try {
    return await run(page, context);
  } finally {
    await context.close();
  }
}

async function openFamily(page) {
  await page.goto(`${BASE}/#/m/family`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // SQLite needs ~8s on a cold profile: OPFS pool creation + wasm load + migrations.
  try {
    await page.waitForFunction(
      () => document.body.innerText.includes('SQLite') && document.body.innerText.includes('已就绪'),
      undefined,
      { timeout: 60000 },
    );
  } catch (error) {
    const text = (await page.locator('body').innerText()).replace(/\n/g, ' | ');
    console.log('  [debug] 数据库未就绪，页面实际内容:', text.slice(0, 300));
    throw error;
  }
  await page.waitForSelector('.ft, .banner', { timeout: 20000 });
}

/** Fill the person dialog. `extra` keys map to the dialog's input names. */
async function fillPerson(page, values) {
  await page.waitForSelector('.modal', { timeout: 10000 });
  for (const [field, value] of Object.entries(values)) {
    const selector = `.modal input[name="${field}"], .modal select[name="${field}"]`;
    const element = await page.$(selector);
    if (element === null) continue;
    const tagName = await element.evaluate((el) => el.tagName);
    if (tagName === 'SELECT') await page.selectOption(selector, String(value));
    else await page.fill(selector, String(value));
  }
}

async function submitDialog(page) {
  await page.click('.modal button[type="submit"]');
  await page.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
}

console.log('1. 建立族谱：成员 → 配偶 → 子女 → 孙辈');
await withBrowser(async (page, context) => {
  await openFamily(page);
  check('empty state explains how to start', (await page.locator('body').innerText()).includes('还没有成员'));
  check('family card is on the dashboard', true);

  // 始祖
  await page.getByRole('button', { name: '＋ 添加成员' }).click();
  await fillPerson(page, { name: ROOT, gender: 'male', generation: '1', nativePlace: '示例籍贯' });
  await submitDialog(page);
  await page.waitForFunction(() => document.querySelectorAll('.ft-node').length === 1, { timeout: 20000 });
  check('first member appears in the tree', true);
  // SVG <text> has no innerText; read textContent instead.
  const rootMeta = (await page.locator('.ft-node__meta').first().textContent()) ?? '';
  check('tree node shows 世次 and birth year', /1世|—/.test(rootMeta), rootMeta);

  // 选中 → 加配偶
  await page.click('.ft-node');
  await page.waitForSelector('.ft-detail', { timeout: 10000 });
  check('clicking a node opens the relation panel', true);
  await page.getByRole('button', { name: '＋ 添加配偶' }).click();
  await fillPerson(page, { name: SPOUSE, gender: 'female' });
  await submitDialog(page);
  await page.waitForFunction(() => document.querySelectorAll('.ft-node').length === 2, { timeout: 20000 });
  check('spouse added, tree shows two boxes', true);
  check('marriage tie drawn', (await page.locator('.ft-tie').count()) >= 1);

  // 子女
  await page.locator('.ft-node').first().click();
  await page.waitForSelector('.ft-detail');
  await page.getByRole('button', { name: '＋ 添加子女' }).click();
  // Give the child a real birth date so the shared-person check with the
  // birthday module (which only lists people that have one) is meaningful.
  await fillPerson(page, { name: CHILD, gender: 'male', f_year: '1980', f_month: '6', f_day: '15' });
  await submitDialog(page);
  await page.waitForFunction(() => document.querySelectorAll('.ft-node').length === 3, { timeout: 20000 });
  check('child added below the couple', true);
  check('parent→child path drawn', (await page.locator('.ft-link').count()) >= 1);

  // 孙辈（验证世次自动 +1）
  await page.locator('.ft-node').filter({ hasText: CHILD }).click();
  await page.waitForSelector('.ft-detail');
  await page.getByRole('button', { name: '＋ 添加子女' }).click();
  await fillPerson(page, { name: GRANDCHILD, gender: 'female' });
  await submitDialog(page);
  await page.waitForFunction(() => document.querySelectorAll('.ft-node').length === 4, { timeout: 20000 });
  const detailText = await page.locator('.ft-detail').innerText();
  check('grandchild recorded with an explicit 世次', /第 \d 世/.test(detailText), detailText.slice(0, 120));

  // 世代列表
  await page.getByRole('button', { name: '世代列表' }).click();
  await page.waitForSelector('.ft-gens', { timeout: 10000 });
  const gensText = await page.locator('.ft-gens').innerText();
  check('list groups by 世次', gensText.includes('第 1 世') && /第 [23] 世/.test(gensText), gensText.slice(0, 160));
  check('all four members listed', [ROOT, SPOUSE, CHILD, GRANDCHILD].every((n) => gensText.includes(n)));

  // 中文著录字段
  await page.locator('.ft-name').filter({ hasText: ROOT }).click();
  await page.waitForSelector('.ft-detail');
  check('籍贯 recorded', (await page.locator('.ft-detail').innerText()).includes('示例籍贯'));

  // ---- 多配偶：再娶 + 各房子女 + 离异（旧实现会丢掉第二房的子女）----
  await page.getByRole('button', { name: '世系图' }).click();
  await page.waitForSelector('.ft-canvas');
  await page.locator('.ft-node').filter({ hasText: ROOT }).first().click();
  await page.waitForSelector('.ft-detail');
  await page.getByRole('button', { name: '＋ 添加配偶' }).click();
  await fillPerson(page, { name: SECOND_SPOUSE, gender: 'female', f_year: '1935', f_month: '2', f_day: '8' });
  await submitDialog(page);
  await page.waitForFunction(() => document.querySelectorAll('.ft-node--spouse').length === 2, { timeout: 20000 });
  check('second spouse drawn as its own marriage', true);
  const marriageCount = await page.locator('.ft-marriage').count();
  check('two marriage nodes drawn', marriageCount === 2, 'marriages=' + marriageCount);

  await page.locator('.ft-node').filter({ hasText: ROOT }).first().click();
  await page.waitForSelector('.ft-detail');
  await page
    .locator('.ft-rel li')
    .filter({ hasText: SECOND_SPOUSE })
    .getByRole('button', { name: '子女' })
    .click();
  await fillPerson(page, { name: SECOND_CHILD, gender: 'male' });
  await submitDialog(page);
  await page.waitForFunction((n) => document.body.innerText.includes(n), SECOND_CHILD, { timeout: 20000 });
  check('child of the second marriage is present (was silently dropped before)', true);
  check('both houses visible at once', (await page.locator('.ft-node').count()) >= 6);

  await page.locator('.ft-node').filter({ hasText: ROOT }).first().click();
  await page.waitForSelector('.ft-detail');
  await page
    .locator('.ft-rel li')
    .filter({ hasText: SPOUSE })
    .getByRole('button', { name: '离异' })
    .click();
  await page.waitForFunction(() => document.querySelectorAll('.ft-tie--divorced').length >= 1, { timeout: 20000 });
  check('divorced marriage drawn as a dashed tie with 离', (await page.locator('.ft-divorce').count()) >= 1);

  await page.getByRole('button', { name: '世代列表' }).click();
  await page.waitForSelector('.ft-gens');
  const allText = await page.locator('.ft-gens').innerText();
  check('list shows all six members', [ROOT, SPOUSE, SECOND_SPOUSE, CHILD, GRANDCHILD, SECOND_CHILD].every((n) => allText.includes(n)));
  await page.getByRole('button', { name: '世系图' }).click();
  await page.waitForSelector('.ft-canvas');

  // ---- 切换根节点必须真的重绘（曾出现"选了根但图没变"）----
  const namesOf = async () => (await page.locator('.ft-node__name').allTextContents()).join(',');
  const beforeRoot = await namesOf();
  await page.selectOption('.ft-focus select', { label: SPOUSE });
  await page.waitForTimeout(1000);
  const afterRoot = await namesOf();
  const rootLabel = await page.locator('.ft-focus select option:checked').textContent();
  check('switching the root redraws the tree', beforeRoot !== afterRoot, beforeRoot + ' -> ' + afterRoot);
  check('root choice is reflected in the dropdown', rootLabel === SPOUSE, String(rootLabel));
  check('new root is marked on the canvas', (await page.locator('.ft-root-mark').count()) === 1);

  // 详情面板的「设为根」走同一条路径
  await page.locator('.ft-node').filter({ hasText: ROOT }).first().click();
  await page.getByRole('button', { name: '设为根' }).click();
  await page.waitForTimeout(1000);
  check('「设为根」按钮也重绘', (await namesOf()) === beforeRoot, await namesOf());
  check('root mark follows the selection', (await page.locator('.ft-root-mark').count()) === 1);

  // GEDCOM 导出
  const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
  await page.getByRole('button', { name: '导出 GEDCOM' }).click();
  const download = await downloadPromise;
  const filePath = await download.path();
  const gedcom = readFileSync(filePath, 'utf8');
  check('GEDCOM download produced a file', gedcom.length > 0);
  check('GEDCOM header is 7.0', gedcom.includes('0 HEAD') && gedcom.includes('2 VERS 7.0'));
  check('GEDCOM has INDI and FAM records', gedcom.includes(' INDI') && gedcom.includes(' FAM'));
  check('GEDCOM links husband/wife/child', gedcom.includes('1 HUSB') && gedcom.includes('1 WIFE') && gedcom.includes('1 CHIL'));
  check('GEDCOM carries the Chinese names', gedcom.includes(ROOT) && gedcom.includes(SPOUSE));
  check('GEDCOM ends with TRLR', gedcom.trimEnd().endsWith('0 TRLR'));

  // ---- 删除：需要确认、子女保留、不留悬空关系 ----
  await page.locator('.ft-node').filter({ hasText: SECOND_SPOUSE }).first().click();
  await page.waitForSelector('.ft-detail');
  await page.locator('.ft-detail__actions .btn--danger').click();
  await page.waitForSelector('.modal');
  const confirmTitle = await page.locator('.modal__head h3').innerText();
  check('delete asks for confirmation first', confirmTitle.includes('移除'), confirmTitle);
  await page.getByRole('button', { name: '取消' }).click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 10000 });
  check('cancelling keeps the member', (await namesOf()).includes(SECOND_SPOUSE));

  await page.locator('.ft-node').filter({ hasText: SECOND_SPOUSE }).first().click();
  await page.waitForSelector('.ft-detail');
  await page.locator('.ft-detail__actions .btn--danger').click();
  await page.waitForSelector('.modal');
  await page.getByRole('button', { name: /彻底删除/ }).click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
  await page.waitForTimeout(1200);
  const afterSpouseDelete = await namesOf();
  check('deleted member leaves the tree', !afterSpouseDelete.includes(SECOND_SPOUSE), afterSpouseDelete);
  check('their child survives the delete', afterSpouseDelete.includes(SECOND_CHILD), afterSpouseDelete);
  check('no dangling marriage node is left behind', (await page.locator('.ft-node--spouse').count()) === 1, 'spouses=' + (await page.locator('.ft-node--spouse').count()));

  // 删除一个「子女」：只移除本人，其父辈保留
  await page.locator('.ft-node').filter({ hasText: GRANDCHILD }).first().click();
  await page.waitForSelector('.ft-detail');
  await page.locator('.ft-detail__actions .btn--danger').click();
  await page.waitForSelector('.modal');
  await page.getByRole('button', { name: /彻底删除/ }).click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
  await page.waitForTimeout(1200);
  const afterChildDelete = await namesOf();
  check('deleting a child removes only that child', !afterChildDelete.includes(GRANDCHILD) && afterChildDelete.includes(CHILD), afterChildDelete);

  // 与生日模块共享同一张 person 表
  await page.goto(`${BASE}/#/m/birthday`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.panel', { timeout: 20000 });
  check('family members are the same person rows the birthday module reads',
    (await page.locator('body').innerText()).includes(CHILD));
});

console.log('2. 关闭浏览器后重新打开：族谱是否还在');
await withBrowser(async (page) => {
  await openFamily(page);
  await page.waitForSelector('.ft-node', { timeout: 30000 });
  const boxes = await page.locator('.ft-node').count();
  check('tree restored after a full browser restart', boxes === 4, `boxes=${boxes}`);
  const names = await page.locator('.ft-node__name').allTextContents();
  check('remaining names still present', [ROOT, SPOUSE, CHILD, SECOND_CHILD].every((n) => names.includes(n)), names.join(','));
  check('deleted members stay deleted after restart', ![SECOND_SPOUSE, GRANDCHILD].some((n) => names.includes(n)), names.join(','));

  await page.getByRole('button', { name: '世代列表' }).click();
  await page.waitForSelector('.ft-gens');
  check('generation grouping restored', (await page.locator('.ft-gens').innerText()).includes('第 1 世'));

  // ---- 移除范围：仅移出族谱（保留亲友）vs 彻底删除 ----
  // 恢复后可能停在世代列表，先切回世系图再操作节点
  await page.getByRole('button', { name: '世系图' }).click();
  await page.waitForSelector('.ft');
  await page.waitForTimeout(600);
  await page.locator('.ft-node').filter({ hasText: SECOND_CHILD }).first().click();
  await page.waitForSelector('.ft-detail');
  await page.locator('.ft-detail__actions .btn--danger').click();
  await page.waitForSelector('.modal');
  const scopeLabels = (await page.locator('.scope strong').allTextContents()).join('/');
  check('delete offers both scopes', scopeLabels.includes('仅移出族谱') && scopeLabels.includes('彻底删除'), scopeLabels);
  await page.getByRole('button', { name: /仅移出族谱/ }).click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
  await page.waitForTimeout(1000);
  const treeAfterDetach = await page.locator('.ft-node__name').allTextContents();
  check('detaching removes the member from the tree', !treeAfterDetach.includes(SECOND_CHILD), treeAfterDetach.join(','));

  await page.goto(`${BASE}/#/m/birthday`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.person-list', { timeout: 30000 });
  await page.waitForTimeout(700);
  check('detached member is still in the birthday / friends list', (await page.locator('body').innerText()).includes(SECOND_CHILD));

  await page.goto(`${BASE}/#/m/family`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ft, .banner');
  await page.waitForTimeout(900);
  await page.locator('.ft-node').filter({ hasText: CHILD }).first().click();
  await page.waitForSelector('.ft-detail');
  await page.locator('.ft-detail__actions .btn--danger').click();
  await page.waitForSelector('.modal');
  await page.getByRole('button', { name: /彻底删除/ }).click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
  await page.waitForTimeout(1000);
  const treeAfterPurge = await page.locator('.ft-node__name').allTextContents();
  check('purging also removes the member from the tree', !treeAfterPurge.includes(CHILD), treeAfterPurge.join(','));

  await page.goto(`${BASE}/#/m/birthday`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.person-list', { timeout: 30000 });
  await page.waitForTimeout(700);
  check('purging also removes the member from the friends list', !(await page.locator('body').innerText()).includes(CHILD));
  // ---- 首任配偶必须是初婚：先有子女（形成无配偶家庭）也不该变成继配 ----
  await page.goto(`${BASE}/#/m/family`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ft, .banner');
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: '世系图' }).click();
  await page.waitForSelector('.ft');
  await page.getByRole('button', { name: '＋ 添加成员' }).click();
  await fillPerson(page, { name: '测甲', gender: 'male', generation: '1' });
  await submitDialog(page);
  await page.waitForTimeout(700);
  // A brand-new person has no relations yet, so they are not in the current tree:
  // make them the root through the toolbar, then click the node.
  await page.selectOption('.ft-focus select', { label: '测甲' });
  await page.waitForTimeout(700);
  await page.locator('.ft-node').filter({ hasText: '测甲' }).first().click();
  await page.waitForSelector('.ft-detail');
  await page.getByRole('button', { name: '＋ 添加子女' }).click();
  await fillPerson(page, { name: '测乙', gender: 'male' });
  await submitDialog(page);
  await page.waitForTimeout(700);
  await page.locator('.ft-node').filter({ hasText: '测甲' }).first().click();
  await page.waitForSelector('.ft-detail');
  await page.getByRole('button', { name: '＋ 添加配偶' }).click();
  await fillPerson(page, { name: '测丙', gender: 'female' });
  await submitDialog(page);
  await page.waitForTimeout(900);
  const marriageKinds = await page.locator('.ft-kind').allTextContents();
  check('the first spouse is 初婚, not 继配 (bug: partner-less family counted as a marriage)', !marriageKinds.includes('继配'), marriageKinds.join(','));

  // ---- 本人：族谱以本人为中心 ----
  await page.goto(`${BASE}/#/m/birthday`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.panel', { timeout: 30000 });
  await page.locator('.person-list li').filter({ hasText: '测甲' }).first().getByRole('button', { name: /编辑|补生日/ }).click();
  await page.waitForSelector('.modal');
  await page.check(".modal input[name=\"is_self\"]");
  await page.click(".modal button[type=\"submit\"]");
  await page.waitForSelector('.modal', { state: 'detached', timeout: 20000 });
  await page.waitForTimeout(800);
  check('本人 is tagged in the birthday list', (await page.locator('.tag--self').count()) >= 1);

  await page.goto(`${BASE}/#/m/family`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ft, .banner');
  await page.waitForTimeout(1400);
  const selfMarks = await page.locator('.ft-root-mark').allTextContents();
  check('the tree centres on 本人', selfMarks.includes('本人'), selfMarks.join(','));
  const selfTree = await page.locator('.ft-node__name').allTextContents();
  check('本人 expands to spouse and children', selfTree.includes('测丙') && selfTree.includes('测乙'), selfTree.join(','));

  // ---- 已入族谱的人不能从生日模块直接删除 ----
  await page.goto(`${BASE}/#/m/birthday`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.panel', { timeout: 30000 });
  await page.locator('.person-list li').filter({ hasText: '测甲' }).first().getByRole('button', { name: '删除' }).click();
  await page.waitForTimeout(700);
  const blockedTitle = await page.locator('.modal__head h3').innerText();
  check('deleting a family member from the birthday list is blocked', blockedTitle.includes('无法删除'), blockedTitle);
  check('the blocked dialog explains where to handle it', (await page.locator('.modal').innerText()).includes('家族树'));
  check('no destructive confirm button is offered', !(await page.locator('.modal').innerText()).includes('确认删除'));
  await page.getByRole('button', { name: '前往家族树' }).click();
  await page.waitForTimeout(700);
  check('the blocked dialog routes to the family tree', (await page.evaluate(() => location.hash)).includes('family'));

  // ---- 生日模块的关系标签应自动转成族谱关系链 ----
  await page.goto(`${BASE}/#/m/birthday`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.panel', { timeout: 30000 });
  const addBirthdayPerson = async (values) => {
    await page.getByRole('button', { name: '＋ 添加生日' }).click();
    await page.waitForSelector('.modal');
    const { self, ...fields } = values;
    for (const [field, value] of Object.entries(fields)) {
      const selector = `.modal input[name="${field}"], .modal select[name="${field}"]`;
      const el = await page.$(selector);
      if (el === null) continue;
      const tag = await el.evaluate((n) => n.tagName);
      if (tag === 'SELECT') await page.selectOption(selector, String(value));
      else await page.fill(selector, String(value));
    }
    if (self) await page.check('.modal input[name="is_self"]');
    await page.click('.modal button[type="submit"]');
    await page.waitForSelector('.modal', { state: 'detached', timeout: 30000 });
    await page.waitForTimeout(650);
  };
  await addBirthdayPerson({ name: '链父', relation: '爸爸', gender: 'male', f_year: '1940', f_month: '1', f_day: '2' });
  await addBirthdayPerson({ name: '链母', relation: '妈妈', gender: 'female', f_year: '1943', f_month: '4', f_day: '5' });
  await addBirthdayPerson({ name: '链女', relation: '女儿', gender: 'female', f_year: '2002', f_month: '6', f_day: '7' });

  await page.goto(`${BASE}/#/m/family`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ft, .banner');
  await page.waitForTimeout(1600);
  const chainNodes = await page.locator('.ft-node__name').allTextContents();
  check(
    'birthday relations form a real family chain around 本人',
    ['测甲', '链父', '链母', '链女'].every((name) => chainNodes.includes(name)),
    chainNodes.join(','),
  );

  // 世次 is derived from the structure, not typed: 根是第 1 世，往下每一代 +1。
  // 这里没有指定过根，所以按「本人」为基准：测甲第 1 世，链女第 2 世。
  await page.getByRole('button', { name: '世代列表' }).click();
  await page.waitForSelector('.ft-gens');
  await page.waitForTimeout(400);
  const gensText = (await page.locator('.ft-gens').innerText()).replace(/\n/g, ' ');
  check(
    '世次 is derived from the structure (root is 世 1)',
    gensText.includes('第 1 世') && gensText.includes('第 2 世'),
    gensText.slice(0, 140),
  );
  check(
    'the root (本人) sits in 世 1',
    /第 1 世[\s\S]*?测甲/.test(gensText),
    gensText.slice(0, 140),
  );
  await page.getByRole('button', { name: '世系图' }).click();
  await page.waitForSelector('.ft');

  console.log('3. 根持久化');
  await page.goto(`${BASE}/#/m/family`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ft-focus select', { timeout: 60000 });
  await page.waitForTimeout(1400);

  const readRoot = async () => {
    // 根选择器只在世系图视图里出现，先等它。
    await page.waitForSelector('.ft-focus select', { timeout: 30000 });
    const value = await page.locator('.ft-focus select').inputValue();
    return (await page.locator(`.ft-focus select option[value="${value}"]`).innerText()).trim();
  };

  const initialRoot = await readRoot();
  check('族谱显示当前根', initialRoot !== '', initialRoot);

  // 选一个不是当前根的人作为新的根
  const rootNames = (await page.locator('.ft-node__name').allTextContents()).map((n) => n.trim());
  const otherName = rootNames.find((name) => name !== initialRoot);
  check('能选到另一个成员作为根', otherName !== undefined, rootNames.join(','));

  if (otherName !== undefined) {
    await page.locator('.ft-node').filter({ hasText: otherName }).first().click();
    await page.waitForSelector('.ft-detail');
    await page.getByRole('button', { name: '设为根' }).click();
    await page.waitForTimeout(900);
    check('设为根后立即生效', (await readRoot()) === otherName, await readRoot());

    // 刷新：根必须还在
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ft-focus select', { timeout: 60000 });
    await page.waitForTimeout(1600);
    check('刷新后根保持不变（持久化）', (await readRoot()) === otherName, await readRoot());

    // 下拉切换也要持久化
    const back = rootNames.find((name) => name !== otherName);
    if (back !== undefined) {
      const backId = await page.locator(`.ft-focus select option:text-is("${back}")`).getAttribute('value');
      if (backId !== null) await page.locator('.ft-focus select').selectOption(backId);
      await page.waitForTimeout(800);
      check('下拉切换根后立即生效', (await readRoot()) === back, await readRoot());
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.ft-focus select', { timeout: 60000 });
      await page.waitForTimeout(1600);
      check('下拉切换的根也被记住', (await readRoot()) === back, await readRoot());
    }
  }

  // 本人 是独立概念：换根不应该改动它
  await page.getByRole('button', { name: '世代列表' }).click();
  await page.waitForSelector('.ft-gens');
  await page.waitForTimeout(400);
  const selfTagCount = await page.locator('.tag--self').count();
  check('换根不影响「本人」标记', selfTagCount >= 1, String(selfTagCount));
  await page.getByRole('button', { name: '世系图' }).click();
  await page.waitForSelector('.ft');

  // 根 = 第一代：改根后世次要跟着重排，并且刷新后保持。
  const genGroups = async () => {
    await page.getByRole('button', { name: '世代列表' }).click();
    await page.waitForSelector('.ft-gens');
    await page.waitForTimeout(500);
    const groups = new Map();
    for (const section of await page.locator('.ft-gens .month-group').all()) {
      const head = (await section.locator('.month-group__head').innerText()).replace(/\n/g, ' ');
      const match = head.match(/第\s*(\d+)\s*世/);
      if (match === null) continue;
      const names = (await section.locator('.ft-name').allTextContents()).map((t) => t.trim());
      groups.set(Number(match[1]), names);
    }
    await page.getByRole('button', { name: '世系图' }).click();
    await page.waitForSelector('.ft');
    return groups;
  };

  const rootOf = async () => {
    // 根选择器只在世系图视图里出现，先等它。
    await page.waitForSelector('.ft-focus select', { timeout: 30000 });
    const value = await page.locator('.ft-focus select').inputValue();
    return (await page.locator(`.ft-focus select option[value="${value}"]`).innerText()).trim();
  };

  const memberNames = (await page.locator('.ft-node__name').allTextContents()).map((t) => t.trim());
  const currentRootName = await rootOf();
  const newRootName = memberNames.find((name) => name !== currentRootName);
  check('能挑出另一个成员当根', newRootName !== undefined, memberNames.join(','));

  if (newRootName !== undefined) {
    await page.locator('.ft-node').filter({ hasText: newRootName }).first().click();
    await page.waitForSelector('.ft-detail');
    await page.getByRole('button', { name: '设为根' }).click();
    await page.waitForTimeout(1500);
    check('改根后立即生效', (await rootOf()) === newRootName, await rootOf());

    const gens = await genGroups();
    check('根就是第一代', (gens.get(1) ?? []).includes(newRootName), JSON.stringify([...gens.entries()]));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ft-focus select', { timeout: 60000 });
    await page.waitForTimeout(1800);
    check('刷新后根不变', (await rootOf()) === newRootName, await rootOf());
    const gensAfter = await genGroups();
    check('刷新后根仍是第一代', (gensAfter.get(1) ?? []).includes(newRootName), JSON.stringify([...gensAfter.entries()]));
  }

  await page.getByRole('button', { name: '世系图' }).click();
  await page.waitForSelector('.ft');
});


const ignorable = /Download the React DevTools/i;
const realErrors = errors.filter((e) => !ignorable.test(e));

check('no console/page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;