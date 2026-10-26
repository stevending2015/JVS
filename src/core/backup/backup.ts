/**
 * 逻辑备份：把整个数据库导出成一份可读的 JSON。
 *
 * 为什么不用原始 .sqlite 文件：逻辑备份能在**清空本地数据之前**先校验格式、
 * 版本、表和行数，把「这个文件里到底有什么」展示给用户，再让他确认覆盖。
 * 原始文件要验证内容就得先挂载/替换，风险和代码量都高得多。
 *
 * BLOB（笔记图片）在 JSON 里用 `{"$blob": "<base64>"}` 表示，导入时还原。
 */

import { db } from '../db/client.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { passwordFingerprint } from '../security/password.js';

/** 备份格式标识。 */
export const BACKUP_FORMAT = 'jvs-backup';
/** 备份格式版本。 */
export const BACKUP_VERSION = 1;
/** 建议的文件后缀。 */
export const BACKUP_EXTENSION = 'jvsbackup';

/** 备份文件里不需要的表：纯缓存，导入它没有意义。 */
export const SKIPPED_TABLES = ['weather_cache'];

/** 参与备份的表，顺序即导入时的插入顺序（父表在前）。 */
export const BACKUP_TABLES = [
  'person',
  'family',
  'family_child',
  'countdown',
  'note',
  'note_image',
  'focus_session',
  'goal',
  'goal_sub',
  'goal_log',
  'word_entry',
  'word_card',
  'word_day',
  'word_set',
  'word_set_item',
  'word_mistake',
  'setting',
  'app_meta',
] as const;

/** JSON 里的 BLOB 包装。 */
interface BlobValue {
  $blob: string;
}

/** 一条记录。 */
export type BackupRow = Record<string, unknown>;

/** 备份信封。 */
export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** 导出时间（ISO）。 */
  exportedAt: string;
  /** 导出时的 schema 版本。 */
  schemaVersion: number;
  /** 导出时若设了口令，带上哈希指纹 —— 导入方要先验证。 */
  password: { salt: string; hash: string; iterations: number } | null;
  /** 每张表若干行。 */
  tables: Record<string, BackupRow[]>;
  /** 每张表的行数，便于校验与展示。 */
  counts: Record<string, number>;
}

/** 校验结果。 */
export interface BackupInspection {
  ok: boolean;
  /** 失败原因。 */
  error?: string;
  /** 信封本身（校验通过时）。 */
  envelope?: BackupEnvelope;
  /** 需要口令才能导入。 */
  needsPassword: boolean;
  /** 兼容性提示（例如备份来自更新的版本）。 */
  warnings: string[];
  /** 各表行数，用于预览。 */
  counts: Record<string, number>;
  /** 总行数。 */
  totalRows: number;
}

/** Uint8Array → base64。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // 分块，避免超长参数把 String.fromCharCode 爆栈。
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** base64 → Uint8Array。 */
function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * 把一行里的 BLOB 转成可序列化形式。
 *
 * @param row - 数据库行。
 * @returns JSON 友好的行。
 */
function encodeRow(row: BackupRow): BackupRow {
  const out: BackupRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) out[key] = { $blob: bytesToBase64(value) } satisfies BlobValue;
    else if (value instanceof ArrayBuffer) out[key] = { $blob: bytesToBase64(new Uint8Array(value)) } satisfies BlobValue;
    else out[key] = value;
  }
  return out;
}

/**
 * 把一行里的 `$blob` 还原成 Uint8Array。
 *
 * @param row - 备份里的行。
 * @returns 可直接绑定的行。
 */
