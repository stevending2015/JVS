/**
 * Calendar engine entry point.
 *
 * Wires up the timezone service, the adapter registry, and the hub. Returns
 * a triple that consumers (`ctx.get('calendar')`) can use directly.
 */

import { AdapterRegistry } from './registry.js';
import { TimezoneService, createTimezoneService } from './timezone.js';
import { GregorianHub } from './hub.js';
import { CalendarAdapter, CalendarEngineOptions, CalendarEnginePublic } from './types.js';

import { GregorianAdapter } from './adapters/gregorian.js';
import { LunarAdapter } from './adapters/lunar.js';
import { IslamicAdapter } from './adapters/islamic.js';
import { HebrewAdapter } from './adapters/hebrew.js';

export * from './types.js';
export { AdapterRegistry } from './registry.js';
export { GregorianHub } from './hub.js';
export { TimezoneService, createTimezoneService } from './timezone.js';
export * from './errors.js';
export { GregorianAdapter } from './adapters/gregorian.js';
export { LunarAdapter } from './adapters/lunar.js';
export { IslamicAdapter } from './adapters/islamic.js';
export { HebrewAdapter } from './adapters/hebrew.js';

const builtInFactories: Record<
  string,
  (tz: TimezoneService) => CalendarAdapter
> = {
  gregorian: (tz) => new GregorianAdapter(tz),
  lunar: (tz) => new LunarAdapter(tz),
  islamic: (tz) => new IslamicAdapter(tz),
  hebrew: (tz) => new HebrewAdapter(tz),
};

export function createCalendarEngine(
  options: CalendarEngineOptions,
): CalendarEnginePublic {
  const timezone = createTimezoneService(options.timezoneEngine ?? 'system');
  const registry = new AdapterRegistry();

  for (const id of options.enabledCalendars) {
    const factory = builtInFactories[id];
    if (factory) {
      registry.register(factory(timezone));
    }
  }

  if (options.thirdPartyFactories) {
    for (const id of Object.keys(options.thirdPartyFactories)) {
      const factory = options.thirdPartyFactories[id];
      registry.register(factory(timezone));
    }
  }

  const hub = new GregorianHub(registry, timezone);
  return { hub, registry, timezone };
}
