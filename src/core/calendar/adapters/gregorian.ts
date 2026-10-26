/**
 * Gregorian adapter — the baseline. Every other adapter converts to/from
 * Gregorian via the hub, so this one is the simplest possible implementation.
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

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInGregorianMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  if ([4, 6, 9, 11].includes(m)) return 30;
  return 31;
}

export class GregorianAdapter extends BaseAdapter {
  readonly id = 'gregorian';
  readonly name = '公历';
  readonly minYear = 1;
  readonly maxYear = 9999;
  readonly dayBoundary = 'midnight' as const;
  readonly capabilities: AdapterCapabilities = {
    hasLeapMonth: false,
    hasSkippedDays: false,
    sunsetBoundary: false,
    needsMoonSighting: false,
    solarAligned: true,
  };

  validate(fields: CalendarFields): ValidationResult {
    const base = this.validateBase(fields, 12, 31);
    if (base.valid) {
      const monthLen = daysInGregorianMonth(fields.year, fields.month);
      if (fields.day > monthLen) {
        base.errors.push(
          `day ${fields.day} exceeds month length ${monthLen} for ${fields.year}-${fields.month}`,
        );
        base.valid = false;
      }
    }
    return base;
  }

  toGregorian(fields: CalendarFields, timezone: string): GregorianResult {
    const localDate = this.ymd(fields.year, fields.month, fields.day);
    return {
      localDate,
      startUtc: this.buildStartUtc(localDate, timezone),
      timezone,
    };
  }

  fromGregorian(localDate: string, _timezone: string): CalendarFields {
    const [y, m, d] = localDate.split('-').map(Number);
    return { year: y, month: m, day: d };
  }

  resolveAnnual(
    birthday: CalendarFields,
    targetYear: number,
    timezone: string,
  ): AnnualResult {
    const localDate = this.ymd(targetYear, birthday.month, birthday.day);
    return {
      localDate,
      startUtc: this.buildStartUtc(localDate, timezone),
      timezone,
      degraded: false,
    };
  }

  describeFields(): FieldDescriptor[] {
    return [
      { key: 'year', label: '年', type: 'number', required: true, min: 1, max: 9999 },
      { key: 'month', label: '月', type: 'number', required: true, min: 1, max: 12 },
      { key: 'day', label: '日', type: 'number', required: true, min: 1, max: 31 },
    ];
  }
}
