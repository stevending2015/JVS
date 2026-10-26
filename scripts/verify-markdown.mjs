/**
 * Markdown renderer unit checks.
 *
 * Runs the real renderer (compiled to CJS by the verify script) in Node, so the
 * HTML it produces is checked directly rather than through the UI.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderMarkdown, markdownPreview } = require('./.md-for-test.cjs');

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

const nothing = (html) => html.length > 0;

console.log('1. 块级语法');

check('headings render', (() => {
  const html = renderMarkdown('# 一级\n\n## 二级\n\n### 三级');
  return html.includes('<h1>一级</h1>') && html.includes('<h2>二级</h2>') && html.includes('<h3>三级</h3>');
})());

check('paragraph line breaks become <br>', renderMarkdown('第一行\n第二行').includes('<br />'));

check('unordered list', (() => {
  const html = renderMarkdown('- 甲\n- 乙');
  return html.includes('<ul>') && html.split('<li>').length === 3;
})());

check('ordered list', (() => {
  const html = renderMarkdown('1. 甲\n2. 乙');
  return html.includes('<ol>') && html.split('<li>').length === 3;
})());

check('blockquote', renderMarkdown('> 引用').includes('<blockquote>'));

check('horizontal rule', renderMarkdown('---').includes('<hr />'));

check('fenced code keeps its contents verbatim', (() => {
  const html = renderMarkdown('```ts\nconst a = 1 ** 2;\n```');
  return html.includes('<pre class="md-code">') && html.includes('const a = 1 ** 2;') && html.includes('md-code__lang">ts');
})());

check('fenced code is escaped, never executed as markup', (() => {
  const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
  return html.includes('&lt;script&gt;') && !html.includes('<script>');
})());

check('table renders header and body', (() => {
  const html = renderMarkdown('| 项 | 值 |\n| --- | --- |\n| 甲 | 1 |');
  return html.includes('<table class="md-table">') && html.includes('<th>项</th>') && html.includes('<td>甲</td>');
})());

console.log('2. 行内语法');

check('bold', renderMarkdown('**粗**').includes('<strong>粗</strong>'));
check('italic', renderMarkdown('*斜*').includes('<em>斜</em>'));
check('strikethrough', renderMarkdown('~~删~~').includes('<del>删</del>'));
check('inline code', renderMarkdown('`x`').includes('<code>x</code>'));
check('link', renderMarkdown('[示例](https://example.com)').includes('<a href="https://example.com"'));
check('javascript: link is dropped', !renderMarkdown('[坏](javascript:alert(1))').includes('javascript:'));
check('raw html is escaped', (() => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  return html.includes('&lt;img') && !html.includes('<img src=x');
})());

console.log('3. 数学公式');

check('inline math renders KaTeX', renderMarkdown('公式 $E=mc^2$ 结束').includes('class="katex"'));
check('display math renders KaTeX display mode', renderMarkdown('$$a^2+b^2=c^2$$').includes('katex-display'));
check('formula underscores are not parsed as emphasis', (() => {
  const html = renderMarkdown('$a_1 + a_2$');
  return html.includes('class="katex"') && !html.includes('<em>');
})());
check('broken formula does not throw', (() => {
  try {
    renderMarkdown('$\\frac{1}{$');
    return true;
  } catch {
    return false;
  }
})());

console.log('4. 笔记图片');

check('note-image scheme becomes a placeholder img', (() => {
  const html = renderMarkdown('![图](note-image:abc-123)');
  return html.includes('data-note-image="abc-123"') && !html.includes('note-image:');
})());

console.log('5. 预览与安全');

check('preview strips markdown', (() => {
  const preview = markdownPreview('# 标题\n\n**正文** 内容');
  return !preview.includes('#') && !preview.includes('**') && preview.includes('正文');
})());

check('empty input renders nothing', renderMarkdown('') === '');

check('renderer always returns a string', nothing(renderMarkdown('文字')));


// ── 层级：嵌套列表 ──
console.log('N. 列表层级');
{
  const two = renderMarkdown('- 一\n  - 一点一\n  - 一点二\n- 二');
  check('生成嵌套 ul', /<li>一<ul>/.test(two), two.slice(0, 120));
  check('子项挂在父项里', /一点一<\/li><li>一点二<\/li><\/ul><\/li>/.test(two), two.slice(0, 160));

  const three = renderMarkdown('- 一\n  - 一点一\n    - 一点一点一\n- 二');
  check('三级嵌套', (three.match(/<ul>/g) ?? []).length === 3, String((three.match(/<ul>/g) ?? []).length));

  const mixed = renderMarkdown('- 章节\n  1. 第一节\n  2. 第二节\n- 附录');
  check('有序列表嵌在无序里', /<ul><li>章节<ol>/.test(mixed), mixed.slice(0, 140));

  const ol = renderMarkdown('1. 甲\n   1. 乙\n2. 丙');
  check('有序嵌套有序', /<ol><li>甲<ol>/.test(ol), ol.slice(0, 120));

  const loose = renderMarkdown('- 甲\n\n- 乙\n\n- 丙');
  check('空行不断列表', (loose.match(/<li>/g) ?? []).length === 3, loose.slice(0, 120));

  const wrapped = renderMarkdown('- 这是一段很长的文字\n  它换行了\n- 下一项');
  check('续行并进上一项', /<li>这是一段很长的文字 它换行了<\/li>/.test(wrapped), wrapped.slice(0, 140));
}

// ── 任务列表 ──
console.log('N+1. 任务列表');
{
  const tasks = renderMarkdown('- [x] 已完成\n- [ ] 未完成');
  check('完成的项带 is-done', /<li class="md-li--task is-done">/.test(tasks), tasks.slice(0, 140));
  check('未完成的项无 is-done', /<li class="md-li--task"><span class="md-task"/.test(tasks), tasks.slice(0, 200));
  check('文字包在 label 里（才能加删除线）', /<span class="md-task__label">已完成<\/span>/.test(tasks), tasks.slice(0, 200));

  const nestedTask = renderMarkdown('- [ ] 父任务\n  - [x] 子任务');
  check('任务列表也能嵌套', /父任务[\s\S]*<ul>[\s\S]*子任务/.test(nestedTask), nestedTask.slice(0, 220));
}

// ── 标题层级 ──
console.log('N+2. 标题层级');
{
  const heads = renderMarkdown('# 一\n## 二\n### 三\n#### 四');
  check('h1…h4 都生成', ['<h1>', '<h2>', '<h3>', '<h4>'].every((tag) => heads.includes(tag)), heads.slice(0, 120));
  check('标题层级不串味', heads.indexOf('<h1>') < heads.indexOf('<h2>') && heads.indexOf('<h2>') < heads.indexOf('<h3>'));
}


console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
