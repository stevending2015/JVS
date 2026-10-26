/**
 * One note in the list: read view with fold, inline editor, pin, delete.
 */

import * as React from 'react';
import { Modal } from '../../app/Modal.js';
import { NoteRepository } from '../../core/note/repository.js';
import { markdownPreview } from '../../core/note/markdown.js';
import { MAX_NOTE_IMAGES, countNoteImages, noteTags, type Note } from '../../core/note/types.js';
import type { Person } from '../../core/person/types.js';
import { createSetFromNote } from '../../core/word/link.js';
import { insertImagesIntoBody } from './imageInsert.js';
import { MarkdownView } from './MarkdownView.js';
import { PrintSheet } from './PrintSheet.js';

interface NoteCardProps {
  note: Note;
  persons: Person[];
  focusNoteId: string | null;
  onChanged: () => void;
}

export function NoteCard({ note, persons, focusNoteId, onChanged }: NoteCardProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [title, setTitle] = React.useState(note.title);
  const [body, setBody] = React.useState(note.body_md);
  const [tags, setTags] = React.useState<string[]>(noteTags(note));
  const [tagInput, setTagInput] = React.useState('');
  const [personId, setPersonId] = React.useState(note.person_id ?? '');
  const [busy, setBusy] = React.useState(false);
  const [extracting, setExtracting] = React.useState(false);
  const [wordResult, setWordResult] = React.useState<string | null>(null);
  const [printing, setPrinting] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);

  const tagsOfNote = noteTags(note);
  const foldable = note.body_md.split('\n').length > 6 || note.body_md.length > 700;
  const preview = foldable && !expanded
    ? note.body_md.split('\n').slice(0, 6).join('\n')
    : note.body_md;
  const linkedPerson = note.person_id === null
    ? undefined
    : persons.find((person) => person.id === note.person_id);
  const highlighted = focusNoteId === note.id;

  function beginEdit(): void {
    setTitle(note.title);
    setBody(note.body_md);
    setTags(noteTags(note));
    setPersonId(note.person_id ?? '');
    setTagInput('');
    setError(null);
    setEditing(true);
  }

  async function togglePin(): Promise<void> {
    setBusy(true);
    try {
      await NoteRepository.update(note.id, { pinned: note.pinned !== 1 });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  /**
   * 把这篇笔记里出现的英文词挑出来，组成一个「词光 atlas」词集。
   *
   * 只挑词库里有的词，所以不会把 the / is 也塞进去。
   */
  async function extractWords(): Promise<void> {
    setExtracting(true);
    setWordResult(null);
    try {
      const result = await createSetFromNote(note.id);
      setWordResult(
        result === null
          ? '这篇笔记里没有词库收录的英文词'
          : `已加入「${result.setName}」：本次 ${result.added} 词，共 ${result.found} 词`,
      );
    } catch (e) {
      setWordResult((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }

  async function saveEdit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await NoteRepository.update(note.id, {
        title,
        bodyMd: body,
        tags,
        personId: personId === '' ? null : personId,
      });
      // A marker may have been deleted by hand — drop the now-unreferenced bytes.
      await NoteRepository.pruneImages(note.id).catch(() => 0);
      setEditing(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    try {
      await NoteRepository.remove(note.id);
      setConfirmDelete(false);
      onChanged();
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
      const merged = await insertImagesIntoBody({ noteId: note.id, files, body, start, end });
      setBody(merged.body);
      if (merged.rejected > 0) setError(`已达 ${MAX_NOTE_IMAGES} 张上限，忽略 ${merged.rejected} 张`);
      await NoteRepository.update(note.id, { bodyMd: merged.body });
      onChanged();
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

  function commitTag(): void {
    const next = tagInput.trim();
    if (next === '') return;
    setTags((prev) => [...new Set([...prev, next])]);
    setTagInput('');
  }

  const imageCount = countNoteImages(body);

  return (
    <li className={`note${highlighted ? ' note--focus' : ''}`} data-note-id={note.id}>
      <header className="note__head">
        <div className="note__titles">
          <div className="note__titleline">
            {note.pinned === 1 && <span className="note__pin" title="已置顶">📌</span>}
            <strong className="note__title">{note.title}</strong>
            {tagsOfNote.map((tag) => <span key={tag} className="tag">#{tag}</span>)}
            {linkedPerson !== undefined && <span className="tag tag--link">👤 {linkedPerson.name}</span>}
          </div>
          <div className="note__meta">
            {new Date(note.created_at).toLocaleString()}
            {note.updated_at !== note.created_at && ' · 已编辑'}
          </div>
        </div>
        <div className="note__actions">
          <button type="button" className="link" disabled={busy} onClick={() => void togglePin()}>
            {note.pinned === 1 ? '取消置顶' : '置顶'}
          </button>
          <button type="button" className="link" disabled={busy} onClick={beginEdit}>编辑</button>
          <button type="button" className="link" onClick={() => setPrinting(true)}>导出 PDF</button>
          <button type="button" className="link" disabled={extracting} onClick={() => void extractWords()}>
            {extracting ? '提取中…' : '提取生词'}
          </button>
          <button type="button" className="link link--danger" disabled={busy} onClick={() => setConfirmDelete(true)}>删除</button>
        </div>
      </header>

      {wordResult !== null && (
        <p className="note__wordresult">{wordResult}</p>
      )}

      {editing ? (
        <div className="note__editor">
          <input
            className="note__edit-title"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="笔记标题"
          />
          <textarea
            ref={bodyRef}
            className="note__edit-body"
            rows={10}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="note__editor-bar">
            <label className={`btn btn--file${uploading || imageCount >= MAX_NOTE_IMAGES ? ' is-disabled' : ''}`}>
              {uploading ? '上传中…' : `插入图片 (${imageCount}/${MAX_NOTE_IMAGES})`}
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
                <button type="button" onClick={() => setTags((prev) => prev.filter((item) => item !== tag))}>×</button>
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
            <button type="button" className="primary" disabled={busy} onClick={() => void saveEdit()}>
              {busy ? '保存中…' : '保存'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setEditing(false)}>取消</button>
          </div>
          {error !== null && <div className="banner banner--bad">{error}</div>}
        </div>
      ) : (
        <>
          {note.body_md.trim() === '' ? (
            <p className="note__empty">{markdownPreview(note.body_md) || '（空笔记）'}</p>
          ) : (
            <MarkdownView markdown={preview} />
          )}
          {foldable && (
            <button type="button" className="link note__more" onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起 ↑' : '… 阅读全文 ↓'}
            </button>
          )}
        </>
      )}

      <Modal open={confirmDelete} title={`删除笔记：${note.title}`} onClose={() => setConfirmDelete(false)} width={420}>
        <div className="form">
          <p className="ft-confirm">
            将<b>彻底删除</b>这篇笔记及其 {noteTags(note).length > 0 ? '标签、' : ''}图片，不可恢复。
          </p>
          <div className="form__actions">
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void remove()}>
              {busy ? '删除中…' : '确认删除'}
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)}>取消</button>
          </div>
        </div>
      </Modal>

      {printing && (
        <PrintSheet
          note={note}
          personName={linkedPerson?.name}
          onClose={() => setPrinting(false)}
        />
      )}
    </li>
  );
}
