/**
 * GOAL module checks.
 *
 * Two halves:
 *  1. the arithmetic (progress, cadence plan, forecast) and the note-sync format,
 *     exercised as pure functions;
 *  2. the real browser flow — create a reading goal, add a book, check in with a
 *     note, and confirm the note reaches the notes module with the exact
 *     「#《书名》 … #」 shape the user asked for.
 */
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const logic = require('./.goal-logic-for-test.cjs');
const noteSync = require('./.goal-noteformat-for-test.cjs');

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

const DAY = 86_400_000;
const now = new Date('2026-06-01T12:00:00').getTime();
const iso = (ms) => new Date(ms).toISOString();

function makeGoal(overrides = {}) {
  return {
    id: 'g1', title: '读书', kind: 'qty', target: 500, unit: '页',
    initial_done: 0, start_value: 0, target_value: 0, direction: 1,
    start_at: iso(now - 5 * DAY), due_at: iso(now + 25 * DAY),
    ended_at: null, max_per_day: 0, pattern: '0', shape: 'front',
    color: '#2f4bff', archived: 0, voided: 0,
    created_at: iso(now), updated_at: iso(now),
    ...overrides,
  };
}

function makeLog(amount, daysAgo = 0, extra = {}) {
  return {
    id: 'l' + Math.random().toString(36).slice(2, 8),
    goal_id: 'g1', sub_id: null, amount, value: null, position: null,
    note: '', note_id: null,
    at: iso(now - daysAgo * DAY), created_at: iso(now - daysAgo * DAY),
    ...extra,
  };
}

// ───────────────────────── 1. 进度与统计 ─────────────────────────
console.log('1. 进度计算');
{
  const goal = makeGoal();
  const logs = [makeLog(100, 3), makeLog(50, 2), makeLog(25, 1)];
  const info = logic.goalInfo(goal, logs, now);
  check('累计完成量 = 各次打卡之和', info.done === 175, String(info.done));
  check('剩余量 = 总量 - 已完成', info.remain === 325, String(info.remain));
  check('百分比按已完成/总量', info.percent === 35, String(info.percent));
  check('未完成时 isDone 为 false', info.isDone === false);
  check('未超期时 isLate 为 false', info.isLate === false);
  check('时间进度与截止日一致', info.timePercent >= 15 && info.timePercent <= 20, String(info.timePercent));

  const doneGoal = makeGoal({ target: 100 });
  const doneInfo = logic.goalInfo(doneGoal, [makeLog(100)], now);
  check('达到总量即完成', doneInfo.isDone === true && doneInfo.remain === 0);

  const lateGoal = makeGoal({ due_at: iso(now - DAY) });
  check('超过截止时间为逾期', logic.goalInfo(lateGoal, [], now).isLate === true);

  const futureGoal = makeGoal({ start_at: iso(now + 3 * DAY), due_at: iso(now + 30 * DAY) });
  check('起始时间在未来为未开始', logic.goalInfo(futureGoal, [], now).notStarted === true);
}

console.log('2. 结果型目标');
{
  const goal = makeGoal({ kind: 'result', unit: 'kg', start_value: 80, target_value: 70, target: 10, direction: -1 });
  const info80 = logic.goalInfo(goal, [], now);
  check('结果型按当前值算完成量', info80.done === 0, String(info80.done));
  const logs = [makeLog(0, 3, { value: 78 }), makeLog(0, 1, { value: 76 })];
  const info76 = logic.goalInfo(goal, logs, now);
  check('数值下降为正向进展（减重）', info76.done === 4, String(info76.done));
  check('当前值取最近一次记录', logic.currentValue(goal, logs) === 76);
}

console.log('3. 子目标');
{
  const goal = makeGoal({ target: 2, unit: '本' });
  const sub = { id: 's1', goal_id: 'g1', name: '小王子', unit: '页', total: 120, position: 0, created_at: iso(now) };
  const logs = [makeLog(120, 1, { sub_id: 's1' })];
  check('子目标完成量独立统计', logic.subDone('s1', logs) === 120);
  check('不同单位的子目标完成计入主目标 1 本', logic.doneOf(goal, logs, [sub]) === 1, String(logic.doneOf(goal, logs, [sub])));

  const sameUnit = { ...sub, unit: '本', total: 1 };
  check('相同单位的子目标按数量累计', logic.doneOf(goal, [makeLog(1, 1, { sub_id: 's1' })], [sameUnit]) === 1);
}

