/**
 * 专注 module — 番茄钟 / 正计时。
 *
 * 参考 masuka 的「专注」页：多档番茄时长 + 正计时、任务描述、刷新不丢计时、
 * 今日累计、专注记录。在此基础上加了每日目标环、连续天数与专注热力图。
 *
 * 计时始终由 start_time 推导，因此刷新页面、切到别的模块、甚至关掉标签页再回来，
 * 显示的时长都不会错。
 */

import * as React from 'react';
import { FocusRepository, type FocusSession } from '../../core/focus/repository.js';
import {
  DEFAULT_DAILY_GOAL,
  FOCUS_MODES,
  HEATMAP_DAYS,
  formatDuration,
  formatMinutes,
  heatBucket,
  localDayKey,
  playFocusChime,
  plannedSeconds,
  recentDayKeys,
} from '../../core/focus/util.js';
import { useStore } from '../../core/store.js';

type Mode = 'pomodoro' | 'stopwatch';

/** Dashboard card: today's total, or the live timer while one is running. */
export function FocusCard(): React.ReactElement {
  const { focusSession, focusTodaySeconds, focusGoal } = useStore();
  const done = Math.floor(focusTodaySeconds / (25 * 60));
  const running = focusSession !== null;
  /** 每秒重算一次，让卡片上的读数和专注页同步走动。 */
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    if (focusSession === null) return undefined;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [focusSession]);

  let display: string;
  let hint: React.ReactNode;
  if (focusSession !== null) {
    const elapsed = Math.max(0, Math.floor((Date.now() - new Date(focusSession.start_time).getTime()) / 1000));
    if (focusSession.mode === 'pomodoro') {
      const remaining = Math.max(0, focusSession.planned_seconds - elapsed);
      display = formatDuration(remaining);
      hint = <>⏺ 番茄钟 · 计划 {Math.round(focusSession.planned_seconds / 60)} 分钟</>;
    } else {
      display = formatDuration(elapsed);
      hint = <>⏺ 正计时进行中</>;
    }
  } else {
    display = formatMinutes(focusTodaySeconds);
    hint = <>今日 {done}/{focusGoal} 个番茄</>;
  }

  return (
    <div>
      <div className={`mini-big${running ? ' focus-card--running' : ''}`}>{display}</div>
      <div className="mini-list__meta">
        {hint}
        {focusSession?.task_label != null && <span className="focus-card__task"> · {focusSession.task_label}</span>}
      </div>
    </div>
  );
}

