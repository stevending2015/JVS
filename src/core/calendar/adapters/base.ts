/**
 * BaseAdapter — shared validation + utilities for built-in and 3rd-party adapters.
 *
 * Subclasses are expected to override the abstract hooks below. This base class
 * centralises field validation, year-range checks, and a couple of date helpers
 * so adapters don't have to duplicate them.
 */

import type {
  AdapterCapabilities,
  CalendarAdapter,
  CalendarFields,
  FieldDescriptor,
  ValidationResult,
} from '../types.js';
import { TimezoneService } from '../timezone.js';

export abstract class BaseAdapter implements CalendarAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly minYear: number;
  abstract readonly maxYear: number;
  abstract readonly dayBoundary: 'midnight' | 'sunset';
  abstract readonly capabilities: AdapterCapabilities;

  constructor(protected readonly tz: TimezoneService) {}

  /** Base structural validation shared by every adapter. */
  protected validateBase(
    fields: CalendarFields,
    maxMonth: number,
    maxDay: number,
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!Number.isInteger(fields.year)) errors.push('year must be an integer');
    if (!Number.isInteger(fields.month)) errors.push('month must be an integer');
    if (!Number.isInteger(fields.day)) errors.push('day must be an integer');
    if (fields.year < this.minYear || fields.year > this.maxYear) {
      errors.push(
        `year ${fields.year} outside adapter range [${this.minYear}, ${this.maxYear}]`,
      );
    }
    if (fields.month < 1 || fields.month > maxMonth) {
      errors.push(`month ${fields.month} outside [1, ${maxMonth}]`);
    }
    if (fields.day < 1 || fields.day > maxDay) {
      errors.push(`day ${fields.day} outside [1, ${maxDay}]`);
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  /** Pad a number to at least 2 digits. */
  protected pad(n: number): string {
    return String(n).padStart(2, '0');
  }

  /** Build a YYYY-MM-DD. */
  protected ymd(year: number, month: number, day: number): string {
    return `${year}-${this.pad(month)}-${this.pad(day)}`;
  }

  /** Convenience wrapper around the timezone service. */
  protected buildStartUtc(localDate: string, tz: string): string {
    return this.tz.buildStartUtc(localDate, tz).startUtc;
  }

  abstract validate(fields: CalendarFields): ValidationResult;
  abstract toGregorian(fields: CalendarFields, timezone: string): import('../types.js').GregorianResult;
  abstract fromGregorian(localDate: string, timezone: string): CalendarFields;
  abstract resolveAnnual(
    birthday: CalendarFields,
    targetYear: number,
    timezone: string,
  ): import('../types.js').AnnualResult;
  abstract describeFields(): FieldDescriptor[];
}