console.log('4. 节奏计划');
{
  const goal = makeGoal({ target: 100, unit: '页', pattern: '2-1', start_at: iso(now), due_at: iso(now + 20 * DAY) });
  const plan = logic.buildPlan(goal, [], now);
  check('有节奏时生成计划', plan !== null);
  check('计划包含若干天', plan.days.length > 0, String(plan?.days.length));
  check('计划里既有打卡日也有休息日',
    plan.days.some((d) => d.planned) && plan.days.some((d) => !d.planned));
  check('计划可排下时 feasible 为 true', plan.feasible === true);

  // 节奏日太少、量太大时，必须前紧后松：靠前的日子要连着打卡。
  const tight = makeGoal({ target: 40, unit: '本', pattern: '1-5', start_at: iso(now), due_at: iso(now + 10 * DAY) });
  const history = [makeLog(1, 6), makeLog(1, 4), makeLog(1, 2)];
  const tightPlan = logic.buildPlan(tight, history, now);
  check('节奏排不下时要求前置连续打卡', tightPlan !== null && tightPlan.leadDays > 0, String(tightPlan?.leadDays));
  check('每次打卡量按节奏日摊分', tightPlan !== null && tightPlan.perCheck >= 1, String(tightPlan?.perCheck));
  check('每天次数受限且天数不够时标记排不下',
    logic.buildPlan(
      makeGoal({ target: 100, unit: '本', pattern: '1-5', max_per_day: 1, start_at: iso(now), due_at: iso(now + 3 * DAY) }),
      [makeLog(1, 2), makeLog(1, 1)],
      now,
    ).feasible === false);

  check('不限节奏时不需要计划', logic.buildPlan(makeGoal({ pattern: '0' }), [], now) === null);
  check('已完成的目标不再排计划', logic.buildPlan(makeGoal({ target: 10 }), [makeLog(10)], now) === null);
}

console.log('5. 速率预测');
{
  const goal = makeGoal({ target: 500, unit: '页' });
  const logs = [makeLog(10, 6), makeLog(10, 5), makeLog(10, 4), makeLog(10, 3)];
  const prediction = logic.forecast(goal, logs, now);
  check('有足够数据时给出预测', prediction !== null);
  check('预测文本提到预计完成', prediction.text.includes('预计'), prediction?.text);
  check('打卡不足时明确说数据不足', logic.forecast(goal, [makeLog(10, 1)], now).text.includes('不足'));
}

console.log('6. 打卡约束');
{
  const goal = makeGoal();
  check('正常可打卡', logic.checkInBlocker(goal, [], now) === '');
  check('逾期后不能新增打卡', logic.checkInBlocker(makeGoal({ due_at: iso(now - DAY) }), [], now).includes('过期'));
  check('作废目标不能打卡', logic.checkInBlocker(makeGoal({ voided: 1 }), [], now).includes('作废'));
  check('已完成目标不能打卡', logic.checkInBlocker(makeGoal({ target: 10 }), [makeLog(10)], now).includes('完成'));
  check('不能填写未来时间', logic.checkInBlocker(goal, [], now, now + DAY).includes('未来'));
  check('整数单位不做小数累加', logic.unitNeedsInteger('个') === true && logic.unitNeedsInteger('公里') === false);
}

// ───────────────────────── 7. 笔记同步格式 ─────────────────────────
console.log('7. 打卡笔记格式');
{
  const body = noteSync.buildCheckInBody('小王子', '今天读了第三章');
  check('书名按 #《小王子》 开头', body.startsWith('#《小王子》'), JSON.stringify(body.slice(0, 14)));
  check('正文包含笔记内容', body.includes('今天读了第三章'));
  check('正文不再以孤立的 # 结尾', !/\\n#\\s*$/.test(body), JSON.stringify(body.slice(-12)));
  check('空内容不产生正文', noteSync.buildCheckInBody('小王子', '   ') === '');
  check('结尾没有多余的 #', !noteSync.buildCheckInBody('小王子', '内容').endsWith('#'));
  check('旧笔记的孤立 # 会被去掉',
    noteSync.stripTrailingHash('#《小王子》\n\n内容\n#') === '#《小王子》\n\n内容',
    JSON.stringify(noteSync.stripTrailingHash('#《小王子》\n\n内容\n#')));
  check('正文里的 # 标题不受影响', noteSync.stripTrailingHash('# 小标题\n\n内容').includes('# 小标题'));
  check('书名已带《》时不重复包裹', noteSync.buildCheckInBody('《小王子》', 'x').startsWith('#《小王子》'));
  check('wrapBookName 补括号', noteSync.wrapBookName('小王子') === '《小王子》');
  check('wrapBookName 不重复补', noteSync.wrapBookName('《小王子》') === '《小王子》');

  const tags = noteSync.buildCheckInTags('小王子', '读书');
  check('打卡目标作为标签', tags.includes('读书'), tags.join(','));
  check('书名也作为标签', tags.includes('小王子'), tags.join(','));
  const goalOnly = noteSync.buildCheckInTags('', '跑步');
  check('没有书名时仍有目标标签', goalOnly.includes('跑步') && !goalOnly.includes('小王子'), goalOnly.join(','));
  const both = noteSync.buildCheckInTags('小王子', '读书', ['读书']);
  check('重复标签只出现一次', both.filter((t) => t === '读书').length === 1, both.join(','));
  check('标题带书名', noteSync.checkInNoteTitle('小王子') === '《小王子》 读书打卡', noteSync.checkInNoteTitle('小王子'));
  check('无书名时标题为读书打卡', noteSync.checkInNoteTitle('') === '读书打卡');
}

// ───────────────────────── 8. 浏览器流程 ─────────────────────────
const BASE = (process.env.JVS_BASE ?? 'http://localhost:4173/').replace(/\/$/, '');
const out = join(process.cwd(), '.verify');
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'jvs-goal-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, args: ['--no-sandbox'], viewport: { width: 1280, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text());
});

