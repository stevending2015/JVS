/**
 * Pure formatting for check-in notes — no database, no imports.
 *
 * Split from noteSync.ts so the format can be unit-tested without loading the
 * SQLite stack.
 */

/** Tag applied to every note produced by a reading check-in. */
export const READING_NOTE_TAG = '读书';

/**
 * Wrap a bare sub-goal name in 《》 — unless the user already typed them.
 *
 * @param name - sub-goal name, e.g. 「小王子」.
 * @returns 「《小王子》」, or '' for an empty name.
 */
export function wrapBookName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '';
  if (/^[《〈]/.test(trimmed) && /[》〉]$/.test(trimmed)) return trimmed;
  return `《${trimmed}》`;
}

/**
 * Remove a trailing standalone `#` line and the blank lines around it.
 *
 * Notes written by an earlier version ended with that marker, which renders as an
 * empty heading — visible noise at the end of every note.
 *
 * @param bodyMd - note body.
 * @returns The body without the trailing marker.
 */
export function stripTrailingHash(bodyMd: string): string {
  const lines = bodyMd.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '#') lines.pop();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

/**
 * Build the markdown body for a check-in note.
 *
 * The shape is the one the user specified:
 *
 *     #《小王子》
 *
 *     笔记内容
 *
 * @param bookName - sub-goal name, e.g. 《小王子》.
 * @param content - what the user wrote.
 * @returns The markdown body, or an empty string when there is nothing to write.
 */
export function buildCheckInBody(bookName: string, content: string): string {
  const trimmed = content.trim();
  if (trimmed === '') return '';
  const book = wrapBookName(bookName);
  const title = book === '' ? '' : `#${book}\n\n`;
  return `${title}${trimmed}`;
}

/**
 * Tags for a check-in note: the reading tag plus the book name.
 *
 * @param bookName - sub-goal name.
 * @param extra - additional tags.
 * @returns Tag list without duplicates.
 */
export function buildCheckInTags(
  bookName: string,
  goalTitle = '',
  extra: string[] = [],
): string[] {
  const tags: string[] = [];
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed !== '' && !tags.includes(trimmed)) tags.push(trimmed);
  };
  // 打卡目标（如「读书」「跑步」）永远作为标签出现，笔记模块里能按目标筛选。
  add(goalTitle);
  const bare = bookName.replace(/[《》〈〉<>"']/g, '').trim();
  if (bare !== '') {
    // 有书名说明是读书类打卡，补上统一的「读书」标签再挂书名。
    add(READING_NOTE_TAG);
    add(bare);
  }
  for (const tag of extra) add(tag);
  return tags;
}

/**
 * The note title a check-in produces.
 * @param bookName - sub-goal name.
 * @returns Display title.
 */
export function checkInNoteTitle(bookName: string): string {
  const book = wrapBookName(bookName);
  return book === '' ? '读书打卡' : `${book} 读书打卡`;
}