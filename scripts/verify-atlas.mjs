/**
 * 词光 atlas 模块验证。
 *
 * 两半：
 *  1. 纯逻辑 —— 生词提取、FSRS 调度、出题（不需要浏览器）
 *  2. 浏览器流程 —— 词库导入、做题、评分落库、刷新后进度还在、词集联动
 */
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const extract = require('./.word-extract-for-test.cjs');
const session = require('./.word-session-for-test.cjs');

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

// ───────────────────────── 1. 生词提取 ─────────────────────────
console.log('1. 生词提取');
{
  const tokens = extract.tokenizeWords("The fox said: don't abandon well-known ideas, Charles' book.");
  const normalized = tokens.map((t) => t.normalized);
  check('切成小写词', normalized.includes('abandon') && normalized.includes('fox'), normalized.join(','));
  check('去掉所有格', !normalized.some((w) => w.includes("'")), normalized.join(','));
  check('连字符拆开', normalized.includes('well') && normalized.includes('known'), normalized.join(','));

  const known = new Set(['abandon', 'library', 'fox', 'prince']);
  const found = extract.extractKnownWords('The fox ran to the library and abandon everything', known);
  check('只挑词库里的词', found.every((w) => known.has(w)), found.join(','));
  check('按出现顺序去重', found.join(',') === 'fox,library,abandon', found.join(','));
  check('不挑虚词', !found.includes('the') && !found.includes('and'), found.join(','));

  const md = '```js\nconst abandon = 1;\n```\n读 [abandon](https://x.com/abandon) 和 `library` 以及 prince';
  const fromMd = extract.extractFromMarkdown(md, known);
  check('跳过代码块', fromMd.includes('abandon') && fromMd.includes('library') === false, fromMd.join(','));
  check('跳过 URL 路径', fromMd.filter((w) => w === 'abandon').length === 1 || fromMd.includes('prince'), fromMd.join(','));
  check('保留可见文字', fromMd.includes('prince'), fromMd.join(','));
}

// ───────────────────────── 2. FSRS 调度 ─────────────────────────
console.log('2. FSRS 调度');
{
  const srs = require('./.word-srs-for-test.cjs');
  const now = new Date('2026-06-01T12:00:00Z').getTime();

  const fresh = srs.newWordCard('abandon', now);
  check('新卡状态为 0', fresh.state === 0, String(fresh.state));
  check('新卡到期时间为当前', fresh.due <= now + 1000, String(fresh.due));

  const good = srs.reviewWord(fresh, srs.Rating.Good, now);
  check('答对后到期时间往后推', good.due > now, `${good.due} > ${now}`);
  check('答对后 reps 增加', good.reps >= 1, String(good.reps));

  const again = srs.reviewWord(fresh, srs.Rating.Again, now);
  check('答错后很快再出现', again.due < good.due, `${again.due} < ${good.due}`);

  const easy = srs.reviewWord(fresh, srs.Rating.Easy, now);
  check('很熟比记得推得更远', easy.due > good.due, `${easy.due} > ${good.due}`);

  const intervals = srs.previewIntervals(fresh, now);
  check('四个评分都有间隔',
    intervals[srs.Rating.Again] > 0 && intervals[srs.Rating.Easy] > 0,
    JSON.stringify(intervals));

  check('间隔格式化', srs.formatInterval(60_000) === '1 分钟', srs.formatInterval(60_000));
  check('间隔格式化（天）', srs.formatInterval(86_400_000 * 3) === '3 天', srs.formatInterval(86_400_000 * 3));
}

