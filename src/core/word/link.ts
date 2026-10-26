/**
 * 词光 atlas 与其它模块的联动。
 *
 * 三条链路：
 *   1. 笔记 → 生词集：从笔记正文里挑出词库收录的词，组一个私人词集；
 *   2. 读书目标 → 词集：目标的子目标（书名）对应一个词集，打卡笔记里的生词
 *      会自动进这个集；
 *   3. 复习提醒 → 倒计时：把「今天有多少词要复习」做成一条倒计时事项。
 *
 * 这些操作都只写 word_set / word_set_item，不改动笔记和目标本身 —— 联动是
 * 单向的，删掉词集不会影响原文。
 */

import { NoteRepository } from '../note/repository.js';
import { noteTags } from '../note/types.js';
import { newId } from '../util/id.js';
import { extractFromMarkdown } from './extract.js';
import { WordRepository } from './repository.js';
import type { WordSet } from './types.js';

/** 联动结果。 */
export interface LinkResult {
  setId: string;
  setName: string;
  /** 这次新加进去的词数。 */
  added: number;
  /** 一共挑出多少个词。 */
  found: number;
}

/**
 * 取词库里所有小写的词 id，用于从文本里挑词。
 *
 * 7,298 个词一次读进来约 100 KB，缓存住即可。
 *
 * @returns 词 id 集合。
 */
let knownCache: Set<string> | null = null;

async function knownWordIds(): Promise<Set<string>> {
  if (knownCache !== null) return knownCache;
  const ids = await WordRepository.allWordIds();
  knownCache = new Set(ids);
  return knownCache;
}

/** 词库内容变了（重新导入）时清掉缓存。 */
export function resetWordIdCache(): void {
  knownCache = null;
}

/**
 * 从一篇笔记生成（或更新）生词集。
 *
 * 词集名用笔记标题；同一个笔记重复提取会复用同一个集，不会重复建。
 *
 * @param noteId - 笔记 id。
 * @returns 结果；笔记里没有词库收录的词时返回 null。
 */
export async function createSetFromNote(noteId: string): Promise<LinkResult | null> {
  const note = await NoteRepository.get(noteId);
  if (note === null) return null;

  const known = await knownWordIds();
  // 标题里也可能有生词（「读 The Little Prince」），一起扫。
  const ids = extractFromMarkdown(`${note.title}\n${note.body_md}`, known);
  if (ids.length === 0) return null;

  const set = await WordRepository.ensureSet(`笔记 · ${note.title}`, 'note', note.id);
  const added = await WordRepository.addToSet(set.id, ids);
  return { setId: set.id, setName: set.name, added, found: ids.length };
}

/**
 * 从读书目标的子目标（书名）生成词集。
 *
 * 集名就是书名，这样和打卡笔记里的《书名》对得上。
 *
 * @param goalSubId - 子目标 id。
 * @param bookName - 书名。
 * @returns 词集。
 */
export async function createSetForBook(goalSubId: string, bookName: string): Promise<WordSet> {
  return WordRepository.ensureSet(`《${bookName}》`, 'goal', goalSubId);
}

/**
 * 把一篇笔记里的生词归到某个词集（读书打卡的方向）。
 *
 * @param noteId - 笔记 id。
 * @param setId - 目标词集。
 * @returns 加进去的词数。
 */
export async function addNoteWordsToSet(noteId: string, setId: string): Promise<number> {
  const note = await NoteRepository.get(noteId);
  if (note === null) return 0;
  const known = await knownWordIds();
  const ids = extractFromMarkdown(`${note.title}\n${note.body_md}`, known);
  if (ids.length === 0) return 0;
  return WordRepository.addToSet(setId, ids);
}

/**
 * 按标签找笔记组成的词集（例如「读书」标签下的所有笔记）。
 *
 * @param tag - 标签。
 * @returns 结果；没有词就返回 null。
 */
export async function createSetFromTag(tag: string): Promise<LinkResult | null> {
  const notes = await NoteRepository.list();
  const known = await knownWordIds();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const note of notes) {
    if (!noteTags(note).includes(tag)) continue;
    for (const id of extractFromMarkdown(`${note.title}\n${note.body_md}`, known)) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) return null;
  const set = await WordRepository.ensureSet(`标签 · ${tag}`, 'note', `tag:${tag}`);
  const added = await WordRepository.addToSet(set.id, ids);
  return { setId: set.id, setName: set.name, added, found: ids.length };
}

/** 复习提醒的标题前缀，倒计时里靠它认出自己。 */
export const REVIEW_REMINDER_PREFIX = '背单词复习';

/**
 * 生成今天的复习提醒文案。
 *
 * 只要学过词就能提醒：有待复习的就报数量，没有的就提醒「温习已学词汇」——
 * 刚背完的那一刻 due 通常是 1 分钟后，此时按钮不该变成不可用。
 *
 * @param now - 当前时间。
 * @returns 提醒标题；一个词都没学过时返回 null。
 */
export async function buildReviewReminder(now = Date.now()): Promise<{ title: string; count: number } | null> {
  const summary = await WordRepository.summary(now);
  if (summary.learned === 0) return null;
  if (summary.due === 0) {
    return { title: `${REVIEW_REMINDER_PREFIX} · 温习已学 ${summary.learned} 词`, count: 0 };
  }
  return { title: `${REVIEW_REMINDER_PREFIX} · ${summary.due} 个待复习`, count: summary.due };
}

/** 新建一个 ID（供需要预生成 id 的调用方用）。 */
export function nextSetId(): string {
  return newId();
}
