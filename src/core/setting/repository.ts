/**
 * Small key/value preferences, stored in SQLite so they survive a restart and
 * travel with the database.
 */

import { db } from '../db/client.js';

/** Read a preference. */
export async function getSetting(key: string): Promise<string | null> {
  const rows = await db.all<{ value: string | null }>('SELECT value FROM setting WHERE key = ?', [key]);
  return rows.length === 0 ? null : rows[0].value;
}

/** Write a preference. */
export async function setSetting(key: string, value: string): Promise<void> {
  await db.run(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

/** Preference key holding the last birth timezone the user picked. */
export const KEY_BIRTH_TIMEZONE = 'birthTimezone';

/** Default birth timezone: 东八区 (北京/上海). */
export const FALLBACK_BIRTH_TIMEZONE = 'Asia/Shanghai';