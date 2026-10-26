/**
 * Full-screen image viewer for note attachments.
 *
 * The card list is dense, so a photo is unreadable in place. Clicking one opens this
 * overlay: wheel zooms, dragging pans once zoomed, arrows move between the note's
 * images, Esc (or the backdrop) closes.
 */

import * as React from 'react';
import { NoteRepository } from '../../core/note/repository.js';

interface LightboxProps {
  /** Image ids of the note being viewed, in document order. */
  ids: string[];
  /** Index to show. */
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const DRAG_THRESHOLD = 4;

export function Lightbox({ ids, index, onClose, onIndexChange }: LightboxProps): React.ReactElement {
  const [url, setUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [zoom, setZoom] = React.useState(1);
  const [offset, setOffset] = React.useState({ x: 0, y: 0 });
  const drag = React.useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  /** 'tap' or 'drag' for the gesture that just ended; the click handler reads it. */
  const lastGesture = React.useRef<'tap' | 'drag' | null>(null);
  const stage = React.useRef<HTMLDivElement>(null);
  const imageId = ids[index];

  // Load the bytes for the current image and revoke the object URL on change.
  React.useEffect(() => {
    setLoading(true);
    setFailed(false);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    let cancelled = false;
    let created: string | null = null;
    if (imageId === undefined) {
      setLoading(false);
      return undefined;
    }
    void NoteRepository.readImage(imageId)
      .then((found) => {
        if (cancelled) return;
        if (found === null) {
          setFailed(true);
          setLoading(false);
          return;
        }
        created = URL.createObjectURL(found.blob);
        setUrl(created);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      if (created !== null) URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [imageId]);

  // Keyboard: arrows navigate, Escape closes.
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onIndexChange((index - 1 + ids.length) % ids.length);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        onIndexChange((index + 1) % ids.length);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ids.length, index, onClose, onIndexChange]);

  // Wheel zoom needs a non-passive listener so the page behind does not scroll.
  React.useEffect(() => {
    const node = stage.current;
    if (node === null) return undefined;
    function onWheel(event: WheelEvent): void {
      event.preventDefault();
      setZoom((current) => {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current - Math.sign(event.deltaY) * 0.3));
        if (next === MIN_ZOOM) setOffset({ x: 0, y: 0 });
        return next;
      });
    }
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  function toggleZoom(): void {
    setZoom((current) => {
      if (current > 1) {
        setOffset({ x: 0, y: 0 });
        return 1;
      }
      return 2.5;
    });
  }

  function onPointerDown(event: React.PointerEvent<HTMLImageElement>): void {
    // Always record the gesture so a release can be told apart from a drag.
    drag.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
      moved: false,
    };
    if (zoom > 1) event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLImageElement>): void {
    const state = drag.current;
    if (state === null || zoom <= 1) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) state.moved = true;
    setOffset({ x: state.originX + dx, y: state.originY + dy });
  }

  function onPointerUp(event: React.PointerEvent<HTMLImageElement>): void {
    // Keep `moved` for the click that follows; the release itself decides nothing.
    if (drag.current !== null && !drag.current.moved) lastGesture.current = 'tap';
    else lastGesture.current = 'drag';
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function onClickImage(): void {
    // A drag also ends in a click — only a genuine tap toggles zoom.
    if (lastGesture.current === 'drag') return;
    lastGesture.current = null;
    toggleZoom();
  }

  const single = ids.length <= 1;
  // A drag that ends on the backdrop must not close the viewer: closing is a click,
  // and a pan gesture also ends with a click event on the element it started from.
  const backdropDown = React.useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片查看"
      onMouseDown={(event) => {
        backdropDown.current = { x: event.clientX, y: event.clientY };
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const start = backdropDown.current;
        backdropDown.current = null;
        if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
        onClose();
      }}
    >
      <div className="lightbox__bar">
        <span className="lightbox__count">
          {single ? '1 / 1' : `${index + 1} / ${ids.length}`}
          <span className="lightbox__zoom">{Math.round(zoom * 100)}%</span>
        </span>
        <div className="lightbox__actions">
          <button type="button" className="link" onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + 0.5))} disabled={zoom >= MAX_ZOOM}>
            放大
          </button>
          <button type="button" className="link" onClick={() => setZoom((value) => {
            if (value <= 1.5) {
              setOffset({ x: 0, y: 0 });
              return MIN_ZOOM;
            }
            return value - 0.5;
          })} disabled={zoom <= MIN_ZOOM}>
            缩小
          </button>
          <button type="button" className="link" onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}>
            适应
          </button>
          <button type="button" className="link link--danger" onClick={onClose}>关闭 ✕</button>
        </div>
      </div>

      {!single && (
        <>
          <button
            type="button"
            className="lightbox__nav lightbox__nav--prev"
            aria-label="上一张"
            onClick={() => onIndexChange((index - 1 + ids.length) % ids.length)}
          >
            ‹
          </button>
          <button
            type="button"
            className="lightbox__nav lightbox__nav--next"
            aria-label="下一张"
            onClick={() => onIndexChange((index + 1) % ids.length)}
          >
            ›
          </button>
        </>
      )}

      <div
        className="lightbox__stage"
        ref={stage}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const start = backdropDown.current;
          backdropDown.current = null;
          if (start !== null && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
          onClose();
        }}
      >
        {loading && <p className="lightbox__hint">加载中…</p>}
        {failed && <p className="lightbox__hint">图片已删除或无法读取</p>}
        {url !== null && !failed && (
          <img
            className={`lightbox__img${zoom > 1 ? ' is-zoomed' : ''}`}
            src={url}
            alt="笔记图片"
            draggable={false}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              cursor: zoom > 1 ? 'grab' : 'zoom-in',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onClick={onClickImage}
            onPointerCancel={() => { drag.current = null; lastGesture.current = null; }}
          />
        )}
      </div>

      <p className="lightbox__tips">滚轮缩放 · 单击图片切换 1×/2.5× · 放大后拖动平移 · ← → 切换图片 · Esc 关闭</p>
    </div>
  );
}
