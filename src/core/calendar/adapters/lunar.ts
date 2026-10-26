/**
 * Chinese lunar adapter, backed by the `lunar` npm package (v2).
 *
 *  - Range: 1890–2100 (matches `lunar`'s coverage).
 *  - Supports leap months via `isLeapMonth`. The v2 API encodes a leap month
 *    by passing a negative month to `createLunarDate`.
 *  - `resolveAnnual` degrades gracefully: if the target year has no leap
 *    month matching the birth month, we use the non-leap month and mark the
 *    result `degraded: true` so the UI can surface a hint.
 *
 * v2 module surface (no class):
 *   createLunarDate({ year, month, day, isLeapMonth? }) -> Lunar
 *   toGregorian(lunar, { timezone }) -> { date: Date }
 *   toLunar(date, { timezone }) -> { lunar: Lunar }
 */

import * as lunarPackage from 'lunar';
import { BaseAdapter } from './base.js';
import type {
  AdapterCapabilities,
  AdapterYearInfo,
  AnnualResult,
  CalendarFields,
  FieldDescriptor,
  GregorianResult,
  ValidationResult,
} from '../types.js';
import { InvalidDateError } from '../errors.js';

type LunarValue = { year: number; month: number; day: number; isLeapMonth: boolean };

type LunarModule = {
  createLunarDate: (opts: { year: number; month: number; day: number; isLeapMonth?: boolean }) => LunarValue;
  toGregorian: (lunar: LunarValue, opts: { timezone?: string }) => { date: Date };
  toLunar: (date: Date, opts: { timezone?: string }) => { lunar: LunarValue };
  InvalidLunarDateError?: unknown;
};

let lunarMod: LunarModule | null = null;
try {
  // Statically imported: in the browser the package is bundled, so the
  // lookups happen at build time and cannot fail at runtime.
  const mod = lunarPackage as unknown as LunarModule;
  lunarMod = mod ?? null;
} catch {
  lunarMod = null;
}

function toLunarObject(opts: CalendarFields): { year: number; month: number; day: number; isLeapMonth: boolean } {
  return {
    year: opts.year,
    month: opts.month,
    day: opts.day,
    isLeapMonth: Boolean(opts.isLeapMonth),
  };
}

export class LunarAdapter extends BaseAdapter {
  readonly id = 'lunar';
  readonly name = '中国农历';
  readonly minYear = 1890;
  readonly maxYear = 2100;
  readonly dayBoundary = 'midnight' as const;
  readonly capabilities: AdapterCapabilities = {
    hasLeapMonth: true,
    hasSkippedDays: false,
    sunsetBoundary: false,
    needsMoonSighting: false,
    solarAligned: false,
  };

  validate(fields: CalendarFields): ValidationResult {
    const base = this.validateBase(fields, 12, 30);
    if (!base.valid) return base;
    // 时辰 is optional, but when present it must be one of the twelve.
    if (fields.shichen !== undefined && !SHICHEN.includes(fields.shichen as (typeof SHICHEN)[number])) {
      base.errors.push(`时辰「${String(fields.shichen)}」无效，应为十二时辰之一`);
      base.valid = false;
    }
    if (!lunarMod) {
      base.warnings.push('lunar package unavailable; using structural validation only');
      return base;
    }
    try {
      lunarMod.createLunarDate(toLunarObject(fields));
    } catch (e) {
      base.errors.push(`农历日期无效: ${(e as Error).message}`);
      base.valid = false;
    }
    return base;
  }

  toGregorian(fields: CalendarFields, timezone: string): GregorianResult {
    if (!lunarMod) {
      throw new InvalidDateError(this.id, 'lunar package is not available');
    }
    const lunar = lunarMod.createLunarDate(toLunarObject(fields));
    const { date } = lunarMod.toGregorian(lunar, { timezone });
    const localDate = this.tz.formatLocalDate(date, timezone);
    return {
      localDate,
      startUtc: this.buildStartUtc(localDate, timezone),
      timezone,
    };
  }

  fromGregorian(localDate: string, timezone: string): CalendarFields {
    if (!lunarMod) {
      throw new InvalidDateError(this.id, 'lunar package is not available');
    }
    const [y, m, d] = localDate.split('-').map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const offset = this.tz.getOffset(probe.toISOString(), timezone);
    const local = new Date(probe.getTime() - offset * 60_000);
    const { lunar } = lunarMod.toLunar(local, { timezone });
    return {
      year: lunar.year,
      month: lunar.month,
      day: lunar.day,
      isLeapMonth: lunar.isLeapMonth,
    };
  }

