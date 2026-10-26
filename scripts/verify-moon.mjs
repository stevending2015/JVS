/**
 * Moon phase verification.
 *
 * Part 1 checks the astronomy against eclipse dates: a solar eclipse can only
 * happen at new moon and a lunar eclipse only at full moon, so those instants are
 * ground truth (illumination ≈ 0% / ≈ 100%).
 *
 * Part 2 checks the DRAWING, not just the numbers: each phase path is rasterised
 * in a real browser and its lit area compared with the expected illuminated
 * fraction. That is what catches a crescent drawn as a gibbous — a bug this code
 * had (the terminator swept the wrong way, so new moon rendered as a full disc).
 */

import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { moonPhaseAt, moonGeometry, moonPhaseName } = require('./.moon-for-test.cjs');
const celestial = require('./.celestial-for-test.cjs');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- astronomy ---
console.log('1. 天文计算：用日食/月食日期当基准');

const NEW_MOONS = [
  '2024-04-08T18:21:00Z', // 北美日全食
  '2025-03-29T10:58:00Z', // 日偏食
  '2026-02-17T12:12:00Z', // 日环食
  '2026-08-12T17:46:00Z', // 日全食
];
const FULL_MOONS = [
  '2024-03-25T07:00:00Z', // 半影月食
  '2025-03-14T06:55:00Z', // 月全食
  '2026-03-03T11:38:00Z', // 月全食
];

for (const iso of NEW_MOONS) {
  const moon = moonPhaseAt(new Date(iso));
  check(
    `solar eclipse ${iso.slice(0, 10)} is a new moon`,
    moon.illumination < 0.01,
    `illum=${(moon.illumination * 100).toFixed(3)}%`,
  );
}
for (const iso of FULL_MOONS) {
  const moon = moonPhaseAt(new Date(iso));
  check(
    `lunar eclipse ${iso.slice(0, 10)} is a full moon`,
    moon.illumination > 0.99,
    `illum=${(moon.illumination * 100).toFixed(3)}%`,
  );
}

const waxing = moonPhaseAt(new Date('2026-02-24T12:00:00Z')); // 新月之后
const waning = moonPhaseAt(new Date('2026-03-10T12:00:00Z')); // 满月之后
check('a week after new moon is waxing', waxing.waxing === true, JSON.stringify(waxing));
check('a week after full moon is waning', waning.waxing === false, JSON.stringify(waning));
check('phase advances over a week', waxing.phase > 0.1 && waxing.phase < 0.4, String(waxing.phase));

check('name at 0 is 朔', moonPhaseName(0).includes('朔'));
check('name at 0.25 is 上弦', moonPhaseName(0.25).includes('上弦'));
check('name at 0.5 is 望', moonPhaseName(0.5).includes('望'));
check('name at 0.75 is 下弦', moonPhaseName(0.75).includes('下弦'));
check('name at 0.999 is still 朔', moonPhaseName(0.999).includes('朔'));

// ----------------------------------------------------------------- geometry ---
console.log('2. 几何：terminator 与亮面朝向');

check('new moon terminator spans the limb', Math.abs(moonGeometry(10, 0).terminator - 1) < 1e-6);
check('full moon terminator spans the limb', Math.abs(moonGeometry(10, 0.5).terminator - 1) < 1e-6);
check('quarter terminator is a straight line', moonGeometry(10, 0.25).terminator < 1e-6);
check('waxing lights the right limb', moonGeometry(10, 0.25).litRight === true);
check('waning lights the left limb', moonGeometry(10, 0.75).litRight === false);
check('southern hemisphere mirrors the limb', moonGeometry(10, 0.25, true).litRight === false);

// ------------------------------------------------------------- pixel areas ---
console.log('3. 像素面积：把路径画出来，量亮面占比');

const PHASES = [0.05, 0.13, 0.25, 0.37, 0.5, 0.63, 0.75, 0.87, 0.95];
const RADIUS = 100;
const paths = PHASES.map((phase) => moonGeometry(RADIUS, phase).path);
const expected = PHASES.map((phase) => (1 - Math.cos(2 * Math.PI * phase)) / 2);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const measured = await page.evaluate(
  async ({ paths: pathList, radius }) => {
    const size = radius * 2;
    const results = [];
    for (const d of pathList) {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
        `viewBox="${-radius} ${-radius} ${size} ${size}"><path d="${d}" fill="#fff"/></svg>`;
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      context.clearRect(0, 0, size, size);
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, size, size).data;
      let lit = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 128) lit += 1;
      results.push(lit);
    }
    return results;
  },
  { paths, radius: RADIUS },
);
await browser.close();

