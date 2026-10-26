/**
 * 专注结束的**全局**提醒。
 *
 * 为什么必须是全局组件：番茄归零的检测原来写在「专注」页里（FocusPage 的
 * effect），只有那个页面挂载时才跑。人在别的模块（或仪表盘）时，计时归零了
 * 一点反应都没有；等再点回专注页，那一瞬间才「滴」一声并自动落库 ——
 * 表现就是用户看到的「只有再进入模块才会响一下」。
 *
 * 现在把检测提到这里，挂在 App 外壳上，任何页面都会按秒检查：
 *   - 番茄真正归零 → 自动落库 + 起铃（持续响到用户点「知道了」）；
 *   - 提醒卡片是全局浮层，不依赖当前在哪个模块；
 *   - 铃声复用全局响铃引擎（和倒计时到期同一个 AudioContext），
 *     不会出现两层声音叠在一起。
 *
 * 每次结束用一个**新的 key**（session id）：用户确认过上一个番茄之后，
 * 下一个番茄结束仍然会响 —— 只按标题去重的话只会响第一个。
 */

import * as React from 'react';
import {
  armRing,
  ringNow,
  ringStatus,
  startRing,
  stopRing,
  subscribeRing,
  type RingState,
} from '../core/audio/ring.js';
import { FocusRepository } from '../core/focus/repository.js';
import { useStore } from '../core/store.js';

/** 提醒卡片上显示的标题。 */
const ALARM_TITLE = '专注结束';

/** 一轮已经结束、等待用户确认的番茄。 */
interface FinishedAlarm {
  /** 会话 id，同时作为这次提醒的唯一 key。 */
  id: string;
  /** 计划时长（分钟）。 */
  minutes: number;
}

export function FocusAlarm(): React.ReactElement | null {
  const { focusSession, focusSoundOn, refreshFocus } = useStore();
  const [state, setState] = React.useState<RingState>(ringStatus().state);
  /** 刚结束、还没被用户关掉的那一轮；null 表示没有要显示的东西。 */
  const [finished, setFinished] = React.useState<FinishedAlarm | null>(null);
  /** 已经处理（落库 + 起铃）过的 session id，防止同一个番茄重复处理。 */
  const handledRef = React.useRef<string | null>(null);

  React.useEffect(() => subscribeRing((next) => setState(next)), []);

  // 自动播放策略兜底：被挡住时，用户第一次点/按键就把铃补上。
  React.useEffect(() => {
    if (state !== 'blocked') return undefined;
    return armRing();
  }, [state]);

  /** 新的番茄一开始，就把上一轮的提示收掉。 */
  React.useEffect(() => {
    if (focusSession === null) return;
    if (finished !== null && focusSession.id !== finished.id) setFinished(null);
  }, [focusSession, finished]);

  /**
   * 每秒检查一次「番茄是不是已经到点了」。
   *
   * 只看 pomodoro：正计时没有终点，不该响。
   * 用时间戳推导而不是依赖 interval 的准确度 —— 标签页被节流、电脑休眠后
   * 回来，下一次 tick 会立刻算出早已超时，仍然会正确触发。
   */
  React.useEffect(() => {
    if (focusSession === null || focusSession.mode !== 'pomodoro') return undefined;

    const session = focusSession;
    const isDue = (): boolean => {
      const started = new Date(session.start_time).getTime();
      const elapsed = Math.max(0, (Date.now() - started) / 1000);
      return elapsed >= session.planned_seconds;
    };

    // 挂载时就已经超时（比如刷新页面回来）：立刻处理，不用等下一个 tick。
    if (isDue() && handledRef.current !== session.id) {
      void handleFinished(session);
      return undefined;
    }

    const timer = window.setInterval(() => {
      if (handledRef.current === session.id) return;
      if (isDue()) void handleFinished(session);
    }, 1000);

    return () => window.clearInterval(timer);
    // handleFinished 只依赖 ref 与 props，故意不进依赖表。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSession]);

  /**
   * 到点之后的收尾：落库、刷新全局状态、起铃。
   *
   * 先起铃再落库：落库要走一次 Worker，万一慢一点，铃声也不该迟到。
   *
   * @param session - 刚结束的会话。
   */
  async function handleFinished(session: { id: string; planned_seconds: number }): Promise<void> {
    if (handledRef.current === session.id) return;
    handledRef.current = session.id;

    const minutes = Math.max(1, Math.round(session.planned_seconds / 60));
    setFinished({ id: session.id, minutes });

    // 用户把「结束提示音」关了就不出声；但仍然显示卡片告诉他已经结束了。
    if (focusSoundOn) {
      // bypassMute：引擎的总开关属于倒计时，专注不跟着它一起哑。
      await startRing([ALARM_TITLE], false, `focus:${session.id}`, true);
    }

    try {
      await FocusRepository.stop(session.id, session.planned_seconds);
      await refreshFocus();
    } catch {
      // 落库失败不影响「已经提醒过」这件事，用户可以自己去专注页停表。
    }
  }

  /** 用户点「知道了」：停铃并收掉卡片。 */
  const acknowledge = React.useCallback(() => {
    stopRing();
    setFinished(null);
  }, []);

  /** 被自动播放策略挡住时，用户点一下才出声 —— 这一下本身就是用户手势。 */
  const enable = React.useCallback(() => {
    const key = `focus:${handledRef.current ?? 'manual'}`;
    void ringNow([ALARM_TITLE], key, true);
  }, []);

  if (finished === null) return null;

  const ringing = state === 'ringing';
  const blocked = state === 'blocked';

  return (
    <div className={`focus-alarm${ringing ? ' is-ringing' : ''}`} role="status" aria-live="assertive">
      <span className="focus-alarm__icon" aria-hidden="true">{ringing ? '⏱' : blocked ? '⏰' : '✅'}</span>
      <span className="focus-alarm__text">
        <b>{ALARM_TITLE} · {finished.minutes} 分钟已完成</b>
        <span className="focus-alarm__sub">
          {ringing
            ? '正在持续响铃，点「知道了」停止。'
            : blocked
              ? '浏览器要求先有一次点击才能出声，点「开启提醒」。'
              : focusSoundOn
                ? '已记录，铃声已停止。'
                : '已记录（结束提示音是关闭的）。'}
        </span>
      </span>
      <span className="focus-alarm__actions">
        {blocked && (
          <button type="button" className="primary" onClick={enable}>开启提醒</button>
        )}
        {ringing && (
          <button type="button" className="primary" onClick={acknowledge}>知道了</button>
        )}
        {!ringing && !blocked && (
          <button type="button" className="btn" onClick={acknowledge}>关闭</button>
        )}
      </span>
    </div>
  );
}