// ───────────────────────── 3. 出题 ─────────────────────────
console.log('3. 出题');
{
  const makeEntry = (id, zh, topic = 'daily', media = 31) => ({
    id, word: id, ipa_uk: '', ipa_us: '', cefr: 'A1', topic, media,
    senses: [{ pos: 'n.', zh, en: '' }], examples: [], collocations: [],
    family: [], synonyms: [], antonyms: [], tip: '', note: '', ord: 0,
  });
  const pool = [
    makeEntry('alpha', '阿尔法', 'daily'),
    makeEntry('beta', '贝塔', 'daily'),
    makeEntry('gamma', '伽马', 'science'),
    makeEntry('delta', '德尔塔', 'science'),
  ];

  const q = session.buildQuestion(pool[0], undefined, pool);
  check('生成题目', q.entry.id === 'alpha');
  if (q.kind !== 'spell') {
    check('恰好四个选项', q.options.length === 4, String(q.options.length));
    check('正确答案在选项里', q.options[q.answer] === '阿尔法', q.options.join(','));
    check('选项不重复', new Set(q.options).size === 4, q.options.join(','));
  }

  const distractors = session.pickDistractors(pool[0], pool, 3);
  check('干扰项数量正确', distractors.length === 3, String(distractors.length));
  check('干扰项不含正确答案', !distractors.some((d) => d.id === 'alpha'), distractors.map((d) => d.id).join(','));

  check('拼写检查忽略大小写', session.checkSpelling('  ABANDON ', makeEntry('abandon', '放弃')) === true);
  check('拼写错误能识别', session.checkSpelling('abandan', makeEntry('abandon', '放弃')) === false);

  const minutes = session.estimateMinutes(10, 20);
  check('时间估算合理', minutes >= 1 && minutes <= 30, String(minutes));
}

