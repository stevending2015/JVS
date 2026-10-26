/**
 * Goal arithmetic: progress, cadence planning and rate prediction.
 *
 * Ported from the reference implementation so the numbers a user sees are the
 * ones they would expect:
 *
 *  - quantity goals count check-ins up; result goals track the latest value;
 *  - a "work N days, rest M days" pattern projects which days still need a
 *    check-in, and says plainly when the remaining amount cannot fit;
 *  - the pace forecast uses the last 7 days (or 14 for result goals) and warns
 *    when the data is too thin to predict.
 */

import type { Goal, GoalLog, GoalSub } from './repository.js';

const DAY_MS = 86_400_000;

export const GOAL_COLORS = [
  '#2f4bff', '#0f9d8a', '#3d9a3d', '#e8820c',
  '#d6453d', '#d6409f', '#8a4bd6', '#5d7075',
];

export const GOAL_UNITS = [
  '个', '次', '页', '篇', '章', '组', '本', '道', '课', '公里', '分钟', '小时', '天',
];

/** Units whose amounts are whole numbers. */
const INTEGER_UNITS = new Set(['个', '次', '页', '篇', '章', '组', '本', '道', '课', '天']);

/** Units where decimals are meaningless (time). */
const DECIMAL_UNITS = new Set(['公里', '小时']);

/** Round to one decimal. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Round to two decimals. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Local midnight of a timestamp. */
export function dayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Add whole days to a timestamp, keeping the local time-of-day. */
export function addDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

/** True when a sub-goal uses a different unit than its goal (a book in pages). */
export function subIsSeparate(goal: Goal, sub: GoalSub | undefined): boolean {
  return sub !== undefined && sub.unit !== goal.unit;
}

/** Does this check-in count towards the goal itself (not only its sub-goal)? */
export function countsTowardsGoal(
  goal: Goal,
  log: GoalLog,
  subs: GoalSub[] = [],
): boolean {
  if (log.sub_id === null) return true;
  const sub = subs.find((candidate) => candidate.id === log.sub_id);
  return !subIsSeparate(goal, sub);
}

/** Amount completed inside one sub-goal. */
export function subDone(subId: string, logs: GoalLog[]): number {
  return logs.reduce((sum, log) => sum + (log.sub_id === subId ? log.amount : 0), 0);
}

