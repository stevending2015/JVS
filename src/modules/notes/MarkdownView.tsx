/**
 * Renders a note's markdown, hydrating stored images into object URLs.
 *
 * Images are BLOBs in SQLite, so an `<img>` cannot point at a URL directly. The
 * rendered HTML carries `data-note-image="<id>"`, and after mount we swap each one
 * for a Blob URL — revoked on unmount so a long note list cannot leak memory.
 *
 * Clicking an image opens the lightbox; the ids are collected from the DOM in
 * document order so ←/→ can move between the note's pictures.
 */

import * as React from 'react';
import { renderMarkdown } from '../../core/note/markdown.js';
import { NoteRepository } from '../../core/note/repository.js';
import { Lightbox } from './Lightbox.js';

export function MarkdownView({ markdown }: { markdown: string }): React.ReactElement {
  const html = React.useMemo(() => renderMarkdown(markdown), [markdown]);
  const container = React.useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = React.useState<{ ids: string[]; index: number } | null>(null);

  React.useEffect(() => {
    const root = container.current;
    if (root === null) return;
    const targets = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-note-image]'));
    if (targets.length === 0) return;

    let cancelled = false;
    const urls: string[] = [];
    void (async () => {
      for (const image of targets) {
        const id = image.getAttribute('data-note-image');
        if (id === null) continue;
        const found = await NoteRepository.readImage(id).catch(() => null);
        if (cancelled) return;
        if (found === null) {
          image.alt = '图片已删除';
          continue;
        }
        const url = URL.createObjectURL(found.blob);
        urls.push(url);
        image.src = url;
      }
    })();

    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [html]);

  function openViewer(event: React.MouseEvent<HTMLDivElement>): void {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;
    const id = target.getAttribute('data-note-image');
    if (id === null) return;
    const root = container.current;
    if (root === null) return;
    const ids = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-note-image]'))
      .map((image) => image.getAttribute('data-note-image'))
      .filter((value): value is string => value !== null);
    const index = ids.indexOf(id);
    if (index < 0) return;
    setViewer({ ids, index });
  }

  return (
    <>
      <div
        ref={container}
        className="md-body"
        onClick={openViewer}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {viewer !== null && (
        <Lightbox
          ids={viewer.ids}
          index={viewer.index}
          onClose={() => setViewer(null)}
          onIndexChange={(index) => setViewer((previous) => (previous === null ? null : { ...previous, index }))}
        />
      )}
    </>
  );
}
