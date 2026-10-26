/**
 * 目标 module — 目标倒计时（数量型 / 结果型），子目标（每本书），打卡，
 * 打卡计划推算，以及把读书打卡的笔记同步到笔记模块。
 *
 * 交互参照附档：卡片式倒计时、进度条、今天该打卡还是休息、子目标打卡、
 * 节奏计划、归档与作废、备份与恢复。
 */

import * as React from 'react';
import { Modal } from '../../app/Modal.js';
import {
  GOAL_COLORS,
  GOAL_UNITS,
  amountLimit,
  averagePerCheck,
  buildPlan,
  checkInBlocker,
  countsTowardsGoal,
  currentValue,
  dayCount,
  doneOf,
  formatDate,
  formatMoment,
  forecast,
  goalInfo,
  perDayNeeded,
  perWeekNeeded,
  round1,
  subDone,
  unitNeedsInteger,
} from '../../core/goal/logic.js';
import { GoalRepository, type Goal, type GoalLog, type GoalSub } from '../../core/goal/repository.js';
import { repairCheckInNotes } from '../../core/goal/repairNotes.js';
import { useStore } from '../../core/store.js';
import { BackupDialog, CheckInDialog, Countdown, GoalDetail, GoalForm, SubGoalDialog } from './parts.js';

type Dialog =
  | { kind: 'add' }
  | { kind: 'edit'; goal: Goal }
  | { kind: 'check'; goal: Goal; subId: string | null; logId: string | null }
  | { kind: 'sub'; goal: Goal }
  | { kind: 'backup' }
  | { kind: 'confirm-delete'; goal: Goal }
  | null;

/** Dashboard card: how many goals are live and the nearest deadline. */
export function GoalCard(): React.ReactElement {
  const [goals, setGoals] = React.useState<Goal[]>([]);
  React.useEffect(() => {
    void GoalRepository.list().then(setGoals).catch(() => undefined);
  }, []);
  const live = goals.filter((goal) => goal.archived === 0 && goal.voided === 0);
  if (live.length === 0) return <p className="card__empty">还没有目标</p>;
  const nearest = [...live].sort((a, b) => a.due_at.localeCompare(b.due_at))[0];
  return (
    <div>
      <div className="mini-big">{live.length} 个</div>
      <div className="mini-list__meta">
        最近截止：{nearest === undefined ? '—' : `${nearest.title} · ${formatDate(new Date(nearest.due_at).getTime())}`}
      </div>
    </div>
  );
}

