/**
 * SQLite engine, transport-agnostic.
 *
 * OPFS `opfs-sahpool` takes EXCLUSIVE synchronous access handles on its pool
 * directory, so only ONE worker in the whole origin may own the database. That is
 * why the engine is opened exactly once here and shared by every tab through a
 * SharedWorker — two tabs each opening their own worker fails with
 * "Access Handles cannot be created if there is another open Access Handle".
 *
 * Also: `db.exec({ sql, bind, rowMode, returnValue })` is the current API;
 * `PreparedStatement.run()` no longer exists.
 */

import initSqlite from '@sqlite.org/sqlite-wasm';
import { DDL, DDL_INDEXES, PERSON_COLUMN_ADDITIONS, REQUIRED_PERSON_COLUMNS, REQUIRED_TABLES, SCHEMA_VERSION } from './schema.js';
import type { DbInfo, DbRequest, DbResponse } from './protocol.js';

export interface ExecOptions {
  sql: string;
  bind?: unknown[];
  rowMode?: 'object' | 'array';
  returnValue?: 'this' | 'resultRows';
}

export interface DbHandle {
  exec(arg: string | ExecOptions): unknown;
}

export interface Engine {
  db: DbHandle;
  info: DbInfo;
}

let enginePromise: Promise<Engine> | null = null;

/** Open (once) the shared database. */
export function openEngine(): Promise<Engine> {
  enginePromise ??= (async () => {
    const sqlite3 = await initSqlite();
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'jvs', initialCapacity: 8 });
    const handle = new pool.OpfsSAHPoolDb('/jvs.db') as unknown as DbHandle;
    migrate(handle);
    return { db: handle, info: { vfs: 'opfs-sahpool', persistent: true, dbFile: '/jvs.db' } };
  })();
  return enginePromise;
}

/** Run one request against the engine. Throws on failure. */
export async function handleRequest(request: DbRequest): Promise<DbResponse> {
  const { db } = await openEngine();
  if (request.kind === 'all') {
    const rows = db.exec({
      sql: request.sql,
      bind: request.params ?? [],
      rowMode: 'object',
      returnValue: 'resultRows',
    });
    return { id: request.id, ok: true, value: rows };
  }
  if (request.kind === 'run') {
    db.exec({ sql: request.sql, bind: request.params ?? [] });
    return { id: request.id, ok: true, value: { changes: 0, lastInsertRowid: 0 } };
  }
  db.exec(request.sql);
  return { id: request.id, ok: true };
}

/**
 * Turn a low-level failure into something a user can act on.
 * @param error - whatever was thrown.
 * @returns A readable message.
 */
/**
 * Bring an existing database up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` covers fresh databases, but an older one already
 * has a `person` table without the v2 columns — and those never get added by a
 * create-if-not-exists. So the columns are reconciled explicitly from
 * PRAGMA table_info, which is idempotent and safe to run on every open.
 *
 * @param handle - database handle.
 */
function migrate(handle: DbHandle): void {
  // 1) Tables first. `CREATE TABLE IF NOT EXISTS` leaves an OLD table untouched,
  //    so a v1 database comes out of this step still missing the v2 columns.
  handle.exec(DDL);

  // 2) Reconcile the person columns explicitly.
  const before = handle.exec({
    sql: 'PRAGMA table_info(person)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;
  const existing = new Set(before.map((column) => column.name));
  for (const addition of PERSON_COLUMN_ADDITIONS) {
    if (!existing.has(addition.name)) handle.exec(addition.ddl);
  }

  // 3) Indexes LAST. They reference v2 columns, so creating them before step 2
  //    fails with "no such column: generation" on an old database — and because a
  //    batch stops at the first error, that abort used to leave the migration
  //    half-done and the app unable to start.
  handle.exec(DDL_INDEXES);

  // v1's parent/spouse edge table was never written to (no UI existed for it) and
  // is superseded by family/family_child.
  handle.exec('DROP TABLE IF EXISTS relation');

  // 4) Verify, so a partial migration fails here with a precise message instead
  //    of surfacing later as a puzzling "no such column" on some query.
  const after = handle.exec({
    sql: 'PRAGMA table_info(person)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;
  const present = new Set(after.map((column) => column.name));
  const missing = REQUIRED_PERSON_COLUMNS.filter((name) => !present.has(name));
  const tableRows = handle.exec({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table'",
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ name: string }>;
  const presentTables = new Set(tableRows.map((row) => row.name));
  const missingTables = REQUIRED_TABLES.filter((name) => !presentTables.has(name));
  if (missingTables.length > 0) {
    throw new Error(`数据库迁移未完成，缺少表：${missingTables.join(', ')}`);
  }

  if (missing.length > 0) {
    throw new Error(`数据库迁移未完成，person 表缺少列：${missing.join(', ')}`);
  }

  handle.exec({
    sql: `INSERT INTO app_meta (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    bind: ['schema_version', String(SCHEMA_VERSION)],
  });
}

export function describeDbError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/NoModificationAllowedError|Access Handles cannot be created/i.test(message)) {
    return '数据库正被另一个窗口占用（OPFS 独占访问）。请关闭其他标签页后点「重试」。';
  }
  if (/removeEntry|removeVfs/i.test(message)) {
    return '数据库文件被占用，无法完成初始化。请关闭其他标签页后重试。';
  }
  return message;
}