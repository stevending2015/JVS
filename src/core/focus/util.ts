/**
 * Focus-session helpers shared by the page and the card.
 */

export const FOCUS_MODES = [
  { id: '25', label: '🍅 25 分钟', minutes: 25 },
  { id: '45', label: '45 分钟', minutes: 45 },
  { id: '60', label: '60 分钟', minutes: 60 },
  { id: '90', label: '90 分钟', minutes: 90 },
  { id: '120', label: '120 分钟', minutes: 120 },
] as const;

/** Default daily goal, in pomodoros. */
export const DEFAULT_DAILY_GOAL = 8;

/** How many days the heat map covers. */
export const HEATMAP_DAYS = 35;

/** Session length is not stored in minutes — seconds avoid rounding drift. */
export function plannedSeconds(modeId: string): number {
  const found = FOCUS_MODES.find((mode) => mode.id === modeId);
  return found === undefined ? 25 * 60 : found.minutes * 60;
}

/** mm:ss, or h:mm:ss once the clock passes an hour. */
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Compact duration for lists.
 *
 * Under a minute the seconds are shown instead of a rounded "0 分钟": a session
 * that only lasted a few seconds still happened, and "0 分钟" would read as if
 * nothing was recorded.
 *
 * @param totalSeconds - duration in seconds.
 * @returns Human readable Chinese duration.
 */
export function formatMinutes(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  if (safe > 0 && safe < 60) return `${safe} 秒`;
  const minutes = Math.round(safe / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

/** Local YYYY-MM-DD, matching the key the SQL aggregates use. */
export function localDayKey(at: Date = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** The last `days` local day keys, oldest first. */
export function recentDayKeys(days: number): string[] {
  const keys: string[] = [];
  const cursor = new Date();
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(cursor);
    date.setDate(cursor.getDate() - index);
    keys.push(localDayKey(date));
  }
  return keys;
}

/** 0..3 bucket for the heat map, so four shades are enough to read at a glance. */
export function heatBucket(seconds: number): 0 | 1 | 2 | 3 {
  if (seconds <= 0) return 0;
  if (seconds < 25 * 60) return 1;
  if (seconds < 90 * 60) return 2;
  return 3;
}
