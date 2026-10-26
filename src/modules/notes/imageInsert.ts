/**
 * Insert one or more images at the caret of a note body.
 *
 * Shared by the composer (a fresh draft) and the card editor (an existing note) so
 * the cap, the marker format and the caret handling live in one place.
 */

import { NoteRepository } from '../../core/note/repository.js';
import { MAX_NOTE_IMAGES, countNoteImages } from '../../core/note/types.js';

export interface InsertImagesArgs {
  noteId: string;
  files: File[];
  body: string;
  start: number;
  end: number;
}

export interface InsertImagesResult {
  body: string;
  cursor: number;
  rejected: number;
}

/**
 * Upload images and splice their markers into the body.
 * @param args - note id, files, body and the current selection.
 * @returns The merged body, the new caret position, and how many files were refused.
 */
export async function insertImagesIntoBody(args: InsertImagesArgs): Promise<InsertImagesResult> {
  const remaining = MAX_NOTE_IMAGES - countNoteImages(args.body);
  if (remaining <= 0) {
    throw new Error(`单篇笔记最多 ${MAX_NOTE_IMAGES} 张图片，已达上限`);
  }
  const accepted = args.files.slice(0, remaining);
  const rejected = args.files.length - accepted.length;
  const markers: string[] = [];
  for (const file of accepted) {
    const { marker } = await NoteRepository.insertImage(args.noteId, file);
    markers.push(marker);
  }
  const inserted = markers.join('');
  const body = `${args.body.slice(0, args.start)}${inserted}${args.body.slice(args.end)}`;
  return { body, cursor: args.start + inserted.length, rejected };
}
