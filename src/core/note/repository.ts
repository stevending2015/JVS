/**
 * Note storage: rows, tags, attachments, and markdown import/export.
 *
 * Images are kept as BLOBs in SQLite on purpose. The app has no server, and OPFS
 * files would need a separate garbage collector (delete the note, forget the file →
 * leaked bytes on disk forever). A BLOB dies with its row in the same statement.
 */

import { db } from '../db/client.js';
import { newId } from '../util/id.js';
import {
  MAX_IMAGE_EDGE,
  IMAGE_QUALITY,
  NOTE_IMAGE_SCHEME,
  noteTags,
  noteTitle,
  type Note,
  type NoteImage,
  type NoteInput,
} from './types.js';

const NOTE_COLUMNS =
  'id, title, body_md, pinned, tags_json, person_id, created_at, updated_at, deleted_at';

/** Read every live note, pinned first then newest. */
async function listNotes(): Promise<Note[]> {
  return db.all<Note>(
    `SELECT ${NOTE_COLUMNS} FROM note WHERE deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC`,
  );
}

/** Read one live note. */
async function getNote(id: string): Promise<Note | null> {
  const rows = await db.all<Note>(
    `SELECT ${NOTE_COLUMNS} FROM note WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return rows.length === 0 ? null : rows[0];
}

/** Insert a note and return it. */
async function createNote(input: NoteInput): Promise<Note> {
  const now = new Date().toISOString();
  const note: Note = {
    id: newId(),
    title: noteTitle(input.title, input.bodyMd),
    body_md: input.bodyMd,
    pinned: input.pinned ? 1 : 0,
    tags_json: JSON.stringify(input.tags),
    person_id: input.personId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await db.run(
    `INSERT INTO note (${NOTE_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      note.id, note.title, note.body_md, note.pinned, note.tags_json,
      note.person_id, note.created_at, note.updated_at, note.deleted_at,
    ],
  );
  return note;
}

/** Apply a partial change; `updated_at` always moves. */
async function updateNote(id: string, patch: Partial<NoteInput>): Promise<Note | null> {
  const current = await getNote(id);
  if (current === null) return null;
  const next: Note = {
    ...current,
    title: patch.title !== undefined || patch.bodyMd !== undefined
      ? noteTitle(patch.title ?? current.title, patch.bodyMd ?? current.body_md)
      : current.title,
    body_md: patch.bodyMd ?? current.body_md,
    pinned: patch.pinned === undefined ? current.pinned : patch.pinned ? 1 : 0,
    tags_json: patch.tags === undefined ? current.tags_json : JSON.stringify(patch.tags),
    person_id: patch.personId === undefined ? current.person_id : patch.personId,
    updated_at: new Date().toISOString(),
  };
  await db.run(
    `UPDATE note SET title=?, body_md=?, pinned=?, tags_json=?, person_id=?, updated_at=? WHERE id=?`,
    [next.title, next.body_md, next.pinned, next.tags_json, next.person_id, next.updated_at, id],
  );
  return next;
}

/**
 * Delete a note for good.
 *
 * Hard delete: the note and its image rows go together, so nothing is left in the
 * file. (The rest of the app still soft-deletes people; notes are the user's own
 * writing and a stale copy has no purpose here.)
 */
async function removeNote(id: string): Promise<void> {
  await db.run('DELETE FROM note_image WHERE note_id = ?', [id]);
  await db.run('DELETE FROM note WHERE id = ?', [id]);
}

/** Images of one note, in insertion order. */
async function listImages(noteId: string): Promise<NoteImage[]> {
  return db.all<NoteImage>(
    'SELECT id, note_id, mime, width, height, created_at FROM note_image WHERE note_id = ? ORDER BY created_at',
    [noteId],
  );
}

/** Fetch one image's bytes. */
async function readImage(imageId: string): Promise<{ meta: NoteImage; blob: Blob } | null> {
  const rows = await db.all<NoteImage & { bytes: Uint8Array }>(
    'SELECT id, note_id, mime, width, height, created_at, bytes FROM note_image WHERE id = ?',
    [imageId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const { bytes, ...meta } = row;
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  // Copy into a fresh ArrayBuffer: TS 5.9's BlobPart rejects ArrayBufferLike
  // (the source view may be backed by a SharedArrayBuffer).
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return { meta: meta as NoteImage, blob: new Blob([copy.buffer], { type: meta.mime }) };
}

/** Store an already-compressed image. */
async function addImage(
  noteId: string,
  bytes: Uint8Array,
  mime: string,
  width: number,
  height: number,
): Promise<NoteImage> {
  const image: NoteImage = {
    id: newId(),
    note_id: noteId,
    mime,
    width,
    height,
    created_at: new Date().toISOString(),
  };
  await db.run(
    'INSERT INTO note_image (id, note_id, mime, width, height, bytes, created_at) VALUES (?,?,?,?,?,?,?)',
    [image.id, image.note_id, image.mime, image.width, image.height, bytes, image.created_at],
  );
  return image;
}

/** Remove one image (used when the user deletes a marker from the body). */
async function removeImage(imageId: string): Promise<void> {
  await db.run('DELETE FROM note_image WHERE id = ?', [imageId]);
}

/**
 * Drop image rows whose marker no longer appears in the body.
 *
 * Editing markdown by hand (or deleting a `![](note-image:…)` line) would otherwise
 * leave the bytes orphaned in the database forever.
 *
 * @param noteId - note to reconcile.
 * @returns How many rows were removed.
 */
async function pruneImages(noteId: string): Promise<number> {
  const note = await getNote(noteId);
  if (note === null) return 0;
  const referenced = new Set(
    [...note.body_md.matchAll(/!\[[^\]]*\]\(note-image:([^)]+)\)/g)].map((match) => match[1]),
  );
  const images = await listImages(noteId);
  let removed = 0;
  for (const image of images) {
    if (referenced.has(image.id)) continue;
    await removeImage(image.id);
    removed += 1;
  }
  return removed;
}

/**
 * Compress an image in the browser before it reaches the database.
 *
 * Longest edge ≤ 1920px, WebP when the browser can encode it (JPEG otherwise).
 * Doing this first is what keeps a nine-photo note to a few hundred KB.
 */
async function compressImage(file: File): Promise<{
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  name: string;
}> {
  // `createImageBitmap` is the fast path, but it cannot decode SVG (and a few
  // exotic formats). Fall back to an <img> decode for those instead of failing
  // the upload outright.
  let drawSource: CanvasImageSource;
  let naturalWidth: number;
  let naturalHeight: number;
  let release = (): void => {};
  try {
    const bitmap = await createImageBitmap(file);
    drawSource = bitmap;
    naturalWidth = bitmap.width;
    naturalHeight = bitmap.height;
    release = () => bitmap.close?.();
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('无法解码这张图片'));
        element.src = url;
      });
      drawSource = image;
      naturalWidth = image.naturalWidth || 512;
      naturalHeight = image.naturalHeight || 512;
      release = () => URL.revokeObjectURL(url);
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('无法获取画布上下文');
  context.drawImage(drawSource, 0, 0, width, height);
  release();

  const encode = (mime: string, quality: number): Promise<Blob | null> =>
    new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), mime, quality));

  let blob = await encode('image/webp', IMAGE_QUALITY);
  let mime = 'image/webp';
  if (blob === null || blob.size === 0) {
    blob = await encode('image/jpeg', 0.85);
    mime = 'image/jpeg';
  }
  if (blob === null) throw new Error('浏览器无法编码图片');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const base = file.name.replace(/\.[^.]+$/, '') || 'image';
  return { bytes, mime, width, height, name: `${base}.${mime === 'image/webp' ? 'webp' : 'jpg'}` };
}

