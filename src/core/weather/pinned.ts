/**
 * Pinned weather cities — the storage side.
 *
 * The default city list is seeded from the machine's time zone, and the cities the
 * user searched for used to vanish on reload. A pinned city is the way to say
 * 「keep this one」: it is stored in the settings table and comes back on the next
 * start, next to the time-zone city.
 *
 * The encoding lives in pinnedFormat.ts (pure, unit-tested).
 */

import { getSetting, setSetting } from '../setting/repository.js';
import type { City } from './openMeteo.js';
import { decodeCities, encodeCities } from './pinnedFormat.js';

/** Settings key holding the pinned cities. */
export const KEY_WEATHER_PINNED = 'weather.pinned';

/**
 * Read the pinned cities.
 *
 * @returns The pinned cities, in the order they were pinned.
 */
export async function listPinnedCities(): Promise<City[]> {
  return decodeCities(await getSetting(KEY_WEATHER_PINNED));
}

/**
 * Store the pinned cities.
 *
 * @param cities - the cities to keep.
 */
export async function savePinnedCities(cities: City[]): Promise<void> {
  await setSetting(KEY_WEATHER_PINNED, encodeCities(cities));
}

export { decodeCities, encodeCities, isPinned, parseCity, parseCityKey } from './pinnedFormat.js';
