/**
 * Almanac (万年历) data for the calendar window.
 *
 * Two libraries are in play, deliberately:
 *
 *   - `lunar` (v2) powers the calendar adapters. It is deliberately minimal —
 *     conversion only — and has no solar terms, festivals or 宜忌.
 *   - `lunar-javascript` supplies exactly those extras. Reimplementing the 24
 *     solar terms and the almanac tables by hand would be far more code and far
 *     less accurate.
 *
 * The second is optional: without it the grid still renders with Gregorian
 * dates only, and `note` explains what is missing.
 */

import almanacPackage from 'lunar-javascript';
import type { CalendarFields } from '../../calendar/types.js';
import type { GregorianHub } from '../../calendar/hub.js';
import type { TimezoneService } from '../../calendar/timezone.js';
import type { BirthdayRecord } from '../models/birthday.js';



/** The slice of `lunar-javascript` this module uses. */
interface SolarLike {
  getWeek(): number;
  getWeekInChinese(): string;
  getFestivals(): string[];
  toYmd(): string;
  getLunar(): LunarLike;
}
interface LunarLike {
  getYear(): number;
  getMonth(): number;
  getDay(): number;
  getDayInChinese(): string;
  getMonthInChinese(): string;
  getYearInGanZhi(): string;
  getMonthInGanZhi(): string;
  getDayInGanZhi(): string;
  getYearShengXiao(): string;
  getJieQi(): string;
  getFestivals(): string[];
  getDayYi(): string[];
  getDayJi(): string[];
  toString(): string;
}
interface AlmanacModule {
  Solar: { fromYmd(year: number, month: number, day: number): SolarLike };
}

let almanacMod: AlmanacModule | null = null;
try {
  // Loaded lazily and optionally, exactly like the calendar adapters, so a host
  // without the package still activates.
  almanacMod = almanacPackage as unknown as AlmanacModule;
} catch {
  almanacMod = null;
}

/** Whether the almanac extras (农历/节气/宜忌) are available on this host. */
export function hasAlmanacLibrary(): boolean {
  return almanacMod !== null;
}

/** Supported year range, matching the bundled lunar data. */
export const ALMANAC_MIN_YEAR = 1900;
export const ALMANAC_MAX_YEAR = 2100;

/** A birthday landing on one day of the grid. */
export interface AlmanacBirthday {
  id?: number;
  name: string;
  relation?: string;
  gender?: string;
  calendarSystem: string;
  /** The date as entered, so the client can render it in its own wording. */
  fields: CalendarFields;
  /** Age they turn on this occurrence. */
  turningAge?: number;
  /** True when this year's occurrence is a stand-in (e.g. missing leap month). */
  degraded: boolean;
  degradationReason?: string;
}

/**
 * Map every record onto the day it falls on in a given Gregorian year.
 *
 * Resolution goes through the hub's `resolveAnnual`, the same path the cards and
 * reminders use — so the almanac agrees with them, including for leap-month
 * birthdays in a year without that month, which degrade rather than vanish.
 * @param records - stored birthdays.
 * @param year - the Gregorian year being viewed.
 * @param hub - calendar hub.
 * @returns Date (`YYYY-MM-DD`) to the birthdays on it.
 */
