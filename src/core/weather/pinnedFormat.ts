/**
 * Pure helpers for pinned weather cities — no database, no imports.
 *
 * The stored form is one entry per city:
 *
 *     name@country@lat,lon
 *
 * joined by "|". The two separators must differ, or splitting the list would
 * also split each city apart — which is exactly the bug the first version had.
 */

import { cityKey, type City } from './openMeteo.js';

/** Separator between the pinned cities in the stored list. */
export const SEPARATOR = '|';

/** Separator between a city's name, country and coordinates. */
export const FIELD = '@';

/**
 * Encode one city for storage.
 *
 * @param city - the city.
 * @returns The stored entry.
 */
export function encodeCity(city: City): string {
  return `${city.name}${FIELD}${city.country ?? ''}${FIELD}${cityKey(city)}`;
}

/**
 * Parse a stored coordinate key.
 *
 * @param key - "lat,lon" with three decimals.
 * @returns The city, or null when the key is malformed.
 */
export function parseCityKey(key: string): City | null {
  const [latRaw, lonRaw] = key.split(',');
  const latitude = Number(latRaw);
  const longitude = Number(lonRaw);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { name: '', latitude, longitude };
}

/**
 * Parse one stored entry ("name@country@lat,lon").
 *
 * @param entry - the stored entry.
 * @returns The city, or null when the entry is malformed.
 */
export function parseCity(entry: string): City | null {
  const first = entry.indexOf(FIELD);
  if (first < 0) {
    // 旧格式：只有坐标，没有名字。
    const legacy = parseCityKey(entry);
    return legacy === null ? null : { ...legacy, name: '已钉住的城市' };
  }
  const name = entry.slice(0, first);
  const rest = entry.slice(first + 1);
  const second = rest.indexOf(FIELD);
  const country = second < 0 ? '' : rest.slice(0, second);
  const key = second < 0 ? rest : rest.slice(second + 1);
  const coords = parseCityKey(key);
  if (coords === null) return null;
  return {
    ...coords,
    name: name.trim() === '' ? '已钉住的城市' : name,
    ...(country.trim() === '' ? {} : { country: country.trim() }),
  };
}

/**
 * Encode a list of cities for storage.
 *
 * @param cities - the cities.
 * @returns The stored value.
 */
export function encodeCities(cities: City[]): string {
  return cities.map((city) => encodeCity(city)).join(SEPARATOR);
}

/**
 * Decode a stored list.
 *
 * @param raw - the stored value.
 * @returns The cities that could be read.
 */
export function decodeCities(raw: string | null): City[] {
  if (raw === null || raw.trim() === '') return [];
  const cities: City[] = [];
  for (const part of raw.split(SEPARATOR)) {
    if (part.trim() === '') continue;
    const city = parseCity(part);
    if (city !== null) cities.push(city);
  }
  return cities;
}

/**
 * Is this city pinned?
 *
 * @param cities - the pinned cities.
 * @param city - the city to test.
 * @returns true when the city is in the list.
 */
export function isPinned(cities: City[], city: City): boolean {
  const key = cityKey(city);
  return cities.some((pinnedCity) => cityKey(pinnedCity) === key);
}
