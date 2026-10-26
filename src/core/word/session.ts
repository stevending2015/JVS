/**
 * 学习会话：算出「今天学哪一组」，并为每个词生成一道题。
 *
 * 组的大小是用户定的：**20–30 个词**，正好对应「只缓存当前这一组媒体」的策略
 * （每组约 1.4–2 MB）。换组就换缓存。
 *
 * 出题方式沿用 word-atlas 的四种：看中文选词义、看图选词、听音选词、拼写。
 * 干扰项从同等级、同话题的词里挑，难度才合适。
 */

import type { WordCard, WordEntry } from './types.js';
import { WORD_MEDIA } from './types.js';

/** 题型。 */
export type QuizKind = 'meaning' | 'picture' | 'listen' | 'spell';

/** 一道题。 */
export interface QuizQuestion {
  entry: WordEntry;
  kind: QuizKind;
  /** 选项（除了拼写题）。 */
  options: string[];
  /** 正确答案在 options 里的下标；拼写题为 -1。 */
  answer: number;
}

/** 今天要学的一组。 */
export interface WordGroup {
  /** 复习词（到期）。 */
  due: Array<{ card: WordCard; entry: WordEntry }>;
  /** 新词。 */
  fresh: WordEntry[];
  /** 这一组的全部词条（预取媒体用）。 */
  entries: WordEntry[];
  /** 预计分钟数，粗略值。 */
  minutes: number;
}

/** 每题的平均秒数，只用于估算。 */
const SECONDS_PER_DUE = 15;
const SECONDS_PER_NEW = 50;

/**
 * 估算一组要花多久。
 *
 * @param due - 复习词数。
 * @param fresh - 新词数。
 * @returns 分钟数（至少 1）。
 */
export function estimateMinutes(due: number, fresh: number): number {
  const seconds = due * SECONDS_PER_DUE + fresh * SECONDS_PER_NEW;
  return Math.max(1, Math.round(seconds / 60));
}

/**
 * 打乱数组（Fisher–Yates，就地）。
 *
 * @param list - 要打乱的数组。
 * @returns 同一个数组。
 */
function shuffle<T>(list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = list[i] as T;
    const b = list[j] as T;
    list[i] = b;
    list[j] = a;
  }
  return list;
}

/**
 * 挑干扰项：优先同话题，其次同等级，最后从全库抓。
 *
 * @param entry - 正确的词。
 * @param pool - 候选词池。
 * @param count - 要几个。
 * @returns 干扰词条。
 */
export function pickDistractors(entry: WordEntry, pool: WordEntry[], count = 3): WordEntry[] {
  const others = pool.filter((candidate) => candidate.id !== entry.id);
  const sameTopic = others.filter((candidate) => candidate.topic === entry.topic);
  const sameLevel = others.filter((candidate) => candidate.cefr === entry.cefr);
  const picked: WordEntry[] = [];
  const seen = new Set<string>([entry.id]);

  for (const source of [sameTopic, sameLevel, others]) {
    for (const candidate of shuffle([...source])) {
      if (picked.length >= count) break;
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      picked.push(candidate);
    }
    if (picked.length >= count) break;
  }
  return picked;
}

/**
 * 为一个词生成一道题。
 *
 * 题型选择跟着卡片状态走：新词以「看中文选词」为主（先建立形音义联系），
 * 复习阶段引入听音和拼写。
 *
 * @param entry - 要考的词。
 * @param card - 它的卡片状态（新词传 undefined）。
 * @param pool - 干扰项来源。
 * @returns 题目。
 */
export function buildQuestion(
  entry: WordEntry,
  card: WordCard | undefined,
  pool: WordEntry[],
): QuizQuestion {
  const hasImage = (entry.media & WORD_MEDIA.img) !== 0;
  const hasAudio = (entry.media & (WORD_MEDIA.uk | WORD_MEDIA.us)) !== 0;
  // 卡片稳定度 ≥ 4 说明已经认得比较牢，可以上拼写。
  const solid = card !== undefined && card.stability >= 4;

  const roll = Math.random();
  let kind: QuizKind;
  if (solid && roll < 0.3) kind = 'spell';
  else if (hasAudio && roll < 0.55) kind = 'listen';
  else if (hasImage && roll < 0.75) kind = 'picture';
  else kind = 'meaning';

  // 拼写题不给选项。
  if (kind === 'spell') {
    return { entry, kind, options: [], answer: -1 };
  }

  const distractors = pickDistractors(entry, pool, 3);
  const correct = entry.senses[0]?.zh ?? entry.word;
  const options = shuffle([
    correct,
    ...distractors.map((candidate) => candidate.senses[0]?.zh ?? candidate.word),
  ]);

  return {
    entry,
    kind,
    options,
    answer: options.indexOf(correct),
  };
}

/**
 * 把一组词排成题目序列。
 *
 * 复习词排前面（先巩固旧账），新词排后面。
 *
 * @param group - 今天的一组。
 * @param pool - 干扰项来源（一般是全库或词集）。
 * @param cards - 已知卡片，按 word_id 索引。
 * @returns 题目列表。
 */
export function buildQuestions(
  group: WordGroup,
  pool: WordEntry[],
  cards: Map<string, WordCard>,
): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  for (const item of group.due) {
    questions.push(buildQuestion(item.entry, item.card, pool));
  }
  for (const entry of group.fresh) {
    questions.push(buildQuestion(entry, undefined, pool));
  }
  return questions;
}

/**
 * 检查拼写答案（忽略大小写和首尾空格）。
 *
 * @param input - 用户输入。
 * @param entry - 正确的词。
 * @returns 是否答对。
 */
export function checkSpelling(input: string, entry: WordEntry): boolean {
  return input.trim().toLowerCase() === entry.word.trim().toLowerCase();
}
