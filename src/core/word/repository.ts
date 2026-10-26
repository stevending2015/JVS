/**
 * 词光 atlas 的存储层。
 *
 * 两类数据分开对待：
 *   - 词条（word_entry）是只读的公共词库，由 data/ 下的分片在首次启动时灌入；
 *   - 卡片（word_card）和学习记录是个人的，随做随写。
 *
 * 媒体（插画 / 音频）绝不进这里 —— 它们体积太大，由 core/word/media.ts 按需取。
 */

import { db } from '../db/client.js';
import { newId } from '../util/id.js';
import type {
  WordCard,
  WordDay,
  WordEntry,
  WordExample,
  WordSense,
  WordSet,
  WordSetKind,
} from './types.js';
import { IMPORT_BATCH, wordDayKey } from './types.js';

const ENTRY_COLUMNS =
  'id, word, ipa_uk, ipa_us, cefr, topic, media, senses_json, ex_json, col_json, fam_json, syn_json, ant_json, tip, note, ord';

const CARD_COLUMNS =
  'word_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, first_seen, bookmarked, updated_at';

/** 安全地解析 JSON 数组，坏数据不让整页崩掉。 */
function parseArray<T>(raw: unknown): T[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function entryRow(row: Record<string, unknown>): WordEntry {
  return {
    id: String(row.id ?? ''),
    word: String(row.word ?? ''),
    ipa_uk: String(row.ipa_uk ?? ''),
    ipa_us: String(row.ipa_us ?? ''),
    cefr: String(row.cefr ?? ''),
    topic: String(row.topic ?? ''),
    media: Number(row.media ?? 0),
    senses: parseArray<WordSense>(row.senses_json),
    examples: parseArray<WordExample>(row.ex_json),
    collocations: parseArray<string>(row.col_json),
    family: parseArray<string>(row.fam_json),
    synonyms: parseArray<string>(row.syn_json),
    antonyms: parseArray<string>(row.ant_json),
    tip: String(row.tip ?? ''),
    note: String(row.note ?? ''),
    ord: Number(row.ord ?? 0),
  };
}

function cardRow(row: Record<string, unknown>): WordCard {
  return {
    word_id: String(row.word_id ?? ''),
    due: Number(row.due ?? 0),
    stability: Number(row.stability ?? 0),
    difficulty: Number(row.difficulty ?? 0),
    elapsed_days: Number(row.elapsed_days ?? 0),
    scheduled_days: Number(row.scheduled_days ?? 0),
    learning_steps: Number(row.learning_steps ?? 0),
    reps: Number(row.reps ?? 0),
    lapses: Number(row.lapses ?? 0),
    state: Number(row.state ?? 0) as WordCard['state'],
    last_review: row.last_review === null || row.last_review === undefined ? null : Number(row.last_review),
    first_seen: Number(row.first_seen ?? 0),
    bookmarked: Number(row.bookmarked ?? 0) as 0 | 1,
    updated_at: String(row.updated_at ?? ''),
  };
}

/**
 * 词库里所有词 id（小写）。
 *
 * 用于「从文本里挑出生词」：一次拿全量比逐个查询快得多。
 *
 * @returns 词 id 数组。
 */
async function allWordIds(): Promise<string[]> {
  const rows = await db.all<{ id: string }>('SELECT id FROM word_entry', []);
  return rows.map((row) => String(row.id ?? '').toLowerCase());
}

/** 词库是否已经导入。 */
async function isLoaded(): Promise<boolean> {
  const rows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM word_entry', []);
  return Number(rows[0]?.n ?? 0) > 0;
}

/** 库里有多少词。 */
async function entryCount(): Promise<number> {
  const rows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM word_entry', []);
  return Number(rows[0]?.n ?? 0);
}

/**
 * 批量导入词条。
 *
 * 分片导入而不是一次性插 7,298 行：SQLite WASM 跑在 worker 里，一个巨大事务
 * 会长时间占住数据库，界面上就是「卡住」。
 *
 * @param rows - 词条数组。
 * @param onProgress - 每批完成后回调（已导入数、总数）。
 */
async function importEntries(
  rows: WordEntry[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const total = rows.length;
  let done = 0;
  for (let offset = 0; offset < total; offset += IMPORT_BATCH) {
    const batch = rows.slice(offset, offset + IMPORT_BATCH);
    const values: unknown[] = [];
    const tuples = batch.map((entry) => {
      values.push(
        entry.id, entry.word, entry.ipa_uk, entry.ipa_us, entry.cefr, entry.topic, entry.media,
        JSON.stringify(entry.senses), JSON.stringify(entry.examples), JSON.stringify(entry.collocations),
        JSON.stringify(entry.family), JSON.stringify(entry.synonyms), JSON.stringify(entry.antonyms),
        entry.tip, entry.note, entry.ord,
      );
      return '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
    });
    await db.run(
      `INSERT OR REPLACE INTO word_entry (${ENTRY_COLUMNS}) VALUES ${tuples.join(',')}`,
      values,
    );
    done += batch.length;
    onProgress?.(done, total);
  }
  return done;
}

/** 一次取多个词条（做题时按 id 批量取）。 */
async function entriesByIds(ids: string[]): Promise<WordEntry[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${ENTRY_COLUMNS} FROM word_entry WHERE id IN (${placeholders})`,
    ids,
  );
  return rows.map(entryRow);
}

/** 单条词条。 */
async function entryById(id: string): Promise<WordEntry | null> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${ENTRY_COLUMNS} FROM word_entry WHERE id = ?`,
    [id],
  );
  return rows.length === 0 ? null : entryRow(rows[0]);
}

/**
 * 按单词或中文释义搜索。
 *
 * 前缀匹配走索引式扫描，6,000 多行的表在 OPFS 上很快；中文释义只能全表 LIKE，
 * 但词库固定 7,298 行，实测仍在毫秒级。
 *
 * @param query - 关键词。
 * @param limit - 最多返回多少条。
 * @returns 匹配的词条，按学习路径排序。
 */
async function searchEntries(query: string, limit = 200): Promise<WordEntry[]> {
  const trimmed = query.trim();
  if (trimmed === '') return [];
  const pattern = `%${trimmed}%`;
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${ENTRY_COLUMNS} FROM word_entry
      WHERE word LIKE ? OR senses_json LIKE ?
      ORDER BY ord LIMIT ?`,
    [pattern, pattern, limit],
  );
  return rows.map(entryRow);
}

/**
 * 取「还没学过」的下一批新词。
 *
 * 顺序按 ord（学习路径），所以难度是渐进的；已经建过卡片的会被跳过。
 *
 * @param limit - 取多少个。
 * @param cefr - 可选，只从某个等级取。
 * @returns 新词条。
 */
async function nextNewEntries(limit: number, cefr?: string): Promise<WordEntry[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${ENTRY_COLUMNS} FROM word_entry
      WHERE id NOT IN (SELECT word_id FROM word_card)
        ${cefr === undefined ? '' : 'AND cefr = ?'}
      ORDER BY ord LIMIT ?`,
    cefr === undefined ? [limit] : [cefr, limit],
  );
  return rows.map(entryRow);
}

