/**
 * Goals (目标倒计时): quantity- and result-based targets, sub-goals, check-ins.
 *
 * The arithmetic follows the reference implementation closely, because its
 * scheduling rules (cadence planning, "how much per day", overdue detection) are
 * what make a goal feel honest rather than decorative.
 *
 * One thing is JVS-specific: a check-in that carries a note can be written through
 * to the notes module, tagged with the sub-goal it belongs to.
 */

import { db } from '../db/client.js';
import { newId } from '../util/id.js';

export type GoalKind = 'qty' | 'result';

export interface Goal {
  id: string;
  title: string;
  kind: GoalKind;
  /** Quantity target (qty) or the size of the change (result). */
  target: number;
  unit: string;
  /** Quantity already done when the goal was created. */
  initial_done: number;
  start_value: number;
  target_value: number;
  /** +1 when the value should grow, -1 when it should shrink. */
  direction: number;
  start_at: string;
  due_at: string;
  /** Set once the goal is finished / overdue / voided. */
  ended_at: string | null;
  /** 0 = unlimited. */
  max_per_day: number;
  /** "0" = every day, otherwise "work-rest" like "2-1". */
  pattern: string;
  /** "front" = front-loaded plan, "even" = spread evenly. */
  shape: 'front' | 'even';
  color: string;
  archived: number;
  voided: number;
  created_at: string;
  updated_at: string;
}

export interface GoalSub {
  id: string;
  goal_id: string;
  name: string;
  unit: string;
  total: number;
  position: number;
  created_at: string;
}

export interface GoalLog {
  id: string;
  goal_id: string;
  sub_id: string | null;
  amount: number;
  /** Current value for result goals. */
  value: number | null;
  /** Page position for "读到第几页" style check-ins. */
  position: number | null;
  note: string;
  /** The note this check-in produced, if it was synced. */
  note_id: string | null;
  at: string;
  created_at: string;
}

const GOAL_COLUMNS =
  'id, title, kind, target, unit, initial_done, start_value, target_value, direction, start_at, due_at, ended_at, max_per_day, pattern, shape, color, archived, voided, created_at, updated_at';
const SUB_COLUMNS = 'id, goal_id, name, unit, total, position, created_at';
const LOG_COLUMNS = 'id, goal_id, sub_id, amount, value, position, note, note_id, at, created_at';

function goalRow(value: Record<string, unknown>): Goal {
  return {
    id: String(value.id ?? ''),
    title: String(value.title ?? ''),
    kind: value.kind === 'result' ? 'result' : 'qty',
    target: Number(value.target ?? 0),
    unit: String(value.unit ?? ''),
    initial_done: Number(value.initial_done ?? 0),
    start_value: Number(value.start_value ?? 0),
    target_value: Number(value.target_value ?? 0),
    direction: Number(value.direction ?? 1),
    start_at: String(value.start_at ?? ''),
    due_at: String(value.due_at ?? ''),
    ended_at: value.ended_at === null || value.ended_at === undefined ? null : String(value.ended_at),
    max_per_day: Number(value.max_per_day ?? 0),
    pattern: String(value.pattern ?? '0'),
    shape: value.shape === 'even' ? 'even' : 'front',
    color: String(value.color ?? '#2f4bff'),
    archived: Number(value.archived ?? 0),
    voided: Number(value.voided ?? 0),
    created_at: String(value.created_at ?? ''),
    updated_at: String(value.updated_at ?? ''),
  };
}

function subRow(value: Record<string, unknown>): GoalSub {
  return {
    id: String(value.id ?? ''),
    goal_id: String(value.goal_id ?? ''),
    name: String(value.name ?? ''),
    unit: String(value.unit ?? ''),
    total: Number(value.total ?? 0),
    position: Number(value.position ?? 0),
    created_at: String(value.created_at ?? ''),
  };
}

function logRow(value: Record<string, unknown>): GoalLog {
  return {
    id: String(value.id ?? ''),
    goal_id: String(value.goal_id ?? ''),
    sub_id: value.sub_id === null || value.sub_id === undefined ? null : String(value.sub_id),
    amount: Number(value.amount ?? 0),
    value: value.value === null || value.value === undefined ? null : Number(value.value),
    position: value.position === null || value.position === undefined ? null : Number(value.position),
    note: String(value.note ?? ''),
    note_id: value.note_id === null || value.note_id === undefined ? null : String(value.note_id),
    at: String(value.at ?? ''),
    created_at: String(value.created_at ?? ''),
  };
}

/** All goals, newest first. */
async function listGoals(): Promise<Goal[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${GOAL_COLUMNS} FROM goal ORDER BY created_at DESC`,
  );
  return rows.map(goalRow);
}

/** Sub-goals of one goal, in display order. */
async function listSubs(goalId: string): Promise<GoalSub[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${SUB_COLUMNS} FROM goal_sub WHERE goal_id = ? ORDER BY position, created_at`,
    [goalId],
  );
  return rows.map(subRow);
}