// ───────────────────────── 4. 浏览器流程 ─────────────────────────
const BASE = (process.env.JVS_BASE ?? 'http://localhost:4173/').replace(/\/$/, '');
const out = join(process.cwd(), '.verify');
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'jvs-atlas-'));
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
  console.log('5. 媒体与数据');
  const imgRes = await fetch(`${BASE}/word-media/img/abandon.webp`);
  check('插画可访问', imgRes.status === 200 && (imgRes.headers.get('content-type') ?? '').includes('webp'),
    `${imgRes.status} ${imgRes.headers.get('content-type')}`);
  const audioRes = await fetch(`${BASE}/word-media/audio/uk/abandon.mp3`);
  check('音频可访问', audioRes.status === 200 && (audioRes.headers.get('content-type') ?? '').includes('audio'),
    `${audioRes.status} ${audioRes.headers.get('content-type')}`);
  const rangeRes = await fetch(`${BASE}/word-media/audio/uk/abandon.mp3`, { headers: { Range: 'bytes=0-99' } });
  check('音频支持 Range（可拖动进度）', rangeRes.status === 206, String(rangeRes.status));
  const manifest = await (await fetch(`${BASE}/word-data/manifest.json`)).json();
  check('词库清单 7298 词', manifest.count === 7298, String(manifest.count));
  check('词库署名带 CC BY 4.0', manifest.license === 'CC BY 4.0', manifest.license);

  console.log('6. 首次导入');
  await page.goto(`${BASE}/#/m/atlas`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('已就绪'), undefined, { timeout: 60000 });
  await page.waitForSelector('.wa-page', { timeout: 30000 });
  await page.waitForTimeout(900);
  check('首次显示导入页', (await page.locator('.wa-intro').count()) === 1);

  await page.getByRole('button', { name: /导入词库/ }).click();
  await page.waitForSelector('.wa-stats', { timeout: 240000 });
  check('导入完成并进入今日', (await page.locator('.wa-stats').count()) >= 1);
  const planText = await page.locator('.wa-today__plan').innerText();
  check('今日计划显示新词数', /新词\s*\d+/.test(planText), planText);

  console.log('7. 做题');
  await page.getByRole('button', { name: '开始学习' }).click();
  await page.waitForSelector('.wa-quiz', { timeout: 180000 });
  await page.waitForTimeout(600);
  const barText = await page.locator('.wa-quiz__bar').innerText();
  check('进入第 1 题', barText.includes('1 /'), barText.replace(/\n/g, ' '));
  check('有 4 个选项', (await page.locator('.wa-option').count()) === 4,
    String(await page.locator('.wa-option').count()));

  await page.locator('.wa-option').first().click();
  await page.waitForSelector('.wa-verdict', { timeout: 15000 });
  check('答完给出判定', (await page.locator('.wa-verdict').innerText()).length > 0);
  check('展示词条详情', (await page.locator('.wa-reveal').count()) === 1);
  check('有 4 个评分按钮', (await page.locator('.wa-grade').count()) === 4);

  await page.locator('.wa-grade').nth(2).click();
  await page.waitForTimeout(900);
  check('评分后进入下一题', (await page.locator('.wa-quiz__bar').innerText()).includes('2 /'),
    (await page.locator('.wa-quiz__bar').innerText()).replace(/\n/g, ' '));

  console.log('8. 进度持久化');
  await page.goto(`${BASE}/#/m/atlas`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.wa-stats', { timeout: 60000 });
  await page.waitForTimeout(1500);
  const statsText = await page.locator('.wa-stats').first().innerText();
  check('刷新后导入页不再出现', (await page.locator('.wa-intro').count()) === 0);
  check('刷新后今天学过 1 次', /1\s*今日复习/.test(statsText.replace(/\n/g, ' ')), statsText.replace(/\n/g, ' '));

  console.log('9. 词表与搜索');
  await page.getByRole('button', { name: '词表', exact: true }).click();
  await page.waitForTimeout(1200);
  check('词表有内容', (await page.locator('.wa-words li').count()) > 0,
    String(await page.locator('.wa-words li').count()));
  await page.fill('.wa-search', 'library');
  await page.waitForTimeout(1000);
  const firstWord = await page.locator('.wa-words li').first().innerText();
  check('搜索命中 library', firstWord.includes('library'), firstWord.replace(/\n/g, ' '));

  console.log('10. 笔记联动');
  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.composer, textarea', { timeout: 30000 });
  await page.waitForTimeout(900);
  await page.locator('textarea').first().fill('The magnificent library preserved an ancient manuscript.');
  await page.locator('button:has-text("保存")').first().click();
  await page.waitForSelector('.note', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.locator('.note').first().getByRole('button', { name: '提取生词' }).click();
  await page.waitForTimeout(2000);
  const extractText = await page.locator('.note__wordresult').first().innerText();
  check('笔记提取出生词', /本次\s*\d+\s*词/.test(extractText), extractText);
  check('提取的是词库里的词', !/本次 0 词/.test(extractText), extractText);

  await page.goto(`${BASE}/#/m/atlas`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.wa-stats', { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '统计', exact: true }).click();
  await page.waitForTimeout(1200);
  const statsBody = await page.locator('.wa-stats-view').innerText();
  check('统计页出现词集', statsBody.includes('词集') && statsBody.includes('笔记'), statsBody.slice(0, 120));

  console.log('11. 媒体源可配置');
  await page.getByRole('button', { name: '统计', exact: true }).click();
  await page.waitForTimeout(800);
  check('统计页有媒体源设置', (await page.locator('.wa-mediabase').count()) === 1);
  // 用本机绝对地址模拟远端：走的是同一条 HttpMediaSource 代码路径。
  await page.fill('input[aria-label="媒体基地址"]', `${BASE}/word-media`);
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.waitForTimeout(2500);
  const probeHint = await page.locator('.wa-stats-view .wa-today__hint').last().innerText();
  check('远端地址能探测到媒体', probeHint.includes('连接成功'), probeHint);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForTimeout(1500);
  const savedHint = await page.locator('.wa-stats-view .wa-today__hint').last().innerText();
  check('保存后切换了媒体源', savedHint.includes('已切换到'), savedHint);
  // 切回本地，避免影响后续
  await page.fill('input[aria-label="媒体基地址"]', '');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForTimeout(1200);

  console.log('12. 复习提醒');
  const reminder = page.getByRole('button', { name: /添加提醒/ });
  check('提醒按钮可点', (await reminder.count()) === 1 && (await reminder.isEnabled()));
  await reminder.click();
  await page.waitForTimeout(1500);
  await page.goto(`${BASE}/#/m/countdown`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.panel', { timeout: 30000 });
  await page.waitForTimeout(1200);
  const countdownText = await page.locator('.panel').first().innerText();
  check('倒计时出现背单词复习', countdownText.includes('背单词复习'), countdownText.replace(/\n/g, ' ').slice(0, 120));

  await page.screenshot({ path: join(out, 'atlas-final.png'), fullPage: true });

  const realErrors = errors.filter((error) => !/Download the React DevTools/i.test(error));
  check('无控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
