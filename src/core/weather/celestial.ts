/**
 * Where the sun and moon actually are in the sky.
 *
 * The first version of the sky panel faked this: it mapped "sunset → sunrise" onto
 * a left-to-right arc. That looks plausible at dusk but is astronomically wrong —
 * at 5 a.m. it still parked the moon near the left edge even when the real moon had
 * already set, or was high in the west.
 *
 * This module computes proper horizontal coordinates:
 *
 *   d      = days since J2000
 *   GMST   = Greenwich mean sidereal time  (Meeus 12.4)
 *   LST    = GMST + longitude              (east positive)
 *   H      = LST − RA                      (hour angle, positive after transit)
 *   sin h  = sinφ·sinδ + cosφ·cosδ·cosH
 *   A      = atan2(−cosδ·sinH, sinδ − sinφ·sin h)   from North, clockwise
 *
 * The position is accurate to a few arcminutes, which is far beyond what a
 * decorative sky panel needs, and — unlike the fake arc — it is checkable: at local
 * noon the sun must be due south with the altitude the season predicts.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
/** Mean obliquity of the ecliptic (J2000), degrees. */
const OBLIQUITY = 23.4393;

const sin = (degrees: number): number => Math.sin(degrees * DEG);
const cos = (degrees: number): number => Math.cos(degrees * DEG);
const normalize = (degrees: number): number => ((degrees % 360) + 360) % 360;

/** Days (with fraction) since J2000.0. */
export function daysSinceJ2000(at: Date): number {
  return (at.getTime() - J2000_MS) / 86_400_000;
}

/** Greenwich mean sidereal time in degrees. */
export function gmst(days: number): number {
  const t = days / 36_525;
  return normalize(
    280.46061837 + 360.98564736629 * days + 0.000387933 * t * t - (t * t * t) / 38_710_000,
  );
}

/** Sun's apparent ecliptic longitude in degrees. */
export function sunEclipticLongitude(days: number): number {
  const meanLongitude = 280.459 + 0.98564736 * days;
  const meanAnomaly = 357.529 + 0.98560028 * days;
  return normalize(meanLongitude + 1.915 * sin(meanAnomaly) + 0.020 * sin(2 * meanAnomaly));
}

/** Moon's ecliptic longitude and latitude in degrees (main periodic terms). */
export function moonEcliptic(days: number): { longitude: number; latitude: number } {
  const meanLongitude = 218.316 + 13.176396 * days;
  const meanAnomaly = 134.963 + 13.064993 * days;
  const argLatitude = 93.272 + 13.229350 * days;

  const sunLongitude = sunEclipticLongitude(days);
  const elongation = 2 * (meanLongitude - sunLongitude);

  const longitude = normalize(
    meanLongitude +
      6.289 * sin(meanAnomaly) +
      1.274 * sin(elongation - meanAnomaly) +
      0.658 * sin(elongation) +
      0.214 * sin(2 * meanAnomaly) -
      0.186 * sin(357.529 + 0.98560028 * days),
  );

  return { longitude, latitude: 5.128 * sin(argLatitude) };
}

/** Ecliptic -> equatorial. */
function toEquatorial(
  longitude: number,
  latitude: number,
): { rightAscension: number; declination: number } {
  const l = longitude * DEG;
  const b = latitude * DEG;
  const e = OBLIQUITY * DEG;
  const rightAscension = Math.atan2(
    Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e),
    Math.cos(l),
  );
  const declination = Math.asin(
    Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l),
  );
  return { rightAscension: normalize(rightAscension * RAD), declination: declination * RAD };
}

export interface HorizontalPosition {
  /** Degrees above the horizon; negative means below it. */
  altitude: number;
  /** Degrees clockwise from North: 0=N, 90=E, 180=S, 270=W. */
  azimuth: number;
}

/**
 * Convert equatorial coordinates to horizontal for an observer.
 * @param rightAscension - degrees.
 * @param declination - degrees.
 * @param latitude - observer latitude, north positive.
 * @param longitude - observer longitude, east positive.
 * @param days - days since J2000.
 * @returns Altitude and azimuth.
 */
function toHorizontal(
  rightAscension: number,
  declination: number,
  latitude: number,
  longitude: number,
  days: number,
): HorizontalPosition {
  const localSidereal = normalize(gmst(days) + longitude);
  const hourAngle = normalize(localSidereal - rightAscension + 180) - 180; // -180..180
  const phi = latitude * DEG;
  const delta = declination * DEG;
  const h = hourAngle * DEG;

  const sinAltitude = Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(h);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAltitude))) * RAD;

  const azimuth = normalize(
    Math.atan2(
      -Math.cos(delta) * Math.sin(h),
      Math.sin(delta) - Math.sin(phi) * Math.sin(altitude * DEG),
    ) * RAD,
  );

  return { altitude, azimuth };
}

/**
 * Sun position for an observer.
 * @param at - instant.
 * @param latitude - degrees north.
 * @param longitude - degrees east.
 * @returns Altitude and azimuth.
 */
export function sunPosition(at: Date, latitude: number, longitude: number): HorizontalPosition {
  const days = daysSinceJ2000(at);
  const { rightAscension, declination } = toEquatorial(sunEclipticLongitude(days), 0);
  return toHorizontal(rightAscension, declination, latitude, longitude, days);
}

/**
 * Moon position for an observer.
 * @param at - instant.
 * @param latitude - degrees north.
 * @param longitude - degrees east.
 * @returns Altitude and azimuth.
 */
export function moonPosition(at: Date, latitude: number, longitude: number): HorizontalPosition {
  const days = daysSinceJ2000(at);
  const moon = moonEcliptic(days);
  const { rightAscension, declination } = toEquatorial(moon.longitude, moon.latitude);
  return toHorizontal(rightAscension, declination, latitude, longitude, days);
}

/** Standard sunrise/sunset test: the sun's centre is 0.833° below the horizon. */
export function isSunUp(position: HorizontalPosition): boolean {
  return position.altitude > -0.833;
}

/** How close to the horizon, 0..1 — used for the red sun at dawn and dusk. */
export function horizonProximity(altitude: number, degrees = 2.5): number {
  return Math.max(0, Math.min(1, 1 - Math.abs(altitude) / degrees));
}
/**
 * Map an azimuth onto the sky panel's left→right position, 0..1.
 *
 * Northern viewers face south, so east (90°) is on the left and west (270°) on the
 * right; southern viewers face north, which mirrors it. Azimuths behind the viewer
 * clamp to the edge.
 *
 * @param azimuth - degrees clockwise from north.
 * @param latitude - observer latitude; the sign picks the viewing direction.
 * @returns Fraction across the panel.
 */
export function skyFractionFromAzimuth(azimuth: number, latitude: number): number {
  const facingSouth = latitude >= 0;
  const t = facingSouth ? (azimuth - 90) / 180 : (270 - azimuth) / 180;
  return Math.max(0, Math.min(1, t));
}

/**
 * Map an altitude onto the sky panel's bottom→top position, 0..1.
 * @param altitude - degrees above the horizon.
 * @returns Fraction up the panel.
 */
export function skyFractionFromAltitude(altitude: number): number {
  return Math.max(0, Math.min(1, altitude / 90));
}