export function buildBirthdayIndex(
  records: BirthdayRecord[],
  year: number,
  hub: GregorianHub,
): Map<string, AlmanacBirthday[]> {
  const index = new Map<string, AlmanacBirthday[]>();

  for (const record of records) {
    /**
     * Resolve the occurrence that falls inside the VIEWED Gregorian year.
     *
     * The target year is not the Gregorian year for every calendar. A lunar
     * date late in the year lands in the NEXT Gregorian year: 农历 N 年腊月
     * happens in January or February of N+1. Resolving only `year` therefore
     * produced the N+1 date, which never matched the grid — a 腊月 birthday was
     * simply invisible. Trying the neighbours and keeping the occurrence that
     * really lands in `year` fixes that; since a birthday recurs once a year, at
     * most one candidate matches.
     */
    let chosen: { localDate: string; degraded: boolean; degradationReason?: string } | undefined;
    for (const target of [year - 1, year, year + 1]) {
      try {
        const annual = hub.resolveAnnual(
          record.calendarSystem,
          record.fields,
          target,
          record.birthTimezone,
        );
        if (Number(annual.localDate.slice(0, 4)) === year) {
          chosen = annual;
          break;
        }
      } catch {
        // An out-of-range target, or a calendar that cannot resolve this
        // record: either way, move on to the next candidate.
      }
    }
    // A record with no occurrence in this year contributes nothing.
    if (chosen === undefined) continue;

    const localDate = chosen.localDate;
    const degraded = chosen.degraded;
    const degradationReason = chosen.degradationReason;

    const birthYear = Number((record.gregorianLocalDate ?? '').slice(0, 4));
    const occurrenceYear = Number(localDate.slice(0, 4));
    const turningAge =
      Number.isFinite(birthYear) && Number.isFinite(occurrenceYear)
        ? occurrenceYear - birthYear
        : undefined;

    const marker: AlmanacBirthday = {
      id: record.id,
      name: record.name,
      ...(record.relation !== undefined ? { relation: record.relation } : {}),
      ...(record.gender !== undefined ? { gender: record.gender } : {}),
      calendarSystem: record.calendarSystem,
      fields: record.fields,
      ...(turningAge !== undefined && turningAge >= 0 ? { turningAge } : {}),
      degraded,
      ...(degradationReason !== undefined ? { degradationReason } : {}),
    };

    const existing = index.get(localDate);
    if (existing === undefined) index.set(localDate, [marker]);
    else existing.push(marker);
  }

  return index;
}

/** One day in the month grid. */
export interface AlmanacDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Gregorian day of month. */
  day: number;
  /** 0 = Sunday. */
  weekday: number;
  /** 日 / 一 / … / 六. */
  weekdayName: string;
  isToday: boolean;
  isWeekend: boolean;
  /** 初一…三十, empty when the almanac library is unavailable. */
  lunarDayName: string;
  /** 正 / 二 / … / 腊, with 闰 prefixed for a leap month. */
  lunarMonthName: string;
  /** Full 农历 text, e.g. 二〇二三年腊月廿五. */
  lunarText: string;
  lunarYear: number;
  lunarMonth: number;
  lunarDay: number;
  isLeapMonth: boolean;
  yearGanZhi: string;
  monthGanZhi: string;
  dayGanZhi: string;
  zodiac: string;
  /** Solar term falling on this day, or ''. */
  jieQi: string;
  /** Gregorian and lunar festivals, merged. */
  festivals: string[];
  /** Almanac advice. */
  yi: string[];
  /** Almanac warnings. */
  ji: string[];
  /** Birthdays falling on this day. */
  birthdays: AlmanacBirthday[];
}

/** A whole month, ready to render as a grid. */
export interface AlmanacMonth {
  year: number;
  month: number;
  timezone: string;
  /** Today's date in `timezone`. */
  today: string;
  /** Weekday of the 1st (0 = Sunday), for the leading blanks. */
  firstWeekday: number;
  days: AlmanacDay[];
  /** Solar terms in this month, in date order. */
  jieQi: Array<{ name: string; date: string; day: number }>;
  /** Festivals in this month, in date order. */
  festivals: Array<{ name: string; date: string; day: number }>;
  /** Every birthday in this month, in date order. */
  birthdays: Array<{ date: string; day: number; name: string; turningAge?: number }>;
  /** True when 农历/节气/宜忌 are included. */
  almanacAvailable: boolean;
  note?: string;
}

