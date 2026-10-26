/**
 * Notes module verification: composer, markdown+math rendering, tags, pin, search,
 * tag/date filters, image attachments, import/export, person linkage, delete.
 *
 * The markdown renderer has its own unit suite (`pnpm verify:markdown`); this one
 * drives the real UI in a browser.
 */
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.JVS_BASE ?? 'http://localhost:4173/';
const out = join(process.cwd(), '.verify');
mkdirSync(out, { recursive: true });

// Valid 1×1 red PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

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

const profile = mkdtempSync(join(tmpdir(), 'jvs-notes-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox'],
  viewport: { width: 1400, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
    errors.push(message.text());
  }
});

const NOTES = `${BASE}#/m/notes`;
const FAMILY = `${BASE}#/m/family`;

try {
  console.log('1. 输入与渲染');
  await page.goto(NOTES, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => document.body.innerText.includes('SQLite') && document.body.innerText.includes('已就绪'),
    undefined,
    { timeout: 60000 },
  );
  await page.waitForSelector('.note-composer', { timeout: 30000 });
  check('notes page renders the composer', (await page.locator('.note-composer').count()) === 1);

  const markdown = [
    '# 读书笔记',
    '',
    '**粗体** 与 *斜体* 与 `行内代码`。',
    '',
    '- 列表一',
    '- 列表二',
    '',
    '> 引用一句',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    '| 甲 | 1 |',
    '',
    '行内公式 $E=mc^2$ 结束。',
  ].join('\n');
  await page.fill('.note-composer__title', '读书笔记');
  await page.fill('.note-composer__body', markdown);
  await page.fill('.note-composer__tag', '读书');
  await page.press('.note-composer__tag', 'Enter');
  await page.click('.note-composer__right .primary');
  await page.waitForTimeout(900);
  check('saving a note adds a card', (await page.locator('.note').count()) === 1);

  const expand = page.locator('.note').first().getByRole('button', { name: /阅读全文/ });
  if ((await expand.count()) > 0) {
    await expand.click();
    await page.waitForTimeout(300);
  }
  const card = page.locator('.note').first();
  check('markdown heading renders', (await card.locator('h1').count()) === 1);
  check('markdown bold renders', (await card.locator('strong').count()) >= 2);
  check('markdown list renders', (await card.locator('li').count()) >= 2);
  check('markdown table renders', (await card.locator('table').count()) === 1);
  check('math renders through KaTeX', (await card.locator('.katex').count()) >= 1);
  check('tag is shown on the card', (await card.locator('.tag').first().innerText()).includes('读书'));

  console.log('2. 图片');
  await card.getByRole('button', { name: '编辑' }).click();
  await page.waitForSelector('.note__editor');
  await page.setInputFiles('.note__editor input[type="file"]', {
    name: 'pic.png', mimeType: 'image/png', buffer: PNG,
  });
  await page.waitForTimeout(2500);
  await page.setInputFiles('.note__editor input[type="file"]', {
    name: 'pic2.png', mimeType: 'image/png', buffer: PNG,
  });
  await page.waitForTimeout(2200);
  const editorBody = await page.locator('.note__edit-body').inputValue();
  check('image marker is inserted into the body', editorBody.includes('note-image:'), editorBody.slice(0, 60));
  await page.locator('.note__editor').getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(1500);
  const expand2 = page.locator('.note').first().getByRole('button', { name: /阅读全文/ });
  if ((await expand2.count()) > 0) {
    await expand2.click();
    await page.waitForTimeout(400);
  }
  const image = page.locator('.note').first().locator('img[data-note-image]');
  const imageSrc = await image.first().getAttribute('src').catch(() => null);
  check('stored images render from blob URLs', (await image.count()) === 2 && (imageSrc ?? '').startsWith('blob:'));
  check('no raw marker leaks into the rendered text', !(await page.locator('.note').first().innerText()).includes('note-image:'));

  // Lightbox: click to enlarge, arrows navigate, Esc closes.
  await page.locator('.note').first().locator('img[data-note-image]').first().click();
  await page.waitForSelector('.lightbox', { timeout: 10000 });
  await page.waitForTimeout(600);
  check('clicking an image opens the lightbox', (await page.locator('.lightbox').count()) === 1);
  check('lightbox shows an image position counter', (await page.locator('.lightbox__count').innerText()).includes('1 / 2'));
  check('lightbox image loads from a blob URL', ((await page.locator('.lightbox__img').getAttribute('src')) ?? '').startsWith('blob:'));
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  check('arrow keys move to the next image', (await page.locator('.lightbox__count').innerText()).includes('2 / 2'));
  await page.locator('.lightbox__img').click();
  await page.waitForTimeout(400);
  check('clicking the image zooms in', (await page.locator('.lightbox__zoom').innerText()).startsWith('250'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Escape closes the lightbox', (await page.locator('.lightbox').count()) === 0);

  console.log('3. 置顶 / 搜索 / 筛选');
  await page.locator('.note').first().getByRole('button', { name: '置顶' }).click();
  await page.waitForTimeout(700);
  check('pinning marks the card', (await page.locator('.note__pin').count()) === 1);

  await page.fill('input[aria-label="搜索笔记"]', '读书');
  await page.waitForTimeout(500);
  check('search keeps the matching note', (await page.locator('.note').count()) === 1);
  await page.fill('input[aria-label="搜索笔记"]', 'zzz-没有这个');
  await page.waitForTimeout(500);
  check('search with no match shows the empty state', (await page.locator('.card__empty').count()) >= 1);
  await page.fill('input[aria-label="搜索笔记"]', '');
  await page.waitForTimeout(400);

  await page.selectOption('.notes-toolbar__tag', '读书');
  await page.waitForTimeout(500);
  check('tag filter keeps the tagged note', (await page.locator('.note').count()) === 1);
  await page.selectOption('.notes-toolbar__tag', '');
  await page.waitForTimeout(400);

  await page.getByRole('button', { name: /📅/ }).click();
  await page.waitForSelector('.cal-grid');
  check('calendar renders a month grid', (await page.locator('.cal-grid__day').count()) >= 28);
  check('calendar marks the day that has notes', (await page.locator('.cal-grid__day.has-notes').count()) === 1);
  await page.locator('.cal-grid__day.has-notes').first().click();
  await page.getByRole('button', { name: '应用' }).click();
  await page.waitForTimeout(500);
  check('date filter keeps the note', (await page.locator('.note').count()) === 1);
  await page.getByRole('button', { name: /📅/ }).click();
  await page.locator('.cal-filter__panel').getByRole('button', { name: '清除', exact: true }).click();
  await page.getByRole('button', { name: '应用' }).click();
  await page.waitForTimeout(500);

  console.log('4. 导入 / 导出');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.getByRole('button', { name: '导出 Markdown' }).click(),
  ]);
  check('export downloads a markdown file', download !== null && (download.suggestedFilename() ?? '').endsWith('.md'),
    download === null ? 'no download' : download.suggestedFilename());

  const importBlock = '---\ntitle: "导入测试"\ntags: ["导入"]\npinned: false\nperson: null\n---\n\n来自导入的正文';
  await page.getByRole('button', { name: '导入' }).click();
  await page.waitForSelector('.modal');
  await page.fill('.modal textarea', importBlock);
  await page.getByRole('button', { name: '开始导入' }).click();
  await page.waitForTimeout(1200);
  check('import reports a new note', (await page.locator('.modal .banner').innerText()).includes('已导入 1'));
  await page.fill('.modal textarea', importBlock);
  await page.getByRole('button', { name: '开始导入' }).click();
  await page.waitForTimeout(1000);
  check('importing the same block again is skipped', (await page.locator('.modal .banner').innerText()).includes('没有新增'));
  await page.locator('.modal .form__actions button', { hasText: '关闭' }).click();
  await page.waitForTimeout(700);
  check('imported note appears in the list', (await page.locator('.note').count()) === 2);

  console.log('5. 关联亲友');
  const linkedTitle = '给父亲的家事记录';
  await page.fill('.note-composer__title', linkedTitle);
  await page.fill('.note-composer__body', '关于父亲的一些事。');
  await page.selectOption('.note-composer__person', { label: '张父' }).catch(() => undefined);
  const personOptions = await page.locator('.note-composer__person option').allTextContents();
  const hasPerson = personOptions.some((label) => label.includes('张父'));
  if (!hasPerson) {
    // The linked person is created below; create it first then come back.
    await page.goto(FAMILY, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ft, .banner', { timeout: 30000 });
    await page.getByRole('button', { name: '＋ 添加成员' }).click();
    await page.waitForSelector('.modal');
    await page.fill('.modal input[name="name"]', '张父');
    await page.selectOption('.modal select[name="gender"]', 'male');
    await page.click('.modal button[type="submit"]');
    await page.waitForSelector('.modal', { state: 'detached', timeout: 30000 });
    await page.goto(NOTES, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.note-composer', { timeout: 30000 });
    await page.waitForTimeout(900);
    await page.fill('.note-composer__title', linkedTitle);
    await page.fill('.note-composer__body', '关于父亲的一些事。');
    await page.selectOption('.note-composer__person', { label: '张父' });
  }
  await page.click('.note-composer__right .primary');
  await page.waitForTimeout(900);
  const linkTag = page.locator('.note').filter({ hasText: linkedTitle }).locator('.tag--link');
  const linkCount = await linkTag.count();
  const linkText = linkCount > 0 ? await linkTag.first().innerText() : '';
  check('note shows its linked person', linkCount >= 1 && linkText.includes('张父'), 'count=' + linkCount + ' text=' + linkText);

  await page.goto(FAMILY, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ft, .banner', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.locator('.ft-node').filter({ hasText: '张父' }).first().click();
  await page.waitForSelector('.ft-detail');
  await page.waitForTimeout(800);
  check('family detail lists the related note', (await page.locator('.ft-detail').innerText()).includes(linkedTitle));

  console.log('6. 持久化与删除');
  await page.goto(NOTES, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.note', { timeout: 30000 });
  await page.waitForTimeout(900);
  const beforeReload = await page.locator('.note').count();
  check('notes survive a reload', beforeReload === 3, String(beforeReload));

  await page.locator('.note').filter({ hasText: '导入测试' }).getByRole('button', { name: '删除' }).click();
  await page.waitForSelector('.modal');
  await page.getByRole('button', { name: '确认删除' }).click();
  await page.waitForTimeout(900);
  const afterDelete = await page.locator('.note').count();
  check('deleting removes the card', afterDelete === beforeReload - 1, 'after=' + afterDelete + ' before=' + beforeReload);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.note', { timeout: 30000 });
  await page.waitForTimeout(900);
  check('deleted note stays deleted after reload', (await page.locator('.note').count()) === 2);

  await page.screenshot({ path: join(out, 'notes-page.png'), fullPage: true });

  const ignorable = /Download the React DevTools/i;
  const realErrors = errors.filter((error) => !ignorable.test(error));
  check('no console/page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
