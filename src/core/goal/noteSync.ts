/**
 * Writing a check-in through to the notes module.
 *
 * The rule the user asked for: a reading check-in that carries a note becomes a
 * note tagged with the book it belongs to. The exact format lives in
 * noteFormat.ts (pure, unit-tested); this file only performs the write.
 */

import { NoteRepository } from '../note/repository.js';
import type { Note } from '../note/types.js';
import {
  READING_NOTE_TAG,
  buildCheckInBody,
  buildCheckInTags,
  checkInNoteTitle,
} from './noteFormat.js';

export { READING_NOTE_TAG, buildCheckInBody, buildCheckInTags, checkInNoteTitle, wrapBookName } from './noteFormat.js';

/**
 * Create the note for a check-in.
 *
 * Nothing is written when the content is empty — a check-in without a note stays
 * a check-in, and the notes module is not polluted with empty entries.
 *
 * @param input - book name, content and optional extra tags.
 * @returns The created note, or null when there was nothing to write.
 */
export async function createCheckInNote(input: {
  bookName: string;
  content: string;
  /** 打卡所属目标（如「读书」），会作为标签写进笔记。 */
  goalTitle?: string;
  extraTags?: string[];
}): Promise<Note | null> {
  const body = buildCheckInBody(input.bookName, input.content);
  if (body === '') return null;
  return NoteRepository.create({
    title: checkInNoteTitle(input.bookName),
    bodyMd: body,
    tags: buildCheckInTags(input.bookName, input.goalTitle ?? '', input.extraTags ?? []),
    pinned: false,
    personId: null,
  });
}