function decodeRow(row: BackupRow): BackupRow {
  const out: BackupRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && typeof value === 'object' && '$blob' in value) {
      out[key] = base64ToBytes(String((value as BlobValue).$blob));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 导出一份完整备份。
 *
 * @returns 备份信封。
 */
export async function buildBackup(): Promise<BackupEnvelope> {
  const tables: Record<string, BackupRow[]> = {};
  const counts: Record<string, number> = {};

  for (const table of BACKUP_TABLES) {
    const rows = await db.all<BackupRow>(`SELECT * FROM ${table}`);
    tables[table] = rows.map(encodeRow);
    counts[table] = rows.length;
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    password: await passwordFingerprint(),
    tables,
    counts,
  };
}

/**
 * 导出的备份序列化成文本。
 *
 * @returns 带缩进的 JSON。
 */
export async function exportBackupText(): Promise<string> {
  const envelope = await buildBackup();
  return JSON.stringify(envelope);
}

/** 换一个容易认的文件名：jvs-备份-2026-10-26.jvsbackup。 */
export function backupFileName(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `jvs-备份-${date}.${BACKUP_EXTENSION}`;
}

/**
 * 在清空任何数据之前检查一份备份是否合法。
 *
 * @param text - 用户选的文件内容。
 * @returns 检查结果；ok 为 false 时 error 说明原因。
 */
export function inspectBackupText(text: string): BackupInspection {
  const fail = (error: string): BackupInspection => ({
    ok: false,
    error,
    needsPassword: false,
    warnings: [],
    counts: {},
    totalRows: 0,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('不是有效的 JSON 文件 —— 可能选错了文件，或文件已损坏。');
  }

  if (parsed === null || typeof parsed !== 'object') return fail('文件内容不是备份对象。');
  const envelope = parsed as Partial<BackupEnvelope>;

  if (envelope.format !== BACKUP_FORMAT) {
    return fail('这不是 JVS 的备份文件（缺少 jvs-backup 标识）。');
  }
  if (typeof envelope.version !== 'number') return fail('备份缺少版本号。');
  if (envelope.version > BACKUP_VERSION) {
    return fail(`备份格式版本 ${envelope.version} 比当前应用支持的 ${BACKUP_VERSION} 更新，请先升级应用。`);
  }
  if (envelope.tables === null || typeof envelope.tables !== 'object') {
    return fail('备份里没有表数据。');
  }

  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  let totalRows = 0;

  for (const table of BACKUP_TABLES) {
    const rows = (envelope.tables as Record<string, unknown>)[table];
    if (rows === undefined) {
      // app_meta/setting 缺了也不致命，其余表缺了要提醒。
      if (table !== 'app_meta' && table !== 'setting') {
        warnings.push(`缺少表 ${table}（会被当作空表导入）`);
      }
      counts[table] = 0;
      continue;
    }
    if (!Array.isArray(rows)) return fail(`表 ${table} 的数据不是数组。`);
    counts[table] = rows.length;
    totalRows += rows.length;
  }

  if (typeof envelope.schemaVersion === 'number' && envelope.schemaVersion > SCHEMA_VERSION) {
    warnings.push(
      `备份来自更新的数据结构（v${envelope.schemaVersion} > v${SCHEMA_VERSION}），部分字段可能被忽略。`,
    );
  }

  return {
    ok: true,
    envelope: envelope as BackupEnvelope,
    needsPassword: envelope.password !== null && envelope.password !== undefined,
    warnings,
    counts,
    totalRows,
  };
}

/**
 * 清空所有业务表。
 *
 * 先关外键约束，否则按任意顺序 DELETE 可能撞上引用检查；
 * 删完再打开。
 */
async function wipeAll(): Promise<void> {
  await db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const table of [...BACKUP_TABLES].reverse()) {
      await db.run(`DELETE FROM ${table}`);
    }
  } finally {
    await db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * 把备份写进数据库。**会先清空所有现有数据。**
 *
 * @param envelope - 已通过 inspectBackupText 校验的备份。
 * @param onProgress - 进度回调。
 */
export async function restoreBackup(
  envelope: BackupEnvelope,
  onProgress?: (done: number, total: number, table: string) => void,
): Promise<{ inserted: number }> {
  // 先算总行数，用于进度。
  const plans = BACKUP_TABLES.map((table) => ({
    table,
    rows: (envelope.tables[table] ?? []) as BackupRow[],
  })).filter((plan) => plan.rows.length > 0);
  const total = plans.reduce((sum, plan) => sum + plan.rows.length, 0);

  await wipeAll();

  let inserted = 0;
  await db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const plan of plans) {
      for (const raw of plan.rows) {
        const row = decodeRow(raw);
        const columns = Object.keys(row);
        if (columns.length === 0) continue;
        const placeholders = columns.map(() => '?').join(', ');
        await db.run(
          `INSERT INTO ${plan.table} (${columns.join(', ')}) VALUES (${placeholders})`,
          columns.map((column) => row[column]),
        );
        inserted += 1;
        if (inserted % 200 === 0) onProgress?.(inserted, total, plan.table);
      }
      onProgress?.(inserted, total, plan.table);
    }
  } finally {
    await db.exec('PRAGMA foreign_keys = ON');
  }

  return { inserted };
}