/** Days in a Gregorian month. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Validate a requested month, loudly. */
function assertRange(year: number, month: number): void {
  if (!Number.isInteger(year) || year < ALMANAC_MIN_YEAR || year > ALMANAC_MAX_YEAR) {
    throw new Error(`年份需在 ${ALMANAC_MIN_YEAR}–${ALMANAC_MAX_YEAR} 之间，收到 ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`月份需在 1–12 之间，收到 ${month}`);
  }
}

/** `YYYY-MM-DD` with zero padding. */
function ymd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * Build one month of almanac data.
 * @param year - Gregorian year.
 * @param month - Gregorian month, 1-12.
 * @param tz - IANA zone used to decide which day is "today".
 * @param timezone - the timezone service, for the local date.
 * @param now - reference instant, injectable for tests.
 * @param birthdayIndex - date to birthdays, from `buildBirthdayIndex`.
 * @returns The month, with the leading blank count needed for the grid.
 */
export function buildAlmanacMonth(
  year: number,
  month: number,
  tz: string,
  timezone: TimezoneService,
  now: Date = new Date(),
  birthdayIndex?: Map<string, AlmanacBirthday[]>,
): AlmanacMonth {
  assertRange(year, month);

  const today = timezone.formatLocalDate(now, tz);
  const total = daysInMonth(year, month);
  const days: AlmanacDay[] = [];
  const jieQi: AlmanacMonth['jieQi'] = [];
  const festivals: AlmanacMonth['festivals'] = [];
  const birthdays: AlmanacMonth['birthdays'] = [];

  for (let day = 1; day <= total; day += 1) {
    const date = ymd(year, month, day);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const base: AlmanacDay = {
      date,
      day,
      weekday,
      weekdayName: WEEKDAY_NAMES[weekday],
      isToday: date === today,
      isWeekend: weekday === 0 || weekday === 6,
      lunarDayName: '',
      lunarMonthName: '',
      lunarText: '',
      lunarYear: 0,
      lunarMonth: 0,
      lunarDay: 0,
      isLeapMonth: false,
      yearGanZhi: '',
      monthGanZhi: '',
      dayGanZhi: '',
      zodiac: '',
      jieQi: '',
      festivals: [],
      yi: [],
      ji: [],
      birthdays: [],
    };

    if (almanacMod !== null) {
      try {
        const solar = almanacMod.Solar.fromYmd(year, month, day);
        const lunar = solar.getLunar();
        base.lunarDayName = lunar.getDayInChinese();
        // A leap month is a NEGATIVE month number, and `getMonthInChinese`
        // already carries its own 闰 prefix (闰四, not 四). Adding one here too
        // produced 闰闰四月, so the prefix is left to the library.
        const leap = lunar.getMonth() < 0;
        base.lunarMonthName = `${lunar.getMonthInChinese()}月`;
        base.lunarText = lunar.toString();
        base.lunarYear = Math.abs(lunar.getYear());
        base.lunarMonth = Math.abs(lunar.getMonth());
        base.lunarDay = lunar.getDay();
        base.isLeapMonth = leap;
        base.yearGanZhi = lunar.getYearInGanZhi();
        base.monthGanZhi = lunar.getMonthInGanZhi();
        base.dayGanZhi = lunar.getDayInGanZhi();
        base.zodiac = lunar.getYearShengXiao();
        base.jieQi = lunar.getJieQi() ?? '';
        base.festivals = [...new Set([...solar.getFestivals(), ...lunar.getFestivals()])];
        base.yi = lunar.getDayYi();
        base.ji = lunar.getDayJi();

        if (base.jieQi !== '') jieQi.push({ name: base.jieQi, date, day });
        for (const name of base.festivals) festivals.push({ name, date, day });
      } catch {
        // A single unconvertible day must not blank the whole month.
      }
    }

    // Birthdays attach regardless of whether the lunar library loaded: they
    // come from the plugin's own records, not from the almanac extras.
    const onThisDay = birthdayIndex?.get(date);
    if (onThisDay !== undefined && onThisDay.length > 0) {
      base.birthdays = onThisDay;
      for (const person of onThisDay) {
        birthdays.push({
          date,
          day,
          name: person.name,
          ...(person.turningAge !== undefined ? { turningAge: person.turningAge } : {}),
        });
      }
    }

    days.push(base);
  }

  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return {
    year,
    month,
    timezone: tz,
    today,
    firstWeekday,
    days,
    jieQi,
    festivals,
    birthdays,
    almanacAvailable: almanacMod !== null,
    ...(almanacMod === null
      ? { note: '未安装 lunar-javascript：仅显示公历，农历/节气/宜忌不可用。' }
      : {}),
  };
}