const discArea = Math.PI * RADIUS * RADIUS;
for (let i = 0; i < PHASES.length; i += 1) {
  const ratio = measured[i] / discArea;
  check(
    `phase ${PHASES[i].toFixed(2)} lit area matches illumination`,
    Math.abs(ratio - expected[i]) < 0.03,
    `drawn=${(ratio * 100).toFixed(1)}% expected=${(expected[i] * 100).toFixed(1)}%`,
  );
}


// --------------------------------------------------------- horizontal position ---
console.log('4. 地平坐标：太阳/月亮的真实高度与方位');

const BEIJING = { lat: 39.9042, lon: 116.4074 };
const YORK = { lat: 53.96, lon: -1.08 };

// 夏至真太阳时正午：高度应为 90 - |纬度 - 赤纬| ≈ 73.5°，方位正南
const summerNoon = celestial.sunPosition(new Date('2026-06-21T04:14:30Z'), BEIJING.lat, BEIJING.lon);
check('summer-solstice noon altitude matches theory', Math.abs(summerNoon.altitude - 73.5) < 1.5, summerNoon.altitude.toFixed(1));
check('summer-solstice noon is due south', Math.abs(summerNoon.azimuth - 180) < 5, summerNoon.azimuth.toFixed(1));

// 冬至正午：高度 ≈ 90 - (39.9 + 23.44) ≈ 26.7°
const winterNoon = celestial.sunPosition(new Date('2026-12-21T04:14:30Z'), BEIJING.lat, BEIJING.lon);
check('winter-solstice noon altitude matches theory', Math.abs(winterNoon.altitude - 26.7) < 1.5, winterNoon.altitude.toFixed(1));
check('winter sun is lower than the summer sun', winterNoon.altitude < summerNoon.altitude - 40);

const midnight = celestial.sunPosition(new Date('2026-06-21T16:00:00Z'), BEIJING.lat, BEIJING.lon);
check('the sun is below the horizon at local midnight', midnight.altitude < 0, midnight.altitude.toFixed(1));
check('isSunUp agrees with the altitude', celestial.isSunUp(summerNoon) === true && celestial.isSunUp(midnight) === false);

// 满月夜：月亮应当在地平线之上；新月夜：应当在地平线之下
const fullMoonNight = celestial.moonPosition(new Date('2026-03-03T16:00:00Z'), BEIJING.lat, BEIJING.lon);
const newMoonNight = celestial.moonPosition(new Date('2026-02-17T16:00:00Z'), BEIJING.lat, BEIJING.lon);
check('the moon is up at midnight on a full-moon night', fullMoonNight.altitude > 0, fullMoonNight.altitude.toFixed(1));
check('the moon is down at midnight on a new-moon night', newMoonNight.altitude < 0, newMoonNight.altitude.toFixed(1));

// 回归：约克凌晨 5 点，月亮其实还没升起（旧模型却一直画在左下角）
const yorkDawn = celestial.moonPosition(new Date('2026-10-19T04:00:00Z'), YORK.lat, YORK.lon);
check('York 05:00 — the moon is below the horizon (the reported bug)', yorkDawn.altitude < 0, yorkDawn.altitude.toFixed(1));
const yorkDawnSun = celestial.sunPosition(new Date('2026-10-19T04:00:00Z'), YORK.lat, YORK.lon);
check('York 05:00 is still night (sun below the horizon)', yorkDawnSun.altitude < 0, yorkDawnSun.altitude.toFixed(1));

// 方位→画面位置：北半球面南，东在左、西在右
check('north: east maps to the left edge', celestial.skyFractionFromAzimuth(90, 40) < 0.01);
check('north: south maps to the centre', Math.abs(celestial.skyFractionFromAzimuth(180, 40) - 0.5) < 0.01);
check('north: west maps to the right edge', celestial.skyFractionFromAzimuth(270, 40) > 0.99);
check('south: west maps to the left edge', celestial.skyFractionFromAzimuth(270, -40) < 0.01);
check('altitude maps bottom -> top', celestial.skyFractionFromAltitude(0) === 0 && celestial.skyFractionFromAltitude(90) === 1);
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;