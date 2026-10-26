/**
 * Goal detail view, forms and dialogs.
 *
 * Split from the page so the list stays readable; the pieces share the same
 * behaviour as the reference implementation (add / edit a goal, add a sub-goal,
 * check in, plan, backup).
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
import { createCheckInNote } from '../../core/goal/noteSync.js';
import { GoalRepository, type Goal, type GoalLog, type GoalSub } from '../../core/goal/repository.js';

/** Detail page for one goal. */
export function GoalDetail(props: {
  goal: Goal;
  logs: GoalLog[];
  subs: GoalSub[];
  now: number;
  tick: number;
  onBack: () => void;
  onCheck: (subId: string | null, logId: string | null) => void;
  onAddSub: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}): React.ReactElement {
  const { goal, logs, subs, now } = props;
  const info = goalInfo(goal, logs, now);
  const plan = buildPlan(goal, logs, now);
  const prediction = forecast(goal, logs, now);
  const todayCount = dayCount(logs, now);
  const todayAmount = logs
    .filter((log) => {
      const at = new Date(log.at);
      const start = new Date();
      return at.getFullYear() === start.getFullYear()
        && at.getMonth() === start.getMonth()
        && at.getDate() === start.getDate();
    })
    .reduce((sum, log) => sum + log.amount, 0);

  return (
    <div className="panel goal-page">
      <button type="button" className="link goal__back" onClick={props.onBack}>← 返回全部目标</button>

      <section className="goal" style={{ ['--gc' as string]: goal.color }}>
        <div className="goal__head">
          <h2>{goal.title}</h2>
          <div className="goal__headside">
            <div className="goal__headbtns">
              <button type="button" className="link" onClick={() => void props.onChanged()}>刷新</button>
              <button type="button" className="link" onClick={props.onEdit}>编辑</button>
              <button type="button" className="link" onClick={props.onDelete}>删除目标</button>
            </div>
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
        <div className="meta mute">
          <span>{formatMoment(goal.start_at)} 至 {formatMoment(goal.due_at)}</span>
          <span>
            {goal.kind === 'result'
              ? `起始 ${round1(goal.start_value)}${goal.unit}`
              : `今天已完成 ${round1(todayAmount)}${goal.unit}`}
            {goal.max_per_day > 0 ? `（打卡 ${todayCount}/${goal.max_per_day} 次）` : ''}
          </span>
        </div>
      </section>

      {plan !== null && (
        <PlanPanel goal={goal} plan={plan} logs={logs} now={now} />
      )}

      {goal.kind === 'qty' && (
        <>
          <div className="goal__sectionhead">
            <h3>子目标（每本书一个）</h3>
            <button type="button" className="link" onClick={props.onAddSub}>＋ 添加子目标</button>
          </div>
          {subs.length === 0 ? (
            <p className="card__empty">
              可选：为每本书建一个子目标（如《小王子》），打卡时选这本书并写读后感 ——
              笔记会按 <code>#《书名》</code> 的格式同步到笔记模块。
            </p>
          ) : (
            <ul className="goal__subs">
              {subs.map((sub) => {
                const done = subDone(sub.id, logs);
                const remain = Math.max(0, sub.total - done);
                const percent = sub.total <= 0 ? 0 : Math.min(100, Math.round((done / sub.total) * 100));
                return (
                  <li key={sub.id} className="goal__sub" style={{ ['--gc' as string]: goal.color }}>
                    <div className="goal__head">
                      <b>《{sub.name}》</b>
                      <span className="mute">{round1(done)} / {sub.total}{sub.unit}（{percent}%）</span>
                    </div>
                    <div className="bar bar--thin"><i style={{ width: `${percent}%` }} /></div>
                    <div className="meta mute">
                      <span>
                        {remain <= 0
                          ? '已完成'
                          : `${sub.unit === '页' ? `已读到第 ${round1(done)} 页，` : ''}还剩 ${round1(remain)}${sub.unit}`}
                      </span>
                      <button
                        type="button"
                        className="link"
                        disabled={remain <= 0}
                        onClick={() => props.onCheck(sub.id, null)}
                      >
                        打卡
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <div className="goal__sectionhead">
        <h3>打卡记录（{logs.length}）</h3>
        <button
          type="button"
          className="primary"
          disabled={checkInBlocker(goal, logs, now) !== ''}
          onClick={() => props.onCheck(null, null)}
        >
          去打卡
        </button>
      </div>

      {logs.length === 0 ? (
        <p className="card__empty">还没有打卡记录。</p>
      ) : (
        <ul className="goal__logs">
          {logs.map((log) => {
            const sub = subs.find((candidate) => candidate.id === log.sub_id);
            return (
              <li key={log.id}>
                <div>
                  <span className="mute">{formatMoment(log.at)}</span>{' '}
                  <b>
                    {goal.kind === 'result'
                      ? `当前 ${round1(log.value ?? 0)}${goal.unit}`
                      : `${log.position !== null ? `读到第 ${round1(log.position)} 页，` : ''}+${round1(log.amount)}${sub?.unit ?? goal.unit}`}
                  </b>
                  {sub !== undefined && <span className="mute"> 《{sub.name}》</span>}
                  {log.note !== '' && <p className="goal__logtext">{log.note}</p>}
                  {log.note_id !== null && <span className="tag">已同步到笔记</span>}
                </div>
                <span>
                  <button type="button" className="link" onClick={() => props.onCheck(log.sub_id, log.id)}>编辑</button>
                  <button
                    type="button"
                    className="link link--danger"
                    onClick={async () => {
                      await GoalRepository.deleteLog(log.id);
                      await props.onChanged();
                    }}
                  >
                    删除
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <section className="goal__plan">
        <h3>待完成与分配</h3>
        {goal.kind === 'result' ? (
          <ResultPlan goal={goal} logs={logs} now={now} />
        ) : (
          <div className="stats">
            <div><b>{round1(info.remain)}</b><span>待完成{goal.unit}</span></div>
            <div><b>{Math.ceil(info.daysLeft)}</b><span>剩余天数</span></div>
            {perDayNeeded(info) >= 1 && <div><b>{perDayNeeded(info)}</b><span>每天需完成{goal.unit}</span></div>}
            {perWeekNeeded(info) >= 1 && <div><b>{perWeekNeeded(info)}</b><span>每周需完成{goal.unit}</span></div>}
          </div>
        )}
        {prediction !== null && (
          <p className="mute" style={{ margin: '0 0 6px', fontSize: 14, color: prediction.late ? 'var(--bad)' : undefined }}>
            {prediction.text}
          </p>
        )}
        {goal.kind === 'qty' && (
          <p className="mute" style={{ margin: 0, fontSize: 13 }}>
            按你平均每次打卡 {round1(averagePerCheck(goal, logs))}{goal.unit} 计算，还需再打卡约{' '}
            {Math.ceil(info.remain / Math.max(averagePerCheck(goal, logs), 1) - 1e-9)} 次。
          </p>
        )}
      </section>
    </div>
  );
}

/** The projected check-in days. */
function PlanPanel(props: {
  goal: Goal;
  plan: NonNullable<ReturnType<typeof buildPlan>>;
  logs: GoalLog[];
  now: number;
}): React.ReactElement {
  const { goal, plan } = props;
  const [work, rest] = goal.pattern.split('-');
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return (
    <section className="goal__plan">
      <h3>打卡计划（打卡 {work} 天休 {rest} 天，{goal.shape === 'even' ? '均匀分布' : '前紧后松'}）</h3>
      <div className="goal__plandays">
        {plan.days.slice(0, 14).map((day) => {
          const date = new Date(day.at);
          return (
            <span key={day.at} className={day.planned ? 'is-plan' : ''}>
              {date.getMonth() + 1}/{date.getDate()}
              <small>周{weekdays[date.getDay()]} {day.planned ? '打卡' : '休'}</small>
            </span>
          );
        })}
      </div>
      <p className="mute" style={{ margin: '0 0 6px', fontSize: 14 }}>
        {!plan.feasible
          ? `即使每天都打卡，到截止日也只能安排 ${plan.days.length} 次，少于剩余的 ${round1(goal.target - doneOf(goal, props.logs))}${goal.unit}。请调整总量、延长截止时间或放宽每天次数。`
          : plan.leadDays > 0
            ? `按「打卡 ${work} 天休 ${rest} 天」到截止日最多只能完成 ${plan.days.filter((day) => day.planned).length} 次，不够剩余的量，所以前 ${plan.leadDays} 天需要连续打卡，之后再按节奏休息。`
            : `按「打卡 ${work} 天休 ${rest} 天」可以排下，剩余的量共需 ${plan.needed} 个打卡日（每次 ${plan.perCheck}${goal.unit}）。`}
        {' '}预计 {formatDate(plan.end)} 完成。
      </p>
      <p className="mute" style={{ margin: 0, fontSize: 13 }}>
        计划每次打开都会按剩余量重新排：漏打卡的话，后面的安排会自动顺延。
      </p>
    </section>
  );
}

/** The plan panel for result-based goals. */
function ResultPlan(props: { goal: Goal; logs: GoalLog[]; now: number }): React.ReactElement {
  const { goal, logs, now } = props;
  const info = goalInfo(goal, logs, now);
  const current = currentValue(goal, logs);
  const weeks = Math.max(info.daysLeft / 7, 1);
  const expected = goal.start_value + goal.direction * goal.target * (info.timePercent / 100);
  const deviation = goal.direction * (current - expected);
  return (
    <>
      <div className="stats">
        <div><b>{round1(current)}</b><span>当前（{goal.unit}）</span></div>
        <div><b>{round1(goal.target_value)}</b><span>目标（{goal.unit}）</span></div>
        <div><b>{round1(info.remain)}</b><span>还差（{goal.unit}）</span></div>
        <div><b>{round1(info.remain / weeks)}</b><span>每周需变化（{goal.unit}）</span></div>
      </div>
      <p className="mute" style={{ margin: '0 0 6px' }}>
        按时间均匀推进，今天应到 {round1(expected)}{goal.unit}；你现在是 {round1(current)}{goal.unit}，
        {deviation >= 0 ? '领先 ' : '落后 '}{round1(Math.abs(deviation))}{goal.unit}。
      </p>
    </>
  );
}

/** Add / edit a goal. */
export function GoalForm(props: {
  title: string;
  goal?: Goal;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (message: string | null) => void;
}): React.ReactElement {
  const { goal } = props;
  const [kind, setKind] = React.useState<'qty' | 'result'>(goal?.kind ?? 'qty');
  const [color, setColor] = React.useState(goal?.color ?? GOAL_COLORS[0] ?? '#2f4bff');
  const [unit, setUnit] = React.useState(goal?.unit ?? '个');
  const [customUnit, setCustomUnit] = React.useState(
    goal !== undefined && !GOAL_UNITS.includes(goal.unit) ? goal.unit : '',
  );
  const [busy, setBusy] = React.useState(false);

  const now = new Date();
  const defaultStart = new Date(now.getTime());
  const defaultDue = new Date(now.getTime() + 30 * 86_400_000);
  const toLocalInput = (date: Date): string => {
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const title = String(data.get('title') ?? '').trim();
    const startAt = String(data.get('start') ?? '');
    const dueAt = String(data.get('due') ?? '');
    if (title === '') { props.onError('目标名称不能为空'); return; }
    if (new Date(dueAt).getTime() <= new Date(startAt).getTime()) {
      props.onError('截止时间必须晚于起始时间');
      return;
    }
    const effectiveUnit = unit === '__c' ? customUnit.trim() : unit;
    const startValue = Number(data.get('startValue') ?? 0);
    const targetValue = Number(data.get('targetValue') ?? 0);
    const total = kind === 'result'
      ? Math.abs(targetValue - startValue)
      : Number(data.get('target') ?? 0);
    if (kind === 'result' && !(total > 0)) {
      props.onError('起始数值和目标数值不能相同');
      return;
    }
    if (kind === 'qty' && !(total > 0)) {
      props.onError('目标总量必须大于 0');
      return;
    }

    setBusy(true);
    props.onError(null);
    try {
      const payload = {
        title,
        kind,
        target: total,
        unit: effectiveUnit,
        initial_done: kind === 'qty' ? Math.min(total, Math.max(0, Number(data.get('initial') ?? 0))) : 0,
        start_value: kind === 'result' ? startValue : 0,
        target_value: kind === 'result' ? targetValue : 0,
        direction: kind === 'result' ? (targetValue > startValue ? 1 : -1) : 1,
        start_at: new Date(startAt).toISOString(),
        due_at: new Date(dueAt).toISOString(),
        max_per_day: Number(data.get('maxPerDay') ?? 0),
        pattern: kind === 'qty' ? String(data.get('pattern') ?? '0') : '0',
        shape: kind === 'qty' ? (String(data.get('shape') ?? 'front') === 'even' ? 'even' as const : 'front' as const) : 'front' as const,
        color,
        archived: goal?.archived ?? 0,
        voided: goal?.voided ?? 0,
      };
      if (goal === undefined) await GoalRepository.createGoal(payload);
      else await GoalRepository.updateGoal(goal.id, payload);
      await props.onSaved();
    } catch (e) {
      props.onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={props.title} onClose={props.onClose} width={620}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <label>
          目标类型
          <select
            name="kind"
            value={kind}
            disabled={goal !== undefined}
            onChange={(event) => setKind(event.target.value === 'result' ? 'result' : 'qty')}
          >
            <option value="qty">数量导向：累计完成多少（如学 100 个单词、跑 60 次）</option>
            <option value="result">结果导向：达到某个数值（如体重到 65 kg）</option>
          </select>
        </label>

        <label>目标名称<input name="title" required maxLength={40} defaultValue={goal?.title ?? ''} placeholder="例如：读书" /></label>

        {kind === 'qty' ? (
          <>
            <label>目标总量<input name="target" type="number" min="1" step="any" required defaultValue={goal?.target ?? ''} placeholder="60" /></label>
            <label>
              单位
              <select
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
              >
                {GOAL_UNITS.map((option) => <option key={option} value={option}>{option}</option>)}
                <option value="__c">自定义…</option>
              </select>
            </label>
            {unit === '__c' && <input maxLength={6} placeholder="输入单位" value={customUnit} onChange={(event) => setCustomUnit(event.target.value)} />}
            <label>已完成数量（中途开始时填写）<input name="initial" type="number" min="0" step="any" defaultValue={goal?.initial_done ?? 0} /></label>
          </>
        ) : (
          <>
            <label>起始数值（现在的数值）<input name="startValue" type="number" step="any" min="0" required defaultValue={goal?.start_value ?? ''} /></label>
            <label>目标数值<input name="targetValue" type="number" step="any" min="0" required defaultValue={goal?.target_value ?? ''} /></label>
            <label>单位<input name="unitText" maxLength={6} defaultValue={goal?.unit ?? 'kg'} placeholder="例如 kg / 分钟 / %" /></label>
          </>
        )}

        <label>
          每天最多打卡
          <select name="maxPerDay" defaultValue={String(goal?.max_per_day ?? 0)}>
            <option value="0">不限次数</option>
            <option value="1">1 次</option>
            <option value="2">2 次</option>
            <option value="3">3 次</option>
          </select>
        </label>

        {kind === 'qty' && (
          <>
            <label>
              打卡节奏
              <select name="pattern" defaultValue={goal?.pattern ?? '0'}>
                <option value="0">不限（每天都可打卡）</option>
                <option value="1-1">打卡 1 天，休 1 天</option>
                <option value="2-1">打卡 2 天，休 1 天</option>
                <option value="3-1">打卡 3 天，休 1 天</option>
              </select>
            </label>
            <label>
              分配方式
              <select name="shape" defaultValue={goal?.shape ?? 'front'}>
                <option value="front">前紧后松</option>
                <option value="even">均匀分布</option>
              </select>
            </label>
          </>
        )}

        <label>起始时间<input name="start" type="datetime-local" required defaultValue={goal?.start_at !== undefined ? toLocalInput(new Date(goal.start_at)) : toLocalInput(defaultStart)} /></label>
        <label>截止时间<input name="due" type="datetime-local" required defaultValue={goal?.due_at !== undefined ? toLocalInput(new Date(goal.due_at)) : toLocalInput(defaultDue)} /></label>

        <div className="form__row">
          <span className="form__label">颜色标签</span>
          <div className="sw">
            {GOAL_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                style={{ background: option }}
                aria-label={`颜色 ${option}`}
                aria-pressed={color === option}
                onClick={() => setColor(option)}
              />
            ))}
          </div>
        </div>

        <div className="form__actions">
          <button type="submit" className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
          <button type="button" onClick={props.onClose} disabled={busy}>取消</button>
        </div>
      </form>
    </Modal>
  );
}

/** Add a sub-goal (a book). */
export function SubGoalDialog(props: {
  goal: Goal;
  onClose: () => void;
  onDone: () => Promise<void>;
  onError: (message: string | null) => void;
}): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  return (
    <Modal open title="添加子目标" onClose={props.onClose} width={440}>
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const name = String(data.get('name') ?? '').trim();
          if (name === '') { props.onError('名称不能为空'); return; }
          setBusy(true);
          try {
            await GoalRepository.createSub({
              goalId: props.goal.id,
              name,
              unit: String(data.get('unit') ?? ''),
              total: Number(data.get('total') ?? 0),
            });
            await props.onDone();
          } catch (e) {
            props.onError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>名称（例如书名）<input name="name" required maxLength={40} /></label>
        <label>单位<input name="unit" maxLength={6} placeholder="页 / 本 / 章" /></label>
        <label>总量<input name="total" type="number" min="1" step="1" required /></label>
        <div className="form__actions">
          <button type="submit" className="primary" disabled={busy}>{busy ? '添加中…' : '添加'}</button>
          <button type="button" onClick={props.onClose} disabled={busy}>取消</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Check-in dialog.
 *
 * When a sub-goal is picked and the content box is filled, the check-in is also
 * written to the notes module as `#《书名》 … #`.
 */
export function CheckInDialog(props: {
  goal: Goal;
  subs: GoalSub[];
  logs: GoalLog[];
  log: GoalLog | null;
  /** Pre-selected sub-goal (when opened from a book's 打卡 button). */
  initialSubId?: string | null;
  onClose: () => void;
  onDone: () => Promise<void>;
  onError: (message: string | null) => void;
}): React.ReactElement {
  const { goal, subs, logs, log } = props;
  const editing = log !== null;
  const [subId, setSubId] = React.useState<string>(() => {
    if (log !== null) return log.sub_id ?? '';
    if (props.initialSubId !== undefined && props.initialSubId !== null) return props.initialSubId;
    // 从「去打卡」进入时，默认选在读的那本（第一个还没读完的子目标），
    // 免得打卡记了却不知道是哪本书。
    const inProgress = subs.find((sub) => subDone(sub.id, logs) < sub.total);
    return inProgress?.id ?? '';
  });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const selectedSub = subs.find((sub) => sub.id === subId);
  const unit = selectedSub !== undefined ? selectedSub.unit : goal.unit;
  const isPage = unit === '页';
  const currentPos = selectedSub !== undefined ? subDone(selectedSub.id, logs) : 0;

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const note = String(data.get('note') ?? '').trim();
    const at = new Date(String(data.get('at') ?? '')).getTime() || Date.now();
    const now = Date.now();

    if (!editing) {
      const blocker = checkInBlocker(goal, logs, now, at);
      if (blocker !== '') { setError(blocker); return; }
    } else if (at > now + 60_000) {
      setError('不能填写未来时间');
      return;
    }

    let amount = Number(data.get('amount') ?? 0);
    let position: number | null = null;
    if (goal.kind === 'result') {
      amount = 0;
    } else if (isPage && String(data.get('mode') ?? 'pos') === 'pos') {
      position = Number(data.get('amount') ?? 0);
      amount = position - currentPos;
      if (!(amount > 0)) {
        setError(`读到的页数必须大于目前已读到的第 ${round1(currentPos)} 页`);
        return;
      }
    }

    if (goal.kind === 'qty' && !editing) {
      const limit = amountLimit(goal, logs, selectedSub);
      if (amount > limit + 1e-9) {
        setError(`完成量不能超过 ${round1(limit)}${unit}`);
        return;
      }
      if (unitNeedsInteger(unit) && !Number.isInteger(amount)) {
        setError('这个单位的完成量必须是整数');
        return;
      }
      if (goal.max_per_day > 0 && dayCount(logs, at) >= goal.max_per_day) {
        setError(`这个目标每天最多打卡 ${goal.max_per_day} 次，这一天已经打满。`);
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      // 打卡笔记同步：内容不为空才写入笔记模块。
      let noteId: string | null = editing ? log.note_id : null;
      if (!editing && note !== '') {
        const created = await createCheckInNote({
          bookName: selectedSub?.name ?? '',
          content: note,
          goalTitle: goal.title,
        });
        noteId = created?.id ?? null;
      }

      if (editing && log !== null) {
        await GoalRepository.updateLog(log.id, {
          sub_id: subId === '' ? null : subId,
          amount,
          value: goal.kind === 'result' ? Number(data.get('amount') ?? 0) : null,
          position,
          note,
          at: new Date(at).toISOString(),
        });
      } else {
        await GoalRepository.createLog({
          goalId: goal.id,
          subId: subId === '' ? null : subId,
          amount,
          value: goal.kind === 'result' ? Number(data.get('amount') ?? 0) : null,
          position,
          note,
          noteId,
          at: new Date(at).toISOString(),
        });
      }
      await props.onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const toLocalInput = (timestamp: number): string => {
    const date = new Date(timestamp);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  return (
    <Modal open title={`${editing ? '编辑打卡' : '打卡'}：${goal.title}`} onClose={props.onClose} width={520}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        {subs.length > 0 && (
          <label>
            子目标（可选）
            <select name="sub" value={subId} onChange={(event) => setSubId(event.target.value)}>
              <option value="">不指定</option>
              {subs.map((sub) => <option key={sub.id} value={sub.id}>《{sub.name}》</option>)}
            </select>
          </label>
        )}

        {isPage && (
          <label>
            记录方式
            <select name="mode" defaultValue="pos">
              <option value="pos">读到第几页</option>
              <option value="amt">本次读了几页</option>
            </select>
          </label>
        )}

        <label>
          {goal.kind === 'result' ? `当前数值（${goal.unit}）` : `完成量（${unit || '数量'}）`}
          <input
            name="amount"
            type="number"
            min={goal.kind === 'result' ? '0' : '0.1'}
            step="any"
            required
            defaultValue={editing
              ? (log.value ?? log.amount)
              : (goal.kind === 'result' ? currentValue(goal, logs) : (isPage ? currentPos + 1 : 1))}
          />
        </label>

        <label>打卡时间<input name="at" type="datetime-local" required defaultValue={toLocalInput(editing ? new Date(log?.at ?? Date.now()).getTime() : Date.now())} /></label>

        <label>
          {subs.length > 0 ? '内容 / 读后感' : '内容'}
          <textarea name="note" rows={3} maxLength={1000} defaultValue={editing ? log?.note : ''} placeholder="例如：读《小王子》第三章，感受很深" />
        </label>

        {subs.length > 0 && (
          <p className="form__hint">
            内容不为空时，会按 <code>#{'《书名》'}</code> 的格式同步一篇笔记到笔记模块。
          </p>
        )}

        {error !== null && <div className="banner banner--bad">{error}</div>}

        <div className="form__actions">
          <button type="submit" className="primary" disabled={busy}>{busy ? '保存中…' : editing ? '保存' : '完成打卡'}</button>
          <button type="button" onClick={props.onClose} disabled={busy}>取消</button>
        </div>
      </form>
    </Modal>
  );
}

/** Backup and restore: a JSON text the user can copy somewhere safe. */
export function BackupDialog(props: {
  onClose: () => void;
  onError: (message: string | null) => void;
}): React.ReactElement {
  const [text, setText] = React.useState('');
  const [preview, setPreview] = React.useState('');

  async function build(): Promise<void> {
    const goals = await GoalRepository.list();
    const payload = {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      goals: await Promise.all(goals.map(async (goal) => ({
        ...goal,
        subs: await GoalRepository.listSubs(goal.id),
        logs: await GoalRepository.listLogs(goal.id),
      }))),
    };
    setText(JSON.stringify(payload, null, 2));
  }

  React.useEffect(() => { void build(); }, []);

  async function restore(): Promise<void> {
    try {
      const parsed = JSON.parse(text) as { goals?: Array<Record<string, unknown>> };
      if (!Array.isArray(parsed.goals)) throw new Error('备份格式不对');
      for (const goal of parsed.goals) {
        const id = String(goal.id ?? '');
        if (id === '') continue;
        const existing = await GoalRepository.getGoal(id);
        const payload = { ...goal } as unknown as Parameters<typeof GoalRepository.createGoal>[0];
        if (existing === null) await GoalRepository.createGoal(payload);
        else await GoalRepository.updateGoal(id, payload);
      }
      props.onClose();
    } catch (e) {
      props.onError((e as Error).message);
    }
  }

  return (
    <Modal open title="备份与恢复" onClose={props.onClose} width={620}>
      <div className="form">
        <p className="form__hint">
          数据只存在这个浏览器的数据库里，清理浏览器数据或换设备会丢失，请定期复制备份文本保存到自己的网盘。
        </p>
        <label>导出：复制下面的备份文本<textarea rows={6} readOnly value={text} /></label>
        <div className="form__actions">
          <button
            type="button"
            onClick={() => { void navigator.clipboard?.writeText(text); }}
          >
            复制备份
          </button>
          <button type="button" onClick={() => void build()}>刷新</button>
        </div>
        <label>导入：粘贴备份文本<textarea rows={4} value={preview} onChange={(event) => setPreview(event.target.value)} placeholder="粘贴之前复制的备份" /></label>
        {preview !== '' && (
          <div className="form__actions">
            <button type="button" className="primary" onClick={async () => { setText(preview); await restore(); }}>
              合并导入
            </button>
          </div>
        )}
        <div className="form__actions">
          <button type="button" onClick={props.onClose}>关闭</button>
        </div>
      </div>
    </Modal>
  );
}

/** The day/hour/minute/second countdown. */
export function Countdown({ due, endAt }: { due: string; endAt: string | null }): React.ReactElement {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const target = endAt === null ? new Date(due).getTime() : new Date(endAt).getTime();
  const seconds = Math.max(0, Math.floor((target - now) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    <div className="clock">
      <div><b>{days}</b><span>天</span></div>
      <div><b>{pad(hours)}</b><span>时</span></div>
      <div><b>{pad(minutes)}</b><span>分</span></div>
      <div><b>{pad(rest)}</b><span>秒</span></div>
    </div>
  );
}