export function FocusPage(): React.ReactElement {
  const {
    focusSession, focusTodaySeconds, focusGoal, setFocusGoal,
    focusSoundOn, setFocusSoundOn, refreshFocus,
  } = useStore();

  const [mode, setMode] = React.useState<Mode>('pomodoro');
  const [modeId, setModeId] = React.useState<string>('25');
  const [task, setTask] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sessions, setSessions] = React.useState<FocusSession[]>([]);
  const [totals, setTotals] = React.useState<Array<{ day: string; seconds: number }>>([]);
  const [streak, setStreak] = React.useState(0);
  const [todayCount, setTodayCount] = React.useState(0);
  const [tick, setTick] = React.useState(0);
  /** Guards the auto-stop so the end effect cannot fire twice. */
  const finishedRef = React.useRef<string | null>(null);

  const running = focusSession !== null;

  // 1 Hz ticker; drives the display and the pomodoro auto-stop.
  React.useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const loadStats = React.useCallback(async () => {
    const [list, days, run, todaySessions] = await Promise.all([
      FocusRepository.list(100),
      FocusRepository.dailyTotals(HEATMAP_DAYS),
      FocusRepository.streakDays(),
      FocusRepository.sessionsOn(localDayKey()),
    ]);
    setSessions(list);
    setTotals(days);
    setStreak(run);
    setTodayCount(todaySessions.length);
  }, []);

  React.useEffect(() => {
    void loadStats();
  }, [loadStats]);

  // Seconds elapsed for the running session.
  const elapsed = React.useMemo(() => {
    if (focusSession === null) return 0;
    return Math.max(0, Math.floor((Date.now() - new Date(focusSession.start_time).getTime()) / 1000));
    // `tick` re-evaluates this every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSession, tick]);

  const remaining = focusSession === null ? 0 : Math.max(0, focusSession.planned_seconds - elapsed);
  const display = focusSession === null
    ? (mode === 'stopwatch' ? formatDuration(0) : formatDuration(plannedSeconds(modeId)))
    : (focusSession.mode === 'pomodoro' ? formatDuration(remaining) : formatDuration(elapsed));

  /** Fraction 0..1 of the current pomodoro consumed. */
  const progress = focusSession === null
    ? 0
    : focusSession.mode === 'stopwatch'
      ? 0
      : (focusSession.planned_seconds === 0
        ? 0
        : Math.min(1, elapsed / focusSession.planned_seconds));

  // 番茄归零：自动落库 + 提示音。
  React.useEffect(() => {
    if (focusSession === null || focusSession.mode !== 'pomodoro') return;
    if (remaining > 0 || finishedRef.current === focusSession.id) return;
    finishedRef.current = focusSession.id;
    playFocusChime(focusSoundOn);
    void FocusRepository.stop(focusSession.id, focusSession.planned_seconds)
      .then(async () => {
        await refreshFocus();
        await loadStats();
      })
      .catch((e: Error) => setError(e.message));
  }, [remaining, focusSession, focusSoundOn, refreshFocus, loadStats]);

  async function start(): Promise<void> {
    if (busy || running) return;
    setBusy(true);
    setError(null);
    try {
      await FocusRepository.start({
        taskLabel: task === '' ? (mode === 'stopwatch' ? '专注' : '番茄钟') : task,
        mode,
        plannedSeconds: plannedSeconds(modeId),
      });
      finishedRef.current = null;
      await refreshFocus();
      await loadStats();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    if (focusSession === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await FocusRepository.stop(focusSession.id);
      await refreshFocus();
      await loadStats();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pomodorosDone = Math.floor(focusTodaySeconds / (25 * 60));
  const goalPercent = Math.min(1, focusTodaySeconds / (focusGoal * 25 * 60));
  const totalsByDay = new Map(totals.map((entry) => [entry.day, entry.seconds]));
  const heatKeys = recentDayKeys(HEATMAP_DAYS);

  return (
    <div className="panel focus-page">
      <div className="list-head">
        <h3>⏱ 专注</h3>
        <span className="list-head__count">
          今日 {formatMinutes(focusTodaySeconds)} · {pomodorosDone}/{focusGoal} 个番茄
          {streak > 0 && ` · 连续 ${streak} 天`}
        </span>
      </div>

      <section className="focus-clock">
        <div className="focus-modes">
          {FOCUS_MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={mode === 'pomodoro' && modeId === item.id ? 'is-active' : ''}
              disabled={running}
              onClick={() => { setMode('pomodoro'); setModeId(item.id); }}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            className={mode === 'stopwatch' ? 'is-active' : ''}
            disabled={running}
            onClick={() => setMode('stopwatch')}
          >
            ⏱ 正计时
          </button>
        </div>

        <input
          className="focus-task"
          placeholder="你在做什么？（可留空）"
          value={task}
          disabled={running}
          onChange={(event) => setTask(event.target.value)}
          aria-label="专注事项"
        />

        <div className="focus-dial" role="timer" aria-live="off">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="52" className="focus-dial__track" />
            <circle
              cx="60" cy="60" r="52" className="focus-dial__value"
              strokeDasharray={`${Math.round(progress * 326.7)} 326.7`}
            />
          </svg>
          <div className="focus-dial__label">
            <span className={`focus-time${running ? ' is-running' : ''}`}>{display}</span>
            <span className="focus-hint">
              {running
                ? (focusSession?.mode === 'stopwatch' ? '正计时进行中' : `计划 ${Math.round((focusSession?.planned_seconds ?? 0) / 60)} 分钟`)
                : (mode === 'stopwatch' ? '正计时' : `${Math.round(plannedSeconds(modeId) / 60)} 分钟番茄钟`)}
            </span>
          </div>
        </div>

        {running && focusSession?.task_label !== null && focusSession !== null && (
          <p className="focus-current">当前：{focusSession?.task_label}</p>
        )}

        <div className="focus-actions">
          {running ? (
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void stop()}>
              {busy ? '结束中…' : '结束专注'}
            </button>
          ) : (
            <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
              {busy ? '开始中…' : '开始'}
            </button>
          )}
          <button
            type="button"
            className="link"
            disabled={running}
            onClick={() => setTask('')}
          >
            清空输入
          </button>
          <label className="focus-sound">
            <input
              type="checkbox"
              checked={focusSoundOn}
              onChange={(event) => void setFocusSoundOn(event.target.checked)}
            />
            结束提示音
          </label>
        </div>

        {error !== null && <div className="banner banner--bad">{error}</div>}
      </section>

      <section className="focus-stats">
        <div className="focus-goal">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="50" className="focus-dial__track" />
            <circle
              cx="60" cy="60" r="50" className="focus-dial__value"
              strokeDasharray={`${Math.round(goalPercent * 314.16)} 314.16`}
            />
          </svg>
          <div className="focus-goal__label">
            <strong>{Math.round(goalPercent * 100)}%</strong>
            <span>今日目标</span>
          </div>
        </div>
        <div className="focus-goal__side">
          <label className="focus-goal__set">
            每日目标（个番茄）
            <input
              type="number"
              min={1}
              max={20}
              value={focusGoal}
              onChange={(event) => void setFocusGoal(Number(event.target.value))}
            />
          </label>
          <div className="focus-streak">🔥 连续专注 {streak} 天</div>
          <div className="focus-today">今日完成 {todayCount} 次专注 · {formatMinutes(focusTodaySeconds)}</div>
        </div>
        <div className="focus-heat">
          <div className="focus-heat__title">最近 {HEATMAP_DAYS} 天</div>
          <div className="focus-heat__grid">
            {heatKeys.map((day) => {
              const seconds = totalsByDay.get(day) ?? 0;
              const bucket = heatBucket(seconds);
              return (
                <span
                  key={day}
                  className={`focus-heat__cell focus-heat__cell--${bucket}`}
                  title={`${day} · ${formatMinutes(seconds)}`}
                />
              );
            })}
          </div>
        </div>
      </section>

      <section className="focus-history">
        <h4 className="focus-history__title">专注记录（最近 10 条）</h4>
        {sessions.length === 0 ? (
          <p className="card__empty">还没有专注记录。选一个时长，按「开始」。</p>
        ) : (
          <ul className="focus-history__list">
            {sessions.slice(0, 10).map((session) => {
              const isOpen = session.end_time === null;
              return (
                <li key={session.id}>
                  <span className="focus-history__task">
                    {session.task_label ?? '专注'}
                    {isOpen && <span className="tag">进行中</span>}
                    {session.mode === 'stopwatch' && <span className="tag">正计时</span>}
                  </span>
                  <span className="focus-history__meta">
                    {new Date(session.start_time).toLocaleString()} ·{' '}
                    {isOpen ? '计时中' : formatMinutes(session.duration_seconds)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}