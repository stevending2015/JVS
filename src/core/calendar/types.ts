/**
 * Calendar engine — core type definitions.
 * These types define the public contract every CalendarAdapter must implement.
 * Built-in adapters: gregorian, lunar (Chinese), islamic, hebrew.
 * Third-party adapters (e.g. tibetan, mayan) plug in at runtime via
 * `AdapterRegistry.register()`.
 */

/** Per-field shape used in dynamic forms. */
export interface FieldDescriptor {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'string';
  required: boolean;
  min?: number;
  max?: number;
  description?: string;
  /** Override default order in forms. */
  order?: number;
  /**
   * Closed set of allowed values. When present the form renders a select
   * rather than a free-text input, so a value like 时辰 can never be typos.
   */
  options?: string[];
  /** Value the form pre-selects when the record has none. */
  defaultValue?: unknown;
}

/**
 * Calendar-specific facts about one year, used to guide data entry.
 * Adapters that have nothing to say simply omit `yearInfo`.
 */
export interface AdapterYearInfo {
  /**
   * Leap month of that year, or null when the year has none. For the Chinese
   * calendar this is the month number `m` such that `m月` occurs twice.
   */
  leapMonth?: number | null;
  /** Extra sentence shown next to the form's year input. */
  note?: string;
}

/** Optional fields that adapters can attach when validating. */
export interface CalendarFields {
  year: number;
  month: number;
  day: number;
  isLeapMonth?: boolean;
  afterSunset?: boolean;
  [extra: string]: unknown;
}

/** Result of validate(). */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /**
   * Optional auto-corrected fields (e.g. when calendar uses skipped days or
   * duplicate days, the adapter may want to remap the day).
   */
  adjustedFields?: CalendarFields;
}

/** Result of toGregorian(). */
export interface GregorianResult {
  /** ISO local date in the requested timezone, e.g. '2026-10-19'. */
  localDate: string;
  /** UTC instant when the local date starts (00:00 in the requested tz). */
  startUtc: string;
  /** The timezone that anchored this conversion. */
  timezone: string;
}

/** Result of resolveAnnual(). */
export interface AnnualResult extends GregorianResult {
  /** Whether the adapter degraded the date (e.g. leap month missing). */
  degraded: boolean;
  /** Human-readable reason when degraded. */
  degradationReason?: string;
}

/** What an adapter can or cannot do. UI uses this to render warnings. */
export interface AdapterCapabilities {
  hasLeapMonth: boolean;
  /** Tibetan, Hindu etc. may have skipped or repeated days. */
  hasSkippedDays: boolean;
  /** Day starts at sunset, not midnight. */
  sunsetBoundary: boolean;
  /** Calendar may differ from astronomical by 1–2 days. */
  needsMoonSighting: boolean;
  /** True if the calendar is purely solar-aligned. */
  solarAligned: boolean;
}

export interface CalendarAdapter {
  readonly id: string;
  readonly name: string;
  readonly minYear: number;
  readonly maxYear: number;
  readonly dayBoundary: 'midnight' | 'sunset';
  readonly capabilities: AdapterCapabilities;

  validate(fields: CalendarFields): ValidationResult;
  toGregorian(fields: CalendarFields, timezone: string): GregorianResult;
  fromGregorian(localDate: string, timezone: string): CalendarFields;
  resolveAnnual(
    birthday: CalendarFields,
    targetYear: number,
    timezone: string,
  ): AnnualResult;
  describeFields(): FieldDescriptor[];
  /**
   * Optional: facts about a year that help the user enter a correct date
   * (e.g. which month is the leap month). Adapters without any such fact leave
   * this undefined.
   */
  yearInfo?(year: number): AdapterYearInfo;
}

/** A pair of (adapter, fields) so the hub can stay polymorphic. */
export interface ResolvedDate {
  adapter: CalendarAdapter;
  fields: CalendarFields;
}

/** Public engine surface exposed via `ctx.get('calendar')`. */
export interface CalendarEnginePublic {
  hub: import('./hub.js').GregorianHub;
  registry: import('./registry.js').AdapterRegistry;
  timezone: import('./timezone.js').TimezoneService;
}

export interface CalendarEngineOptions {
  enabledCalendars: string[];
  timezoneEngine?: 'system' | 'embedded-tzdb';
  defaultTimezone?: string;
  /**
   * Optional factory for third-party adapters; receives the TimezoneService so
   * they can build local-date strings in a consistent way.
   */
  thirdPartyFactories?: Record<string, (tz: import('./timezone.js').TimezoneService) => CalendarAdapter>;
}
