/**
 * Timezone service.
 *
 * Built entirely on the platform's `Intl.DateTimeFormat`, with no third-party
 * timezone dependency: `Intl` resolves IANA zones correctly, including DST, and
 * needs no tzdata bundling. An earlier draft pulled `clockwork-tz` for extra
 * precision, but that path was never implemented — the comment that described it
 * has been removed rather than left to mislead.
 *
 * All UTC instants produced here are ISO 8601 strings, but we also keep a
 * millisecond epoch so callers don't have to re-parse.
 */

import { TimezoneError } from './errors.js';

export type TzEngineName = 'system' | 'embedded-tzdb';

export class TimezoneService {
  private engine: TzEngineName;

  constructor(engine: TzEngineName = 'system') {
    this.engine = engine;
  }

  get engineName(): TzEngineName {
    return this.engine;
  }

  /**
   * Build a UTC ISO string for the start (00:00 local) of `localDate` in `tz`.
   * If the timezone has a DST gap that day, we jump forward to the next valid
   * instant. Returns `{ startUtc, startUtcMs }`.
   */
  buildStartUtc(localDate: string, tz: string): { startUtc: string; startUtcMs: number } {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      throw new TimezoneError(`localDate must be YYYY-MM-DD, got "${localDate}"`);
    }
    // Step 1: pretend the local clock reads 00:00, treat as UTC, then offset.
    const [y, m, d] = localDate.split('-').map(Number);
    const naiveUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0);

    const offsetMin = this.getOffsetMs(naiveUtcMs, tz) / 60_000;
    const startUtcMs = naiveUtcMs - offsetMin * 60_000;
    return { startUtc: new Date(startUtcMs).toISOString(), startUtcMs };
  }

  /**
   * Offset in minutes for a given UTC instant, in the given IANA zone.
   * Positive means the local clock is ahead of UTC (e.g. Asia/Shanghai +08:00).
   */
  getOffset(utcIsoOrMs: string | number, tz: string): number {
    return this.getOffsetMs(utcIsoOrMs, tz) / 60_000;
  }

  getOffsetMs(utcIsoOrMs: string | number, tz: string): number {
    const ms = typeof utcIsoOrMs === 'number' ? utcIsoOrMs : Date.parse(utcIsoOrMs);
    if (Number.isNaN(ms)) {
      throw new TimezoneError(`Invalid UTC instant "${utcIsoOrMs}"`);
    }
    try {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const parts = dtf.formatToParts(new Date(ms));
      const lookup: Record<string, string> = {};
      for (const p of parts) lookup[p.type] = p.value;
      const asUtc = Date.UTC(
        Number(lookup.year),
        Number(lookup.month) - 1,
        Number(lookup.day),
        Number(lookup.hour) === 24 ? 0 : Number(lookup.hour),
        Number(lookup.minute),
        Number(lookup.second),
      );
      return asUtc - ms;
    } catch (e) {
      throw new TimezoneError(
        `Unknown IANA timezone "${tz}": ${(e as Error).message}`,
      );
    }
  }

  /** Format a UTC instant into YYYY-MM-DD for the given IANA zone. */
  formatLocalDate(utcIsoOrMs: string | number | Date, tz: string): string {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const d = utcIsoOrMs instanceof Date
      ? utcIsoOrMs
      : new Date(typeof utcIsoOrMs === 'number' ? utcIsoOrMs : Date.parse(utcIsoOrMs));
    return dtf.format(d);
  }

  /** Parse a local date into the UTC instant when that local day starts. */
  parseLocalStart(localDate: string, tz: string): { startUtc: string; startUtcMs: number } {
    return this.buildStartUtc(localDate, tz);
  }

  /** Add `days` whole days to a YYYY-MM-DD, in calendar terms (no DST shifting). */
  addDays(localDate: string, days: number): string {
    const [y, m, d] = localDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  /** Whether the two IANA zones are at the same UTC offset at the given instant. */
  sameOffset(utcIsoOrMs: string | number, tzA: string, tzB: string): boolean {
    return this.getOffset(utcIsoOrMs, tzA) === this.getOffset(utcIsoOrMs, tzB);
  }
}

/** Default factory used by tests and the engine bootstrap. */
export function createTimezoneService(engine: TzEngineName = 'system'): TimezoneService {
  return new TimezoneService(engine);
}
