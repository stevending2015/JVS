/** Messages between the UI thread and the SQLite worker. */

export interface DbInfo {
  vfs: string;
  persistent: boolean;
  dbFile: string;
}

export type DbRequest =
  | { id: number; kind: 'all'; sql: string; params?: unknown[] }
  | { id: number; kind: 'run'; sql: string; params?: unknown[] }
  | { id: number; kind: 'exec'; sql: string };

export type DbResponse =
  | { id: number; ok: true; value?: unknown }
  | { id: number; ok: false; error: string };