export function GoalPage(): React.ReactElement {
  const { refresh } = useStore();
  const [goals, setGoals] = React.useState<Goal[]>([]);
  const [logs, setLogs] = React.useState<GoalLog[]>([]);
  const [subs, setSubs] = React.useState<GoalSub[]>([]);
  const [viewId, setViewId] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<Dialog>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [tick, setTick] = React.useState(0);

  // 1 Hz ticker so the countdowns tick.
  React.useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const load = React.useCallback(async () => {
    const [allGoals, allLogs, allSubs] = await Promise.all([
      GoalRepository.list(),
      Promise.all([] as Array<GoalLog>),
      Promise.all([] as Array<GoalSub>),
    ]);
    setGoals(allGoals);
    // Logs and sub-goals are per goal; load them for the goal in view (and for the
    // cards we only need the counts, so those load lazily).
    const ids = allGoals.map((goal) => goal.id);
    const [logRows, subRows] = await Promise.all([
      Promise.all(ids.map((id) => GoalRepository.listLogs(id))),
      Promise.all(ids.map((id) => GoalRepository.listSubs(id))),
    ]);
    setLogs(logRows.flat());
    setSubs(subRows.flat());
  }, []);

  React.useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [load]);

  // 旧版打卡笔记缺少书名：进入目标页时幂等修复一次（有书名的会被跳过）。
  React.useEffect(() => {
    void repairCheckInNotes()
      .then((count) => {
        if (count > 0) void load();
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const now = Date.now();
  const logsOf = React.useCallback((goalId: string) => logs.filter((log) => log.goal_id === goalId), [logs]);
  const subsOf = React.useCallback((goalId: string) => subs.filter((sub) => sub.goal_id === goalId), [subs]);

  const visible = goals.filter((goal) => (goal.archived === 1) === showArchived);
  const view = viewId === null ? undefined : goals.find((goal) => goal.id === viewId);

  async function afterChange(): Promise<void> {
    await load();
    await refresh();
  }

  /** Shared dialogs, rendered by BOTH the list and the detail view. */
  const dialogs = (
    <>
        {dialog?.kind === 'add' && (
          <GoalForm
            title="添加目标"
            onClose={() => setDialog(null)}
            onSaved={async () => { setDialog(null); await afterChange(); }}
            onError={setError}
          />
        )}
        {dialog?.kind === 'edit' && (
          <GoalForm
            title={`编辑：${dialog.goal.title}`}
            goal={dialog.goal}
            onClose={() => setDialog(null)}
            onSaved={async () => { setDialog(null); await afterChange(); }}
            onError={setError}
          />
        )}
        {dialog?.kind === 'check' && (
          <CheckInDialog
            goal={dialog.goal}
            subs={subsOf(dialog.goal.id)}
            logs={logsOf(dialog.goal.id)}
            log={dialog.logId === null ? null : logsOf(dialog.goal.id).find((log) => log.id === dialog.logId) ?? null}
            initialSubId={dialog.subId}
            onClose={() => setDialog(null)}
            onDone={async () => { setDialog(null); await afterChange(); }}
            onError={setError}
          />
        )}
        {dialog?.kind === 'sub' && (
          <SubGoalDialog
            goal={dialog.goal}
            onClose={() => setDialog(null)}
            onDone={async () => { setDialog(null); await afterChange(); }}
            onError={setError}
          />
        )}
        {dialog?.kind === 'confirm-delete' && (
          <Modal open title={`删除目标：${dialog.goal.title}`} onClose={() => setDialog(null)} width={430}>
            <div className="form">
              <p className="ft-confirm">
                将删除这个目标及其全部打卡记录，<b>不可恢复</b>。
                已经同步到笔记模块的读书笔记会保留。
              </p>
              <div className="form__actions">
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await GoalRepository.remove(dialog.goal.id);
                      setDialog(null);
                      await afterChange();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? '删除中…' : '确认删除'}
                </button>
                <button type="button" onClick={() => setDialog(null)}>取消</button>
              </div>
            </div>
          </Modal>
        )}
        {dialog?.kind === 'backup' && (
          <BackupDialog onClose={() => setDialog(null)} onError={setError} />
        )}
    </>
  );

  if (view !== undefined) {
    return (
      <>
        <GoalDetail
          goal={view}
          logs={logsOf(view.id)}
          subs={subsOf(view.id)}
          now={now}
          tick={tick}
          onBack={() => setViewId(null)}
          onCheck={(subId, logId) => setDialog({ kind: 'check', goal: view, subId, logId })}
          onAddSub={() => setDialog({ kind: 'sub', goal: view })}
          onEdit={() => setDialog({ kind: 'edit', goal: view })}
          onDelete={() => setDialog({ kind: 'confirm-delete', goal: view })}
          onChanged={afterChange}
          onError={setError}
        />
        {dialogs}
      </>
    );
  }

  return (
    <>
      <div className="panel goal-page">
        <div className="list-head">
          <h3>🎯 目标</h3>
          <span className="list-head__count">
            {goals.filter((goal) => goal.archived === 0 && goal.voided === 0).length} 个进行中
          </span>
          <button type="button" className="link" onClick={() => setShowArchived((value) => !value)}>
            {showArchived ? '返回进行中' : '归档'}
          </button>
          <button type="button" className="primary" onClick={() => { setError(null); setDialog({ kind: 'add' }); }}>
            ＋ 添加目标
          </button>
        </div>

        {error !== null && <div className="banner banner--bad">{error}</div>}

        {visible.length === 0 ? (
          <p className="card__empty">
            {showArchived
              ? '归档里还没有目标。已完成、已作废或已过期的目标，可以在卡片上点「归档」收进来。'
              : '还没有目标。点「添加目标」开始。'}
          </p>
        ) : (
          <div className="goal-list">
            {visible.map((goal) => (
              <GoalCardItem
                key={goal.id}
                goal={goal}
                logs={logsOf(goal.id)}
                subs={subsOf(goal.id)}
                now={now}
                tick={tick}
                onOpen={() => setViewId(goal.id)}
                onCheck={() => setDialog({ kind: 'check', goal, subId: null, logId: null })}
                onArchive={async () => {
                  await GoalRepository.update(goal.id, { archived: goal.archived === 1 ? 0 : 1 });
                  await afterChange();
                }}
              />
            ))}
          </div>
        )}

      </div>
      {dialogs}
    </>
  );
}

/** One goal card in the list. */
function GoalCardItem(props: {
  goal: Goal;
  logs: GoalLog[];
  subs: GoalSub[];
  now: number;
  tick: number;
  onOpen: () => void;
  onCheck: () => void;
  onArchive: () => void;
}): React.ReactElement {
  const { goal, logs, now } = props;
  const info = goalInfo(goal, logs, now);
  const plan = buildPlan(goal, logs, now);
  const limit = checkInBlocker(goal, logs, now);
  const todayCount = dayCount(logs, now);
  const limited = goal.max_per_day > 0 && todayCount >= goal.max_per_day;
  const finished = goal.voided === 1 || info.isDone || info.isLate || info.notStarted;
  const label = goal.voided === 1
    ? '已作废'
    : info.isDone
      ? '已完成'
      : info.isLate
        ? '已过期'
        : info.notStarted
          ? '未开始'
          : limited
            ? '今日已记录'
            : goal.kind === 'result'
              ? '记录'
              : '打卡';

  const status = goal.voided === 1
    ? '已作废'
    : info.isDone
      ? '已完成'
      : info.isLate
        ? `已超时，还差 ${round1(info.remain)}${goal.unit}`
        : info.notStarted
          ? '尚未开始'
          : `还差 ${round1(info.remain)}${goal.unit}，剩 ${Math.ceil(info.daysLeft)} 天`
          + (goal.kind === 'result' ? '' : perDayNeeded(info) >= 1 ? `，每天约 ${perDayNeeded(info)}${goal.unit}` : '');

  const todayText = plan === null || info.notStarted
    ? ''
    : doneOnDayText(goal, logs, plan, now);

  return (
    <section
      className={`goal${info.isDone ? ' is-done' : ''}${info.isLate ? ' is-late' : ''}${goal.voided === 1 ? ' is-void' : ''}`}
      style={{ ['--gc' as string]: goal.color }}
      onClick={props.onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter') props.onOpen(); }}
    >
      <div className="goal__head">
        <h2>
          {goal.title}
          {goal.kind === 'result' && <small className="mute"> 结果</small>}
        </h2>
        <div className="goal__headside">
          <div className="goal__headbtns">
            {(goal.voided === 1 || info.isDone || info.isLate || goal.archived === 1) && (
              <button type="button" className="link" onClick={(event) => { event.stopPropagation(); props.onArchive(); }}>
                {goal.archived === 1 ? '取消归档' : '归档'}
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={finished || limited}
              onClick={(event) => { event.stopPropagation(); props.onCheck(); }}
            >
              {label}
            </button>
          </div>
          <span className="mute">打卡 {logs.length} 次</span>
        </div>
      </div>

      <Countdown due={goal.due_at} endAt={goal.ended_at} />

      <div className="bar"><i style={{ width: `${info.percent}%` }} /></div>

      <div className="meta">
        <span>
          <b>{goal.kind === 'result'
            ? `当前 ${round1(currentValue(goal, logs))}${goal.unit} → 目标 ${round1(goal.target_value)}${goal.unit}`
            : `${round1(info.done)} / ${goal.target}${goal.unit}`}</b>
          （{info.percent}%）
        </span>
        <span className="mute">时间已过 {info.timePercent}%</span>
      </div>
      <div className="meta mute"><span>{status}</span></div>
      {todayText !== '' && <div className="meta"><span className="goal__today">{todayText}</span></div>}
    </section>
  );
}

/** "今天：该打卡 / 今天：已打卡 / 今天：休息日" line. */
function doneOnDayText(goal: Goal, logs: GoalLog[], plan: ReturnType<typeof buildPlan>, now: number): string {
  if (plan === null) return '';
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const doneToday = logs.some(
    (log) => countsTowardsGoal(goal, log)
      && new Date(log.at).getFullYear() === today.getFullYear()
      && new Date(log.at).getMonth() === today.getMonth()
      && new Date(log.at).getDate() === today.getDate(),
  );
  const first = plan.days[0];
  const plannedToday = first !== undefined && first.at === todayStart && first.planned;
  const next = plan.days.find((day) => day.planned && day.at > todayStart);
  let text = doneToday ? '今天：已打卡' : plannedToday ? `今天：该打卡（${plan.perCheck}${goal.unit}）` : '今天：休息日';
  if ((doneToday || !plannedToday) && next !== undefined) {
    text += `，下次打卡 ${formatDate(next.at)}`;
  }
  if (!plan.feasible) text += '；计划排不下，请调整';
  return text;
}
