/**
 * 「刚结束、还没被确认」的那一轮专注，做成全局可读的小状态。
 *
 * 为什么不是组件内部 state：结束提醒同时出现在两个地方 —— 全局浮层
 * （FocusAlarm，任何页面都能看到）和**专注卡片**（仪表盘上）。两处必须看到
 * 同一份状态，否则会出现「卡片还在提示、点掉浮层后卡片不消失」这种不一致。
 *
 * 形态照抄 core/audio/ring.ts 的单例 + 订阅写法，组件用 useEffect 订阅。
 */

/** 一轮已经结束、等待用户确认的专注。 */
export interface FocusAlarmState {
  /** 会话 id，同时充当这次提醒的唯一键。 */
  sessionId: string;
  /** 这一轮的计划时长（分钟），只用于文案。 */
  minutes: number;
}

type Listener = (state: FocusAlarmState | null) => void;

let current: FocusAlarmState | null = null;
const listeners = new Set<Listener>();

/**
 * 记下一轮刚结束的专注。
 *
 * @param next - 结束的会话与时长。
 */
export function setFocusAlarm(next: FocusAlarmState): void {
  current = next;
  for (const listener of listeners) listener(current);
}

/**
 * 用户确认（或关掉提示）后清空。
 */
export function clearFocusAlarm(): void {
  current = null;
  for (const listener of listeners) listener(current);
}

/**
 * 当前待确认的提醒。
 *
 * @returns 没有待确认时为 null。
 */
export function focusAlarmState(): FocusAlarmState | null {
  return current;
}

/**
 * 订阅变化。
 *
 * @param listener - 状态变化时调用。
 * @returns 退订函数。
 */
export function subscribeFocusAlarm(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
