/**
 * Moon phase for the weather sky.
 *
 * The phase is a property of the instant, not of a timezone: the same moment has
 * the same phase everywhere. What the timezone does change is WHEN the moon is up,
 * which the sky already derives from the city clock and the sunrise/sunset window.
 *
 * Illumination comes from the sun-moon elongation rather than a plain synodic
 * average, because the average drifts by up to ~0.6 days (the orbit is eccentric)
 * and that is visible near the quarters.
 *
 * The rendering uses the classic terminator construction: the lit part is bounded
 * by a limb semicircle and a semi-ellipse whose horizontal axis is r·|2k−1|, so a
 * crescent, a quarter and a gibbous moon all fall out of the same path.
 *
 * Checked against eclipse dates (a solar eclipse can only happen at new moon, a
 * lunar eclipse only at full moon) in `scripts/verify-moon.mjs`.
 */

import { daysSinceJ2000, moonEcliptic, sunEclipticLongitude } from './celestial.js';

const DEG = Math.PI / 180;
const SYNODIC_MONTH = 29.530588861;

const sin = (degrees: number): number => Math.sin(degrees * DEG);
const cos = (degrees: number): number => Math.cos(degrees * DEG);

export interface MoonPhase {
  /** 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter. */
  phase: number;
  /** Illuminated fraction, 0..1. */
  illumination: number;
  /** True while the lit part is growing. */
  waxing: boolean;
  /** Days since the last new moon. */
  ageDays: number;
  /** Chinese phase name, e.g. 上弦月. */
  name: string;
}

/** Chinese name for a phase fraction. */
export function moonPhaseName(phase: number): string {
  const p = ((phase % 1) + 1) % 1;
  if (p < 0.02 || p >= 0.98) return '朔（新月）';
  if (p < 0.21) return '蛾眉月';
  if (p < 0.29) return '上弦月';
  if (p < 0.46) return '盈凸月';
  if (p < 0.54) return '望（满月）';
  if (p < 0.71) return '亏凸月';
  if (p < 0.79) return '下弦月';
  return '残月';
}

/**
 * Moon phase at an instant.
 * @param at - the instant.
 * @returns Phase fraction, illumination, waxing flag, age and Chinese name.
 */
export function moonPhaseAt(at: Date): MoonPhase {
  // Same ecliptic model the horizontal-position code uses, so the phase and the
  // place in the sky can never disagree.
  const d = daysSinceJ2000(at);
  const sunLongitude = sunEclipticLongitude(d);
  const { longitude: moonLongitude, latitude: moonLatitude } = moonEcliptic(d);

  // Elongation in 0..180°, then the phase angle (0 at full, 180 at new).
  const delta = ((moonLongitude - sunLongitude) % 360 + 360) % 360;
  const elongation = Math.acos(cos(moonLatitude) * cos(delta));
  const phaseAngle = Math.PI - elongation;
  const illumination = (1 + Math.cos(phaseAngle)) / 2;

  const phase = delta / 360;
  return {
    phase,
    illumination,
    waxing: delta < 180,
    ageDays: phase * SYNODIC_MONTH,
    name: moonPhaseName(phase),
  };
}

export interface MoonGeometry {
  /** Path for the LIT part, drawn in a viewBox of -r..r. */
  path: string;
  /** Horizontal semi-axis of the terminator, relative to r (0..1). */
  terminator: number;
  /** True when the lit limb is on the right (northern-hemisphere waxing). */
  litRight: boolean;
}

/**
 * Geometry for drawing a moon phase.
 *
 * @param radius - disc radius in user units.
 * @param phase - phase fraction (0 new, 0.5 full).
 * @param southernHemisphere - mirror the lit limb for southern viewers.
 * @returns Path plus the intermediate values, which the tests assert on.
 */
export function moonGeometry(radius: number, phase: number, southernHemisphere = false): MoonGeometry {
  const p = ((phase % 1) + 1) % 1;
  const k = (1 - Math.cos(2 * Math.PI * p)) / 2;
  // |2k-1| == |cos(2*pi*p)|; at new and full the terminator equals the limb.
  const terminator = Math.abs(2 * k - 1);
  const a = radius * terminator;
  const r = radius;

  const waxing = p < 0.5;
  // Southern viewers see the lit limb mirrored.
  const litRight = southernHemisphere ? !waxing : waxing;
  const gibbous = k > 0.5;

  // First arc runs top -> bottom: sweep=1 traces the right limb, sweep=0 the left.
  const limbSweep = litRight ? 1 : 0;
  //
  // The terminator runs back bottom -> top, and SVG's sweep flag means the opposite
  // side for that direction: sweep=0 traces the right side, sweep=1 the left.
  //   crescent (k < 0.5) -> terminator follows the SAME side as the lit limb, so the
  //     lit area is a sliver; at k = 0 the two arcs coincide and the area is zero.
  //   gibbous  (k > 0.5) -> it follows the OPPOSITE side; at k = 1 the two arcs
  //     together trace the whole disc.
  // Hence `1 - limbSweep` for a crescent. Inverting this draws a crescent as a full
  // disc — caught by `verify:moon`'s pixel-area check.
  const terminatorSweep = gibbous ? limbSweep : 1 - limbSweep;

  const path =
    `M 0 ${-r} ` +
    `A ${r} ${r} 0 0 ${limbSweep} 0 ${r} ` +
    `A ${a} ${r} 0 0 ${terminatorSweep} 0 ${-r} Z`;

  return { path, terminator, litRight };
}