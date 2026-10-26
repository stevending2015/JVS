/**
 * A small Markdown renderer, written for this app rather than pulled in.
 *
 * Scope is deliberately the subset a personal note actually uses: headings, lists,
 * quotes, fenced code, tables, rules, emphasis, inline code, links, images and
 * `$…$` / `$$…$$` math via KaTeX. Raw HTML in the source is always escaped — a note
 * is user text, never a template.
 *
 * The pipeline is: protect code/math → escape everything → parse blocks → inline
 * rules → restore protected HTML. Protecting first is what keeps `_` inside a
 * formula or `**` inside code from being mangled by the emphasis rules.
 */

import katex from 'katex';
import { NOTE_IMAGE_SCHEME } from './types.js';

const PLACEHOLDER = '\u0000';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Only http(s), mailto, root-relative and hash links survive. */
function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href === '') return null;
  if (/^(https?:|mailto:|#|\/)/i.test(href)) return href;
  return null;
}

interface Protected {
  text: string;
  slots: string[];
}

/**
 * Pull out fenced code and math before markdown parsing.
 *
 * @param source - raw markdown.
 * @returns Text with placeholders plus the rendered HTML for each slot.
 */
function protectSegments(source: string): Protected {
  const slots: string[] = [];
  const stash = (html: string): string => {
    slots.push(html);
    return `${PLACEHOLDER}${slots.length - 1}${PLACEHOLDER}`;
  };

  let rest = source.replace(/\r\n?/g, '\n');

  // Fenced code blocks first: their contents must never be parsed as markdown.
  rest = rest.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, info: string, code: string) => {
    const language = info.trim();
    const label = language === ''
      ? ''
      : `<span class="md-code__lang">${escapeHtml(language)}</span>`;
    return stash(
      `<pre class="md-code">${label}<code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`,
    );
  });

  // Display math ($$…$$) may span lines.
  rest = rest.replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex: string) => {
    try {
      return stash(katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }));
    } catch {
      return stash(`<code class="md-math-failed">${escapeHtml(tex)}</code>`);
    }
  });

  // Inline math ($…$) on a single line.
  rest = rest.replace(/\$([^$\n]+?)\$/g, (_match, tex: string) => {
    try {
      return stash(katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false }));
    } catch {
      return stash(`<code class="md-math-failed">${escapeHtml(tex)}</code>`);
    }
  });

  return { text: rest, slots };
}

/** Inline rules, applied to text that already has code/math stashed away. */
function renderInline(text: string): string {
  let out = escapeHtml(text);

  // Images before links: the image syntax is a superset of the link syntax.
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_match, alt: string, url: string) => {
      if (url.startsWith(NOTE_IMAGE_SCHEME)) {
        const id = url.slice(NOTE_IMAGE_SCHEME.length);
        return `<img data-note-image="${escapeHtml(id)}" alt="${alt}" class="md-image" loading="lazy" />`;
      }
      const href = safeHref(url);
      if (href === null) return alt;
      return `<img src="${escapeHtml(href)}" alt="${alt}" class="md-image" loading="lazy" />`;
    },
  );

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    const href = safeHref(url);
    if (href === null) return label;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // Bare URLs.
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_match, lead: string, url: string) => {
    return `${lead}<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  return out;
}

/** Render a table block (rows already trimmed). */
function renderTable(rows: string[]): string {
  const header = rows[0] ?? '';
  const cells = (line: string): string[] =>
    line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  const headCells = cells(header);
  const bodyRows = rows.slice(2);
  const head = headCells.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
  const body = bodyRows
    .map((row) => `<tr>${cells(row).map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
const FENCE_OPEN = /^```([^\n`]*)$/;
const UL_ITEM = /^(\s*)[-*+]\s+(.*)$/;
const OL_ITEM = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** 一层列表项，children 是缩进更深的子列表。 */
interface ListItem {
  ordered: boolean;
  text: string;
  children: ListItem[];
}

/** 一行开头有多少个空格；tab 按两个空格算。 */
function leadingSpaces(line: string): number {
  const match = /^[ \t]*/.exec(line);
  if (match === null) return 0;
  let width = 0;
  for (const char of match[0]) width += char === '\t' ? 2 : 1;
  return width;
}

/** 任务列表的复选框标记。 */
const TASK_MARK = /^\[([ xX])\]\s+(.*)$/;

/**
 * 渲染一个任务项：复选框 + 文字。
 *
 * 文字要单独包一层 span —— 删除线只能作用在元素上，裸文本节点选不中，
 * 直接在 li 上加 text-decoration 又会顺着子元素传播、没法只取消复选框那部分。
 *
 * @param text - 去掉标记后的项文本。
 * @returns HTML，或 null（不是任务项）。
 */
function renderTask(text: string): string | null {
  const match = TASK_MARK.exec(text);
  if (match === null) return null;
  const done = (match[1] ?? ' ').toLowerCase() === 'x';
  const label = match[2] ?? '';
  return `<span class="md-task${done ? ' is-done' : ''}" aria-hidden="true">${done ? '✓' : ''}</span><span class="md-task__label">${renderInline(label)}</span>`;
}

/**
 * 把一组同级列表项渲染成一个或多个列表。
 *
 * 顶层可能混着有序和无序（少见但合法），所以按类型分组，而不是假设整块同一类型。
 *
 * @param items - 同级列表项。
 * @returns HTML。
 */
