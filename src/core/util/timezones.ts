/**
 * Timezone options for the birth-timezone picker.
 *
 * The full IANA list comes from `Intl.supportedValuesOf('timeZone')` when the
 * engine provides it, so the picker stays correct as the tzdb updates. Each
 * entry carries its current UTC offset so the label reads `UTC+08:00 · 北京/上海`
 * — a bare `Asia/Shanghai` tells most users nothing.
 *
 * The list is computed once and memoised: building a formatter per zone is the
 * expensive part, and the offset only shifts at a DST boundary.
 */

export interface TimezoneOption {
  value: string;
  label: string;
  offsetMinutes: number;
}

export interface TimezoneGroup {
  label: string;
  options: TimezoneOption[];
}

/** Default birth timezone: 东八区. */
export const DEFAULT_BIRTH_TIMEZONE = 'Asia/Shanghai';

/** Chinese-friendly labels for the zones people reach for most. */
const COMMON_LABELS: Record<string, string> = {
  'Asia/Shanghai': '北京/上海',
  'Asia/Hong_Kong': '香港',
  'Asia/Macau': '澳门',
  'Asia/Taipei': '台北',
  'Asia/Singapore': '新加坡',
  'Asia/Kuala_Lumpur': '吉隆坡',
  'Asia/Tokyo': '东京',
  'Asia/Seoul': '首尔',
  'Asia/Bangkok': '曼谷',
  'Asia/Jakarta': '雅加达',
  'Asia/Kolkata': '新德里',
  'Asia/Dubai': '迪拜',
  UTC: '协调世界时',
  'Europe/London': '伦敦',
  'Europe/Paris': '巴黎',
  'Europe/Berlin': '柏林',
  'Europe/Moscow': '莫斯科',
  'America/New_York': '纽约',
  'America/Chicago': '芝加哥',
  'America/Denver': '丹佛',
  'America/Los_Angeles': '洛杉矶',
  'America/Phoenix': '凤凰城',
  'America/Sao_Paulo': '圣保罗',
  'Australia/Sydney': '悉尼',
  'Pacific/Auckland': '奥克兰',
  'Africa/Johannesburg': '约翰内斯堡',
};

/** Zones shown in the pinned "常用" group, in this order. */
const COMMON_ORDER = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
];

/** Fallback list used when the engine cannot enumerate zones. */
const FALLBACK_ZONES = [
  ...COMMON_ORDER,
  'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Kolkata', 'Asia/Dubai',
  'Europe/Berlin', 'Europe/Moscow', 'America/Chicago', 'America/Denver',
  'America/Phoenix', 'America/Sao_Paulo', 'Pacific/Auckland',
  'Africa/Johannesburg',
];

/**
 * Current UTC offset of a zone, in minutes.
 * @param timeZone - IANA zone name.
 * @param at - instant to measure at; defaults to now.
 * @returns Offset in minutes, or null when the zone is unknown.
 */
export function offsetMinutesFor(timeZone: string, at: Date = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 'NaN');
    const asUtc = Date.UTC(
      read('year'),
      read('month') - 1,
      read('day'),
      read('hour') % 24,
      read('minute'),
      read('second'),
    );
    if (Number.isNaN(asUtc)) return null;
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return null;
  }
}

/**
 * Render a UTC offset as `UTC+08:00`.
 * @param minutes - offset in minutes.
 * @returns The formatted label.
 */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const mins = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${mins}`;
}

/** Every IANA zone the engine knows, or the fallback list. */
function allZoneNames(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf?.('timeZone');
    if (Array.isArray(supported) && supported.length > 0) return supported;
  } catch {
    /* fall through */
  }
  return FALLBACK_ZONES;
}

let cached: TimezoneOption[] | null = null;

/**
 * All timezone options, each labelled with its current offset.
 * @returns The memoised option list.
 */
export function listTimezoneOptions(): TimezoneOption[] {
  if (cached !== null) return cached;
  const now = new Date();
  const seen = new Set<string>();
  const options: TimezoneOption[] = [];
  for (const zone of allZoneNames()) {
    if (seen.has(zone)) continue;
    seen.add(zone);
    const offsetMinutes = offsetMinutesFor(zone, now);
    if (offsetMinutes === null) continue;
    const known = COMMON_LABELS[zone];
    options.push({
      value: zone,
      label: `${formatOffset(offsetMinutes)} · ${known ?? zone.replace(/_/g, ' ')}`,
      offsetMinutes,
    });
  }
  cached = options;
  return options;
}

/**
 * Options grouped for an `<optgroup>` picker: a pinned "常用" group first, then
 * the remaining zones by region.
 * @returns The grouped options.
 */
export function timezoneGroups(): TimezoneGroup[] {
  const options = listTimezoneOptions();
  const byValue = new Map(options.map((o) => [o.value, o]));

  const common: TimezoneOption[] = [];
  for (const zone of COMMON_ORDER) {
    const option = byValue.get(zone);
    if (option !== undefined) common.push({ ...option, label: `${formatOffset(option.offsetMinutes)} · ${COMMON_LABELS[zone] ?? zone}` });
  }
  const commonValues = new Set(common.map((o) => o.value));

  const byRegion = new Map<string, TimezoneOption[]>();
  for (const option of options) {
    if (commonValues.has(option.value)) continue;
    const region = option.value.includes('/') ? option.value.split('/')[0] : '其他';
    const bucket = byRegion.get(region);
    if (bucket === undefined) byRegion.set(region, [option]);
    else bucket.push(option);
  }

  const groups: TimezoneGroup[] = [{ label: '常用', options: common }];
  for (const region of [...byRegion.keys()].sort()) {
    const bucket = byRegion.get(region)!;
    bucket.sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.value.localeCompare(b.value));
    groups.push({ label: region, options: bucket });
  }
  return groups;
}

/**
 * Whether a zone name is one the engine can actually format with.
 * @param timeZone - candidate IANA zone name.
 * @returns True when the zone resolves.
 */
export function isKnownTimezone(timeZone: string): boolean {
  if (timeZone === '') return false;
  return offsetMinutesFor(timeZone) !== null;
}

/**
 * Display label for one zone, e.g. `UTC+08:00 · 北京/上海`.
 * @param timeZone - IANA zone name.
 * @returns The label, or the raw name when the zone is unknown.
 */
export function timezoneLabel(timeZone: string): string {
  const offset = offsetMinutesFor(timeZone);
  if (offset === null) return timeZone;
  const known = COMMON_LABELS[timeZone];
  return `${formatOffset(offset)} · ${known ?? timeZone.replace(/_/g, ' ')}`;
}
