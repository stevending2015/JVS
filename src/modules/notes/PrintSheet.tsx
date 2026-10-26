/**
 * 单篇笔记的打印 / PDF 导出。
 *
 * 做法是「打印样式 + 浏览器原生另存为 PDF」，而不是引入 jsPDF 之类的库：
 *  - 零依赖，不增加包体积；
 *  - 产出的是**真 PDF**（文字可选中、可搜索、可复制），不是截图；
 *  - 中文字体交给浏览器排，比 canvas 渲染清楚；
 *  - 完全离线可用。
 *
 * 屏幕上是**真·分页预览**：先离屏量一遍真实高度，把正文按纸张高度切成 N 张
 * 独立的纸，一张一张摞着。用户可以翻页（按钮 / 方向键 / 直接滚），
 * 一眼能看出「第几页 / 共几页」以及分页点落在哪里。
 *
 * 为什么要真的切分，而不是让浏览器自己分页：屏幕上如果不切，就只有一个
 * 无穷长的白条，用户根本不知道打印出来会在哪里断页 —— 这正是这个功能
 * 原来最大的问题。
 *
 * 打印时每一页**已经切好了**，靠 `@page { margin: 0 }` + 每页
 * `break-after: page` 一页一张地吐出去，浏览器不会再自作主张重新分页，
 * 所以预览看到的分页点就是 PDF 里的分页点。
 *
 * 为什么整块要 portal 到 document.body：打印时必须让应用外壳**彻底离开版面**。
 * 只把它 `visibility: hidden` 是不够的 —— 那只是看不见，布局还占着高度，
 * 于是打印层被顶到第 2 页之后，凭空多出一堆空白页（实测 2 页变 5 页）。
 * portal 到 body 之后，打印时直接 `body > *:not(.print-overlay) { display: none }`
 * 就能把应用从版面里拿干净，页数才对得上。
 */

import * as React from 'react';
import { createPortal } from 'react-dom';
import { renderMarkdown } from '../../core/note/markdown.js';
import { NoteRepository } from '../../core/note/repository.js';
import { noteTags, type Note } from '../../core/note/types.js';

export interface PrintSheetProps {
  note: Note;
  /** 关联亲友的名字；没有就传 undefined。 */
  personName?: string;
  onClose: () => void;
}

/**
 * 可选纸张。
 *
 * 尺寸用 mm，和 `@page` / 打印机一致。留白也按纸别给：A5 比 A4 小一圈，
 * 留白跟着缩小，否则小纸上全是不必要的白边。
 */
interface PaperSize {
  id: string;
  label: string;
  /** 纸宽（mm）。 */
  widthMm: number;
  /** 纸高（mm）。 */
  heightMm: number;
  /** 左右留白（mm）。 */
  padXMm: number;
  /** 上下留白（mm）。 */
  padYMm: number;
}

const PAPERS: readonly PaperSize[] = [
  { id: 'a4', label: 'A4（210 × 297 mm）', widthMm: 210, heightMm: 297, padXMm: 16, padYMm: 18 },
  { id: 'a5', label: 'A5（148 × 210 mm）', widthMm: 148, heightMm: 210, padXMm: 12, padYMm: 14 },
  { id: 'b5', label: 'B5（176 × 250 mm）', widthMm: 176, heightMm: 250, padXMm: 14, padYMm: 16 },
  { id: 'letter', label: 'Letter（215.9 × 279.4 mm）', widthMm: 215.9, heightMm: 279.4, padXMm: 16, padYMm: 18 },
];

const DEFAULT_PAPER: PaperSize = PAPERS[0] as PaperSize;

/** 1mm 在 CSS px（96dpi）下是多少。 */
const MM_TO_PX = 96 / 25.4;

/**
 * 分页时给内容高度留的安全余量（px）。
 *
 * 量出来的高度和真正排版的高度可能差一两个像素（亚像素取整、字体回退），
 * 而一页的盒子是固定高度、overflow 会裁掉超出部分。宁可少放一行，
 * 也不要让最后一行的下半截被裁掉。
 */
const SAFETY_PX = 2;