/** Insert one image into a note and return the markdown marker to paste. */
async function insertImage(
  noteId: string,
  file: File,
): Promise<{ image: NoteImage; marker: string }> {
  const compressed = await compressImage(file);
  const image = await addImage(noteId, compressed.bytes, compressed.mime, compressed.width, compressed.height);
  return { image, marker: `![${compressed.name}](${NOTE_IMAGE_SCHEME}${image.id})\n` };
}

/**
 * Export every note as one Markdown document.
 *
 * Front matter carries the fields plain Markdown cannot express (pin, tags, linked
 * person), so a round trip through `importMarkdown` restores the list faithfully.
 */
/** Separator written between exported notes; cannot collide with user text. */
const NOTE_SEPARATOR = '<!-- jvs-note -->';

/**
 * Export every note as one Markdown document.
 *
 * Each note is introduced by NOTE_SEPARATOR and a front-matter block carrying the
 * fields plain Markdown cannot express (pin, tags, linked person), so an
 * export → import round trip restores the list faithfully.
 */
async function exportMarkdown(): Promise<string> {
  const notes = await listNotes();
  const parts: string[] = ['# JVS 笔记导出', ''];
  for (const note of notes) {
    parts.push(
      NOTE_SEPARATOR,
      '---',
      `title: ${JSON.stringify(noteTitle(note.title, note.body_md))}`,
      `tags: ${JSON.stringify(noteTags(note))}`,
      `pinned: ${note.pinned === 1 ? 'true' : 'false'}`,
      `person: ${note.person_id === null ? 'null' : JSON.stringify(note.person_id)}`,
      `created: ${note.created_at}`,
      `updated: ${note.updated_at}`,
      '---',
      '',
      note.body_md,
      '',
    );
  }
  return parts.join('\n');
}

