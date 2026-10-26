/**
 * 倒计时提醒的偏好设置与「到期」判定。
 *
 * 偏好存在 setting 表里（见 core/setting/repository.ts），这样刷新页面、
 * 关掉标签页再回来，声音开关与音量都还在。
 *
 * 「到期」的语义（整个功能的基准，写在这里以便模块与卡片共用同一套判定）：
 *
 *  - 目标日期当天算「今天」，也就是 `days === 0`，从当天 00:00 起就开始提醒；
 *  - 已经过去的日子（`days < 0`）**不**补响铃 —— 那些日子已经过了，
 *    重新打开页面时对着昨天的事狂响没有意义；
 *  - 因此触发点只有一个：从 `days > 0` 变成 `days === 0` 的那一刻。
 */

import { getSetting, setSetting } from '../setting/repository.js';
import { setRingEnabled, setRingVolume } from './ring.js';

/** 设置键：响铃总开关（'1' / '0'）。 */
export const KEY_RING_ENABLED = 'countdown.ring.enabled';
/** 设置键：铃声音量（0–1 的字符串）。 */
export const KEY_RING_VOLUME = 'countdown.ring.volume';

/** 默认音量。 */
export const DEFAULT_RING_VOLUME = 0.7;

/** 响铃偏好。 */
export interface RingPreferences {
  /** 是否允许响铃。 */
  enabled: boolean;
  /** 音量 0–1。 */
  volume: number;
}

/**
 * 读出响铃偏好。
 *
 * 读不到就用默认值：响铃默认开着（这是这个功能的存在意义），音量取默认值。
 *
 * @returns 响铃偏好。
 */
export async function readRingPreferences(): Promise<RingPreferences> {
  const [savedEnabled, savedVolume] = await Promise.all([
    getSetting(KEY_RING_ENABLED).catch(() => null),
    getSetting(KEY_RING_VOLUME).catch(() => null),
  ]);
  const volume = savedVolume === null ? DEFAULT_RING_VOLUME : Number(savedVolume);
  return {
    enabled: savedEnabled === null ? true : savedEnabled !== '0',
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : DEFAULT_RING_VOLUME,
  };
}

/**
 * 保存响铃偏好。
 *
 * @param preferences - 要保存的偏好。
 */
export async function writeRingPreferences(preferences: RingPreferences): Promise<void> {
  await Promise.all([
    setSetting(KEY_RING_ENABLED, preferences.enabled ? '1' : '0'),
    setSetting(KEY_RING_VOLUME, String(preferences.volume)),
  ]);
}

/**
 * 读出响铃偏好并同步给响铃引擎。
 *
 * 为什么读取放在这里而不是只放在页面上：仪表盘卡片和倒计时页是两个独立的
 * 挂载点，谁都可能先挂上。如果只有倒计时页读偏好，用户停在仪表盘上时引擎
 * 并不知道「声音是关的」，卡片照样会起铃。所以引擎的状态必须由这一处统一下发。
 *
 * @returns 读到的偏好。
 */
export async function loadRingPreferences(): Promise<RingPreferences> {
  const prefs = await readRingPreferences();
  setRingEnabled(prefs.enabled);
  setRingVolume(prefs.volume);
  return prefs;
}

/**
 * 距离目标日期还有几天（可为负）。
 *
 * 用本地日历日做差，跟模块列表里显示的「还有 N 天」保持同一套算法。
 *
 * @param date - 目标日期，YYYY-MM-DD。
 * @param today - 今天，默认取当前日期。
 * @returns 距离目标的天数：0 表示就是今天，负数表示已经过去。
 */
export function daysUntil(date: string, today: Date = new Date()): number {
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const target = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  return Math.round((target - start) / 86_400_000);
}

/**
 * 一个倒计时是否正处在「该响铃」的那一天。
 *
 * @param targetDate - 目标日期，YYYY-MM-DD。
 * @param today - 今天，默认取当前日期。
 * @returns true 表示就是今天（该响铃）。
 */
export function isDueToday(targetDate: string, today: Date = new Date()): boolean {
  return daysUntil(targetDate, today) === 0;
}
