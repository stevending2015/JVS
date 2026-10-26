/**
 * Quick composer: write a note without leaving the list.
 *
 * Enter saves, Shift+Enter breaks the line. Images need a note row to hang on, so
 * the first image creates a draft and every later save updates it — the same note,
 * never a second one.
 */

import * as React from 'react';
import { Modal } from '../../app/Modal.js';
import { NoteRepository } from '../../core/note/repository.js';
import { MAX_NOTE_IMAGES, countNoteImages, noteTags, type Note } from '../../core/note/types.js';
import type { Person } from '../../core/person/types.js';
import { insertImagesIntoBody } from './imageInsert.js';

interface ComposerProps {
  persons: Person[];
  onSaved: () => void;
}

export function Composer({ persons, onSaved }: ComposerProps): React.ReactElement {
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [tags, setTags] = React.useState<string[]>([]);
  const [tagInput, setTagInput] = React.useState('');
  const [personId, setPersonId] = React.useState('');
  const [draftId, setDraftId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);

  const imageCount = countNoteImages(body);

  async function ensureDraft(): Promise<string> {
    if (draftId !== null) return draftId;
    const created = await NoteRepository.create({
      title,
      bodyMd: body,
      tags,
      pinned: false,
      personId: personId === '' ? null : personId,
    });
    setDraftId(created.id);
    return created.id;
  }

  function reset(): void {
    setTitle('');
    setBody('');
    setTags([]);
    setTagInput('');
    setPersonId('');
    setDraftId(null);
    setExpanded(false);
  }

  async function save(): Promise<void> {
    if (body.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        title,
        bodyMd: body,
        tags,
        pinned: false,
        personId: personId === '' ? null : personId,
      };
      if (draftId !== null) await NoteRepository.update(draftId, payload);
      else await NoteRepository.create(payload);
      reset();
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function insertImages(files: File[]): Promise<void> {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const area = bodyRef.current;
      const start = area?.selectionStart ?? body.length;
      const end = area?.selectionEnd ?? body.length;
      const noteId = await ensureDraft();
      const merged = await insertImagesIntoBody({ noteId, files, body, start, end });
      setBody(merged.body);
      if (merged.rejected > 0) {
        setError(`已达 ${MAX_NOTE_IMAGES} 张上限，忽略 ${merged.rejected} 张`);
      }
      // Persist immediately: a draft with an uploaded image must keep its marker,
      // otherwise the bytes are orphaned on the next reload.
      await NoteRepository.update(noteId, { bodyMd: merged.body });
      onSaved();
      queueMicrotask(() => {
        const target = bodyRef.current;
        if (target === null) return;
        target.focus();
        target.setSelectionRange(merged.cursor, merged.cursor);
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function clearDraft(): Promise<void> {
    setConfirmClear(false);
    setBusy(true);
    setError(null);
    try {
      if (draftId !== null) await NoteRepository.remove(draftId);
      reset();
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function commitTag(): void {
    const next = tagInput.trim();
    if (next === '') return;
    setTags((prev) => [...new Set([...prev, next])]);
    setTagInput('');
  }

  const canSave = body.trim() !== '' && !busy;

  return (
    <section className="note-composer">
      <div className="note-composer__top">
        <input
          className="note-composer__title"
          placeholder="标题（可留空，自动取正文首行）"
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
        />
        <button
          type="button"
          className="note-composer__help"
          aria-label="编辑器帮助"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((open) => !open)}
        >
          ?
        </button>
      </div>

      {helpOpen && (
        <div className="note-help">
          <div><code>Enter</code> 保存 · <code>Shift + Enter</code> 换行</div>
          <div><code># 标题</code> · <code>**粗体**</code> · <code>*斜体*</code> · <code>`代码`</code></div>
          <div><code>- 列表</code> · <code>1. 有序</code> · <code>&gt; 引用</code> · <code>| 表格 |</code></div>
          <div><code>[文字](链接)</code> · <code>![说明](图片)</code>（最多 {MAX_NOTE_IMAGES} 张）</div>
          <div><code>{"$a^2+b^2=c^2$"}</code> 行内公式 · <code>{"$$\\int e^{-x^2}dx$$"}</code> 块公式</div>
        </div>
      )}

      <textarea
        ref={bodyRef}
        className={`note-composer__body${expanded ? ' is-expanded' : ''}`}
        placeholder="写点什么…（支持 Markdown 与 $公式$）"
        value={body}
        rows={expanded ? 18 : 3}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void save();
          }
        }}
      />

      <div className="note-composer__bar">
        <div className="note-composer__left">
          <label className={`btn btn--file${uploading || imageCount >= MAX_NOTE_IMAGES ? ' is-disabled' : ''}`}>
            {uploading ? '压缩上传中…' : `插入图片${imageCount > 0 ? ` (${imageCount}/${MAX_NOTE_IMAGES})` : ''}`}
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              disabled={uploading || imageCount >= MAX_NOTE_IMAGES}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                void insertImages(files);
              }}
            />
          </label>
          {tags.map((tag) => (
            <span key={tag} className="tag tag--removable">
              #{tag}
              <button type="button" onClick={() => setTags((prev) => prev.filter((item) => item !== tag))} aria-label={`移除标签 ${tag}`}>
                ×
              </button>
            </span>
          ))}
          <input
            className="note-composer__tag"
            placeholder="+ 标签"
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitTag();
              }
            }}
          />
          <select
            className="note-composer__person"
            value={personId}
            onChange={(event) => setPersonId(event.target.value)}
            aria-label="关联亲友"
          >
            <option value="">不关联亲友</option>
            {persons.map((person) => (
              <option key={person.id} value={person.id}>{person.name}</option>
            ))}
          </select>
        </div>
        <div className="note-composer__right">
          <button type="button" className="link" onClick={() => setExpanded((value) => !value)}>
            {expanded ? '收起' : '展开'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || (title === '' && body === '' && tags.length === 0)}
            onClick={() => setConfirmClear(true)}
          >
            清空
          </button>
          <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {error !== null && <div className="banner banner--bad">{error}</div>}

      <Modal open={confirmClear} title="清空当前输入？" onClose={() => setConfirmClear(false)} width={420}>
        <div className="form">
          <p className="ft-confirm">
            标题、正文、标签以及已上传的图片（{imageCount} 张）都会被移除，且不可恢复。
          </p>
          <div className="form__actions">
            <button type="button" className="btn btn--danger" onClick={() => void clearDraft()}>确认清空</button>
            <button type="button" onClick={() => setConfirmClear(false)}>取消</button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

/** Title helper re-exported so the page can label a note consistently. */
export function composerTitle(note: Note): string {
  const tags = noteTags(note);
  return tags.length === 0 ? note.title : `${note.title}`;
}