interface ParsedChunk {
  meta: Record<string, string>;
  body: string;
}

/** Split one chunk into front matter and body; null when it holds nothing. */
function parseChunk(raw: string): ParsedChunk | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('# JVS 笔记导出')) return null;

  const frontMatter = /^---\n([\s\S]*?)\n---\n?/.exec(trimmed);
  if (frontMatter !== null) {
    const meta: Record<string, string> = {};
    for (const line of (frontMatter[1] ?? '').split('\n')) {
      const at = line.indexOf(':');
      if (at < 0) continue;
      meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return { meta, body: trimmed.slice(frontMatter[0].length).trim() };
  }

  // Loose `key: value` header lines (hand-written imports).
  const meta: Record<string, string> = {};
  const rest: string[] = [];
  for (const line of trimmed.split('\n')) {
    const match = /^(title|tags|pinned|person|created|updated):/.exec(line);
    if (match === null) {
      rest.push(line);
      continue;
    }
    const at = line.indexOf(':');
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const body = rest.join('\n').trim();
  if (body === '' && Object.keys(meta).length === 0) return null;
  return { meta, body };
}

/**
 * Import notes from `exportMarkdown` output, or from a plain Markdown document.
 *
 * A plain document becomes a single note: splitting on `---` would mistake a
 * horizontal rule for a note boundary.
 *
 * @param text - markdown document.
 * @param mode - `merge` skips an identical title+body, `append` always adds.
 * @returns How many notes were written.
 */
async function importMarkdown(text: string, mode: 'merge' | 'append' = 'merge'): Promise<number> {
  const existing = await listNotes();
  const known = new Set(existing.map((note) => `${noteTitle(note.title, note.body_md)}|${note.body_md}`));
  const chunks = text.includes(NOTE_SEPARATOR) ? text.split(NOTE_SEPARATOR) : [text];
  let written = 0;

  for (const chunk of chunks) {
    const parsed = parseChunk(chunk);
    if (parsed === null) continue;
    const { meta, body } = parsed;
    if (body === '') continue;

    const titlePart = meta.title !== undefined ? (JSON.parse(meta.title) as string) : '';
    let tagsPart: string[] = [];
    if (meta.tags !== undefined) {
      try {
        const parsedTags: unknown = JSON.parse(meta.tags);
        if (Array.isArray(parsedTags)) tagsPart = parsedTags.filter((tag): tag is string => typeof tag === 'string');
      } catch {
        tagsPart = [];
      }
    }
    let personPart: string | null = null;
    if (meta.person !== undefined && meta.person !== 'null') {
      try {
        personPart = JSON.parse(meta.person) as string;
      } catch {
        personPart = null;
      }
    }

    const key = `${noteTitle(titlePart, body)}|${body}`;
    if (mode === 'merge' && known.has(key)) continue;
    await createNote({
      title: titlePart,
      bodyMd: body,
      tags: tagsPart,
      pinned: meta.pinned === 'true',
      personId: personPart,
    });
    known.add(key);
    written += 1;
  }
  return written;
}


/** Notes linked to one person (shown in the family detail panel). */
async function notesOfPerson(personId: string): Promise<Note[]> {
  return db.all<Note>(
    `SELECT ${NOTE_COLUMNS} FROM note WHERE deleted_at IS NULL AND person_id = ? ORDER BY updated_at DESC`,
    [personId],
  );
}

export const NoteRepository = {
  list: listNotes,
  get: getNote,
  create: createNote,
  update: updateNote,
  remove: removeNote,
  listImages,
  readImage,
  addImage,
  removeImage,
  pruneImages,
  insertImage,
  exportMarkdown,
  importMarkdown,
  notesOfPerson,
};