/**
 * 取今天到期的复习词。
 *
 * @param now - 当前时间。
 * @param limit - 最多取多少。
 * @returns 卡片 + 词条。
 */
async function dueCards(now: number, limit = 200): Promise<Array<{ card: WordCard; entry: WordEntry }>> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${CARD_COLUMNS.split(', ').map((c) => `c.${c}`).join(', ')},
            ${ENTRY_COLUMNS.split(', ').map((c) => `e.${c}`).join(', ')}
       FROM word_card c JOIN word_entry e ON e.id = c.word_id
      WHERE c.due <= ?
      ORDER BY c.due LIMIT ?`,
    [now, limit],
  );
  return rows.map((row) => ({
    card: cardRow({
      word_id: row.word_id, due: row.due, stability: row.stability, difficulty: row.difficulty,
      elapsed_days: row.elapsed_days, scheduled_days: row.scheduled_days,
      learning_steps: row.learning_steps, reps: row.reps, lapses: row.lapses, state: row.state,
      last_review: row.last_review, first_seen: row.first_seen, bookmarked: row.bookmarked,
      updated_at: row.updated_at,
    }),
    entry: entryRow(row),
  }));
}

/** 取一张卡片。 */
async function cardById(wordId: string): Promise<WordCard | null> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${CARD_COLUMNS} FROM word_card WHERE word_id = ?`,
    [wordId],
  );
  return rows.length === 0 ? null : cardRow(rows[0]);
}

/** 写入或更新一张卡片。 */
async function upsertCard(card: WordCard): Promise<void> {
  await db.run(
    `INSERT INTO word_card (${CARD_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(word_id) DO UPDATE SET
       due=excluded.due, stability=excluded.stability, difficulty=excluded.difficulty,
       elapsed_days=excluded.elapsed_days, scheduled_days=excluded.scheduled_days,
       learning_steps=excluded.learning_steps, reps=excluded.reps, lapses=excluded.lapses,
       state=excluded.state, last_review=excluded.last_review, bookmarked=excluded.bookmarked,
       updated_at=excluded.updated_at`,
    [
      card.word_id, card.due, card.stability, card.difficulty, card.elapsed_days,
      card.scheduled_days, card.learning_steps, card.reps, card.lapses, card.state,
      card.last_review, card.first_seen, card.bookmarked, card.updated_at,
    ],
  );
}

