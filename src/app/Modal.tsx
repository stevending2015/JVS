/**
 * Reusable dialog.
 *
 * Forms live in here rather than inline on the page: the page stays a readable
 * list, and a dialog unmounts on save, so nobody has to reset a form through an
 * event object that React has already nulled.
 */

import * as React from 'react';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}

export function Modal({ open, title, onClose, children, width = 470 }: ModalProps): React.ReactElement | null {
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        <header className="modal__head">
          <h3>{title}</h3>
          <button type="button" className="modal__close" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}