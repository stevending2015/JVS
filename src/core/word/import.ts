/**
 * 词库导入：把 public/word-data 下的分片灌进 SQLite。
 *
 * 为什么要导入而不是每次读 JSON：
 *   - 做题要随机取词、按等级筛、排除学过的 —— 这些用 SQL 一句就够，翻 73 个
 *     JSON 文件则每次都要加载 6.5 MB 到内存。
 *   - 导入只做一次（约 7,298 行），之后所有查询都走数据库索引。
 *
 * 分片逐条导入，每批 500 行：SQLite WASM 在 worker 里，一个巨型事务会让界面
 * 长时间无响应。进度通过回调报给界面。
 */

import { WordRepository } from './repository.js';
import type { WordEntry, WordSense, WordExample } from './types.js';

/** 词条数据的静态目录。 */
const DATA_BASE = '/word-data';

/** manifest.json 的结构。 */
interface WordManifest {
  source: string;
  license: string;
  attribution: string;
  count: number;
  shards: Array<{ file: string; count: number }>;
}

/** 导入进度。 */
export interface ImportProgress {
  /** 已导入词条数。 */
  done: number;
  /** 总词条数。 */
  total: number;
  /** 0–1。 */
  ratio: number;
}

/** 未压缩的中间格式，字段名和 manifest 里的分片一致。 */
interface RawEntry {
  id: string;
  w: string;
  uk: string;
  us: string;
  cefr: string;
  topic: string;
  m: number;
  senses: WordSense[];
  ex: WordExample[];
  col: string[];
  fam: string[];
  syn: string[];
  ant: string[];
  tip: string;
  note: string;
  ord: number;
}

/** 把分片里的紧凑行转成库里的词条。 */
function toEntry(raw: RawEntry): WordEntry {
  return {
    id: raw.id,
    word: raw.w,
    ipa_uk: raw.uk,
    ipa_us: raw.us,
    cefr: raw.cefr,
    topic: raw.topic,
    media: raw.m,
    senses: raw.senses,
    examples: raw.ex,
    collocations: raw.col,
    family: raw.fam,
    synonyms: raw.syn,
    antonyms: raw.ant,
    tip: raw.tip,
    note: raw.note,
    ord: raw.ord,
  };
}

/** 读 manifest；文件不存在说明词库还没生成。 */
export async function readWordManifest(): Promise<WordManifest | null> {
  try {
    const response = await fetch(`${DATA_BASE}/manifest.json`);
    if (!response.ok) return null;
    return (await response.json()) as WordManifest;
  } catch {
    return null;
  }
}

/**
 * 首次启动时导入词库。
 *
 * 已经导入过就直接返回（不重复灌）。
 *
 * @param onProgress - 进度回调。
 * @returns 导入的词条数；已存在时返回 0。
 */
export async function importWordData(
  onProgress?: (progress: ImportProgress) => void,
): Promise<number> {
  if (await WordRepository.isLoaded()) return 0;

  const manifest = await readWordManifest();
  if (manifest === null) throw new Error('找不到词库数据（public/word-data/manifest.json）');

  const total = manifest.count;
  let done = 0;

  // 一个分片 100 词，逐片取、逐片灌：内存里同时只有一个分片。
  for (const shard of manifest.shards) {
    const response = await fetch(`${DATA_BASE}/${shard.file}`);
    if (!response.ok) throw new Error(`词库分片读取失败：${shard.file}`);
    const rows = (await response.json()) as RawEntry[];
    const entries = rows.map(toEntry);
    done += await WordRepository.importEntries(entries, (batchDone, batchTotal) => {
      onProgress?.({
        done: done - batchTotal + batchDone,
        total,
        ratio: (done - batchTotal + batchDone) / total,
      });
    });
  }

  onProgress?.({ done: total, total, ratio: 1 });
  return done;
}

/**
 * 确保词库可用：没导入就导入。
 *
 * @param onProgress - 进度回调。
 * @returns 是否做了导入。
 */
export async function ensureWordData(
  onProgress?: (progress: ImportProgress) => void,
): Promise<boolean> {
  if (await WordRepository.isLoaded()) return false;
  await importWordData(onProgress);
  return true;
}