try {
  console.log('8. 目标页面流程');
  await page.goto(`${BASE}/#/m/goal`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('已就绪'), undefined, { timeout: 60000 });
  await page.waitForSelector('.goal-page', { timeout: 30000 });
  check('目标页渲染', (await page.locator('.goal-page').count()) === 1);

  // 新建读书目标
  await page.getByRole('button', { name: '＋ 添加目标' }).click();
  await page.waitForSelector('.modal');
  await page.fill('.modal input[name="title"]', '读书');
  await page.fill('.modal input[name="target"]', '500');
  const selects = page.locator('.modal select');
  const selectCount = await selects.count();
  for (let i = 0; i < selectCount; i += 1) {
    const options = await selects.nth(i).locator('option').allTextContents();
    if (options.includes('页')) { await selects.nth(i).selectOption({ label: '页' }); break; }
  }
  await page.locator('.modal button[type="submit"]').click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 30000 });
  await page.waitForTimeout(1200);
  check('新目标出现在列表', (await page.locator('.goal').count()) >= 1);
  check('卡片显示倒计时', (await page.locator('.goal .clock').first().innerText()).includes('天'));
  check('卡片显示进度', (await page.locator('.goal .bar').count()) >= 1);

  // 进入详情
  await page.locator('.goal').first().click();
  await page.waitForTimeout(800);
  check('详情页有返回按钮', (await page.getByRole('button', { name: /返回全部目标/ }).count()) === 1);

  // 加子目标《小王子》
  await page.getByRole('button', { name: /添加子目标/ }).click();
  await page.waitForSelector('.modal');
  await page.fill('.modal input[name="name"]', '小王子');
  await page.fill('.modal input[name="unit"]', '页');
  await page.fill('.modal input[name="total"]', '120');
  await page.locator('.modal button[type="submit"]').click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 30000 });
  await page.waitForTimeout(1200);
  check('子目标出现', (await page.locator('.goal__sub').count()) === 1);
  check('子目标显示书名', (await page.locator('.goal__sub').first().innerText()).includes('小王子'));

  // 从子目标打卡并写笔记
  await page.locator('.goal__sub').first().getByRole('button', { name: '打卡' }).click();
  await page.waitForSelector('.modal');
  check('打卡弹窗预选了这本书', (await page.locator('.modal').innerText()).includes('小王子'));
  const modeSelect = page.locator('.modal select[name="mode"]');
  if ((await modeSelect.count()) > 0) await modeSelect.selectOption('amt');
  await page.fill('.modal input[name="amount"]', '12');
  await page.fill('.modal textarea[name="note"]', '今天读了第三章，狐狸说驯养就是建立联系。');
  await page.locator('.modal button[type="submit"]').click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 30000 });
  await page.waitForTimeout(1500);

  check('打卡记录出现', (await page.locator('.goal__logs li').count()) === 1);
  check('记录显示已同步到笔记', (await page.locator('.goal__logs li').first().innerText()).includes('已同步到笔记'));
  check('子目标进度更新', (await page.locator('.goal__sub').first().innerText()).includes('12'));

  await page.screenshot({ path: join(out, 'goal-detail.png'), fullPage: true });

  // 笔记模块确认
  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.note', { timeout: 30000 });
  await page.waitForTimeout(1200);
  check('笔记模块出现同步的笔记', (await page.locator('.note').count()) === 1);
  const noteText = await page.locator('.note').first().innerText();
  check('笔记标题含书名', noteText.includes('《小王子》'), noteText.split('\n')[0]);
  check('笔记正文含 #《小王子》 标记', noteText.includes('#《小王子》'));
  check('笔记正文含打卡内容', noteText.includes('狐狸说驯养就是建立联系'));
  check('笔记把打卡目标显示为标签', noteText.includes('读书'));
  const tagTexts = (await page.locator('.note .tag').allTextContents()).map((t) => t.trim());
  check('笔记标签里有书名', tagTexts.some((t) => t.includes('小王子')), tagTexts.join(','));
  check('笔记标签里有目标', tagTexts.some((t) => t.includes('读书')), tagTexts.join(','));
  await page.screenshot({ path: join(out, 'goal-note-synced.png'), fullPage: true });

  // 空内容的打卡不产生笔记
  await page.goto(`${BASE}/#/m/goal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.goal', { timeout: 30000 });
  await page.locator('.goal').first().click();
  await page.waitForTimeout(800);
  await page.locator('.goal__sub').first().getByRole('button', { name: '打卡' }).click();
  await page.waitForSelector('.modal');
  const modeSelect2 = page.locator('.modal select[name="mode"]');
  if ((await modeSelect2.count()) > 0) await modeSelect2.selectOption('amt');
  await page.fill('.modal input[name="amount"]', '5');
  await page.locator('.modal button[type="submit"]').click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 30000 });
  await page.waitForTimeout(1500);
  check('无内容打卡不写笔记', (await page.locator('.goal__logs li').count()) === 2);

  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.note', { timeout: 30000 });
  await page.waitForTimeout(1000);
  check('笔记数量仍为 1', (await page.locator('.note').count()) === 1, String(await page.locator('.note').count()));

  console.log('9. 旧打卡笔记修复');
  // 用「不指定」打卡，造出没有书名的旧格式笔记
  await page.goto(`${BASE}/#/m/goal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.goal-page', { timeout: 30000 });
  await page.waitForTimeout(900);
  await page.locator('.goal').first().click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: '去打卡' }).click();
  await page.waitForSelector('.modal');
  await page.locator('.modal select[name="sub"]').selectOption('');
  const legacyMode = page.locator('.modal select[name="mode"]');
  if ((await legacyMode.count()) > 0) await legacyMode.selectOption('amt');
  await page.fill('.modal input[name="amount"]', '7');
  await page.fill('.modal textarea[name="note"]', '旧格式：打卡时没有选书。');
  await page.locator('.modal button[type="submit"]').click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 30000 });
  await page.waitForTimeout(1600);

  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.note', { timeout: 30000 });
  await page.waitForTimeout(1200);
  const legacyNotes = page.locator('.note');
  const legacyCount = await legacyNotes.count();
  let legacyIndex = -1;
  for (let i = 0; i < legacyCount; i += 1) {
    const text = await legacyNotes.nth(i).innerText();
    if (text.includes('旧格式：打卡时没有选书')) { legacyIndex = i; break; }
  }
  check('造出了旧格式笔记', legacyIndex >= 0, 'index=' + legacyIndex);
  if (legacyIndex >= 0) {
    const before = await legacyNotes.nth(legacyIndex).innerText();
    check('旧笔记确实没有书名', !before.includes('#《小王子》'), before.split('\n')[0]);
  }

  // 进入目标页触发幂等修复
  await page.goto(`${BASE}/#/m/goal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.goal-page', { timeout: 30000 });
  await page.waitForTimeout(2800);
  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.note', { timeout: 30000 });
  await page.waitForTimeout(1400);
  let repairedText = '';
  for (let i = 0; i < await page.locator('.note').count(); i += 1) {
    const text = await page.locator('.note').nth(i).innerText();
    if (text.includes('旧格式：打卡时没有选书')) { repairedText = text; break; }
  }
  check('旧笔记被补回书名头', repairedText.includes('#《小王子》'), repairedText.split('\n')[0]);
  check('旧笔记标题补上书名', repairedText.includes('《小王子》 读书打卡'), repairedText.split('\n')[0]);
  check('旧笔记补上书名标签', repairedText.includes('小王子'), repairedText.split('\n')[0]);

  const realErrors = errors.filter((error) => !/Download the React DevTools/i.test(error));
  check('无控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;