/** 一页里最多塞几个「块」，防止异常数据把分页循环拖爆。 */
const MAX_BLOCKS_PER_PAGE = 400;

/** 按纸别算出内容区宽度（px）。 */
function contentWidthPx(paper: PaperSize): number {
  return (paper.widthMm - paper.padXMm * 2) * MM_TO_PX;
}

/**
 * 把文本转义成可以安全塞进 HTML 字符串的形式。
 *
 * 标题、标签、亲友名都是用户数据，直接拼进 innerHTML 会变成注入口子。
 * （正文那边走 renderMarkdown，它自己已经统一转义了。）
 *
 * @param value - 原始文本。
 * @returns 转义后的文本。
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 按纸别算出内容区高度（px）。 */
function contentHeightPx(paper: PaperSize): number {
  return (paper.heightMm - paper.padYMm * 2) * MM_TO_PX;
}

/**
 * 把一段渲染好的 HTML 按纸高切成若干页。
 *
 * 做法是「离屏量一遍 + 贪心装箱」：
 *  1. 把整段正文塞进一个宽度**恰好等于真实打印内容宽度**的隐藏容器；
 *  2. 逐个读取顶层子元素占的高度（用 offsetTop 差值算，把 margin 塌陷也算进去）；
 *  3. 贪心地往当前页里塞，塞不下就开新页。
 *
 * 关键前提：「测量容器与真实纸张同宽同字号」。否则换行位置不同，
 * 量出来的高度就是错的，页数自然和 PDF 对不上。所以两边都用
 * `.md-body.print-sheet__body` 这套类，只有宽度/高度由纸别决定。
 *
 * **页眉/页脚要占掉正文的高度，必须从首页/末页的预算里扣掉。**
 * 这一点最初漏了：第一页明明还要放标题和日期行，却按「整页都给正文」来装，
 * 结果正文比可用高度多出几十像素，溢到下方留白里、压住页码（A5 实测溢出 56px）。
 *
 * 一个块（比如一张大表格）自己就超过一页时**不切它** —— 宁可让它溢出一点，
 * 也不能把表格劈成两半（那比难看更糟：内容会重复表头或丢行）。
 *
 * @param html - 渲染好的正文 HTML（整篇，图片已带好 src 且已加载完）。
 * @param paper - 目标纸张。
 * @param reserves - 页眉（只在首页）与页脚（只在末页）占掉的高度（px）。
 * @returns 每一页的 HTML 片段；至少一页。
 */
function measurePages(
  html: string,
  paper: PaperSize,
  reserves: { headerPx: number; footerPx: number },
): string[] {
  if (typeof document === 'undefined') return [html];

  const host = document.createElement('div');
  // 用真实纸张那套类名，让 .md-body / .print-sheet__body 的全部规则
  // （字号、行高、表格内边距、代码块）原样生效 —— 测出来的就是打印出来的。
  host.className = 'md-body print-sheet__body print-measure';
  host.style.width = `${contentWidthPx(paper)}px`;
  host.innerHTML = html;
  document.body.appendChild(host);

  try {
    const children = Array.from(host.children) as HTMLElement[];
    if (children.length === 0) return [''];

    // 每个块的「占位高度」= 到下一个块起点的距离（或者到容器末尾）。
    // 直接用 offsetHeight 会漏掉 margin，算出来会偏小 → 一页塞太多 → 溢出被裁。
    const boxes = children.map((child, index) => {
      const next = children[index + 1];
      const top = child.offsetTop;
      const bottom = next !== undefined ? next.offsetTop : host.scrollHeight;
      return { html: child.outerHTML, height: Math.max(child.offsetHeight, bottom - top) };
    });

    const baseLimit = contentHeightPx(paper) - SAFETY_PX;
    const firstLimit = Math.max(baseLimit - reserves.headerPx, baseLimit * 0.3);
    const lastLimit = Math.max(baseLimit - reserves.footerPx, baseLimit * 0.3);

    // 第一遍：首页扣掉页眉，其余按整页装。
    const pages: Array<{ parts: string[]; height: number }> = [];
    let current: { parts: string[]; height: number } = { parts: [], height: 0 };

    for (const box of boxes) {
      const limit = pages.length === 0 ? firstLimit : baseLimit;
      if (current.parts.length > 0 && current.height + box.height > limit) {
        pages.push(current);
        current = { parts: [], height: 0 };
      }
      current.parts.push(box.html);
      current.height += box.height;
      if (current.parts.length >= MAX_BLOCKS_PER_PAGE) {
        pages.push(current);
        current = { parts: [], height: 0 };
      }
    }
    if (current.parts.length > 0) pages.push(current);

    // 第二遍：末页还要放页脚，装不下就把末尾的块挪到新的一页。
    // 只挪块、不劈块；万一单个块自己就超过 lastLimit，就认了（宁可溢出也不劈）。
    while (pages.length > 0) {
      const last = pages[pages.length - 1] as { parts: string[]; height: number };
      if (last.height <= lastLimit || last.parts.length <= 1) break;
      const tailHtml = last.parts.pop() as string;
      const tailHeight = boxes.find((box) => box.html === tailHtml)?.height ?? 0;
      last.height -= tailHeight;
      pages.push({ parts: [tailHtml], height: tailHeight });
    }

    const result = pages.map((page) => page.parts.join(''));
    return result.length > 0 ? result : [''];
  } finally {
    host.remove();
  }
}