/** 切换收藏状态。 */
async function toggleBookmark(wordId: string): Promise<0 | 1> {
  const current = await cardById(wordId);
  const next = current === null || current.bookmarked === 0 ? 1 : 0;
  if (current === null) {
    const now = Date.now();
    await upsertCard({
      word_id: wordId, due: now, stability: 0, difficulty: 0, elapsed_days: 0,
      scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0,
      last_review: null, first_seen: now, bookmarked: next,
      updated_at: new Date().toISOString(),
    });
  } else {
    await db.run(
      'UPDATE word_card SET bookmarked = ?, updated_at = ? WHERE word_id = ?',
      [next, new Date().toISOString(), wordId],
    );
  }
  return next as 0 | 1;
}

/** 收藏的词。 */
async function bookmarkedEntries(): Promise<WordEntry[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${ENTRY_COLUMNS.split(', ').map((c) => `e.${c}`).join(', ')}
       FROM word_card c JOIN word_entry e ON e.id = c.word_id
      WHERE c.bookmarked = 1 ORDER BY c.updated_at DESC`,
    [],
  );
  return rows.map(entryRow);
}

/** 一天的记录（没有就返回零值，不建行）。 */
async function dayStat(day: string): Promise<WordDay> {
  const rows = await db.all<Record<string, unknown>>(
    'SELECT day, new_count, review_count, correct_count, active_seconds FROM word_day WHERE day = ?',
    [day],
  );
  if (rows.length === 0) {
    return { day, new_count: 0, review_count: 0, correct_count: 0, active_seconds: 0 };
  }
  const row = rows[0];
  return {
    day: String(row.day ?? day),
    new_count: Number(row.new_count ?? 0),
    review_count: Number(row.review_count ?? 0),
    correct_count: Number(row.correct_count ?? 0),
    active_seconds: Number(row.active_seconds ?? 0),
  };
}

/**
 * 累加今天的统计。
 *
 * @param patch - 要增加的量。
 */
async function bumpDay(patch: Partial<Omit<WordDay, 'day'>>, day = wordDayKey()): Promise<void> {
  const current = await dayStat(day);
  await db.run(
    `INSERT INTO word_day (day, new_count, review_count, correct_count, active_seconds)
     VALUES (?,?,?,?,?)
     ON CONFLICT(day) DO UPDATE SET
       new_count=excluded.new_count, review_count=excluded.review_count,
       correct_count=excluded.correct_count, active_seconds=excluded.active_seconds`,
    [
      day,
      current.new_count + (patch.new_count ?? 0),
      current.review_count + (patch.review_count ?? 0),
      current.correct_count + (patch.correct_count ?? 0),
      current.active_seconds + (patch.active_seconds ?? 0),
    ],
  );
}

/** 最近 N 天的记录，旧→新。 */
async function recentDays(days: number): Promise<WordDay[]> {
  const rows = await db.all<Record<string, unknown>>(
    'SELECT day, new_count, review_count, correct_count, active_seconds FROM word_day ORDER BY day DESC LIMIT ?',
    [days],
  );
  return rows.map((row) => ({
    day: String(row.day ?? ''),
    new_count: Number(row.new_count ?? 0),
    review_count: Number(row.review_count ?? 0),
    correct_count: Number(row.correct_count ?? 0),
    active_seconds: Number(row.active_seconds ?? 0),
  })).reverse();
}

/** 总体统计：学过多少、掌握多少、待复习多少、收藏多少。 */
async function summary(now: number): Promise<{
  total: number;
  learned: number;
  mastered: number;
  due: number;
  bookmarked: number;
}> {
  const rows = await db.all<Record<string, number>>(
    `SELECT
       (SELECT COUNT(*) FROM word_entry) AS total,
       (SELECT COUNT(*) FROM word_card) AS learned,
       (SELECT COUNT(*) FROM word_card WHERE state = 2 AND stability >= 21) AS mastered,
       (SELECT COUNT(*) FROM word_card WHERE due <= ?) AS due,
       (SELECT COUNT(*) FROM word_card WHERE bookmarked = 1) AS bookmarked`,
    [now],
  );
  const row = rows[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    learned: Number(row.learned ?? 0),
    mastered: Number(row.mastered ?? 0),
    due: Number(row.due ?? 0),
    bookmarked: Number(row.bookmarked ?? 0),
  };
}

/** 记一次错误（错词本）。 */
async function recordMistake(wordId: string, now = Date.now()): Promise<void> {
  await db.run(
    `INSERT INTO word_mistake (word_id, count, last_at) VALUES (?, 1, ?)
     ON CONFLICT(word_id) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
    [wordId, now],
  );
}

