/**
 * 单篇笔记的打印 / PDF 导出。
 *
 * 做法是「打印样式 + 浏览器原生另存为 PDF」，而不是引入 jsPDF 之类的库：
 *  - 零依赖，不增加包体积；
 *  - 产出的是**真 PDF**（文字可选中、可搜索、可复制），不是截图；
 *  - 中文字体交给浏览器排，比 canvas 渲染清楚；
 *  - 完全离线可用。
 *
 * 屏幕上显示的是「打印预览」：一页白纸的排版，和实际打印结果一致。
 * 应用本身是深色主题，所以这张纸单独把配色变量改成浅色（见 .print-sheet）。
 */

import * as React from 'react';
import { renderMarkdown } from '../../core/note/markdown.js';
import { NoteRepository } from '../../core/note/repository.js';
import { noteTags, type Note } from '../../core/note/types.js';

export interface PrintSheetProps {
  note: Note;
  /** 关联亲友的名字；没有就传 undefined。 */
  personName?: string;
  onClose: () => void;
}

/** 把正文里的图片 BLOB 换成 object URL。 */
function useHydrateImages(container: React.RefObject<HTMLDivElement | null>, html: string): boolean {
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    const root = container.current;
    if (root === null) return undefined;
    const targets = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-note-image]'));
    if (targets.length === 0) {
      setReady(true);
      return undefined;
    }

    let cancelled = false;
    const urls: string[] = [];
    setReady(false);

    void (async () => {
      for (const image of targets) {
        const id = image.getAttribute('data-note-image');
        if (id === null) continue;
        const found = await NoteRepository.readImage(id).catch(() => null);
        if (cancelled) return;
        if (found === null) {
          image.alt = '（图片已删除）';
          continue;
        }
        const url = URL.createObjectURL(found.blob);
        urls.push(url);
        image.src = url;
      }
      if (!cancelled) setReady(true);
    })();

    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [container, html]);

  return ready;
}

/** 打印/导出对话框。 */
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
  const container = React.useRef<HTMLDivElement>(null);
  const ready = useHydrateImages(container, html);
  const tags = noteTags(note);
  const created = new Date(note.created_at);
  const edited = note.updated_at !== note.created_at ? new Date(note.updated_at) : null;

  // Esc 关闭。
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="print-overlay" role="dialog" aria-modal="true" aria-label="打印预览">
      <div className="print-toolbar">
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

      <article className="print-sheet">
        <header className="print-sheet__head">
          <h1 className="print-sheet__title">{note.title}</h1>
          <div className="print-sheet__meta">
            <span>{created.toLocaleString('zh-CN', { dateStyle: 'long', timeStyle: 'short' })}</span>
            {edited !== null && (
              <span> · 编辑于 {edited.toLocaleString('zh-CN', { dateStyle: 'long', timeStyle: 'short' })}</span>
            )}
            {personName !== undefined && <span> · 关联亲友：{personName}</span>}
            {tags.length > 0 && <span> · #{tags.join(' #')}</span>}
          </div>
        </header>

        <div
          ref={container}
          className="md-body print-sheet__body"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        <footer className="print-sheet__foot">
          由 JVS 笔记导出 · {new Date().toLocaleDateString('zh-CN')}
        </footer>
      </article>
    </div>
  );
}
