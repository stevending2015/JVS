/**
 * Islamic (Hijri) adapter. Uses a tabular arithmetic calendar (30-year cycle)
 * consistent with the most widely-used conventions. We implement the JDN
 * conversion directly so we don't pull a 3rd-party package for one algorithm.
 *
 * Day boundary is sunset (`dayBoundary: 'sunset'`). For the purposes of a
 * birthday, we treat the Hijri calendar day as the civil day; the UI surfaces
 * `afterSunset` to disambiguate when the user was actually born.
 */

import { BaseAdapter } from './base.js';
import type {
  AdapterCapabilities,
  AnnualResult,
  CalendarFields,
  FieldDescriptor,
  GregorianResult,
  ValidationResult,
} from '../types.js';
import { InvalidDateError } from '../errors.js';

const ISLAMIC_EPOCH_JDN = 1948440; // JDN of 1 Muharram 1 AH (tabular).

function isIslamicLeap(year: number): boolean {
  // Years 2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29 of the 30-year cycle are leap.
  return [2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29].includes(year % 30);
}

function islamicDaysInYear(year: number): number {
  return isIslamicLeap(year) ? 355 : 354;
}

function islamicMonthLength(year: number, month: number): number {
  // Odd months = 30, even months = 29, except the last month of a leap year = 30.
  if (month % 2 === 1) return 30;
  if (month === 12 && isIslamicLeap(year)) return 30;
  return 29;
}

export function toJdnIslamic(year: number, month: number, day: number): number {
  // Standard tabular Islamic → JDN formula.
  return (
    day +
    Math.ceil(29.5 * (month - 1)) +
    (year - 1) * 354 +
    Math.floor((3 + 11 * year) / 30) +
    ISLAMIC_EPOCH_JDN -
    1
  );
}

export function fromJdnIslamic(jdn: number): { year: number; month: number; day: number } {
  // Reverse: search by 30-year cycle approximation, then correct.
  const approx = Math.floor((jdn - ISLAMIC_EPOCH_JDN) / 354) + 1;
  let year = approx;
  // Step to the right year.
  while (toJdnIslamic(year + 1, 1, 1) <= jdn) year += 1;
  while (toJdnIslamic(year, 1, 1) > jdn) year -= 1;
  // Step to the right month.
  let month = 1;
  while (month < 12 && toJdnIslamic(year, month + 1, 1) <= jdn) month += 1;
  const day = jdn - toJdnIslamic(year, month, 1) + 1;
  return { year, month, day };
}

export class IslamicAdapter extends BaseAdapter {
  readonly id = 'islamic';
  readonly name = '伊斯兰历';
  readonly minYear = 1;
  readonly maxYear = 1600;
  readonly dayBoundary = 'sunset' as const;
  readonly capabilities: AdapterCapabilities = {
    hasLeapMonth: false,
    hasSkippedDays: false,
    sunsetBoundary: true,
    needsMoonSighting: true,
    solarAligned: false,
  };

  validate(fields: CalendarFields): ValidationResult {
    const base = this.validateBase(fields, 12, 30);
    if (base.valid) {
      const monthLen = islamicMonthLength(fields.year, fields.month);
      if (fields.day > monthLen) {
        base.errors.push(
          `day ${fields.day} exceeds Islamic month length ${monthLen} for ${fields.year}-${fields.month}`,
        );
        base.valid = false;
      }
    }
    return base;
  }

  toGregorian(fields: CalendarFields, timezone: string): GregorianResult {
    const jdn = toJdnIslamic(fields.year, fields.month, fields.day);
    const g = fromJdnGregorian(jdn);
    const localDate = this.ymd(g.year, g.month, g.day);
    return {
      localDate,
      startUtc: this.buildStartUtc(localDate, timezone),
      timezone,
    };
  }

  fromGregorian(localDate: string, _timezone: string): CalendarFields {
    const [y, m, d] = localDate.split('-').map(Number);
    const jdn = toJdnGregorian(y, m, d);
    return fromJdnIslamic(jdn);
  }

  resolveAnnual(
    birthday: CalendarFields,
    targetYear: number,
    timezone: string,
  ): AnnualResult {
    const monthLen = islamicMonthLength(targetYear, birthday.month);
    const day = Math.min(birthday.day, monthLen);
    const jdn = toJdnIslamic(targetYear, birthday.month, day);
    const g = fromJdnGregorian(jdn);
    const localDate = this.ymd(g.year, g.month, g.day);
    return {
      localDate,
      startUtc: this.buildStartUtc(localDate, timezone),
      timezone,
      degraded: day !== birthday.day,
      degradationReason:
        day !== birthday.day
          ? `伊斯兰历 ${targetYear}-${birthday.month} 只有 ${monthLen} 天，使用第 ${day} 日`
          : undefined,
    };
  }

  describeFields(): FieldDescriptor[] {
    return [
      { key: 'year', label: '伊斯兰历年', type: 'number', required: true, min: 1, max: 1600 },
      { key: 'month', label: '月', type: 'number', required: true, min: 1, max: 12 },
      { key: 'day', label: '日', type: 'number', required: true, min: 1, max: 30 },
      {
        key: 'afterSunset',
        label: '日落之后出生',
        type: 'boolean',
        required: false,
        description: '伊斯兰历以日落为一日之始',
      },
    ];
  }
}

// --- Shared Gregorian <-> JDN helpers (used by islamic + hebrew adapters) ---

export function toJdnGregorian(year: number, month: number, day: number): number {
  // Fliegel & Van Flandern algorithm.
  const a = Math.floor((14 - month) / 12);
  const y2 = year + 4800 - a;
  const m2 = month + 12 * a - 3;
  return day + Math.floor((153 * m2 + 2) / 5) + 365 * y2 + Math.floor(y2 / 4)
    - Math.floor(y2 / 100) + Math.floor(y2 / 400) - 32045;
}

export function fromJdnGregorian(jdn: number): { year: number; month: number; day: number } {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = 100 * b + d - 4800 + Math.floor(m / 10);
  return { year, month, day };
}

// re-export for downstream consumers
export { islamicDaysInYear, islamicMonthLength, isIslamicLeap };