/**
 * 量一段「页面装饰」（页眉 / 页脚）在真实纸面上占多高。
 *
 * 用一个临时 `.print-page` 量，而不是凭空估 —— 标题是两行还是三行、
 * 有没有「编辑于」「关联亲友」「标签」这些附加行，都会改变高度。
 *
 * @param markup - 页眉或页脚的 HTML。
 * @param paper - 目标纸张（决定宽度、字号、留白）。
 * @returns 占位高度（含上下 margin）；量不出来时返回 0。
 */
function measureDecoration(markup: string, paper: PaperSize): number {
  if (typeof document === 'undefined') return 0;

  const probe = document.createElement('div');
  probe.className = 'print-page print-probe';
  probe.style.width = `${paper.widthMm}mm`;
  probe.style.height = 'auto';
  probe.style.padding = `${paper.padYMm}mm ${paper.padXMm}mm`;
  probe.style.overflow = 'visible';
  probe.innerHTML = markup;
  document.body.appendChild(probe);

  try {
    const node = probe.firstElementChild as HTMLElement | null;
    if (node === null) return 0;
    const style = getComputedStyle(node);
    const marginTop = Number.parseFloat(style.marginTop) || 0;
    const marginBottom = Number.parseFloat(style.marginBottom) || 0;
    return node.getBoundingClientRect().height + marginTop + marginBottom;
  } finally {
    probe.remove();
  }
}

/**
 * 等一张图真正「有尺寸」。
 *
 * 为什么不用 `img.decode()`：实测 blob URL 的图片在 Chrome 里 `decode()`
 * 返回的 Promise **可能永远不 settle**（既不 resolve 也不 reject），
 * 于是整个分页流程卡死，预览一直停在「正在分页…」。
 * 改用 load / error 事件 + 超时兜底，保证一定会往下走。
 *
 * 超时也要 resolve：宁可让图片按未知高度排版（难看一点），
 * 也不能让整个预览打不开。
 *
 * @param image - 已经设好 src 的图片元素。
 * @returns 图片加载完成或失败（含超时）时 resolve，永不 reject。
 */
const IMAGE_WAIT_TIMEOUT_MS = 4000;

function waitForImage(image: HTMLImageElement): Promise<void> {
  // 已经加载好了（命中缓存时很常见），直接返回。
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      image.removeEventListener('load', finish);
      image.removeEventListener('error', finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, IMAGE_WAIT_TIMEOUT_MS);
    image.addEventListener('load', finish);
    image.addEventListener('error', finish);
  });
}

/**
 * 把正文里的 `img[data-note-image]` 换成 object URL，并等图片真正有尺寸。
 *
 * 两件事都必须在分页之前做完：
 *  1. **整篇**扫描，不能只看第一页 —— 图片可能落在任何一页；
 *  2. **等图片加载完** —— 图片没有 src 时高度是 0（只剩 alt 文字高），
 *     此时量出来的页面高度是错的，一张竖图实际 400px 却按 0 算，
 *     就会把后面的段落硬塞进同一页，打印时整页溢出被裁。
 *
 * @param html - 渲染好的正文 HTML。
 * @param paper - 目标纸张（决定测量容器的宽度）。
 * @returns 写好 src 的 HTML，以及需要在卸载时释放的 object URL 列表。
 */
