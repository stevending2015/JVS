/**
 * Notes: a markdown document with tags, a pin flag and optional attachments.
 *
 * The row shape mirrors the `note` table. Tags are stored as JSON because SQLite
 * has no array type and the set is small; every read goes through `noteTags()`
 * so a corrupt value can never crash the list.
 */

export interface Note {
  id: string;
  title: string;
  body_md: string;
  pinned: number;
  tags_json: string | null;
  person_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** What the editor hands to the repository. */
export interface NoteInput {
  title: string;
  bodyMd: string;
  tags: string[];
  pinned: boolean;
  personId: string | null;
}

/** Metadata for one stored image (the bytes stay in the database). */
export interface NoteImage {
  id: string;
  note_id: string;
  mime: string;
  width: number;
  height: number;
  created_at: string;
}

/** URL scheme used inside markdown so a stored image can be recognised. */
export const NOTE_IMAGE_SCHEME = 'note-image:';

/** Images allowed per note; enforced before upload and when inserting markers. */
export const MAX_NOTE_IMAGES = 9;
/** Longest edge kept when compressing; larger photos are downscaled first. */
export const MAX_IMAGE_EDGE = 1920;
/** WebP quality used for the stored copy. */
export const IMAGE_QUALITY = 0.82;

/** Notes per page in the list. */
export const NOTES_PAGE_SIZE = 10;

/** Parse `tags_json`, tolerating null and malformed values. */
export function noteTags(note: Note): string[] {
  if (note.tags_json === null || note.tags_json === '') return [];
  try {
    const parsed: unknown = JSON.parse(note.tags_json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((tag): tag is string => typeof tag === 'string' && tag !== '');
  } catch {
    return [];
  }
}

/**
 * Title to display.
 *
 * A note saved with an empty title borrows the first line of the body (stripping a
 * leading `# `), which is how a quick composer can offer Enter-to-save without
 * forcing the user to type a title first.
 *
 * @param title - explicit title from the row.
 * @param body - markdown body.
 * @returns Never-empty display title.
 */
export function noteTitle(title: string, body: string): string {
  const explicit = title.trim();
  if (explicit !== '') return explicit;
  const firstLine = body.split('\n')[0]?.trim() ?? '';
  const stripped = firstLine.startsWith('# ') ? firstLine.slice(2).trim() : firstLine;
  return stripped === '' ? '无标题' : stripped;
}

/** Local calendar day (YYYY-MM-DD) of an ISO timestamp. */
export function noteDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Date filter: nothing, one day, or an inclusive range of local days. */
export type DateFilter =
  | { kind: 'none' }
  | { kind: 'single'; day: string }
  | { kind: 'range'; from: string; to: string };

/** True when a day key falls inside the filter. */
export function dateFilterContains(filter: DateFilter, dayKey: string): boolean {
  if (filter.kind === 'none') return true;
  if (filter.kind === 'single') return dayKey === filter.day;
  return dayKey >= filter.from && dayKey <= filter.to;
}

/** Human label for the filter button. */
export function dateFilterLabel(filter: DateFilter): string {
  if (filter.kind === 'none') return '日期';
  if (filter.kind === 'single') return filter.day.replaceAll('-', '/');
  return `${filter.from.replaceAll('-', '/')} – ${filter.to.replaceAll('-', '/')}`;
}

/** Note count per local day, for the calendar's density bars. */
export function countNotesByDay(notes: Note[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of notes) {
    const key = noteDayKey(note.created_at);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Notes grouped by local day, newest day first, pinned first inside a day. */
export function groupNotesByDay(notes: Note[]): Array<{ day: string; items: Note[] }> {
  const groups = new Map<string, Note[]>();
  for (const note of notes) {
    const key = noteDayKey(note.created_at);
    groups.set(key, [...(groups.get(key) ?? []), note]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, items]) => ({ day, items }));
}

/** Count `![...](note-image:...)` markers already in a body. */
export function countNoteImages(body: string): number {
  return (body.match(/!\[[^\]]*\]\(note-image:[^)]+\)/g) ?? []).length;
}
