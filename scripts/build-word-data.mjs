/**
 * 从 word-atlas 的开放词库生成 JVS 可用的词条数据文件。
 *
 * 输入：<atlas>/public/atlas/entries/*.json（73 个分片，每片 100 词）
 * 输出：src/core/word/data/entry-<n>.json（供 App 首次启动时灌进 SQLite）
 *
 * 只搬运「文本」：插画和音频有 551 MB，绝不进仓库，运行时按需从媒体源取。
 *
 * 用法：
 *   node scripts/build-word-data.mjs [word-atlas 路径]
 *   默认路径 ../word-atlas
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ATLAS_ROOT = resolve(process.argv[2] ?? '../word-atlas');
const ENTRIES_DIR = join(ATLAS_ROOT, 'public/atlas/entries');
const INDEX_FILE = join(ATLAS_ROOT, 'public/atlas/index.json');
const OUT_DIR = resolve('public/word-data');

if (!existsSync(ENTRIES_DIR)) {
  console.error(`找不到词库：${ENTRIES_DIR}`);
  process.exit(1);
}

/** 把 word-atlas 的词条压成 JVS 的紧凑行格式，省掉重复的键名。 */
function toRow(entry, ord) {
  return {
    id: entry.id,
    w: entry.w,
    uk: entry.uk ?? '',
    us: entry.us ?? '',
    cefr: entry.cefr ?? '',
    topic: entry.topic ?? '',
    // 媒体位标志原样保留：1 插画、2 英音、4 美音、8 例句、16 第二例句
    m: entry.m ?? 0,
    senses: (entry.senses ?? []).map((s) => ({ pos: s.pos ?? '', zh: s.zh ?? '', en: s.en ?? '' })),
    ex: (entry.ex ?? []).map((e) => ({ en: e.en ?? '', zh: e.zh ?? '' })),
    col: entry.col ?? [],
    fam: entry.fam ?? [],
    syn: entry.syn ?? [],
    ant: entry.ant ?? [],
    tip: entry.tip ?? '',
    note: entry.note ?? '',
    ord,
  };
}

const index = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
const chunks = readdirSync(ENTRIES_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort((a, b) => Number(a.replace('.json', '')) - Number(b.replace('.json', '')));

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

let ord = 0;
let written = 0;
let bytes = 0;
const shards = [];

for (const file of chunks) {
  const list = JSON.parse(readFileSync(join(ENTRIES_DIR, file), 'utf8'));
  const rows = list.map((entry) => toRow(entry, ord++));
  // 每个分片单独成文件：App 首次导入时逐片灌库，避免一次性解析 7 MB。
  const outName = `entry-${file}`;
  const payload = JSON.stringify(rows);
  writeFileSync(join(OUT_DIR, outName), payload, 'utf8');
  written += rows.length;
  bytes += Buffer.byteLength(payload);
  shards.push({ file: outName, count: rows.length });
}

/** 目录索引：App 按顺序读这些分片。 */
const manifest = {
  source: 'word-atlas',
  license: 'CC BY 4.0',
  attribution: '词条、例句与插画来自 word-atlas（https://github.com/designfuchen/word-atlas）',
  count: written,
  shards,
};
writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

console.log(`  词条总数: ${written}`);
console.log(`  分片数:   ${shards.length}`);
console.log(`  数据体积: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`  原始索引: ${index.count} 词 / ${index.examples} 例句（仅作校验）`);
console.log(`  输出目录: ${OUT_DIR}`);
if (written !== index.count) {
  console.error(`  ⚠ 词条数不一致：导出 ${written}，索引声明 ${index.count}`);
  process.exitCode = 1;
}
