/**
 * Notes page: composer, filters (search / tag / date heat map), day-grouped list,
 * pagination, and markdown import/export.
 */

import * as React from 'react';
import { Modal } from '../../app/Modal.js';
import { NoteRepository } from '../../core/note/repository.js';
import {
  NOTES_PAGE_SIZE,
  countNotesByDay,
  dateFilterContains,
  groupNotesByDay,
  noteTags,
  type DateFilter,
  type Note,
} from '../../core/note/types.js';
import { useStore } from '../../core/store.js';
import { CalendarFilter } from './CalendarFilter.js';
import { Composer } from './Composer.js';
import { NoteCard } from './NoteCard.js';

/** Notes page. */
export function NotesPage(): React.ReactElement {
  const { persons, refresh } = useStore();
  const [notes, setNotes] = React.useState<Note[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [tagFilter, setTagFilter] = React.useState('');
  const [dateFilter, setDateFilter] = React.useState<DateFilter>({ kind: 'none' });
  const [page, setPage] = React.useState(1);
  const [importOpen, setImportOpen] = React.useState(false);
  const [importText, setImportText] = React.useState('');
  const [importBusy, setImportBusy] = React.useState(false);
  const [importResult, setImportResult] = React.useState<string | null>(null);
  const [focusNoteId, setFocusNoteId] = React.useState<string | null>(null);

  const load = React.useCallback(async (focusId?: string | null) => {
    try {
      const next = await NoteRepository.list();
      setNotes(next);
      setError(null);
      if (focusId !== undefined && focusId !== null) setFocusNoteId(focusId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Deep link: #/m/notes?note=<id> focuses one note (used by the family panel).
  React.useEffect(() => {
    const match = /[?&]note=([^&]+)/.exec(location.hash);
    if (match === null) return;
    const id = decodeURIComponent(match[1] ?? '');
    if (id === '') return;
    void load(id);
    const timer = window.setTimeout(() => {
      document.querySelector(`[data-note-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [load]);

  const refreshAll = React.useCallback(() => {
    void load();
    void refresh();
  }, [load, refresh]);

  const sorted = React.useMemo(
    () => [...notes].sort((a, b) =>
      b.pinned - a.pinned || b.updated_at.localeCompare(a.updated_at)),
    [notes],
  );

  const allTags = React.useMemo(
    () => [...new Set(notes.flatMap((note) => noteTags(note)))].sort(),
    [notes],
  );

  const notesByDay = React.useMemo(() => countNotesByDay(notes), [notes]);

  const visible = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return sorted.filter((note) => {
      if (!dateFilterContains(dateFilter, noteDayOf(note))) return false;
      if (tagFilter !== '' && !noteTags(note).includes(tagFilter)) return false;
      if (needle === '') return true;
      return (
        note.title.toLowerCase().includes(needle)
        || note.body_md.toLowerCase().includes(needle)
        || noteTags(note).some((tag) => tag.toLowerCase().includes(needle))
      );
    });
  }, [sorted, dateFilter, tagFilter, search]);

  const groups = React.useMemo(() => groupNotesByDay(visible), [visible]);
  const totalPages = Math.max(1, Math.ceil(visible.length / NOTES_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageSlice = visible.slice((safePage - 1) * NOTES_PAGE_SIZE, safePage * NOTES_PAGE_SIZE);
  const pageGroups = React.useMemo(() => groupNotesByDay(pageSlice), [pageSlice]);

  const filtersActive = search.trim() !== '' || tagFilter !== '' || dateFilter.kind !== 'none';
  const personCount = persons.length;

  async function exportNotes(): Promise<void> {
    try {
      const markdown = await NoteRepository.exportMarkdown();
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `jvs-notes-${new Date().toISOString().slice(0, 10)}.md`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function runImport(): Promise<void> {
    setImportBusy(true);
    setImportResult(null);
    try {
      const written = await NoteRepository.importMarkdown(importText, 'merge');
      setImportResult(written === 0 ? '没有新增笔记（内容重复或为空）' : `已导入 ${written} 篇笔记`);
      setImportText('');
      refreshAll();
    } catch (e) {
      setImportResult(`导入失败：${(e as Error).message}`);
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <div className="panel notes-page">
      <div className="list-head">
        <h3>📝 共 {notes.length} 篇</h3>
        <input
          className="search"
          type="search"
          placeholder="搜索标题 / 正文 / 标签…"
          value={search}
          onChange={(event) => { setSearch(event.target.value); setPage(1); }}
          aria-label="搜索笔记"
        />
        <span className="list-head__count">
          {filtersActive ? `筛选后 ${visible.length} 篇` : `${groups.length} 天${personCount > 0 ? '' : ''}`}
        </span>
        <button type="button" className="btn" onClick={() => void exportNotes()}>导出 Markdown</button>
        <button type="button" className="btn" onClick={() => { setImportResult(null); setImportOpen(true); }}>导入</button>
      </div>

      <Composer persons={persons} onSaved={refreshAll} />

      <div className="notes-toolbar">
        <select
          className="notes-toolbar__tag"
          value={tagFilter}
          onChange={(event) => { setTagFilter(event.target.value); setPage(1); }}
          aria-label="按标签筛选"
        >
          <option value="">全部标签</option>
          {allTags.map((tag) => (
            <option key={tag} value={tag}>#{tag}</option>
          ))}
        </select>
        <CalendarFilter
          value={dateFilter}
          counts={notesByDay}
          onChange={(next) => { setDateFilter(next); setPage(1); }}
        />
        {filtersActive && (
          <button
            type="button"
            className="link"
            onClick={() => { setSearch(''); setTagFilter(''); setDateFilter({ kind: 'none' }); setPage(1); }}
          >
            清除筛选
          </button>
        )}
      </div>

      {error !== null && <div className="banner banner--bad">{error}</div>}
      {loading && <p className="card__empty">正在读取笔记…</p>}

      {!loading && visible.length === 0 && (
        <p className="card__empty">
          {filtersActive ? '当前筛选条件下没有笔记。' : '还没有笔记。在上方写下第一行，按 Enter 保存。'}
        </p>
      )}

      {pageGroups.map((group) => (
        <section key={group.day} className="note-day">
          <header className="note-day__head">{group.day} · {group.items.length} 篇</header>
          <ul className="note-list">
            {group.items.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                persons={persons}
                focusNoteId={focusNoteId}
                onChanged={refreshAll}
              />
            ))}
          </ul>
        </section>
      ))}

      {totalPages > 1 && (
        <div className="note-pager">
          <button type="button" className="link" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>← 上一页</button>
          <span>第 {safePage} / {totalPages} 页</span>
          <button type="button" className="link" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>下一页 →</button>
        </div>
      )}

      <Modal open={importOpen} title="导入 Markdown" onClose={() => setImportOpen(false)} width={620}>
        <div className="form">
          <p className="ft-confirm">
            粘贴 Markdown 文本，或选择 .md 文件。<b>---</b> 分隔的每一块会成为一篇笔记；
            带 <b>title / tags / pinned / person</b> 头信息的块会保留这些字段。相同内容默认跳过。
          </p>
          <input
            type="file"
            accept=".md,.markdown,text/markdown,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file === undefined) return;
              void file.text().then(setImportText);
            }}
          />
          <textarea
            className="note-composer__body"
            rows={12}
            placeholder={'---\ntitle: "示例"\ntags: ["读书"]\npinned: false\nperson: null\n---\n\n正文…'}
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
          />
          {importResult !== null && <div className="banner">{importResult}</div>}
          <div className="form__actions">
            <button type="button" className="primary" disabled={importBusy || importText.trim() === ''} onClick={() => void runImport()}>
              {importBusy ? '导入中…' : '开始导入'}
            </button>
            <button type="button" onClick={() => setImportOpen(false)}>关闭</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Local day of a note (kept local to avoid exporting a helper only used here). */
function noteDayOf(note: Note): string {
  const date = new Date(note.created_at);
  if (Number.isNaN(date.getTime())) return note.created_at.slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Dashboard card: note count + latest title. */
export function NotesCard(): React.ReactElement {
  const { notes } = useStore();
  if (notes.length === 0) return <p className="card__empty">还没有笔记</p>;
  return (
    <div>
      <div className="mini-big">{notes.length} 篇</div>
      <div className="mini-list__meta">最新：{notes[0].title}</div>
    </div>
  );
}
