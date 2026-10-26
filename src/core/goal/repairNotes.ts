/**
 * Repair check-in notes that were written before the book was attached.
 *
 * The user already had a note from a check-in that recorded 「读书打卡」 without the
 * book. This walks the existing check-ins, and for each linked note that is
 * missing its book header or tags, adds them — idempotently, so running every time
 * the goal page opens is harmless and a note that already has the header is left
 * alone.
 */

import { NoteRepository } from '../note/repository.js';
import { noteTags, type Note } from '../note/types.js';
import { buildCheckInBody, buildCheckInTags, checkInNoteTitle, stripTrailingHash, wrapBookName } from './noteFormat.js';
import { GoalRepository, type Goal, type GoalSub } from './repository.js';

/** Prefix the note body with 「#《书名》」 when it is missing. */
function withBookHeader(bodyMd: string, bookName: string): string {
  const book = wrapBookName(bookName);
  if (book === '') return bodyMd;
  const trimmed = bodyMd.trimStart();
  if (trimmed.startsWith(`#${book}`)) return bodyMd;
  // 旧笔记的正文是「内容 + #」，把书名块插到最前面，保持结尾的 # 不变。
  return `#${book}\n\n${trimmed}`;
}

/**
 * Bring one note in line with its check-in.
 *
 * @returns true when the note was updated.
 */
async function repairOne(note: Note, goal: Goal, bookName: string): Promise<boolean> {
  const existing = noteTags(note);
  const wanted = buildCheckInTags(bookName, goal.title, []);
  const missingTags = wanted.filter((tag) => !existing.includes(tag));
  const cleaned = stripTrailingHash(note.body_md);
  const body = bookName.trim() === '' ? cleaned : withBookHeader(cleaned, bookName);
  // 标题只在还是默认「读书打卡」时才补书名，避免覆盖用户自己改过的标题。
  const defaultTitle = '读书打卡';
  const title = note.title.trim() === defaultTitle
    ? checkInNoteTitle(bookName)
    : note.title;
  if (missingTags.length === 0 && body === note.body_md && title === note.title) return false;
  await NoteRepository.update(note.id, {
    title,
    bodyMd: body,
    tags: [...existing, ...missingTags],
  });
  return true;
}

/**
 * Fix every check-in note that predates the book being attached.
 *
 * @returns how many notes were repaired.
 */
export async function repairCheckInNotes(): Promise<number> {
  const goals = await GoalRepository.list();
  let repaired = 0;
  for (const goal of goals) {
    const [logs, subs] = await Promise.all([
      GoalRepository.listLogs(goal.id),
      GoalRepository.listSubs(goal.id),
    ]);
    for (const log of logs) {
      if (log.note_id === null) continue;
      const sub: GoalSub | undefined = subs.find((candidate) => candidate.id === log.sub_id);
      const bookName = sub?.name ?? (subs.length === 1 ? subs[0]?.name ?? '' : '');
      const note = await NoteRepository.get(log.note_id);
      if (note === null) continue;
      if (await repairOne(note, goal, bookName)) repaired += 1;
    }
  }
  return repaired;
}

/**
 * The body/tags a note should have for a check-in — exported for tests.
 *
 * @param content - the note content.
 * @param bookName - sub-goal name, may be empty.
 * @param goalTitle - the goal title.
 * @returns The expected body and tags.
 */
export function expectedNoteShape(
  content: string,
  bookName: string,
  goalTitle: string,
): { body: string; tags: string[] } {
  return {
    body: buildCheckInBody(bookName, content),
    tags: buildCheckInTags(bookName, goalTitle),
  };
}