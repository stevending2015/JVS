/**
 * Chinese zodiac animal (生肖) for a birthday.
 *
 * 生肖 follows the **lunar year**, not the Gregorian year: someone born on
 * 20 Jan 1990 belongs to 己巳 (snake), because Chinese New Year had not yet
 * passed. So every record — Gregorian included — is resolved by converting its
 * Gregorian anchor back to the lunar calendar and reading the year *branch*
 * (地支) from the calendar library rather than computing a modulo ourselves.
 *
 * The `lunar` package is optional: without it, no 生肖 is produced and the rest
 * of the record is unaffected.
 */

import * as lunarPackage from 'lunar';
import type { TimezoneService } from '../../calendar/timezone.js';

type LunarValue = { year: number; month: number; day: number; isLeapMonth: boolean };

type LunarModule = {
  toLunar: (date: Date, opts: { timezone?: string }) => { lunar: LunarValue };
  formatLunarParts: (lunar: LunarValue) => Array<{ type: string; value: string }>;
};



let lunarMod: LunarModule | null = null;
try {
  lunarMod = lunarPackage as unknown as LunarModule;
} catch {
  lunarMod = null;
}

/** 地支 → 生肖. */
export const BRANCH_TO_ANIMAL: Record<string, string> = {
  子: '鼠',
  丑: '牛',
  寅: '虎',
  卯: '兔',
  辰: '龙',
  巳: '蛇',
  午: '马',
  未: '羊',
  申: '猴',
  酉: '鸡',
  戌: '狗',
  亥: '猪',
};

/**
 * Zodiac animal for one 地支.
 * @param branch - the lunar year branch, e.g. 午.
 * @returns The animal, or undefined for an unknown branch.
 */
export function shengxiaoFromBranch(branch: string): string | undefined {
  return BRANCH_TO_ANIMAL[branch];
}

/**
 * Resolve the 生肖 for a Gregorian date, by way of the lunar year.
 * @param localDate - `YYYY-MM-DD` in the birth timezone.
 * @param timezone - the birth timezone that anchors the calendar day.
 * @param tz - timezone service used to place local noon on the right day.
 * @returns The animal, or undefined when the library is missing or the date is
 *          outside its supported range.
 */
export function shengxiaoFromGregorian(
  localDate: string,
  timezone: string,
  tz: TimezoneService,
): string | undefined {
  if (lunarMod === null) return undefined;
  try {
    const [year, month, day] = localDate.split('-').map(Number);
    // Anchor at local noon so the calendar day survives any UTC offset.
    const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const offset = tz.getOffset(probe.toISOString(), timezone);
    const local = new Date(probe.getTime() - offset * 60_000);
    const { lunar } = lunarMod.toLunar(local, { timezone });
    const parts = lunarMod.formatLunarParts(lunar);
    const branch = parts.find((p) => p.type === 'yearBranch')?.value;
    return branch === undefined ? undefined : BRANCH_TO_ANIMAL[branch];
  } catch {
    return undefined;
  }
}
