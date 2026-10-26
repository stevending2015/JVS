/**
 * 验证笔记 Markdown 层级渲染 + PDF 导出。
 *
 * 检查：
 *   - 嵌套列表真的生成了嵌套的 <ul>（不是平的）
 *   - 标题层级有不同字号
 *   - 「导出 PDF」能打开打印预览
 *   - 打印预览是白纸黑字
 *   - 真的能生成 PDF 文件（用 Chromium 的 page.pdf）
 */
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:4173';
const out = join(process.cwd(), '.verify');
mkdirSync(out, { recursive: true });

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

const NOTE = [
  '# 年度总结',
  '',
  '这是开头段落，用来验证正文排版。',
  '',
  '## 工作',
  '',
  '- 完成了三个项目',
  '  - 项目 A：重构了笔记模块',
  '    - 自研 Markdown 渲染器',
  '    - 图片压缩进数据库',
  '  - 项目 B：家族树',
  '- 学习了新技能',
  '',
  '### 学习清单',
  '',
  '1. 第一项',
  '   - 子要点甲',
  '   - 子要点乙',
  '2. 第二项',
  '',
  '- [x] 已完成的任务',
  '- [ ] 还没做的任务',
  '  - [ ] 拆出来的子任务',
  '',
  '> 引用一段话，',
  '> 分成两行。',
  '',
  '| 项目 | 状态 |',
  '| --- | --- |',
  '| 笔记 | 完成 |',
  '| 天气 | 完成 |',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  '公式：$E = mc^2$',
].join('\n');

const profile = mkdtempSync(join(tmpdir(), 'jvs-print-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true, args: ['--no-sandbox'], viewport: { width: 1280, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

try {
  console.log('1. 创建测试笔记');
  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('已就绪'), undefined, { timeout: 60000 });
  await page.waitForSelector('.panel', { timeout: 30000 });
  await page.waitForTimeout(900);

  await page.locator('textarea').first().fill(NOTE);
  await page.locator('button:has-text("保存")').first().click();
  await page.waitForSelector('.note', { timeout: 30000 });
  await page.waitForTimeout(1200);
  // 展开全文
  const more = page.locator('.note__more');
  if (await more.count() > 0) { await more.first().click(); await page.waitForTimeout(600); }
  check('笔记已创建并渲染', (await page.locator('.md-body').count()) > 0);

  console.log('2. 层级：嵌套列表');
  const nesting = await page.evaluate(() => {
    const body = document.querySelector('.note .md-body');
    if (!body) return null;
    const ul = body.querySelector('ul');
    const liWithNested = body.querySelectorAll('li > ul, li > ol').length;
    const olNestedInUl = body.querySelectorAll('ul ol').length;
    return {
      hasUl: ul !== null,
      nestedLists: liWithNested,
      mixedNesting: olNestedInUl,
      depth3: body.querySelectorAll('ul ul ul').length,
      tasks: body.querySelectorAll('.md-task').length,
      doneTasks: body.querySelectorAll('.md-task.is-done').length,
    };
  });
  console.log('  ', JSON.stringify(nesting));
  check('生成 <ul>', nesting.hasUl);
  check('存在嵌套列表（li > ul/ol）', nesting.nestedLists >= 2, `nested=${nesting.nestedLists}`);
  check('三级嵌套存在', nesting.depth3 >= 1, `depth3=${nesting.depth3}`);
  check('有序列表嵌在无序里', nesting.mixedNesting >= 1, `mixed=${nesting.mixedNesting}`);
  check('任务列表渲染出复选框', nesting.tasks === 3, `tasks=${nesting.tasks}`);
  check('已完成任务有勾选状态', nesting.doneTasks === 1, `done=${nesting.doneTasks}`);

  console.log('3. 层级：标题字号递增');
  const sizes = await page.evaluate(() => {
    const body = document.querySelector('.note .md-body');
    if (!body) return null;
    const size = (selector) => {
      const el = body.querySelector(selector);
      return el === null ? 0 : parseFloat(getComputedStyle(el).fontSize);
    };
    return { h1: size('h1'), h2: size('h2'), h3: size('h3'), p: size('p') };
  });
  console.log('  ', JSON.stringify(sizes));
  check('h1 明显大于正文', sizes.h1 > sizes.p + 4, `h1=${sizes.h1} p=${sizes.p}`);
  check('h2 > h3 > 正文', sizes.h2 > sizes.h3 && sizes.h3 >= sizes.p, JSON.stringify(sizes));

  console.log('4. 导出 PDF');
  await page.locator('.note').first().getByRole('button', { name: '导出 PDF' }).click();
  await page.waitForSelector('.print-overlay', { timeout: 20000 });
  await page.waitForTimeout(800);
  check('打开打印预览', (await page.locator('.print-sheet').count()) === 1);

  const paper = await page.evaluate(() => {
    const sheet = document.querySelector('.print-sheet');
    if (!sheet) return null;
    const style = getComputedStyle(sheet);
    return {
      background: style.backgroundColor,
      color: style.color,
      title: document.querySelector('.print-sheet__title')?.textContent ?? '',
      meta: document.querySelector('.print-sheet__meta')?.textContent ?? '',
      bodyLen: document.querySelector('.print-sheet__body')?.innerHTML.length ?? 0,
      hasTable: document.querySelector('.print-sheet__body table') !== null,
      hasCode: document.querySelector('.print-sheet__body pre') !== null,
    };
  });
  console.log('  ', JSON.stringify({ ...paper, bodyLen: paper.bodyLen }));
  check('预览是白底', paper.background.includes('255, 255, 255'), paper.background);
  check('预览是深色字', paper.color !== 'rgb(232, 238, 248)', paper.color);
  check('显示笔记标题', paper.title === '年度总结', paper.title);
  check('显示日期与标签行', paper.meta.length > 0, paper.meta);
  check('正文渲染出表格', paper.hasTable);
  check('正文渲染出代码块', paper.hasCode);

  await page.screenshot({ path: join(out, 'notes-print-preview.png'), fullPage: false });

  console.log('5. 真的能生成 PDF 文件');
  // 用 Chromium 的 PDF 能力验证打印样式下产出的确实是 PDF
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(500);
  const pdfPath = join(out, 'note-export.pdf');
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
  await page.emulateMedia({ media: 'screen' });

  const exists = existsSync(pdfPath);
  const size = exists ? statSync(pdfPath).size : 0;
  console.log(`  PDF: ${pdfPath} (${size} 字节)`);
  check('PDF 文件已生成', exists && size > 5000, `${size} 字节`);

  // PDF 头必须以 %PDF- 开头
  const head = exists ? (await import('node:fs')).readFileSync(pdfPath).subarray(0, 5).toString() : '';
  check('是合法 PDF（%PDF- 头）', head === '%PDF-', head);

  // 打印模式下应用其余部分应被隐藏
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(400);
  const hidden = await page.evaluate(() => {
    const app = document.querySelector('.app__bar');
    if (app === null) return 'no-bar';
    return getComputedStyle(app).visibility;
  });
  await page.emulateMedia({ media: 'screen' });
  check('打印时应用栏被隐藏', hidden === 'hidden', hidden);

  await page.screenshot({ path: join(out, 'notes-markdown-hierarchy.png'), fullPage: false });
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