/** Check-ins of one goal, newest first. */
async function listLogs(goalId: string): Promise<GoalLog[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${LOG_COLUMNS} FROM goal_log WHERE goal_id = ? ORDER BY at DESC`,
    [goalId],
  );
  return rows.map(logRow);
}

/** Insert a goal. */
async function createGoal(input: Omit<Goal, 'id' | 'created_at' | 'updated_at' | 'ended_at'>): Promise<Goal> {
  const now = new Date().toISOString();
  const goal: Goal = { ...input, id: newId(), ended_at: null, created_at: now, updated_at: now };
  await db.run(
    `INSERT INTO goal (${GOAL_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      goal.id, goal.title, goal.kind, goal.target, goal.unit, goal.initial_done,
      goal.start_value, goal.target_value, goal.direction, goal.start_at, goal.due_at,
      goal.ended_at, goal.max_per_day, goal.pattern, goal.shape, goal.color,
      goal.archived, goal.voided, goal.created_at, goal.updated_at,
    ],
  );
  return goal;
}

/** Patch a goal. */
async function updateGoal(id: string, patch: Partial<Goal>): Promise<void> {
  const current = await getGoal(id);
  if (current === null) return;
  const next: Goal = { ...current, ...patch, updated_at: new Date().toISOString() };
  await db.run(
    `UPDATE goal SET title=?, kind=?, target=?, unit=?, initial_done=?, start_value=?,
        target_value=?, direction=?, start_at=?, due_at=?, ended_at=?, max_per_day=?,
        pattern=?, shape=?, color=?, archived=?, voided=?, updated_at=?
      WHERE id=?`,
    [
      next.title, next.kind, next.target, next.unit, next.initial_done,
      next.start_value, next.target_value, next.direction, next.start_at, next.due_at,
      next.ended_at, next.max_per_day, next.pattern, next.shape, next.color,
      next.archived, next.voided, next.updated_at, id,
    ],
  );
}

/** One goal, or null. */
async function getGoal(id: string): Promise<Goal | null> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${GOAL_COLUMNS} FROM goal WHERE id = ?`,
    [id],
  );
  return rows.length === 0 ? null : goalRow(rows[0]);
}

/** Delete a goal with its sub-goals and check-ins. */
async function deleteGoal(id: string): Promise<void> {
  await db.run('DELETE FROM goal_log WHERE goal_id = ?', [id]);
  await db.run('DELETE FROM goal_sub WHERE goal_id = ?', [id]);
  await db.run('DELETE FROM goal WHERE id = ?', [id]);
}

/** Add a sub-goal (a book, a chapter…). */
async function createSub(input: {
  goalId: string;
  name: string;
  unit: string;
  total: number;
}): Promise<GoalSub> {
  const existing = await listSubs(input.goalId);
  const sub: GoalSub = {
    id: newId(),
    goal_id: input.goalId,
    name: input.name,
    unit: input.unit === '' ? '' : input.unit,
    total: input.total,
    position: existing.length,
    created_at: new Date().toISOString(),
  };
  await db.run(
    `INSERT INTO goal_sub (${SUB_COLUMNS}) VALUES (?,?,?,?,?,?,?)`,
    [sub.id, sub.goal_id, sub.name, sub.unit, sub.total, sub.position, sub.created_at],
  );
  return sub;
}

/** Delete a sub-goal; its check-ins lose the link but stay. */
async function deleteSub(id: string): Promise<void> {
  await db.run('UPDATE goal_log SET sub_id = NULL WHERE sub_id = ?', [id]);
  await db.run('DELETE FROM goal_sub WHERE id = ?', [id]);
}

/** Insert a check-in. */
async function createLog(input: {
  goalId: string;
  subId: string | null;
  amount: number;
  value: number | null;
  position: number | null;
  note: string;
  noteId: string | null;
  at: string;
}): Promise<GoalLog> {
  const log: GoalLog = {
    id: newId(),
    goal_id: input.goalId,
    sub_id: input.subId,
    amount: input.amount,
    value: input.value,
    position: input.position,
    note: input.note,
    note_id: input.noteId,
    at: input.at,
    created_at: new Date().toISOString(),
  };
  await db.run(
    `INSERT INTO goal_log (${LOG_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      log.id, log.goal_id, log.sub_id, log.amount, log.value, log.position,
      log.note, log.note_id, log.at, log.created_at,
    ],
  );
  return log;
}

/** Patch a check-in (editing an existing record). */
async function updateLog(id: string, patch: Partial<GoalLog>): Promise<void> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${LOG_COLUMNS} FROM goal_log WHERE id = ?`,
    [id],
  );
  if (rows.length === 0) return;
  const next: GoalLog = { ...logRow(rows[0]), ...patch };
  await db.run(
    `UPDATE goal_log SET sub_id=?, amount=?, value=?, position=?, note=?, note_id=?, at=? WHERE id=?`,
    [next.sub_id, next.amount, next.value, next.position, next.note, next.note_id, next.at, id],
  );
}

/** Delete a check-in. */
async function deleteLog(id: string): Promise<void> {
  await db.run('DELETE FROM goal_log WHERE id = ?', [id]);
}

export const GoalRepository = {
  list: listGoals,
  get: getGoal,
  getGoal,
  create: createGoal,
  createGoal,
  update: updateGoal,
  updateGoal,
  remove: deleteGoal,
  deleteGoal,
  listSubs,
  createSub,
  deleteSub,
  listLogs,
  createLog,
  updateLog,
  deleteLog,
};