  resolveAnnual(
    birthday: CalendarFields,
    targetYear: number,
    timezone: string,
  ): AnnualResult {
    if (!lunarMod) {
      throw new InvalidDateError(this.id, 'lunar package is not available');
    }
    const isLeap = Boolean(birthday.isLeapMonth);
    let degraded = false;
    let degradationReason: string | undefined;

    let lunar = lunarMod.createLunarDate({
      year: targetYear,
      month: birthday.month,
      day: birthday.day,
      isLeapMonth: isLeap,
    });

    let dateResult: { date: Date };
    try {
      dateResult = lunarMod.toGregorian(lunar, { timezone });
    } catch (e) {
      if (isLeap) {
        degraded = true;
        degradationReason = `闰${birthday.month}月生日在 ${targetYear} 年无闰月，按普通月处理`;
        lunar = lunarMod.createLunarDate({
          year: targetYear,
          month: birthday.month,
          day: birthday.day,
          isLeapMonth: false,
        });
        dateResult = lunarMod.toGregorian(lunar, { timezone });
      } else {
        throw new InvalidDateError(this.id, (e as Error).message);
      }
    }

    const localDate = this.tz.formatLocalDate(dateResult.date, timezone);
    return {
      localDate,
      startUtc: this.buildStartUtc(localDate, timezone),
      timezone,
      degraded,
      degradationReason,
    };
  }

  describeFields(): FieldDescriptor[] {
    return [
      { key: 'year', label: '农历年', type: 'number', required: true, min: 1890, max: 2100 },
      { key: 'month', label: '月', type: 'number', required: true, min: 1, max: 12 },
      { key: 'day', label: '日', type: 'number', required: true, min: 1, max: 30 },
      {
        key: 'shichen',
        label: '时辰',
        type: 'string',
        required: false,
        options: [...SHICHEN],
        defaultValue: '辰',
        description: '出生时辰。每个时辰两小时，子时自 23:00 起。默认辰时（07:00–09:00）',
      },
      {
        key: 'isLeapMonth',
        label: '闰月',
        type: 'boolean',
        required: false,
        description: '若出生在闰月，请勾选此项（表单会提示所选年份闰几月）',
      },
    ];
  }

  /**
   * Which month is doubled in a lunar year, for the form's leap-month notice.
   * @param year - lunar year.
   * @returns `{ leapMonth }` — the doubled month number, or null when the year
   *          has no leap month (e.g. 2021, 2026).
   */
  yearInfo(year: number): AdapterYearInfo {
    if (lunarMod === null) return {};
    try {
      const leapMonth = leapMonthOfLunarYear(lunarMod, year);
      return {
        leapMonth,
        note:
          leapMonth === null
            ? `${year} 年没有闰月，不必勾选「闰月」`
            : `${year} 年闰${chineseMonthName(leapMonth)}，若出生在该闰月请勾选「闰月」`,
      };
    } catch {
      return {};
    }
  }
}

/** 十二时辰, in order from 子. */
export const SHICHEN = [
  '子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥',
] as const;

/**
 * Chinese name of a lunar month number, for the leap-month notice.
 *
 * The client keeps its own copy (`src/client/monthNames.ts`) because it cannot
 * import this module without pulling `node:module` into the browser bundle; a
 * test asserts the two agree.
 * @param month - 1..12.
 * @returns The traditional name, falling back to the number.
 */
export function chineseMonthName(month: number): string {
  const names = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
  return names[month - 1] ?? String(month);
}

/**
 * Find the doubled month of a lunar year.
 *
 * The calendar library validates a leap month only when the date is actually
 * converted, so each candidate month is probed until one converts: the one
 * that succeeds is the leap month.
 * @param lunar - the loaded calendar module.
 * @param year - lunar year.
 * @returns The leap month number, or null when the year has none.
 */
export function leapMonthOfLunarYear(lunar: LunarModule, year: number): number | null {
  for (let month = 1; month <= 12; month += 1) {
    try {
      const candidate = lunar.createLunarDate({ year, month, day: 1, isLeapMonth: true });
      lunar.toGregorian(candidate, { timezone: 'UTC' });
      return month;
    } catch {
      // That month is not doubled this year; try the next.
    }
  }
  return null;
}
