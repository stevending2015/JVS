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
  plannedSeconds,
  recentDayKeys,
} from '../../core/focus/util.js';
import { useStore } from '../../core/store.js';

type Mode = 'pomodoro' | 'stopwatch';

/**
 * 拖动圆环时最少留多少秒。
 *
 * 拖到 0 等于「立刻结束」，太容易误触；留 1 分钟，还能当作「提前收工」用。
 */
const MIN_DRAG_SECONDS = 60;

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

  /**
   * 圆环的「满格」按这一轮**开始时的计划时长**算，而不是随 planned_seconds 变。
   *
   * 用户拖动圆环会把 planned_seconds 改小；如果满格跟着变小，拖动时圆环会
   * 原地打转（头不跟手）。固定成开始时的长度，圆环才是一把真正的「剩余时间尺」：
   * 满格 = 25 分钟，拖到一半 = 剩 12.5 分钟，跟手。
   */
  const arcTotal = React.useMemo(
    () => (focusSession?.mode === 'pomodoro' ? focusSession.planned_seconds : 0),
    // 只在换了会话时重算；拖动改 planned_seconds 不该动它。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focusSession?.id],
  );

  /** 正在拖动时的预览值（秒）；null 表示没在拖。 */
  const [dragRemaining, setDragRemaining] = React.useState<number | null>(null);
  /** 拖动中的最新值。state 更新是异步的，pointerup 时读它才不会掉一拍。 */
  const dragValueRef = React.useRef<number | null>(null);
  const dialRef = React.useRef<HTMLDivElement>(null);

  const isPomodoro = focusSession !== null && focusSession.mode === 'pomodoro';
  const canDrag = isPomodoro && remaining > 0;
  /**
   * 拖动的上限 = 回到「没缩短过」时的剩余时间。
   *
   * 允许往回拖是刻意的：拖短了想反悔，把圆环头推回去就行，不用重开一轮。
   */
  const maxDragRemaining = Math.max(
    MIN_DRAG_SECONDS,
    isPomodoro ? Math.max(remaining, arcTotal - elapsed) : remaining,
  );
  const shownRemaining = dragRemaining ?? remaining;
  /** 剩余比例：1 = 满圈（刚开始），0 = 走完了。 */
  const arcFraction = arcTotal > 0 ? Math.max(0, Math.min(1, shownRemaining / arcTotal)) : 0;

  /** 圆环头的坐标（svg 坐标系，12 点方向为起点，顺时针）。 */
  const handleAngle = -Math.PI / 2 + Math.PI * 2 * arcFraction;
  const handleX = 60 + 52 * Math.cos(handleAngle);
  const handleY = 60 + 52 * Math.sin(handleAngle);

  const display = focusSession === null
    ? (mode === 'stopwatch' ? formatDuration(0) : formatDuration(plannedSeconds(modeId)))
    : (focusSession.mode === 'pomodoro' ? formatDuration(shownRemaining) : formatDuration(elapsed));

  /**
   * 把屏幕坐标换算成「从 12 点开始顺时针」的比例。
   *
   * @param clientX - 指针 x。
   * @param clientY - 指针 y。
   * @returns 0..1；取不到圆心时返回 null。
   */
  function fractionAt(clientX: number, clientY: number): number | null {
    const node = dialRef.current;
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    if (dx === 0 && dy === 0) return null;
    let angle = Math.atan2(dx, -dy);
    if (angle < 0) angle += Math.PI * 2;
    return angle / (Math.PI * 2);
  }

  /**
   * 比例 → 目标剩余秒数。
   *
   * 吸附到整分钟：显示本来就是 mm:ss，按整分钟拖更好用，也不至于拖出
   * 「剩 11 分 37 秒」这种没有意义的数。
   *
   * @param fraction - 0..1。
   * @returns 目标剩余秒数（已夹紧）。
   */
  function remainingFromFraction(fraction: number): number {
    const wanted = fraction * arcTotal;
    const snapped = Math.round(wanted / 60) * 60;
    return Math.max(MIN_DRAG_SECONDS, Math.min(maxDragRemaining, snapped));
  }

  function beginDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (!canDrag) return;
    const fraction = fractionAt(event.clientX, event.clientY);
    if (fraction === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = remainingFromFraction(fraction);
    dragValueRef.current = next;
    setDragRemaining(next);
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (dragValueRef.current === null) return;
    const fraction = fractionAt(event.clientX, event.clientY);
    if (fraction === null) return;
    const next = remainingFromFraction(fraction);
    dragValueRef.current = next;
    setDragRemaining(next);
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (dragValueRef.current === null) return;
    const target = dragValueRef.current;
    dragValueRef.current = null;
    setDragRemaining(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    void applyRemaining(target);
  }

  /**
   * 把「剩余 target 秒」写回这一轮番茄。
   *
   * 换算成 `planned = 已过 + 目标剩余`：已经过去的时间不动，只是把终点提前。
   * 这样结束时记的专注时长就等于缩短后的计划长度。
   *
   * @param targetRemaining - 目标剩余秒数。
   */
  async function applyRemaining(targetRemaining: number): Promise<void> {
    if (focusSession === null || focusSession.mode !== 'pomodoro') return;
    const planned = Math.max(1, elapsed + targetRemaining);
    if (Math.abs(planned - focusSession.planned_seconds) < 1) return;
    try {
      await FocusRepository.setPlannedSeconds(focusSession.id, planned);
      await refreshFocus();
      await loadStats();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** 键盘也能调：↑/→ 缩短 1 分钟，↓/← 放回 1 分钟。 */
  function onDialKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!canDrag) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowRight'
      && event.key !== 'ArrowDown' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const shrink = event.key === 'ArrowUp' || event.key === 'ArrowRight';
    const next = Math.max(
      MIN_DRAG_SECONDS,
      Math.min(maxDragRemaining, remaining + (shrink ? -60 : 60)),
    );
    void applyRemaining(next);
  }

  /*
   * 番茄归零的处理**不在这里**。
   *
   * 原来这段「落库 + 提示音」写在页面的 effect 里，只有当专注页挂载时才跑 ——
   * 用户在别的模块时归零毫无反应，等回到这个页面才补响一声。现在它被提到
   * 全局的 src/app/FocusAlarm.tsx（挂在 App 外壳上），任何页面都会按秒检查，
   * 到点就自动落库并持续响铃直到用户确认。
   *
   * 页面这边只需要在全局状态变化后刷新一次自己的统计数据即可。
   */
  React.useEffect(() => {
    void loadStats();
  }, [focusSession, loadStats]);

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

        {/*
          圆环表示**剩余**时间：一开始是满圈蓝，随着倒计时一路消隐成灰。
          （原来是按「已用比例」画的，看着像正计时在增长，反直觉。）

          番茄进行中时，圆环头可以拖：把它往下拽就把剩余时间缩短，松手落库。
        */}
        <div
          className={[
            'focus-dial',
            canDrag ? 'focus-dial--draggable' : '',
            dragRemaining !== null ? 'is-dragging' : '',
          ].filter(Boolean).join(' ')}
          ref={dialRef}
          role={canDrag ? 'slider' : 'timer'}
          tabIndex={canDrag ? 0 : -1}
          aria-live="off"
          aria-label={canDrag ? '剩余时间，拖动圆环头部可缩短' : undefined}
          aria-valuemin={canDrag ? MIN_DRAG_SECONDS : undefined}
          aria-valuemax={canDrag ? maxDragRemaining : undefined}
          aria-valuenow={canDrag ? shownRemaining : undefined}
          aria-valuetext={canDrag ? `剩余 ${formatDuration(shownRemaining)}` : undefined}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onDialKeyDown}
        >
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="52" className="focus-dial__track" />
            {/* 只旋转这一圈，让 dash 从 12 点开始画；整张 svg 不转，圆环头才好定位 */}
            <circle
              cx="60" cy="60" r="52" className="focus-dial__value"
              transform="rotate(-90 60 60)"
              strokeDasharray={`${Math.round(arcFraction * 326.7)} 326.7`}
            />
            {canDrag && arcFraction > 0 && (
              <circle
                className="focus-dial__handle"
                cx={handleX}
                cy={handleY}
                r={7}
              />
            )}
          </svg>
          <div className="focus-dial__label">
            <span className={`focus-time${running ? ' is-running' : ''}`}>{display}</span>
            <span className="focus-hint">
              {running
                ? (focusSession?.mode === 'stopwatch'
                  ? '正计时进行中'
                  : arcTotal > 0 && (focusSession?.planned_seconds ?? 0) !== arcTotal
                    // 拖过之后：告诉用户原计划多长，以及现在缩到了多少
                    ? `已缩短 · 原计划 ${Math.round(arcTotal / 60)} 分钟`
                    : '拖动圆环可缩短')
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