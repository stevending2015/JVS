/**
 * Next birthday per person.
 *
 * Same algorithm the DSH plugin settled on after two bugs: try the neighbouring
 * target years (a 腊月 date lands in the NEXT Gregorian year) and compare LOCAL
 * DATES rather than instants, so the birthday itself still counts as "today".
 */

import type { GregorianHub } from '../calendar/hub.js';
import type { CalendarFields } from '../calendar/types.js';
import type { Person } from './types.js';

export interface UpcomingPerson {
  person: Person;
  nextLocalDate: string;
  daysUntil: number;
  turningAge?: number;
  degraded: boolean;
}

/** Whole days between two `YYYY-MM-DD` dates. */
function daysBetween(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/** Resolve every person's next birthday, soonest first. */
export function upcomingPersons(
  persons: Person[],
  hub: GregorianHub,
  tz: string,
  now: Date = new Date(),
): UpcomingPerson[] {
  const today = hub.timezone.formatLocalDate(now, tz);
  const year = Number(today.slice(0, 4));
  const result: UpcomingPerson[] = [];

  for (const person of persons) {
    if (person.calendar_system === null || person.date_fields_json === null) continue;
    let fields: CalendarFields;
    try {
      fields = JSON.parse(person.date_fields_json) as CalendarFields;
    } catch {
      continue;
    }
    const birthTz = person.birth_timezone ?? tz;
    let best: { localDate: string; degraded: boolean } | undefined;
    for (const target of [year - 1, year, year + 1]) {
      try {
        const annual = hub.resolveAnnual(person.calendar_system, fields, target, birthTz);
        if (annual.localDate >= today && (best === undefined || annual.localDate < best.localDate)) {
          best = { localDate: annual.localDate, degraded: annual.degraded };
        }
      } catch {
        // Skip a target this calendar cannot resolve.
      }
    }
    if (best === undefined) continue;

    const birthYear = Number((person.gregorian_local_date ?? '').slice(0, 4));
    const occurrenceYear = Number(best.localDate.slice(0, 4));
    result.push({
      person,
      nextLocalDate: best.localDate,
      daysUntil: daysBetween(today, best.localDate),
      ...(Number.isFinite(birthYear) ? { turningAge: occurrenceYear - birthYear } : {}),
      degraded: best.degraded,
    });
  }

  return result.sort((a, b) => a.daysUntil - b.daysUntil);
}