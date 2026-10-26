/**
 * 验证笔记「导出 PDF」的**分页预览**。
 *
 * 这个功能原来最大的问题是：屏幕预览只有一条无限长的白纸，用户根本不知道
 * 打印出来会在哪里断页；而 PDF 其实是好几页。所以这里的核心断言是
 * 「预览的页数 == PDF 的页数」—— 只要这两者一致，用户看到的就是真的。
 *
 * 另外覆盖：
 *   - 每页确实是 A4/A5/B5/Letter 的尺寸（不是随便一个盒子）
 *   - 翻页按钮能翻、边界会禁用、计数会跟着变
 *   - 换纸张会重新分页，页数与尺寸都跟着变
 *   - 文字不丢：第一节和最后一节都在
 */
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://localhost:4173';
const out = join(process.cwd(), '.verify');
mkdirSync(out, { recursive: true });

/** 1mm 在 CSS px（96dpi）下是多少。 */
const MM = 96 / 25.4;

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

/** 数 PDF 里有几页。 */
function pdfPageCount(path) {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path).toString('latin1');
  return (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/** 造一篇足够长的笔记，保证能分出好几页。 */
const SECTIONS = 12;
const LONG_NOTE = [
  '# 长笔记分页测试',
  '',
  ...Array.from({ length: SECTIONS }, (_, i) => [
    `## 第 ${i + 1} 节 小标题`,
    '',
    `这是第 ${i + 1} 节的正文。` + '内容占位，用来把这一节撑得足够长以便分页。'.repeat(12),
    '',
    `- 列表项 A${i + 1}`,
    `- 列表项 B${i + 1}`,
    '',
    '```js',
    `const value${i + 1} = ${i + 1};`,
    '```',
    '',
  ].join('\n')),
].join('\n');

const profile = mkdtempSync(join(tmpdir(), 'jvs-print-paging-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: true,
  args: ['--no-sandbox'],
  viewport: { width: 1400, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

try {
  console.log('1. 造一篇长笔记');
  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('已就绪'), undefined, { timeout: 60000 });
  await page.waitForSelector('.panel', { timeout: 30000 });
  await page.waitForTimeout(900);

  await page.locator('textarea').first().fill(LONG_NOTE);
  await page.locator('button:has-text("保存")').first().click();
  await page.waitForSelector('.note', { timeout: 30000 });
  await page.waitForTimeout(1200);
  const more = page.locator('.note__more');
  if (await more.count() > 0) { await more.first().click(); await page.waitForTimeout(600); }

  console.log('2. 打开打印预览');
  await page.locator('.note').first().getByRole('button', { name: '导出 PDF' }).click();
  await page.waitForSelector('.print-overlay', { timeout: 20000 });
  await page.waitForSelector('.print-page', { timeout: 20000 });
  await page.waitForTimeout(1200);

  const a4 = await page.evaluate(() => {
    const pages = Array.from(document.querySelectorAll('.print-page'));
    const first = pages[0];
    const rect = first?.getBoundingClientRect();
    return {
      count: pages.length,
      widthPx: Math.round(rect?.width ?? 0),
      heightPx: Math.round(rect?.height ?? 0),
      counter: document.querySelector('.print-toolbar__count')?.textContent?.trim() ?? '',
      pageNos: Array.from(document.querySelectorAll('.print-page__no')).map((n) => n.textContent?.trim() ?? ''),
    };
  });
  console.log('  ', JSON.stringify({ ...a4, pageNos: a4.pageNos.slice(0, 3) }));

  check('预览渲染出多个独立页', a4.count >= 3, `count=${a4.count}`);
  check('每页高度是 A4（297mm）', Math.abs(a4.heightPx - 297 * MM) <= 3, `${a4.heightPx} vs ${Math.round(297 * MM)}`);
  check('每页宽度是 A4（210mm）', Math.abs(a4.widthPx - 210 * MM) <= 3, `${a4.widthPx} vs ${Math.round(210 * MM)}`);
  check('工具栏显示「第 1 / N 页」', a4.counter === `第 1 / ${a4.count} 页`, a4.counter);
  check('每页都印着页码', a4.pageNos.length === a4.count, `${a4.pageNos.length} vs ${a4.count}`);
  check('页码文案带「共 N 页」', a4.pageNos.every((t) => t.includes(`共 ${a4.count} 页`)), a4.pageNos[0] ?? '');

  console.log('3. 翻页按钮');
  const prevBtn = page.locator('.print-toolbar__nav button', { hasText: '上一页' });
  const nextBtn = page.locator('.print-toolbar__nav button', { hasText: '下一页' });
  check('有「上一页」按钮', (await prevBtn.count()) === 1);
  check('有「下一页」按钮', (await nextBtn.count()) === 1);
  check('第 1 页时「上一页」禁用', await prevBtn.isDisabled());
  check('第 1 页时「下一页」可用', !(await nextBtn.isDisabled()));

  await nextBtn.click();
  await page.waitForTimeout(800);
  check('点「下一页」到第 2 页', (await page.locator('.print-toolbar__count').innerText()).includes('第 2 /'), await page.locator('.print-toolbar__count').innerText());
  check('第 2 页时「上一页」可用', !(await prevBtn.isDisabled()));

  await prevBtn.click();
  await page.waitForTimeout(800);
  check('点「上一页」回到第 1 页', (await page.locator('.print-toolbar__count').innerText()).includes('第 1 /'), await page.locator('.print-toolbar__count').innerText());

  // 跳到最后一页，「下一页」应当禁用
  for (let i = 0; i < a4.count; i += 1) {
    if (await nextBtn.isDisabled()) break;
    await nextBtn.click();
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(400);
  check('最后一页时「下一页」禁用', await nextBtn.isDisabled());
  check('最后一页计数正确', (await page.locator('.print-toolbar__count').innerText()).includes(`第 ${a4.count} /`), await page.locator('.print-toolbar__count').innerText());

  await page.screenshot({ path: join(out, 'print-paging-a4.png'), fullPage: false });

  console.log('4. 预览页数必须与真实 PDF 页数一致');
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(700);
  const pdfA4 = join(out, 'print-paging-a4.pdf');
  await page.pdf({ path: pdfA4, printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  const pdfA4Pages = pdfPageCount(pdfA4);
  console.log(`  预览 ${a4.count} 页 → PDF ${pdfA4Pages} 页`);
  check('PDF 页数等于预览页数', pdfA4Pages === a4.count, `预览=${a4.count} PDF=${pdfA4Pages}`);

  console.log('5. 文字没有丢失');
  const texts = await page.evaluate(() => {
    const pages = Array.from(document.querySelectorAll('.print-page'));
    return {
      first: pages[0]?.innerText.includes('第 1 节') ?? false,
      last: pages[pages.length - 1]?.innerText.includes('由 JVS 笔记导出') ?? false,
      all: pages.map((p) => p.innerText).join('\n'),
    };
  });
  check('第一页有第 1 节', texts.first);
  check('最后一页有页脚', texts.last);
  check('12 节全部都在', Array.from({ length: 12 }, (_, i) => texts.all.includes(`第 ${i + 1} 节`)).every(Boolean));

  console.log('6. 换纸张会重新分页');
  await page.locator('.print-toolbar__paper select').selectOption('a5');
  await page.waitForTimeout(1500);

  const a5 = await page.evaluate(() => {
    const pages = Array.from(document.querySelectorAll('.print-page'));
    const rect = pages[0]?.getBoundingClientRect();
    return {
      count: pages.length,
      widthPx: Math.round(rect?.width ?? 0),
      heightPx: Math.round(rect?.height ?? 0),
      counter: document.querySelector('.print-toolbar__count')?.textContent?.trim() ?? '',
    };
  });
  console.log('  ', JSON.stringify(a5));
  check('A5 每页高度是 210mm', Math.abs(a5.heightPx - 210 * MM) <= 3, `${a5.heightPx} vs ${Math.round(210 * MM)}`);
  check('A5 每页宽度是 148mm', Math.abs(a5.widthPx - 148 * MM) <= 3, `${a5.widthPx} vs ${Math.round(148 * MM)}`);
  check('换成小纸后页数变多', a5.count > a4.count, `A5=${a5.count} A4=${a4.count}`);
  check('换纸后页码归零到第 1 页', a5.counter.includes('第 1 /'), a5.counter);

  await page.screenshot({ path: join(out, 'print-paging-a5.png'), fullPage: false });

  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(700);
  const pdfA5 = join(out, 'print-paging-a5.pdf');
  await page.pdf({ path: pdfA5, printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  const pdfA5Pages = pdfPageCount(pdfA5);
  console.log(`  预览 ${a5.count} 页 → PDF ${pdfA5Pages} 页`);
  check('A5 的 PDF 页数也等于预览页数', pdfA5Pages === a5.count, `预览=${a5.count} PDF=${pdfA5Pages}`);

  console.log('7. 纸张选择器有全部四档');
  const options = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.print-toolbar__paper option')).map((o) => o.textContent?.trim() ?? ''),
  );
  console.log('  ', JSON.stringify(options));
  check('有 A4 / A5 / B5 / Letter 四档', options.length === 4, options.join(', '));
  check('每档都标了尺寸', options.every((t) => /\d+\s*×\s*[\d.]+/.test(t)), options.join(', '));

  console.log('7.5 正文不能溢到纸的留白里（会压住页码 / 被裁掉）');
  // 首页要放页眉（标题 + 日期行），末页要放页脚；这两块都得从正文预算里扣掉。
  // 早先漏了这一步：A5 首页正文比可用高度多出 56px，直接压住了页码。
  for (const pid of ['a4', 'a5']) {
    // 每次都显式切换：上一节结束时停在 A5，不切回去就会把 A5 的尺寸当成 A4 断言。
    await page.locator('.print-toolbar__paper select').selectOption(pid);
    await page.waitForTimeout(1600);
    const overflow = await page.evaluate(() => {
      const rows = [];
      for (const el of Array.from(document.querySelectorAll('.print-page'))) {
        const body = el.querySelector('.print-sheet__body');
        if (body === null) continue;
        const pr = el.getBoundingClientRect();
        const padBottom = Number.parseFloat(getComputedStyle(el).paddingBottom) || 0;
        // 纸的下边缘 - 下留白 = 正文允许到达的最远处
        const contentBottom = pr.bottom - padBottom;
        const last = body.lastElementChild;
        const lastBottom = last !== null ? last.getBoundingClientRect().bottom : body.getBoundingClientRect().bottom;
        rows.push(Math.round(lastBottom - contentBottom));
      }
      return rows;
    });
    const worst = Math.max(...overflow, 0);
    console.log(`  ${pid.toUpperCase()} 各页溢出 = ${JSON.stringify(overflow)}`);
    // 允许 2px 的亚像素误差
    check(`${pid.toUpperCase()} 正文没有溢出留白`, worst <= 2, `最大溢出 ${worst}px`);
  }
  // 复位到 A4，后面的用例依赖它
  await page.locator('.print-toolbar__paper select').selectOption('a4');
  await page.waitForTimeout(1600);

  console.log('8. 短笔记只应该 1 页（别把空白页也算进去）');
  await page.locator('.print-toolbar__close').click();
  await page.waitForTimeout(500);
  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.note-composer__body', { timeout: 30000 });
  await page.waitForTimeout(600);
  await page.locator('.note-composer__body').fill('# 短笔记\n\n只有两行字。\n');
  await page.locator('.note-composer button:has-text("保存")').first().click();
  await page.waitForTimeout(1300);
  await page.locator('.note').first().getByRole('button', { name: '导出 PDF' }).click();
  await page.waitForSelector('.print-page', { timeout: 20000 });
  await page.waitForTimeout(900);
  const shortPages = await page.locator('.print-page').count();
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(500);
  const shortPdfPath = join(out, 'print-paging-short.pdf');
  await page.pdf({ path: shortPdfPath, printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  console.log(`  预览 ${shortPages} 页 → PDF ${pdfPageCount(shortPdfPath)} 页`);
  check('短笔记预览 1 页', shortPages === 1, `count=${shortPages}`);
  check('短笔记 PDF 也是 1 页', pdfPageCount(shortPdfPath) === 1, `${pdfPageCount(shortPdfPath)}`);
  check('短笔记正文确实在纸上', (await page.locator('.print-page').first().innerText()).includes('只有两行字'));

  console.log('9. 带图片的笔记：图片必须有真实高度');
  // 图片高度如果是 0，分页就会算错 —— 这正是最容易踩的坑。
  await page.locator('.print-toolbar__close').click();
  await page.waitForTimeout(500);
  await page.goto(`${BASE}/#/m/notes`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.note-composer__body', { timeout: 30000 });
  await page.waitForTimeout(600);
  await page.locator('.note-composer__body').fill('# 图片笔记\n\n下面是一张图：\n');
  // 用真实截图当图片素材：手写 base64 很容易损坏，浏览器会解码失败。
  const imgFile = join(out, 'print-paging-image.png');
  await page.screenshot({ path: imgFile, clip: { x: 0, y: 0, width: 640, height: 480 } });
  await page.locator('.note-composer input[type="file"]').first().setInputFiles(imgFile);
  await page.waitForTimeout(3000);
  await page.locator('.note-composer button:has-text("保存")').first().click();
  await page.waitForTimeout(1500);
  await page.locator('.note').first().getByRole('button', { name: '导出 PDF' }).click();
  await page.waitForSelector('.print-page', { timeout: 20000 });
  await page.waitForTimeout(1500);

  const imgInfo = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('.print-page img'));
    return {
      total: imgs.length,
      hydrated: imgs.filter((i) => (i.getAttribute('src') ?? '').startsWith('blob:')).length,
      heights: imgs.map((i) => Math.round(i.getBoundingClientRect().height)),
      pages: document.querySelectorAll('.print-page').length,
    };
  });
  console.log('  ', JSON.stringify(imgInfo));
  check('图片出现在分页预览里', imgInfo.total >= 1, JSON.stringify(imgInfo));
  check('图片已 hydrate 成 blob URL（不是破图）', imgInfo.total > 0 && imgInfo.hydrated === imgInfo.total, JSON.stringify(imgInfo));
  check('图片高度不是 0（分页才算得准）', imgInfo.total > 0 && imgInfo.heights.every((h) => h > 20), JSON.stringify(imgInfo.heights));

  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(500);
  const imgPdfPath = join(out, 'print-paging-image.pdf');
  await page.pdf({ path: imgPdfPath, printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  console.log(`  预览 ${imgInfo.pages} 页 → PDF ${pdfPageCount(imgPdfPath)} 页`);
  check('带图片时预览与 PDF 页数一致', pdfPageCount(imgPdfPath) === imgInfo.pages, `预览=${imgInfo.pages} PDF=${pdfPageCount(imgPdfPath)}`);
} finally {
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
