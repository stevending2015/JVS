/**
 * Weather cache in SQLite.
 *
 * The dashboard must render instantly and still mean something offline, so the
 * last successful forecast is stored per location and displayed while a refresh
 * is in flight (or failing). `fetched_at` is what makes the age visible.
 */

import { db } from '../db/client.js';
import { cityKey, type City, type WeatherBundle } from './openMeteo.js';

/** Last cached forecast for a city, or null. */
export async function readCachedWeather(city: City): Promise<WeatherBundle | null> {
  const rows = await db.all<{ payload_json: string }>(
    'SELECT payload_json FROM weather_cache WHERE location_key = ?',
    [cityKey(city)],
  );
  if (rows.length === 0) return null;
  try {
    return { ...(JSON.parse(rows[0].payload_json) as WeatherBundle), city };
  } catch {
    return null;
  }
}

/** Store a forecast for a city. */
export async function writeCachedWeather(city: City, bundle: WeatherBundle): Promise<void> {
  await db.run(
    `INSERT INTO weather_cache (location_key, fetched_at, payload_json) VALUES (?,?,?)
     ON CONFLICT(location_key) DO UPDATE SET
       fetched_at = excluded.fetched_at,
       payload_json = excluded.payload_json`,
    [cityKey(city), bundle.fetchedAt, JSON.stringify(bundle)],
  );
}