/**
 * FSRS 复习调度。
 *
 * 算法本身来自 word-atlas（它用 ts-fsrs 5.x，参数是 request_retention 0.9、
 * 学习步骤 1m/10m、重学 10m）。这里只做两件事：
 *
 *  1. 把 ts-fsrs 的卡片压成扁平字段存进 SQLite（日期存 epoch 毫秒）；
 *  2. 在 JVS 里提供「下次复习时间」和「各评分对应的间隔」，用于按钮上的提示。
 *
 * 评分沿用 FSRS 的四档：Again / Hard / Good / Easy。
 */

import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from 'ts-fsrs';
import type { WordCard } from './types.js';

export { Rating };
export type { Grade };

/** 缓存不同保留率对应的调度器，避免每次调分都新建。 */
const schedulers = new Map<number, ReturnType<typeof fsrs>>();

function scheduler(retention: number): ReturnType<typeof fsrs> {
  const cached = schedulers.get(retention);
  if (cached !== undefined) return cached;
  const created = fsrs({
    request_retention: retention,
    enable_fuzz: true,
    enable_short_term: true,
    learning_steps: ['1m', '10m'],
    relearning_steps: ['10m'],
  });
  schedulers.set(retention, created);
  return created;
}

/** 把存库的状态转成 ts-fsrs 的 Card。 */
function toCard(card: WordCard): Card {
  return {
    due: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as State,
    last_review: card.last_review === null ? undefined : new Date(card.last_review),
  };
}

/** 把 ts-fsrs 的结果写回扁平状态。 */
function fromCard(card: Card, firstSeen: number): Omit<WordCard, 'word_id' | 'bookmarked' | 'updated_at'> {
  return {
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as WordCard['state'],
    last_review: card.last_review === undefined ? null : card.last_review.getTime(),
    first_seen: firstSeen,
  };
}

/** 一张全新的卡片（首次遇到这个词时创建）。 */
export function newWordCard(
  wordId: string,
  now: number,
): Omit<WordCard, 'updated_at'> {
  const card = createEmptyCard(new Date(now));
  const flat = fromCard(card, now);
  return { word_id: wordId, ...flat, bookmarked: 0 };
}

/**
 * 用一次评分推进卡片。
 *
 * @param prev - 现有状态；没有就当作新卡。
 * @param grade - 四档评分之一。
 * @param now - 当前时间（epoch 毫秒）。
 * @param retention - 目标保留率，默认 0.9。
 * @returns 新状态（不含 word_id / bookmarked / updated_at，由调用方补）。
 */
export function reviewWord(
  prev: WordCard | undefined,
  grade: Grade,
  now: number,
  retention = 0.9,
): Omit<WordCard, 'word_id' | 'bookmarked' | 'updated_at'> {
  const card = prev === undefined ? createEmptyCard(new Date(now)) : toCard(prev);
  const next = scheduler(retention).next(card, new Date(now), grade).card;
  return fromCard(next, prev?.first_seen ?? now);
}

/**
 * 四个评分各自会把下次复习推到多久之后，用于按钮提示。
 *
 * @param prev - 现有状态；没有就当作新卡。
 * @param now - 当前时间。
 * @param retention - 目标保留率。
 * @returns 每个评分对应的间隔毫秒数。
 */
export function previewIntervals(
  prev: WordCard | undefined,
  now: number,
  retention = 0.9,
): Record<Grade, number> {
  const card = prev === undefined ? createEmptyCard(new Date(now)) : toCard(prev);
  const repeat = scheduler(retention).repeat(card, new Date(now));
  return {
    [Rating.Again]: repeat[Rating.Again].card.due.getTime() - now,
    [Rating.Hard]: repeat[Rating.Hard].card.due.getTime() - now,
    [Rating.Good]: repeat[Rating.Good].card.due.getTime() - now,
    [Rating.Easy]: repeat[Rating.Easy].card.due.getTime() - now,
  } as Record<Grade, number>;
}

/**
 * 现在的回忆概率（0–1），用于「这个词你快忘了」这类提示。
 *
 * @param card - 卡片状态。
 * @param now - 当前时间。
 * @param retention - 目标保留率。
 * @returns 0 到 1 之间的数值。
 */
export function retrievability(card: WordCard, now: number, retention = 0.9): number {
  return scheduler(retention).get_retrievability(toCard(card), new Date(now), false) as number;
}

/**
 * 把间隔毫秒转成中文短语，用在评分按钮上。
 *
 * @param ms - 间隔毫秒。
 * @returns 例如「10 分钟」「3 天」「2 个月」。
 */
export function formatInterval(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} 天`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} 个月`;
  return `${(days / 365).toFixed(1)} 年`;
}