async function attachImages(html: string, paper: PaperSize): Promise<{ html: string; urls: string[] }> {
  if (typeof document === 'undefined') return { html, urls: [] };

  const host = document.createElement('div');
  host.innerHTML = html;
  // 量图要有个宽度，否则图片按容器宽度算出来又不准。
  host.style.position = 'absolute';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.width = `${contentWidthPx(paper)}px`;
  document.body.appendChild(host);

  const urls: string[] = [];
  try {
    const ids = new Set<string>();
    for (const image of Array.from(host.querySelectorAll<HTMLImageElement>('img[data-note-image]'))) {
      const id = image.getAttribute('data-note-image');
      if (id !== null) ids.add(id);
    }
    if (ids.size === 0) return { html: host.innerHTML, urls };

    const byId = new Map<string, string>();
    for (const id of ids) {
      const found = await NoteRepository.readImage(id).catch(() => null);
      if (found === null) continue;
      const url = URL.createObjectURL(found.blob);
      urls.push(url);
      byId.set(id, url);
    }

    const pending: Array<Promise<void>> = [];
    for (const image of Array.from(host.querySelectorAll<HTMLImageElement>('img[data-note-image]'))) {
      const id = image.getAttribute('data-note-image');
      const url = id === null ? undefined : byId.get(id);
      if (url === undefined) {
        image.alt = '（图片已删除）';
        continue;
      }
      image.src = url;
      pending.push(waitForImage(image));
    }
    await Promise.all(pending);

    return { html: host.innerHTML, urls };
  } finally {
    host.remove();
  }
}