function renderListItems(items: ListItem[]): string {
  const out: string[] = [];
  let index = 0;
  while (index < items.length) {
    const ordered = items[index]?.ordered ?? false;
    const group: ListItem[] = [];
    while (index < items.length && (items[index]?.ordered ?? false) === ordered) {
      const item = items[index];
      if (item !== undefined) group.push(item);
      index += 1;
    }
    const body = group
      .map((item) => {
        const task = renderTask(item.text);
        // 任务项：复选框 + 标签（标签会按完成状态加删除线）；普通项：常规渲染。
        const inner = task !== null
          ? `<li class="md-li--task${TASK_MARK.exec(item.text)?.[1]?.toLowerCase() === 'x' ? ' is-done' : ''}">${task}</li>`
          : `<li>${renderInline(item.text)}</li>`;
        if (item.children.length === 0) return inner;
        // 子列表插到 </li> 前面，形成真正的嵌套。
        return `${inner.replace(/<\/li>$/, '')}${renderListItems(item.children)}</li>`;
      })
      .join('');
    out.push(`<${ordered ? 'ol' : 'ul'}>${body}</${ordered ? 'ol' : 'ul'}>`);
  }
  return out.join('');
}

/**
 * 解析一整块列表（可能多级嵌套）。
 *
 * 缩进决定层级：比当前项更深的就是它的子列表。空行后面如果还是列表项，
 * 列表继续（Markdown 的松散列表）；否则列表结束。
 *
 * @param lines - 全部行。
 * @param start - 起始下标。
 * @returns 渲染好的 HTML 与下一个待处理行号；不是列表时返回 null。
 */
function parseList(lines: string[], start: number): { html: string; next: number } | null {
  const topLevel: ListItem[] = [];
  /** 记录每层当前的项，用来挂子列表。 */
  const stack: Array<{ indent: number; item: ListItem }> = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // 空行：向后看，如果还会继续列表就跳过空行，否则结束。
    if (line.trim() === '') {
      let look = index + 1;
      while (look < lines.length && (lines[look] ?? '').trim() === '') look += 1;
      const nextLine = lines[look] ?? '';
      if (UL_ITEM.exec(nextLine) === null && OL_ITEM.exec(nextLine) === null) break;
      const baseIndent = stack[0]?.indent ?? leadingSpaces(nextLine);
      if (leadingSpaces(nextLine) < baseIndent) break;
      index = look;
      continue;
    }

    const ul = UL_ITEM.exec(line);
    const ol = OL_ITEM.exec(line);
    const match = ul ?? ol;

    // 不是列表项：可能是上一个条目的续行（缩进更深）。
    if (match === null) {
      const top = stack[stack.length - 1];
      if (top !== undefined && leadingSpaces(line) > top.indent) {
        top.item.text = `${top.item.text} ${line.trim()}`;
        index += 1;
        continue;
      }
      break;
    }

    const indent = match[1]?.length ?? 0;
    const isOrdered = ol !== null && ul === null;
    const text = isOrdered ? (ol?.[3] ?? '') : (ul?.[2] ?? '');

    // 回到同级或更浅：把更深的层弹出。
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? -1) >= indent) stack.pop();

    const item: ListItem = { ordered: isOrdered, text, children: [] };
    const parent = stack[stack.length - 1];
    if (parent === undefined) topLevel.push(item);
    else parent.item.children.push(item);
    stack.push({ indent, item });
    index += 1;
  }

  if (topLevel.length === 0) return null;
  return { html: renderListItems(topLevel), next: index };
}

/**
 * Render markdown to an HTML string.
 * @param source - markdown text.
 * @returns Safe HTML (all user text escaped).
 */
export function renderMarkdown(source: string): string {
  const { text, slots } = protectSegments(source ?? '');
  const lines = text.split('\n');
  const html: string[] = [];
  let index = 0;

  const flushParagraph = (buffer: string[]): void => {
    if (buffer.length === 0) return;
    html.push(`<p>${buffer.map((line) => renderInline(line)).join('<br />')}</p>`);
    buffer.length = 0;
  };

  let paragraph: string[] = [];

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // Blank line ends the current paragraph.
    if (line.trim() === '') {
      flushParagraph(paragraph);
      index += 1;
      continue;
    }

    // An unclosed fence (no trailing ```) still renders as code.
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      flushParagraph(paragraph);
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      html.push(`<pre class="md-code"><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flushParagraph(paragraph);
      const level = heading[1]?.length ?? 1;
      html.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph(paragraph);
      html.push('<hr />');
      index += 1;
      continue;
    }

    if (TABLE_ROW.test(line) && TABLE_DIVIDER.test(lines[index + 1] ?? '')) {
      flushParagraph(paragraph);
      const rows: string[] = [];
      while (index < lines.length && TABLE_ROW.test(lines[index] ?? '')) {
        rows.push(lines[index] ?? '');
        index += 1;
      }
      html.push(renderTable(rows));
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph(paragraph);
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? '')) {
        quoted.push(QUOTE.exec(lines[index] ?? '')?.[1] ?? '');
        index += 1;
      }
      html.push(`<blockquote>${quoted.map((row) => renderInline(row)).join('<br />')}</blockquote>`);
      continue;
    }

    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      flushParagraph(paragraph);
      const block = parseList(lines, index);
      if (block !== null) {
        html.push(block.html);
        index = block.next;
      } else {
        // 理论上不会发生（上面刚判断是列表项），保险起见当作正文。
        paragraph.push(line);
        index += 1;
      }
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph(paragraph);

  // Restore protected code/math HTML. Placeholders survived escaping untouched.
  return html
    .join('\n')
    .replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'), (_match, slot: string) => {
      return slots[Number(slot)] ?? '';
    });
}

/**
 * Plain text preview of a note body, for list summaries and search.
 * @param source - markdown.
 * @param limit - maximum characters.
 */
export function markdownPreview(source: string, limit = 140): string {
  const plain = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]+?\$/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~]/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return plain.length <= limit ? plain : `${plain.slice(0, limit)}…`;
}