/** Latest recorded value for a result goal. */
export function currentValue(goal: Goal, logs: GoalLog[]): number {
  const withValue = logs
    .filter((log) => log.value !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
  return withValue.length === 0 ? goal.start_value : (withValue[withValue.length - 1]?.value ?? goal.start_value);
}

/** How many check-ins happened on one local day. */
export function dayCount(logs: GoalLog[], at: number): number {
  const key = new Date(at).toDateString();
  return logs.filter((log) => new Date(log.at).toDateString() === key).length;
}

/** Was there a check-in on this local day? */
export function doneOnDay(goal: Goal, logs: GoalLog[], at: number): boolean {
  const key = dayStart(at);
  return logs.some((log) => countsTowardsGoal(goal, log) && dayStart(new Date(log.at).getTime()) === key);
}

/** Total completed so far. */
export function doneOf(goal: Goal, logs: GoalLog[], subs: GoalSub[] = []): number {
  if (goal.kind === 'result') {
    return Math.max(0, goal.direction * (currentValue(goal, logs) - goal.start_value));
  }
  const fromLogs = logs.reduce((sum, log) => sum + (countsTowardsGoal(goal, log, subs) ? log.amount : 0), 0);
  const fromSubs = subs.reduce(
    (sum, sub) => sum + (subIsSeparate(goal, sub) && subDone(sub.id, logs) >= sub.total ? 1 : 0),
    0,
  );
  return (goal.initial_done || 0) + fromLogs + fromSubs;
}

export interface GoalInfo {
  done: number;
  remain: number;
  isDone: boolean;
  isLate: boolean;
  notStarted: boolean;
  /** 0..100 — share of the amount completed. */
  percent: number;
  /** 0..100 — share of the time budget consumed. */
  timePercent: number;
  /** Days left from now (or from the start, if not yet begun). */
  daysLeft: number;
  /** Difference between progress and time elapsed, in points. */
  deviation: number;
}

/** Everything the UI needs to describe a goal right now. */
export function goalInfo(goal: Goal, logs: GoalLog[], now: number): GoalInfo {
  const done = doneOf(goal, logs);
  const remain = Math.max(0, goal.target - done);
  const start = new Date(goal.start_at).getTime();
  const due = new Date(goal.due_at).getTime();
  const isDone = remain <= 0;
  const isLate = !isDone && now >= due;
  const notStarted = now < start;
  const from = Math.max(now, start);
  const daysLeft = Math.max(0, (due - from) / DAY_MS);
  const timePercent = due > start
    ? Math.max(0, Math.min(100, Math.round(((now - start) / (due - start)) * 100)))
    : 0;
  const percent = goal.target <= 0 ? 0 : Math.min(100, Math.round((done / goal.target) * 100));
  return {
    done, remain, isDone, isLate, notStarted,
    percent, timePercent, daysLeft,
    deviation: percent - timePercent,
  };
}

/** One day in the projected plan. */
export interface PlanDay {
  at: number;
  /** True when a check-in is expected that day. */
  planned: boolean;
}

export interface GoalPlan {
  days: PlanDay[];
  /** Days that need a check-in. */
  needed: number;
  /** How much per check-in. */
  perCheck: number;
  /** Whether the remaining amount fits into the available days. */
  feasible: boolean;
  /** Days that must be done back-to-back before the rhythm can start. */
  leadDays: number;
  /** Last planned day. */
  end: number;
}

/**
 * Project which days still need a check-in.
 *
 * With a "work 2 days, rest 1 day" rhythm the available days are limited, so the
 * plan may need a front-loaded run of consecutive days. When even that is not
 * enough the plan is reported as infeasible instead of quietly showing a plan that
 * cannot work.
 *
 * @param goal - the goal.
 * @param logs - its check-ins.
 * @param now - current timestamp.
 * @returns The projection, or null when the goal needs no plan.
 */
export function buildPlan(goal: Goal, logs: GoalLog[], now: number): GoalPlan | null {
  const info = goalInfo(goal, logs, now);
  if (goal.kind === 'result') return null;
  if (!goal.pattern || goal.pattern === '0') return null;
  if (goal.voided === 1 || info.isDone || info.isLate) return null;

  const [workRaw, restRaw] = goal.pattern.split('-');
  const work = Number(workRaw) || 0;
  const cycle = Math.max(1, work + (Number(restRaw) || 0));
  const start = dayStart(new Date(goal.start_at).getTime());
  const today = dayStart(now);
  let cursor = Math.max(today, start);
  // Today only counts if it is still a plan day and nothing was logged yet.
  if (cursor === today && doneOnDay(goal, logs, today)) cursor = addDays(today, 1);

  const dueDay = dayStart(new Date(goal.due_at).getTime() - 1);
  const total = Math.round((dueDay - cursor) / DAY_MS) + 1;
  if (total < 1) return null;

  const pattern: boolean[] = [];
  for (let index = 0; index < total; index += 1) {
    const offset = ((Math.round((addDays(cursor, index) - start) / DAY_MS) % cycle) + cycle) % cycle;
    pattern.push(offset < work);
  }

  const rhythmDays = pattern.filter(Boolean).length;
  const remaining = info.remain;
  if (remaining <= 0) return null;

  // Prefer the pace the user has actually shown: if they have been logging ~1 book
  // per check-in, a plan that assumes 20 per sitting is a fiction. Only fall back
  // to spreading the remainder over the rhythm days when there is no history.
  const counted = logs.filter((log) => countsTowardsGoal(goal, log));
  const historyAvg = counted.length === 0
    ? 0
    : counted.reduce((sum, log) => sum + log.amount, 0) / counted.length;
  const perRaw = historyAvg > 0 ? historyAvg : remaining / Math.max(rhythmDays, 1);
  const perCheck = unitNeedsInteger(goal.unit) ? Math.max(1, Math.ceil(perRaw)) : Math.max(1, round1(perRaw));
  const needed = Math.ceil(remaining / perCheck);

  // Days available at the maximum allowed rate (or one check-in per day when the
  // goal does not cap the rate).
  const perDayCap = goal.max_per_day > 0 ? goal.max_per_day : 1;
  const capacity = total * perDayCap;
  const feasible = needed <= capacity;

  // When the rhythm alone cannot fit the amount, the first days must be done
  // back-to-back before rests begin.
  const leadDays = needed > rhythmDays ? Math.min(total, needed - rhythmDays) : 0;

  const picked = new Set<number>();
  if (goal.shape === 'even' && leadDays === 0) {
    const available = pattern.map((value, index) => (value ? index : -1)).filter((index) => index >= 0);
    for (let index = 0; index < needed; index += 1) {
      picked.add(available[Math.floor((index * available.length) / Math.max(needed, 1))] ?? (available[0] ?? 0));
    }
  } else {
    let count = 0;
    for (let index = 0; index < total && count < needed; index += 1) {
      if (index < leadDays || pattern[index]) { picked.add(index); count += 1; }
    }
  }

  const days: PlanDay[] = [];
  let last = 0;
  for (let index = 0; index < total; index += 1) {
    if (picked.has(index)) last = index;
    days.push({ at: addDays(cursor, index), planned: picked.has(index) });
  }

  return {
    days, needed, perCheck, feasible, leadDays,
    end: addDays(cursor, last),
  };
}

/** How much the user should do per day to finish in time. */
export function perDayNeeded(info: GoalInfo): number {
  if (info.daysLeft <= 0) return 0;
  return Math.ceil((info.remain / info.daysLeft) * 10) / 10;
}

/** How much the user should do per week to finish in time. */
export function perWeekNeeded(info: GoalInfo): number {
  const weeks = Math.max(info.daysLeft / 7, 1);
  return Math.ceil((info.remain / weeks) * 10) / 10;
}

/** Average amount per check-in, used to estimate how many check-ins are left. */
export function averagePerCheck(goal: Goal, logs: GoalLog[]): number {
  const counted = logs.filter((log) => countsTowardsGoal(goal, log));
  if (counted.length === 0) return 1;
  return counted.reduce((sum, log) => sum + log.amount, 0) / counted.length;
}

/**
 * Forecast the finishing date from recent activity.
 *
 * @param goal - the goal.
 * @param logs - its check-ins.
 * @param now - current timestamp.
 * @returns The estimate and the reasoning, or null when there is not enough data.
 */
export function forecast(
  goal: Goal,
  logs: GoalLog[],
  now: number,
): { text: string; late: boolean } | null {
  const info = goalInfo(goal, logs, now);
  if (info.remain <= 0) return null;

  if (goal.kind === 'result') {
    const recent = logs
      .filter((log) => log.value !== null && new Date(log.at).getTime() > now - 14 * DAY_MS && new Date(log.at).getTime() <= now)
      .sort((a, b) => a.at.localeCompare(b.at));
    if (recent.length < 3) {
      return { text: '近 14 天记录不足 3 次，数据不足，暂不预测达成日期。', late: false };
    }
    const first = recent[0];
    const last = recent[recent.length - 1];
    if (first === undefined || last === undefined) return null;
    const days = Math.max(1, (new Date(last.at).getTime() - new Date(first.at).getTime()) / DAY_MS);
    const perDay = goal.direction * ((last.value ?? 0) - (first.value ?? 0)) / days;
    if (perDay <= 0) {
      return { text: '近 14 天没有朝目标方向变化，按此趋势无法达成，建议调整计划。', late: false };
    }
    const eta = now + (info.remain / perDay) * DAY_MS;
    const due = new Date(goal.due_at).getTime();
    const late = eta > due;
    return {
      text: `近 14 天平均每周变化 ${round2(perDay * 7)}${goal.unit}，按此趋势预计 ${formatDate(eta)} 达成` +
        (late ? `，晚于截止 ${Math.ceil((eta - due) / DAY_MS)} 天，有逾期风险` : '，可以按期达成') + '。',
      late,
    };
  }

  const recent = logs.filter(
    (log) => countsTowardsGoal(goal, log) && new Date(log.at).getTime() > now - 7 * DAY_MS && new Date(log.at).getTime() <= now,
  );
  if (recent.length < 3) {
    return { text: '近 7 天打卡不足 3 次，数据不足，暂不预测完成日期。', late: false };
  }
  const sum = recent.reduce((total, log) => total + log.amount, 0);
  const days = Math.min(7, Math.max(1, (now - new Date(goal.start_at).getTime()) / DAY_MS));
  const perDay = sum / days;
  if (perDay <= 0) return { text: '近期没有进展，暂不预测完成日期。', late: false };
  const eta = now + (info.remain / perDay) * DAY_MS;
  const due = new Date(goal.due_at).getTime();
  const late = eta > due;
  return {
    text: `近 7 天平均每天完成 ${round1(perDay)}${goal.unit}，按此速度预计 ${formatDate(eta)}（约 ${Math.ceil(info.remain / perDay)} 天后）完成` +
      (late ? `，晚于截止 ${Math.ceil((eta - due) / DAY_MS)} 天，有逾期风险` : '，可以按期完成') + '。',
    late,
  };
}

/** "10月5日" style date. */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** "10月5日 14:30" style timestamp. */
export function formatMoment(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Why a check-in cannot be added right now (empty means it is allowed). */
export function checkInBlocker(
  goal: Goal,
  logs: GoalLog[],
  now: number,
  at?: number,
): string {
  if (goal.archived === 1) return '归档目标是只读的，请先取消归档';
  if (goal.voided === 1) return '这个目标已作废，不能打卡';
  const info = goalInfo(goal, logs, now);
  if (info.isDone) return '这个目标已经完成了';
  if (now < new Date(goal.start_at).getTime()) return '目标还没开始，不能打卡';
  if (now >= new Date(goal.due_at).getTime()) return '目标已过期，不能再新增打卡；如需纠错，请编辑已有记录';
  if (at !== undefined) {
    if (at > now + 60_000) return '不能填写未来时间';
    if (at < new Date(goal.start_at).getTime() || at > new Date(goal.due_at).getTime()) {
      return '打卡时间必须在目标起止时间内';
    }
  }
  return '';
}

/** The largest amount a check-in may record. */
export function amountLimit(goal: Goal, logs: GoalLog[], sub: GoalSub | undefined): number {
  if (sub !== undefined) {
    const subRemaining = Math.max(0, sub.total - subDone(sub.id, logs));
    return subIsSeparate(goal, sub) ? subRemaining : Math.min(goalInfo(goal, logs, Date.now()).remain, subRemaining);
  }
  return goalInfo(goal, logs, Date.now()).remain;
}

/** Whole-number check for units that need it. */
export function unitNeedsInteger(unit: string): boolean {
  return INTEGER_UNITS.has(unit) && !DECIMAL_UNITS.has(unit);
}
