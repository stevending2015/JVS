/**
 * GregorianHub — the conversion pivot.
 *
 * Every adapter converts in/out via the Gregorian calendar (specifically via a
 * UTC anchor instant and the user's birth timezone). The hub is the only place
 * that combines adapter + registry + timezone, so consumers always go through
 * it and never call adapter methods directly. This keeps the public surface
 * small and testable.
 */

import type {
  AdapterYearInfo,
  AnnualResult,
  CalendarAdapter,
  CalendarFields,
  FieldDescriptor,
  GregorianResult,
  ValidationResult,
} from './types.js';
import { AdapterRegistry } from './registry.js';
import { TimezoneService } from './timezone.js';
import { InvalidDateError } from './errors.js';

export interface UpcomingOptions {
  /** When resolving an annual date, what to do if the calendar degraded. */
  leapMonthStrategy?: 'normal' | 'postpone' | 'skip';
  /** How many days of "upcoming" to consider. */
  horizonDays?: number;
}

export interface UpcomingEntry {
  /**
   * Stored record id. Named `id` (not `recordId`) because this object is
   * returned verbatim by `GET /api/birthday/upcoming`, and every client
   * read — and every update/delete round-trip — addresses the record by `id`.
   */
  id?: number;
  name: string;
  /** Relationship to the record owner, e.g. 朋友 / 爸爸. */
  relation?: string;
  /** Gender of the recorded person. */
  gender?: string;
  note?: string;
  calendarSystem: string;
  fields: CalendarFields;
  fieldsDescription: FieldDescriptor[];
  /** Local date in the birth timezone for the next occurrence. */
  nextLocalDate: string;
  /** Original birth date resolved in the Gregorian calendar (YYYY-MM-DD). */
  gregorianLocalDate: string;
  /** UTC instant the next occurrence starts. */
  nextStartUtc: string;
  /** User-local "action" instant, e.g. the moment the user is in their day. */
  userActionUtc: string;
  /** Whether user and birth are in the same UTC offset at the next occurrence. */
  sameOffset: boolean;
  /** The record's birth timezone, so a card can label a cross-timezone entry. */
  birthTimezone: string;
  /** Western zodiac of the stored Gregorian anchor. */
  zodiacSign?: string;
  /** Chinese zodiac animal (生肖), derived from the lunar year. */
  shengxiao?: string;
  /** 时辰 of birth, when the calendar defines one (Chinese lunar). */
  shichen?: string;
  /** Pre-rendered five-element histogram of the stored Gregorian anchor. */
  wuxingSummary?: string;
  /** Optional degradation report. */
  degraded: boolean;
  degradationReason?: string;
}

export class GregorianHub {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly tz: TimezoneService,
  ) {}

  get adapterRegistry(): AdapterRegistry {
    return this.registry;
  }

  get timezone(): TimezoneService {
    return this.tz;
  }

  /**
   * Calendar-specific facts about one year, used to guide data entry (e.g. the
   * Chinese leap month). Adapters without such facts return an empty object.
   * @param adapterId - the calendar to ask.
   * @param year - the year in that calendar.
   * @returns The adapter's year info, or `{}` when it has none.
   */
  yearInfo(adapterId: string, year: number): AdapterYearInfo {
    const adapter = this.registry.get(adapterId);
    if (typeof adapter.yearInfo !== 'function') return {};
    try {
      return adapter.yearInfo(year) ?? {};
    } catch {
      return {};
    }
  }

  listCalendars(): Array<{
    id: string;
    name: string;
    minYear: number;
    maxYear: number;
    dayBoundary: 'midnight' | 'sunset';
    fields: FieldDescriptor[];
    capabilities: CalendarAdapter['capabilities'];
  }> {
    return this.registry.list().map((a) => ({
      id: a.id,
      name: a.name,
      minYear: a.minYear,
      maxYear: a.maxYear,
      dayBoundary: a.dayBoundary,
      fields: a.describeFields(),
      capabilities: a.capabilities,
    }));
  }

  validate(adapterId: string, fields: CalendarFields): ValidationResult {
    return this.registry.get(adapterId).validate(fields);
  }

  toGregorian(adapterId: string, fields: CalendarFields, timezone: string): GregorianResult {
    const adapter = this.registry.get(adapterId);
    const v = adapter.validate(fields);
    if (!v.valid) {
      throw new InvalidDateError(adapterId, v.errors.join('; ') || 'invalid date');
    }
    return adapter.toGregorian(v.adjustedFields ?? fields, timezone);
  }

  fromGregorian(adapterId: string, localDate: string, timezone: string): CalendarFields {
    return this.registry.get(adapterId).fromGregorian(localDate, timezone);
  }

  resolveAnnual(
    adapterId: string,
    birthday: CalendarFields,
    targetYear: number,
    timezone: string,
  ): AnnualResult {
    return this.registry.get(adapterId).resolveAnnual(birthday, targetYear, timezone);
  }

  /**
   * Cross-timezone "what time should the user be notified" helper.
   * Returns a UTC instant that, when formatted in `userTimezone`, equals the
   * user's preferred action time (default 09:00 local).
   */
  userActionInstant(
    birthStartUtc: string,
    userTimezone: string,
    hour: number = 9,
    minute: number = 0,
  ): string {
    // Format birthStartUtc in user tz, then re-anchor at hour:minute.
    const localDate = this.tz.formatLocalDate(birthStartUtc, userTimezone);
    const [y, m, d] = localDate.split('-').map(Number);
    const naive = Date.UTC(y, m - 1, d, hour, minute, 0, 0);
    const offsetMin = this.tz.getOffset(naive, userTimezone);
    return new Date(naive - offsetMin * 60_000).toISOString();
  }
}
