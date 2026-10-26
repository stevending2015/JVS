/** The single calendar engine instance the whole app shares. */

import { createCalendarEngine } from './index.js';

export const engine = createCalendarEngine({
  enabledCalendars: ['gregorian', 'lunar', 'islamic', 'hebrew'],
  timezoneEngine: 'system',
});

export const hub = engine.hub;
export const USER_TIMEZONE =
  (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Asia/Shanghai';