/** 错词最多的 N 个词。 */
async function mistakes(limit = 50): Promise<Array<{ entry: WordEntry; count: number }>> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${ENTRY_COLUMNS.split(', ').map((c) => `e.${c}`).join(', ')}, m.count
       FROM word_mistake m JOIN word_entry e ON e.id = m.word_id
      ORDER BY m.count DESC, m.last_at DESC LIMIT ?`,
    [limit],
  );
  return rows.map((row) => ({ entry: entryRow(row), count: Number(row.count ?? 0) }));
}

// ── 词集 ────────────────────────────────────────────────────────────────────

/** 所有词集。 */
async function listSets(): Promise<WordSet[]> {
  const rows = await db.all<Record<string, unknown>>(
    'SELECT id, name, kind, source_id, created_at FROM word_set ORDER BY created_at DESC',
    [],
  );
  return rows.map((row) => ({
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    kind: String(row.kind ?? 'custom') as WordSetKind,
    source_id: row.source_id === null || row.source_id === undefined ? null : String(row.source_id),
    created_at: String(row.created_at ?? ''),
  }));
}

/**
 * 新建词集；同名同来源的已存在就直接返回它。
 *
 * @param name - 词集名字。
 * @param kind - 来源类型。
 * @param sourceId - 来源 id（note / goal_sub）。
 * @returns 词集。
 */
async function ensureSet(name: string, kind: WordSetKind, sourceId: string | null = null): Promise<WordSet> {
  const rows = await db.all<Record<string, unknown>>(
    'SELECT id, name, kind, source_id, created_at FROM word_set WHERE kind = ? AND COALESCE(source_id, \'\') = ?',
    [kind, sourceId ?? ''],
  );
  if (rows.length > 0) {
    const row = rows[0];
    return {
      id: String(row.id ?? ''),
      name: String(row.name ?? ''),
      kind: String(row.kind ?? kind) as WordSetKind,
      source_id: row.source_id === null || row.source_id === undefined ? null : String(row.source_id),
      created_at: String(row.created_at ?? ''),
    };
  }
  const set: WordSet = { id: newId(), name, kind, source_id: sourceId, created_at: new Date().toISOString() };
  await db.run(
    'INSERT INTO word_set (id, name, kind, source_id, created_at) VALUES (?,?,?,?,?)',
    [set.id, set.name, set.kind, set.source_id, set.created_at],
  );
  return set;
}

/** 删掉词集（连同它的词）。 */
async function removeSet(setId: string): Promise<void> {
  await db.run('DELETE FROM word_set_item WHERE set_id = ?', [setId]);
  await db.run('DELETE FROM word_set WHERE id = ?', [setId]);
}

/** 往词集里加词（已存在的跳过）。 */
async function addToSet(setId: string, wordIds: string[]): Promise<number> {
  if (wordIds.length === 0) return 0;
  const now = new Date().toISOString();
  let added = 0;
  for (const wordId of wordIds) {
    await db.run(
      'INSERT OR IGNORE INTO word_set_item (set_id, word_id, added_at) VALUES (?,?,?)',
      [setId, wordId, now],
    );
    added += 1;
  }
  return added;
}

/** 词集里的词条。 */
async function setEntries(setId: string): Promise<WordEntry[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${ENTRY_COLUMNS.split(', ').map((c) => `e.${c}`).join(', ')}
       FROM word_set_item i JOIN word_entry e ON e.id = i.word_id
      WHERE i.set_id = ? ORDER BY i.added_at, e.ord`,
    [setId],
  );
  return rows.map(entryRow);
}

/** 词集里有多少词。 */
async function setSize(setId: string): Promise<number> {
  const rows = await db.all<{ n: number }>(
    'SELECT COUNT(*) AS n FROM word_set_item WHERE set_id = ?',
    [setId],
  );
  return Number(rows[0]?.n ?? 0);
}

export const WordRepository = {
  isLoaded,
  entryCount,
  allWordIds,
  importEntries,
  entriesByIds,
  entryById,
  searchEntries,
  nextNewEntries,
  dueCards,
  cardById,
  upsertCard,
  toggleBookmark,
  bookmarkedEntries,
  dayStat,
  bumpDay,
  recentDays,
  summary,
  recordMistake,
  mistakes,
  listSets,
  ensureSet,
  removeSet,
  addToSet,
  setEntries,
  setSize,
};
