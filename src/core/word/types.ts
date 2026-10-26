/**
 * 词光 atlas 的类型定义。
 *
 * 词条文本来自 word-atlas 的开放词库（CC BY 4.0）；学习和复习状态是 JVS 自己
 * 的数据，落在 SQLite 里。
 */

/** 媒体位标志，与 word-atlas 的 index.json 保持一致。 */
export const WORD_MEDIA = {
  img: 1,
  uk: 2,
  us: 4,
  ex: 8,
  ex2: 16,
} as const;

/** 媒体种类，用作缓存键和文件路径。 */
export type WordMediaKind = 'img' | 'uk' | 'us' | 'ex' | 'ex2';

export interface WordSense {
  pos: string;
  zh: string;
  en: string;
}

export interface WordExample {
  en: string;
  zh: string;
}

/** 一个完整词条。 */
export interface WordEntry {
  id: string;
  word: string;
  ipa_uk: string;
  ipa_us: string;
  cefr: string;
  topic: string;
  /** 媒体位标志，见 {@link WORD_MEDIA}。 */
  media: number;
  senses: WordSense[];
  examples: WordExample[];
  collocations: string[];
  family: string[];
  synonyms: string[];
  antonyms: string[];
  tip: string;
  note: string;
  /** 学习路径里的位置。 */
  ord: number;
}

/** FSRS 卡片状态；日期一律是 epoch 毫秒。 */
export interface WordCard {
  word_id: string;
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  /** 0 新 / 1 学习中 / 2 复习 / 3 重学 */
  state: 0 | 1 | 2 | 3;
  last_review: number | null;
  first_seen: number;
  bookmarked: 0 | 1;
  updated_at: string;
}

/** 一天的学习量。 */
export interface WordDay {
  day: string;
  new_count: number;
  review_count: number;
  correct_count: number;
  active_seconds: number;
}

export type WordSetKind = 'custom' | 'note' | 'goal' | 'all';

/** 一个词集：自己建的、从笔记提取的、或来自读书目标。 */
export interface WordSet {
  id: string;
  name: string;
  kind: WordSetKind;
  /** note.id 或 goal_sub.id，取决于 kind。 */
  source_id: string | null;
  created_at: string;
}

/** 每天计划学习的新词数。 */
export const DAILY_NEW_DEFAULT = 20;

/** 稳定度到这个值就算「已掌握」（约三周后仍有 90% 回忆率）。 */
export const MASTERED_STABILITY = 21;

/** 批量导入时每批的词条数，避免一次事务过大。 */
export const IMPORT_BATCH = 500;

/** 词条是否带某种媒体。 */
export function hasMedia(entry: { media: number }, kind: WordMediaKind): boolean {
  return (entry.media & WORD_MEDIA[kind]) !== 0;
}

/** 本地日键（YYYY-MM-DD），与其它模块一致。 */
export function wordDayKey(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** 这个卡片算不算已掌握。 */
export function isMastered(card: WordCard | undefined): boolean {
  return card !== undefined && card.state === 2 && card.stability >= MASTERED_STABILITY;
}

/** 首个义项的中文，作为列表里的简短释义。 */
export function primaryZh(entry: WordEntry): string {
  return entry.senses[0]?.zh ?? '';
}
