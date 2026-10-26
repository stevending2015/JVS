/**
 * Weather state model checks.
 *
 * The reported problem was that 晴朗 / 多云 / 阴天 / 雨天 looked alike (and a clear sky
 * looked hazy). These assertions pin the properties that make them distinguishable,
 * so a future palette tweak cannot silently collapse them again.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const weather = require('./.weather-for-test.cjs');

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

const { WEATHER_KIND, THEMES, SKY_STYLE, kindOf, defaultWeatherCities } = weather;

function hexLuminance(hex) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function blueness(hex) {
  const clean = hex.replace('#', '');
  return parseInt(clean.slice(4, 6), 16) - parseInt(clean.slice(0, 2), 16);
}

console.log('1. WMO 代码分类');
const expected = {
  0: 'clear', 1: 'partly', 2: 'partly', 3: 'overcast',
  45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 56: 'drizzle', 57: 'drizzle',
  61: 'rain', 63: 'rain', 65: 'rain', 66: 'rain', 67: 'rain',
  71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow',
  80: 'rain', 81: 'rain', 82: 'rain', 85: 'snow', 86: 'snow',
  95: 'thunder', 96: 'thunder', 99: 'thunder',
};
const mismatched = Object.entries(expected)
  .filter(([code, kind]) => kindOf(Number(code)) !== kind)
  .map(([code, kind]) => `${code}:${kindOf(Number(code))}≠${kind}`);
check('every WMO code maps to the intended state', mismatched.length === 0, mismatched.join(','));
check('overcast is its own state (was lumped into cloudy)', kindOf(3) === 'overcast');
check('drizzle is separate from rain', kindOf(53) === 'drizzle' && kindOf(63) === 'rain');
check('unknown codes fall back to a visible state', kindOf(999) === 'partly', kindOf(999));

console.log('2. 每个状态都有主题与场景参数');
const kinds = Object.keys(SKY_STYLE);
check('eight distinguishable states', kinds.length === 8, kinds.join(','));
check('every state has a theme', kinds.every((kind) => THEMES[kind] !== undefined));
check('every state has scene parameters', kinds.every((kind) => SKY_STYLE[kind] !== undefined));
check('the mapping only uses declared states',
  Object.values(WEATHER_KIND).every((kind) => kinds.includes(kind)));

console.log('3. 晴朗必须干净（不能像雾霾）');
const clear = SKY_STYLE.clear;
check('clear has no baseline cloud cover', clear.coverage === 0);
check('clear has no veil wash', clear.veil === 0);
check('clear has no precipitation', clear.rain === 0 && clear.snow === 0);
check('clear day sky is genuinely blue, not grey',
  blueness(THEMES.clear.dayTop) > 100, String(blueness(THEMES.clear.dayTop)));
check('clear day is notably bluer than overcast 60+',
  blueness(THEMES.clear.dayTop) - blueness(THEMES.overcast.dayTop) > 60,
  `${blueness(THEMES.clear.dayTop)} vs ${blueness(THEMES.overcast.dayTop)}`);

console.log('4. 阴天/雨天必须与晴天可分');
check('overcast has near-total cloud cover', SKY_STYLE.overcast.coverage > 0.9);
check('overcast washes the sky out with a veil', SKY_STYLE.overcast.veil > 0.3);
check('overcast hides the sun (solid deck)', SKY_STYLE.overcast.coverage > 0.88);
check('rain carries precipitation', SKY_STYLE.rain.rain > 0 && SKY_STYLE.rain.snow === 0);
check('rain sky is darker than a clear sky',
  hexLuminance(THEMES.rain.dayBottom) < hexLuminance(THEMES.clear.dayBottom),
  `${Math.round(hexLuminance(THEMES.rain.dayBottom))} < ${Math.round(hexLuminance(THEMES.clear.dayBottom))}`);
check('thunder is darker than overcast',
  hexLuminance(THEMES.thunder.dayTop) < hexLuminance(THEMES.overcast.dayTop),
  `${Math.round(hexLuminance(THEMES.thunder.dayTop))} vs ${Math.round(hexLuminance(THEMES.overcast.dayTop))}`);
check('drizzle is lighter precipitation than rain',
  SKY_STYLE.drizzle.rain > 0 && SKY_STYLE.drizzle.rain < SKY_STYLE.rain.rain,
  `${SKY_STYLE.drizzle.rain} < ${SKY_STYLE.rain.rain}`);
check('snow has flakes and no rain',
  SKY_STYLE.snow.snow > 0 && SKY_STYLE.snow.rain === 0);
check('fog is the palest, most washed-out sky',
  SKY_STYLE.fog.veil >= 0.5, String(SKY_STYLE.fog.veil));

console.log('5. 纱幕颜色方向正确');
check('dark states use a dark veil (darken, not lighten)',
  hexLuminance(SKY_STYLE.rain.veilToneDay) < 120 && hexLuminance(SKY_STYLE.thunder.veilToneDay) < 100,
  `${Math.round(hexLuminance(SKY_STYLE.rain.veilToneDay))}, ${Math.round(hexLuminance(SKY_STYLE.thunder.veilToneDay))}`);
check('pale states use a light veil',
  hexLuminance(SKY_STYLE.snow.veilToneDay) > 180 && hexLuminance(SKY_STYLE.overcast.veilToneDay) > 150);

console.log('6. 默认城市');
const cities = defaultWeatherCities('Asia/Shanghai');
const names = cities.map((city) => city.name);
check('the time zone city is the first one', names[0] === '上海', names[0]);
check('no duplicate chips', new Set(names).size === names.length, names.join(','));
// 城市行现在只有一个默认（本机时区城市），其余靠图钉钉住；HOME_CITIES 只是候选。
check('the time zone city is present', names.includes('上海'), names.join(','));
check('home cities remain available as candidates',
  ['深圳', '北京', '徐州', '衡阳'].every((name) => names.includes(name)), names.join(','));


console.log('7. 国外城市解析');
const { CITY_ALIASES, COUNTRY_LABELS, pickBestCity } = weather;

check('纽约 maps to the indexed English name', CITY_ALIASES['纽约'] === 'New York', CITY_ALIASES['纽约']);
check('伦敦 maps to London', CITY_ALIASES['伦敦'] === 'London');
check('东京 maps to Tokyo', CITY_ALIASES['东京'] === 'Tokyo');
check('约克 maps to York (the UK city, not York SC)', CITY_ALIASES['约克'] === 'York');
check('every alias target is latin script',
  Object.values(CITY_ALIASES).every((value) => /^[\x20-\x7e]+$/.test(value)));

const bigger = [{ name: 'York', latitude: 0, longitude: 0, population: 144000 },
                { name: 'York', latitude: 1, longitude: 1, population: 7864 }];
check('among same-name hits the largest city wins', pickBestCity(bigger, 'York')?.population === 144000);

const exactVsBig = [{ name: 'Yorkshire', latitude: 0, longitude: 0, population: 9000000 },
                    { name: 'York', latitude: 1, longitude: 1, population: 144000 }];
check('an exact name beats a bigger fuzzy match', pickBestCity(exactVsBig, 'York')?.name === 'York');

const diacritics = [{ name: 'São Paulo', latitude: 0, longitude: 0, population: 12000000 }];
check('diacritics do not break the exact match', pickBestCity(diacritics, 'Sao Paulo') !== undefined);
check('empty results resolve to nothing', pickBestCity([], '纽约') === undefined);

check('English countries get Chinese labels',
  COUNTRY_LABELS['United States'] === '美国' && COUNTRY_LABELS['United Kingdom'] === '英国'
  && COUNTRY_LABELS['Japan'] === '日本', COUNTRY_LABELS['United States']);
check('China stays a clean 中国 label', COUNTRY_LABELS.China === '中国');
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