/** 打印 / 导出对话框。 */
export function PrintSheet({ note, personName, onClose }: PrintSheetProps): React.ReactElement {
  /**
   * 正文里如果第一行就是 `# 标题` 且和笔记标题一致，就去掉它 ——
   * 否则纸上会出现两个一模一样的标题（一个是页眉，一个是正文首行）。
   */
  const body = React.useMemo(() => {
    const trimmed = note.body_md.replace(/^\s+/, '');
    const match = /^#[^#\n]*\n?/.exec(trimmed);
    if (match === null) return note.body_md;
    const heading = match[0].replace(/^#\s*/, '').trim();
    if (heading !== note.title.trim()) return note.body_md;
    return trimmed.slice(match[0].length);
  }, [note.body_md, note.title]);

  const html = React.useMemo(() => renderMarkdown(body), [body]);

  const tags = noteTags(note);
  const created = new Date(note.created_at);
  const edited = note.updated_at !== note.created_at ? new Date(note.updated_at) : null;

  /**
   * 页眉 / 页脚也做成 HTML 字符串。
   *
   * 为什么不用 JSX：分页必须先知道它们占多高，才能从首页/末页的预算里扣；
   * 而「量到的」和「渲染出来的」必须是同一份东西，否则差几个像素就会溢出。
   * 做成字符串之后就只有一个来源：量它、渲染它，都是它。
   */
  const headerHtml = React.useMemo(() => {
    const metaParts: string[] = [
      `<span>${escapeHtml(created.toLocaleString('zh-CN', { dateStyle: 'long', timeStyle: 'short' }))}</span>`,
    ];
    if (edited !== null) {
      metaParts.push(`<span> · 编辑于 ${escapeHtml(edited.toLocaleString('zh-CN', { dateStyle: 'long', timeStyle: 'short' }))}</span>`);
    }
    if (personName !== undefined) {
      metaParts.push(`<span> · 关联亲友：${escapeHtml(personName)}</span>`);
    }
    if (tags.length > 0) {
      metaParts.push(`<span> · #${tags.map(escapeHtml).join(' #')}</span>`);
    }
    return `<header class="print-sheet__head">`
      + `<h1 class="print-sheet__title">${escapeHtml(note.title)}</h1>`
      + `<div class="print-sheet__meta">${metaParts.join('')}</div>`
      + `</header>`;
  }, [created, edited, note.title, personName, tags]);

  const footerHtml = React.useMemo(
    () => `<footer class="print-sheet__foot">由 JVS 笔记导出 · ${escapeHtml(new Date().toLocaleDateString('zh-CN'))}</footer>`,
    [],
  );

  const [paperId, setPaperId] = React.useState<string>(DEFAULT_PAPER.id);
  const paper = PAPERS.find((item) => item.id === paperId) ?? DEFAULT_PAPER;

  /** 切好的页（HTML 片段）；null 表示还在分页。 */
  const [pages, setPages] = React.useState<string[] | null>(null);
  /** 当前页（0 起）；只在导航与高亮时用。 */
  const [pageIndex, setPageIndex] = React.useState(0);
  /** 当前这批页面引用着的 object URL —— 卸载或重新分页时释放。 */
  const urlsRef = React.useRef<string[]>([]);

  const overlayRef = React.useRef<HTMLDivElement>(null);
  const pageRefs = React.useRef<Array<HTMLElement | null>>([]);

  /**
   * 载入图片 → 按纸别切页。
   *
   * 换纸张要重切（内容宽高都变了），所以 paper 是依赖项。切完把页码归零，
   * 不然换到更小的纸、页数变多时，当前页可能已经不存在了。
   *
   * 切出来的 HTML 里已经带着 blob URL，所以直接 dangerouslySetInnerHTML
   * 就能显示图片，不需要渲染完再补一遍 —— 这里只负责在换纸/卸载时释放它们。
   */
  React.useEffect(() => {
    let cancelled = false;
    setPages(null);
    setPageIndex(0);
    pageRefs.current = [];

    void (async () => {
      // 分页失败也必须把预览打开：宁可图片没排好，也不能卡在「正在分页…」。
      // 所以这里把整个流程包起来，出错就退回「不带图片的原始 HTML」再分一次。
      let withImages = html;
      let urls: string[] = [];
      try {
        const attached = await attachImages(html, paper);
        withImages = attached.html;
        urls = attached.urls;
      } catch {
        withImages = html;
        urls = [];
      }

      if (cancelled) {
        for (const url of urls) URL.revokeObjectURL(url);
        return;
      }
      for (const old of urlsRef.current) URL.revokeObjectURL(old);
      urlsRef.current = urls;

      let next: string[];
      try {
        // 页眉只占首页、页脚只占末页，都要从各自那页的正文预算里扣掉。
        next = measurePages(withImages, paper, {
          headerPx: measureDecoration(headerHtml, paper),
          footerPx: measureDecoration(footerHtml, paper),
        });
      } catch {
        next = [withImages];
      }
      setPages(next);
      // 重新分页后必须回到第一页：换了纸，页数变了，原来的滚动位置
      // 对应的已经不是同一页了。不重置的话，换到 A5 会停在「第 5 / 8 页」。
      setPageIndex(0);
      overlayRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    })();

    return () => {
      cancelled = true;
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
      urlsRef.current = [];
    };
  }, [html, paper, headerHtml, footerHtml]);

  const total = pages?.length ?? 0;

  /** 滚到某一页。越界夹紧。 */
  const goToPage = React.useCallback((next: number): void => {
    if (pages === null) return;
    const clamped = Math.max(0, Math.min(pages.length - 1, next));
    setPageIndex(clamped);
    const node = pageRefs.current[clamped];
    if (node !== null && node !== undefined) {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [pages]);

  // 键盘：← → 翻页，Esc 关闭。
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goToPage(pageIndex - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goToPage(pageIndex + 1);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose, goToPage, pageIndex]);

  /**
   * 滚动时同步「当前是第几页」。
   *
   * 不这么做的话，用户自己滚到第 3 页，工具栏还显示「第 1 页」，
   * 点「下一页」会莫名其妙跳回第 2 页。
   */
  React.useEffect(() => {
    const overlay = overlayRef.current;
    if (overlay === null || pages === null) return undefined;
    const onScroll = (): void => {
      const box = overlay.getBoundingClientRect();
      let best = 0;
      let bestGap = Number.POSITIVE_INFINITY;
      for (let index = 0; index < pageRefs.current.length; index += 1) {
        const node = pageRefs.current[index];
        if (node === null || node === undefined) continue;
        const gap = Math.abs(node.getBoundingClientRect().top - box.top);
        if (gap < bestGap) {
          bestGap = gap;
          best = index;
        }
      }
      setPageIndex(best);
    };
    overlay.addEventListener('scroll', onScroll, { passive: true });
    return () => overlay.removeEventListener('scroll', onScroll);
  }, [pages]);

  const ready = pages !== null;

  /** 纸的实际像素盒：屏幕上按 96dpi 的原尺寸显示。 */
  const pageStyle: React.CSSProperties = {
    width: `${paper.widthMm}mm`,
    height: `${paper.heightMm}mm`,
    padding: `${paper.padYMm}mm ${paper.padXMm}mm`,
  };

  return createPortal(
    <div
      className="print-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="打印预览"
      ref={overlayRef}
    >
      {/*
        打印时的页面尺寸必须跟着选中的纸走，否则选 A5 预览、打出来却是 A4。

        注意 `@page` **不能**套在 `@media print` 里 —— 它只能出现在样式表顶层，
        套进 @media 会被整条忽略，于是浏览器退回默认纸和默认页边距，
        每张纸都会比可打印区高一点点，一张纸就被劈成两页（实测 4 页变 9 页）。
        所以这里直接写在顶层：@page 本来就只在打印时才起作用。
      */}
      <style>{`@page { size: ${paper.widthMm}mm ${paper.heightMm}mm; margin: 0; }`}</style>

      <div className="print-toolbar">
        <label className="print-toolbar__paper">
          <span>纸张</span>
          <select
            value={paperId}
            onChange={(event) => setPaperId(event.target.value)}
            aria-label="纸张大小"
          >
            {PAPERS.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>

        <div className="print-toolbar__nav">
          <button
            type="button"
            onClick={() => goToPage(pageIndex - 1)}
            disabled={!ready || pageIndex <= 0}
            aria-label="上一页"
            title="上一页（←）"
          >
            ‹ 上一页
          </button>
          <span className="print-toolbar__count" role="status" aria-live="polite">
            {ready ? `第 ${pageIndex + 1} / ${total} 页` : '正在分页…'}
          </span>
          <button
            type="button"
            onClick={() => goToPage(pageIndex + 1)}
            disabled={!ready || pageIndex >= total - 1}
            aria-label="下一页"
            title="下一页（→）"
          >
            下一页 ›
          </button>
        </div>

        <span className="print-toolbar__hint">
          {ready ? '点「打印」后在对话框里选「另存为 PDF」' : '正在载入图片…'}
        </span>
        <button
          type="button"
          className="primary"
          disabled={!ready}
          onClick={() => window.print()}
        >
          打印 / 保存为 PDF
        </button>
        <button type="button" className="print-toolbar__close" onClick={onClose}>关闭</button>
      </div>

      <div className="print-pages">
        {(pages ?? []).map((page, index) => (
          <article
            className="print-page"
            key={`${paper.id}-${index}`}
            style={pageStyle}
            ref={(node) => { pageRefs.current[index] = node; }}
            data-page={index + 1}
          >
            {/*
              页眉只出现在第一页，页脚只出现在最后一页 —— 和「一张纸」的直觉一致。
              这里用 innerHTML 注入而不是写 JSX：分页时量的是同一份 HTML 字符串，
              量到的和渲染出来的必须完全一致，否则分页预算会差几个像素、溢出被裁。
            */}
            {index === 0 && (
              <div dangerouslySetInnerHTML={{ __html: headerHtml }} />
            )}

            <div
              className="md-body print-sheet__body"
              dangerouslySetInnerHTML={{ __html: page }}
            />

            {index === total - 1 && total > 0 && (
              <div dangerouslySetInnerHTML={{ __html: footerHtml }} />
            )}

            <div className="print-page__no" aria-hidden="true">
              第 {index + 1} 页 / 共 {total} 页
            </div>
          </article>
        ))}
      </div>
    </div>,
    document.body,
  );
}
