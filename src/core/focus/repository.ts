/**
 * Focus sessions (番茄钟 / 正计时).
 *
 * The running timer is derived from `start_time`, never from an in-memory counter.
 * That is what makes a reload — or closing the tab entirely — safe: reopening the
 * app shows the same elapsed time because the truth is a timestamp in the database.
 *
 * `end_time IS NULL` means the session is still running. Only one session may be
 * open at a time, matching masuka's rule.
 */

import { db } from '../db/client.js';
import { newId } from '../util/id.js';

const COLUMNS =
  'id, task_label, mode, planned_seconds, start_time, end_time, duration_seconds, created_at';

export interface FocusSession {
  id: string;
  task_label: string | null;
  /** `pomodoro` counts down to a plan; `stopwatch` counts up. */
  mode: 'pomodoro' | 'stopwatch';
  planned_seconds: number;
  start_time: string;
  /** null while the session is still running. */
  end_time: string | null;
  duration_seconds: number;
  created_at: string;
}

function row(value: Record<string, unknown>): FocusSession {
  return {
    id: String(value.id ?? ''),
    task_label: value.task_label === null || value.task_label === undefined ? null : String(value.task_label),
    mode: value.mode === 'stopwatch' ? 'stopwatch' : 'pomodoro',
    planned_seconds: Number(value.planned_seconds ?? 0),
    start_time: String(value.start_time ?? ''),
    end_time: value.end_time === null || value.end_time === undefined ? null : String(value.end_time),
    duration_seconds: Number(value.duration_seconds ?? 0),
    created_at: String(value.created_at ?? ''),
  };
}

/** The running session, or null. */
async function activeSession(): Promise<FocusSession | null> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM focus_session WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1`,
  );
  return rows.length === 0 ? null : row(rows[0]);
}

/** Recent finished sessions plus any running one, newest first. */
async function listSessions(limit = 100): Promise<FocusSession[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM focus_session ORDER BY start_time DESC LIMIT ?`,
    [limit],
  );
  return rows.map(row);
}

/**
 * Start a session.
 *
 * Refuses when one is already running: two concurrent timers would make "today's
 * total" meaningless.
 */
async function startSession(input: {
  taskLabel: string;
  mode: 'pomodoro' | 'stopwatch';
  plannedSeconds: number;
}): Promise<FocusSession> {
  const running = await activeSession();
  if (running !== null) throw new Error('已有进行中的专注会话，请先结束');
  const now = new Date().toISOString();
  const session: FocusSession = {
    id: newId(),
    task_label: input.taskLabel.trim() === '' ? null : input.taskLabel.trim(),
    mode: input.mode,
    planned_seconds: input.mode === 'stopwatch' ? 0 : Math.max(0, Math.round(input.plannedSeconds)),
    start_time: now,
    end_time: null,
    duration_seconds: 0,
    created_at: now,
  };
  await db.run(
    `INSERT INTO focus_session (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?)`,
    [
      session.id, session.task_label, session.mode, session.planned_seconds,
      session.start_time, session.end_time, session.duration_seconds, session.created_at,
    ],
  );
  return session;
}

/**
 * Finish a session.
 *
 * `overrideSeconds` lets the caller stamp the full planned length when a pomodoro
 * runs out (the timer would otherwise record one second less than the plan).
 *
 * @param id - session to close.
 * @param overrideSeconds - duration to record, or undefined to measure from start_time.
 */
async function stopSession(id: string, overrideSeconds?: number): Promise<FocusSession | null> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM focus_session WHERE id = ? AND end_time IS NULL`,
    [id],
  );
  if (rows.length === 0) return null;
  const session = row(rows[0]);

  let duration = overrideSeconds;
  if (duration === undefined || duration <= 0) {
    duration = Math.max(0, Math.floor((Date.now() - new Date(session.start_time).getTime()) / 1000));
  }
  const now = new Date().toISOString();
  await db.run(
    'UPDATE focus_session SET end_time = ?, duration_seconds = ? WHERE id = ?',
    [now, Math.round(duration), id],
  );
  return { ...session, end_time: now, duration_seconds: Math.round(duration) };
}

/** Abandon the running session without recording time (a mis-click reset). */
async function discardSession(id: string): Promise<void> {
  await db.run('DELETE FROM focus_session WHERE id = ? AND end_time IS NULL', [id]);
}

/** Total focused seconds on one local day (YYYY-MM-DD). */
async function totalSecondsOn(dayKey: string): Promise<number> {
  const rows = await db.all<{ total: number | null }>(
    `SELECT SUM(duration_seconds) AS total FROM focus_session
      WHERE date(start_time, 'localtime') = ? AND end_time IS NOT NULL`,
    [dayKey],
  );
  return Number(rows[0]?.total ?? 0);
}

/** Focused seconds per local day for the last `days` days, oldest first. */
async function dailyTotals(days: number): Promise<Array<{ day: string; seconds: number }>> {
  const rows = await db.all<{ day: string; seconds: number }>(
    `SELECT date(start_time, 'localtime') AS day, SUM(duration_seconds) AS seconds
       FROM focus_session
      WHERE end_time IS NOT NULL
        AND start_time >= datetime('now', ?)
      GROUP BY day`,
    [`-${Math.max(1, days)} days`],
  );
  return rows.map((entry) => ({ day: String(entry.day), seconds: Number(entry.seconds ?? 0) }));
}

/** Per-session totals for one local day, for the goal ring. */
async function sessionsOn(dayKey: string): Promise<FocusSession[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM focus_session
      WHERE end_time IS NOT NULL AND date(start_time, 'localtime') = ?
      ORDER BY start_time DESC`,
    [dayKey],
  );
  return rows.map(row);
}

/** Consecutive days with at least one finished session, counting back from today. */
async function streakDays(): Promise<number> {
  const rows = await db.all<{ day: string }>(
    `SELECT DISTINCT date(start_time, 'localtime') AS day
       FROM focus_session
      WHERE end_time IS NOT NULL
      ORDER BY day DESC
      LIMIT 400`,
  );
  if (rows.length === 0) return 0;
  const days = new Set(rows.map((entry) => String(entry.day)));
  // Walk back from today; yesterday still counts so a streak is not lost until a
  // whole day passes without focus.
  const cursor = new Date();
  const key = (date: Date): string =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  let streak = 0;
  if (!days.has(key(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(key(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** Hard-delete every session (settings → reset). */
async function clearAll(): Promise<void> {
  await db.run('DELETE FROM focus_session', []);
}

export const FocusRepository = {
  active: activeSession,
  list: listSessions,
  start: startSession,
  stop: stopSession,
  discard: discardSession,
  totalSecondsOn,
  dailyTotals,
  sessionsOn,
  streakDays,
  clearAll,
};