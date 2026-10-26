/**
 * Weather data, ported from the cyweather desktop app (Open-Meteo, no API key).
 *
 * Kept from that project: the WMO code -> kind mapping, the per-kind day/night
 * sky palettes, the sun arc driven by sunrise/sunset, the ~10-minute red sun at
 * either end of daylight, and the seasonal noon elevation from latitude.
 *
 * Changed for the browser: IP geolocation is gone (ip-api.com is plain HTTP and
 * sends no CORS headers, so a page on HTTPS cannot use it). City search uses
 * Open-Meteo's geocoder, and the default cities come from settings.
 */

/**
 * Sky presets, one per distinguishable weather state.
 *
 * The first version collapsed everything into six kinds whose gradients were almost
 * identical (clear #D8E9EC vs cloudy #DCE6E8), drew no clouds at all and always
 * showed a full-brightness sun — so 晴朗 / 多云 / 阴天 / 雨天 looked the same.
 *
 * Overcast is now its own state (WMO 3), drizzle is separate from rain, and the
 * scene additionally consumes the real \`cloud_cover\` percentage, so the number of
 * cloud sprites follows the actual sky rather than a coarse preset.
 */
export type WeatherKind =
  | 'clear'      // 0            cloudless
  | 'partly'     // 1, 2         scattered cloud, the sun still gets through
  | 'overcast'   // 3            solid cloud deck
  | 'fog'        // 45, 48
  | 'drizzle'    // 51–57        fine, light precipitation
  | 'rain'       // 61–67, 80–82
  | 'snow'       // 71–77, 85–86
  | 'thunder';   // 95–99

/** WMO weather code -> theme key. */
export const WEATHER_KIND: Record<number, WeatherKind> = {
  0: 'clear',
  1: 'partly', 2: 'partly',
  3: 'overcast',
  45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'drizzle',
  56: 'drizzle', 57: 'drizzle',
  61: 'rain', 63: 'rain', 65: 'rain',
  66: 'rain', 67: 'rain',
  71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow',
  80: 'rain', 81: 'rain', 82: 'rain',
  85: 'snow', 86: 'snow',
  95: 'thunder', 96: 'thunder', 99: 'thunder',
};

/** Chinese descriptions for the WMO codes. */
export const WMO_DESC: Record<number, string> = {
  0: '晴朗', 1: '大致晴朗', 2: '局部多云', 3: '阴天',
  45: '雾', 48: '雾凇',
  51: '毛毛雨(弱)', 53: '毛毛雨(中)', 55: '毛毛雨(强)',
  56: '冻毛雨(弱)', 57: '冻毛雨(强)',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨(弱)', 67: '冻雨(强)',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨(弱)', 81: '阵雨(中)', 82: '阵雨(强)',
  85: '阵雪(弱)', 86: '阵雪(强)',
  95: '雷暴', 96: '雷暴伴小冰雹', 99: '雷暴伴大冰雹',
};

export const WMO_EMOJI: Record<number, string> = {
  0: '☀️', 1: '🌤', 2: '⛅', 3: '☁️',
  45: '🌫', 48: '🌫',
  51: '🌦', 53: '🌦', 55: '🌧',
  56: '🌧', 57: '🌧',
  61: '🌧', 63: '🌧', 65: '🌧',
  66: '🌧', 67: '🌧',
  71: '🌨', 73: '🌨', 75: '❄️', 77: '❄️',
  80: '🌦', 81: '🌧', 82: '⛈',
  85: '🌨', 86: '❄️',
  95: '⛈', 96: '⛈', 99: '⛈',
};

/**
 * Sky gradient per kind.
 *
 * Day palettes are now clearly separated: deep blue for clear, washed blue-grey for
 * partly, flat grey for overcast, pale desaturated for fog, dark slate for rain, and
 * near-black for thunder.
 */
export const THEMES: Record<WeatherKind, { dayTop: string; dayBottom: string; nightTop: string; nightBottom: string }> = {
  clear:    { dayTop: '#5AA9E6', dayBottom: '#D2EAF8', nightTop: '#081523', nightBottom: '#16304A' },
  partly:   { dayTop: '#7FB6DC', dayBottom: '#D8E8F2', nightTop: '#122232', nightBottom: '#243D52' },
  overcast: { dayTop: '#98A5AE', dayBottom: '#C8D0D5', nightTop: '#1A222A', nightBottom: '#2D3943' },
  fog:      { dayTop: '#C2CBC7', dayBottom: '#E6EBE7', nightTop: '#1E2623', nightBottom: '#39433E' },
  drizzle:  { dayTop: '#8AA3B2', dayBottom: '#C2D1D9', nightTop: '#141F28', nightBottom: '#26363F' },
  rain:     { dayTop: '#5D7586', dayBottom: '#A9BEC9', nightTop: '#0C161F', nightBottom: '#1D2F3B' },
  snow:     { dayTop: '#B7CAD8', dayBottom: '#EAF2F7', nightTop: '#1A2733', nightBottom: '#3A5064' },
  thunder:  { dayTop: '#49545F', dayBottom: '#8D99A7', nightTop: '#080C14', nightBottom: '#1A2330' },
};

/** What the scene draws for one weather state. */
export interface SkyStyle {
  /** Baseline cloud coverage 0..1, used when the payload has no cloud_cover. */
  coverage: number;
  /** Cloud fill colour, day and night. */
  cloudToneDay: string;
  cloudToneNight: string;
  /** Flat veil over the whole panel, 0..1 (overcast and fog wash the sky out). */
  veil: number;
  /** Veil colour: dark states must darken, not lighten, the panel. */
  veilToneDay: string;
  veilToneNight: string;
  /** Precipitation strength 0..1; drizzle is thin and slow, rain is heavy. */
  rain: number;
  snow: number;
}

export const SKY_STYLE: Record<WeatherKind, SkyStyle> = {
  clear:    { coverage: 0, cloudToneDay: '#FFFFFF', cloudToneNight: '#2A3A4C', veil: 0, veilToneDay: 'transparent', veilToneNight: 'transparent', rain: 0, snow: 0 },
  partly:   { coverage: 0.45, cloudToneDay: '#F4F9FC', cloudToneNight: '#2C3C4E', veil: 0, veilToneDay: 'transparent', veilToneNight: 'transparent', rain: 0, snow: 0 },
  overcast: { coverage: 0.97, cloudToneDay: '#C6CED4', cloudToneNight: '#28323C', veil: 0.42, veilToneDay: '#D5DCE1', veilToneNight: '#B8C6D4', rain: 0, snow: 0 },
  fog:      { coverage: 0.55, cloudToneDay: '#D5DCD7', cloudToneNight: '#2C3733', veil: 0.55, veilToneDay: '#E8EDEA', veilToneNight: '#C9D2CE', rain: 0, snow: 0 },
  drizzle:  { coverage: 0.9, cloudToneDay: '#A9B8C2', cloudToneNight: '#202C36', veil: 0.3, veilToneDay: '#8FA3AF', veilToneNight: '#7C93A4', rain: 0.35, snow: 0 },
  rain:     { coverage: 0.97, cloudToneDay: '#6B7D8A', cloudToneNight: '#19232C', veil: 0.42, veilToneDay: '#41525E', veilToneNight: '#31455A', rain: 1, snow: 0 },
  snow:     { coverage: 0.92, cloudToneDay: '#E3ECF2', cloudToneNight: '#24313D', veil: 0.28, veilToneDay: '#DDE7EE', veilToneNight: '#C4D2DE', rain: 0, snow: 1 },
  thunder:  { coverage: 1, cloudToneDay: '#5A6572', cloudToneNight: '#10161F', veil: 0.52, veilToneDay: '#2A333F', veilToneNight: '#1B2534', rain: 1.15, snow: 0 },
};

/** Red sun lasts about this long at either end of daylight. */
export const RED_SUN_MINUTES = 10;
/** Particle counts at full intensity. */
export const RAIN_DROPS = 70;
export const SNOW_FLAKES = 50;
export const STARS = 80;
/** Cloud sprites in the pool; real coverage decides how many are drawn. */
export const CLOUD_SPRITES = 8;

export interface City {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
}

export interface CurrentWeather {
  time: string;
  temperature: number;
  apparent: number;
  humidity: number;
  isDay: boolean;
  code: number;
  windSpeed: number;
  windDirection: number;
  precipitation: number;
  pressure: number;
  /** Cloud cover 0–100%, drives how many cloud sprites the scene draws. */
  cloudCover: number;
}

export interface DailyWeather {
  date: string;
  code: number;
  max: number;
  min: number;
  precipitationSum: number;
  precipitationProbability: number;
  windMax: number;
  sunrise: string;
  sunset: string;
  uvMax: number;
}

export interface WeatherBundle {
  city: City;
  fetchedAt: string;
  utcOffsetSeconds: number;
  timezoneAbbr: string;
  current: CurrentWeather;
  daily: DailyWeather[];
}

/** Default cities, matching cyweather's shortcuts. */
/**
 * Cities that always sit in the default chip row.
 *
 * The row is deliberately small and personal: the user's own places, plus the city
 * of their time zone (prepended by `defaultWeatherCities`). Searched cities are
 * temporary — they show for the session and are dropped on reload.
 */
export const HOME_CITIES: City[] = [
  { name: '深圳', latitude: 22.5455, longitude: 114.0545, country: '中国' },
  { name: '北京', latitude: 39.9042, longitude: 116.4074, country: '中国' },
  { name: '徐州', latitude: 34.2044, longitude: 117.2858, country: '中国' },
  { name: '衡阳', latitude: 26.9004, longitude: 112.5720, country: '中国' },
];

/** Representative city for a time zone, used as the "where I am" default chip. */
const TIMEZONE_CITIES: Record<string, City> = {
  'Asia/Shanghai': { name: '上海', latitude: 31.2222, longitude: 121.4581, country: '中国' },
  'Asia/Chongqing': { name: '上海', latitude: 31.2222, longitude: 121.4581, country: '中国' },
  'Asia/Harbin': { name: '上海', latitude: 31.2222, longitude: 121.4581, country: '中国' },
  'Asia/Hong_Kong': { name: '香港', latitude: 22.3193, longitude: 114.1694, country: '中国' },
  'Asia/Macau': { name: '澳门', latitude: 22.1987, longitude: 113.5439, country: '中国' },
  'Asia/Taipei': { name: '台北', latitude: 25.033, longitude: 121.5654, country: '中国' },
  'Asia/Tokyo': { name: '东京', latitude: 35.6895, longitude: 139.6917, country: '日本' },
  'Asia/Seoul': { name: '首尔', latitude: 37.5665, longitude: 126.978, country: '韩国' },
  'Asia/Singapore': { name: '新加坡', latitude: 1.3521, longitude: 103.8198, country: '新加坡' },
  'Asia/Bangkok': { name: '曼谷', latitude: 13.7563, longitude: 100.5018, country: '泰国' },
  'Asia/Kolkata': { name: '新德里', latitude: 28.6139, longitude: 77.209, country: '印度' },
  'Asia/Dubai': { name: '迪拜', latitude: 25.2048, longitude: 55.2708, country: '阿联酋' },
  'Europe/London': { name: '伦敦', latitude: 51.5074, longitude: -0.1278, country: '英国' },
  'Europe/Paris': { name: '巴黎', latitude: 48.8566, longitude: 2.3522, country: '法国' },
  'Europe/Berlin': { name: '柏林', latitude: 52.52, longitude: 13.405, country: '德国' },
  'Europe/Madrid': { name: '马德里', latitude: 40.4168, longitude: -3.7038, country: '西班牙' },
  'Europe/Moscow': { name: '莫斯科', latitude: 55.7558, longitude: 37.6173, country: '俄罗斯' },
  'America/New_York': { name: '纽约', latitude: 40.7128, longitude: -74.006, country: '美国' },
  'America/Chicago': { name: '芝加哥', latitude: 41.8781, longitude: -87.6298, country: '美国' },
  'America/Denver': { name: '丹佛', latitude: 39.7392, longitude: -104.9903, country: '美国' },
  'America/Phoenix': { name: '凤凰城', latitude: 33.4484, longitude: -112.074, country: '美国' },
  'America/Los_Angeles': { name: '洛杉矶', latitude: 34.0522, longitude: -118.2437, country: '美国' },
  'America/Vancouver': { name: '温哥华', latitude: 49.2827, longitude: -123.1207, country: '加拿大' },
  'America/Toronto': { name: '多伦多', latitude: 43.6532, longitude: -79.3832, country: '加拿大' },
  'America/Sao_Paulo': { name: '圣保罗', latitude: -23.5505, longitude: -46.6333, country: '巴西' },
  'Australia/Sydney': { name: '悉尼', latitude: -33.8688, longitude: 151.2093, country: '澳大利亚' },
  'Australia/Perth': { name: '珀斯', latitude: -31.9523, longitude: 115.8613, country: '澳大利亚' },
  'Pacific/Auckland': { name: '奥克兰', latitude: -36.8485, longitude: 174.7633, country: '新西兰' },
  'Africa/Cairo': { name: '开罗', latitude: 30.0444, longitude: 31.2357, country: '埃及' },
  'Africa/Johannesburg': { name: '约翰内斯堡', latitude: -26.2041, longitude: 28.0473, country: '南非' },
};

/**
 * Default weather chips: the city of the viewer's time zone, then the home cities.
 *
 * @param timezone - IANA zone of the viewer; unknown zones fall back to 上海.
 * @returns Deduplicated chip list.
 */
export function defaultWeatherCities(timezone: string): City[] {
  const home = TIMEZONE_CITIES[timezone] ?? TIMEZONE_CITIES['Asia/Shanghai'];
  const list = home === undefined ? [...HOME_CITIES] : [home, ...HOME_CITIES];
  const seen = new Set<string>();
  return list.filter((city) => {
    const key = `${city.name}|${city.latitude},${city.longitude}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Hourly-style cache key for one location. */
export function cityKey(city: City): string {
  return `${city.latitude.toFixed(3)},${city.longitude.toFixed(3)}`;
}

export function kindOf(code: number): WeatherKind {
  return WEATHER_KIND[code] ?? 'partly';
}

export function descOf(code: number): string {
  return WMO_DESC[code] ?? `代码 ${code}`;
}

export function emojiOf(code: number): string {
  return WMO_EMOJI[code] ?? '❓';
}

/** Render seconds east of UTC as `UTC+08:00`. */
export function utcOffsetLabel(offsetSeconds: number): string {
  const sign = offsetSeconds >= 0 ? '+' : '-';
  const total = Math.round(Math.abs(offsetSeconds) / 60);
  const hours = String(Math.floor(total / 60)).padStart(2, '0');
  const minutes = String(total % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}

/** Approximate seasonal noon sun height for a latitude. */
export function noonSolarElevation(latitude: number, dayOfYear: number): number {
  const lat = Math.max(-90, Math.min(90, latitude));
  const declination = 23.44 * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
  return Math.max(0, 90 - Math.abs(lat - declination));
}

/** 0 at sunrise, 1 at sunset; keeps the sun red for ~10 minutes at each end. */
export function horizonRedness(progress: number, daylightMinutes: number): number {
  if (daylightMinutes <= 0 || progress < 0 || progress > 1) return 0;
  const minutesFromHorizon = Math.min(progress, 1 - progress) * daylightMinutes;
  if (minutesFromHorizon <= RED_SUN_MINUTES * 0.7) return 1;
  return Math.max(0, Math.min(1, (RED_SUN_MINUTES - minutesFromHorizon) / (RED_SUN_MINUTES * 0.3)));
}

/** City wall-clock time as a Date whose UTC fields read as local time. */
export function cityWallClock(utcOffsetSeconds: number, at: Date = new Date()): Date {
  return new Date(at.getTime() + utcOffsetSeconds * 1000);
}

/** Parse an Open-Meteo local ISO stamp as a wall-clock Date. */
export function parseWallClock(iso: string): Date {
  return new Date(`${iso}Z`);
}

/**
 * Sun position for a moment, or null at night.
 * @param now - wall clock (see cityWallClock).
 * @param sunrise - local ISO from daily.
 * @param sunset - local ISO from daily.
 * @returns progress in 0..1 and daylight length.
 */
export function solarWindow(
  now: Date,
  sunrise: string,
  sunset: string,
): { progress: number; daylightMinutes: number } | null {
  const rise = parseWallClock(sunrise);
  const set = parseWallClock(sunset);
  const daylightMinutes = (set.getTime() - rise.getTime()) / 60_000;
  if (!Number.isFinite(daylightMinutes) || daylightMinutes <= 0) return null;
  const progress = (now.getTime() - rise.getTime()) / (set.getTime() - rise.getTime());
  if (progress < 0 || progress > 1) return null;
  return { progress, daylightMinutes };
}

/**
 * Common foreign cities in Chinese, mapped to what the geocoder actually indexes.
 *
 * Open-Meteo's geocoder matches the canonical (Latin) names; with `language=zh` it can
 * only *label* results, so 「纽约」 returned nothing at all, 「东京」 resolved to two
 * villages in China and 「伦敦」 to London, Ontario. A Chinese alias table plus an
 * English query fixes that without any extra service.
 */
export const CITY_ALIASES: Record<string, string> = {
  纽约: 'New York', 纽约市: 'New York', 洛杉矶: 'Los Angeles', 旧金山: 'San Francisco',
  圣何塞: 'San Jose', 西雅图: 'Seattle', 芝加哥: 'Chicago', 波士顿: 'Boston',
  华盛顿: 'Washington', 拉斯维加斯: 'Las Vegas', 迈阿密: 'Miami', 休斯顿: 'Houston',
  达拉斯: 'Dallas', 亚特兰大: 'Atlanta', 丹佛: 'Denver', 凤凰城: 'Phoenix',
  檀香山: 'Honolulu', 温哥华: 'Vancouver', 多伦多: 'Toronto', 蒙特利尔: 'Montreal',
  渥太华: 'Ottawa', 墨西哥城: 'Mexico City', 圣保罗: 'Sao Paulo', 里约热内卢: 'Rio de Janeiro',
  布宜诺斯艾利斯: 'Buenos Aires', 利马: 'Lima', 圣地亚哥: 'Santiago',
  伦敦: 'London', 巴黎: 'Paris', 柏林: 'Berlin', 慕尼黑: 'Munich', 法兰克福: 'Frankfurt',
  汉堡: 'Hamburg', 罗马: 'Rome', 米兰: 'Milan', 马德里: 'Madrid', 巴塞罗那: 'Barcelona',
  阿姆斯特丹: 'Amsterdam', 布鲁塞尔: 'Brussels', 苏黎世: 'Zurich', 维也纳: 'Vienna',
  日内瓦: 'Geneva', 斯德哥尔摩: 'Stockholm', 奥斯陆: 'Oslo', 哥本哈根: 'Copenhagen',
  赫尔辛基: 'Helsinki', 都柏林: 'Dublin', 里斯本: 'Lisbon', 布拉格: 'Prague',
  华沙: 'Warsaw', 布达佩斯: 'Budapest', 雅典: 'Athens', 莫斯科: 'Moscow',
  圣彼得堡: 'Saint Petersburg', 伊斯坦布尔: 'Istanbul',
  开罗: 'Cairo', 开普敦: 'Cape Town', 约翰内斯堡: 'Johannesburg', 内罗毕: 'Nairobi',
  拉各斯: 'Lagos', 迪拜: 'Dubai', 阿布扎比: 'Abu Dhabi', 多哈: 'Doha',
  利雅得: 'Riyadh', 特拉维夫: 'Tel Aviv',
  新德里: 'New Delhi', 孟买: 'Mumbai', 班加罗尔: 'Bangalore', 加尔各答: 'Kolkata',
  曼谷: 'Bangkok', 新加坡: 'Singapore', 吉隆坡: 'Kuala Lumpur', 雅加达: 'Jakarta',
  马尼拉: 'Manila', 河内: 'Hanoi', 胡志明市: 'Ho Chi Minh City',
  东京: 'Tokyo', 大阪: 'Osaka', 京都: 'Kyoto', 名古屋: 'Nagoya', 札幌: 'Sapporo',
  福冈: 'Fukuoka', 首尔: 'Seoul', 釜山: 'Busan',
  悉尼: 'Sydney', 墨尔本: 'Melbourne', 布里斯班: 'Brisbane', 珀斯: 'Perth',
  奥克兰: 'Auckland', 惠灵顿: 'Wellington',
  约克: 'York', 剑桥: 'Cambridge', 牛津: 'Oxford', 曼彻斯特: 'Manchester',
  利物浦: 'Liverpool', 爱丁堡: 'Edinburgh', 伯明翰: 'Birmingham', 格拉斯哥: 'Glasgow',
  布里斯托: 'Bristol', 利兹: 'Leeds', 谢菲尔德: 'Sheffield', 纽卡斯尔: 'Newcastle',
  卡迪夫: 'Cardiff', 贝尔法斯特: 'Belfast',
};

/** English country names -> Chinese labels, so foreign chips read naturally. */
export const COUNTRY_LABELS: Record<string, string> = {
  China: '中国', 'United States': '美国', 'United Kingdom': '英国', Japan: '日本',
  'South Korea': '韩国', 'North Korea': '朝鲜', France: '法国', Germany: '德国',
  Italy: '意大利', Spain: '西班牙', Portugal: '葡萄牙', Netherlands: '荷兰',
  Belgium: '比利时', Switzerland: '瑞士', Austria: '奥地利', Sweden: '瑞典',
  Norway: '挪威', Denmark: '丹麦', Finland: '芬兰', Ireland: '爱尔兰',
  Poland: '波兰', Czechia: '捷克', 'Czech Republic': '捷克', Hungary: '匈牙利',
  Greece: '希腊', Russia: '俄罗斯', Ukraine: '乌克兰', Turkey: '土耳其',
  'Türkiye': '土耳其', Egypt: '埃及', 'South Africa': '南非', Kenya: '肯尼亚',
  Nigeria: '尼日利亚', 'United Arab Emirates': '阿联酋', Qatar: '卡塔尔',
  'Saudi Arabia': '沙特阿拉伯', Israel: '以色列', India: '印度', Thailand: '泰国',
  Singapore: '新加坡', Malaysia: '马来西亚', Indonesia: '印度尼西亚',
  Philippines: '菲律宾', Vietnam: '越南', Australia: '澳大利亚',
  'New Zealand': '新西兰', Canada: '加拿大', Mexico: '墨西哥', Brazil: '巴西',
  Argentina: '阿根廷', Chile: '智利', Peru: '秘鲁',
  'Hong Kong': '中国香港', Taiwan: '中国台湾', Macau: '中国澳门',
};

/** One geocoder hit, reduced to what the app needs. */
export interface GeocodeResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  population?: number;
}

/** Lowercase and drop diacritics so "São Paulo" matches "Sao Paulo". */
function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Pick the city the user most likely meant.
 *
 * Exact name matches win, then the largest population: "London" must resolve to the
 * UK capital, not to London, Ontario, and "Paris" to France, not Texas.
 *
 * @param results - geocoder hits.
 * @param query - what was searched for.
 * @returns The best hit, or undefined when there are none.
 */
export function pickBestCity(results: GeocodeResult[], query: string): GeocodeResult | undefined {
  if (results.length === 0) return undefined;
  const target = normalizeName(query);
  const exact = results.filter((result) => normalizeName(result.name) === target);
  const pool = exact.length > 0 ? exact : results;
  return [...pool].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
}

/** Query the geocoder in one language. */
async function searchCities(
  query: string,
  language: 'zh' | 'en',
): Promise<GeocodeResult[]> {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.searchParams.set('name', query);
  url.searchParams.set('count', '10');
  url.searchParams.set('language', language);
  url.searchParams.set('format', 'json');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`城市查询失败 (HTTP ${response.status})`);
  const payload = (await response.json()) as {
    results?: Array<{
      name?: string;
      latitude?: number;
      longitude?: number;
      country?: string;
      population?: number;
    }>;
  };
  return (payload.results ?? []).flatMap((result) => {
    if (typeof result.latitude !== 'number' || typeof result.longitude !== 'number') return [];
    return [{
      name: result.name ?? '',
      latitude: result.latitude,
      longitude: result.longitude,
      ...(result.country === undefined ? {} : { country: result.country }),
      ...(result.population === undefined ? {} : { population: result.population }),
    }];
  });
}

/**
 * Search a city by name.
 *
 * Strategy:
 *  - a Chinese alias for a foreign city → look up the English name, label it Chinese;
 *  - otherwise Chinese input → query with `language=zh` (Chinese cities are only
 *    indexed in Chinese);
 *  - Latin input → query with `language=en` (Chinese labelling breaks the ranking and
 *    once turned "New York" into York, Nebraska).
 *
 * Every path then picks the largest exact-name match, so 伦敦 is London UK and not
 * London, Ontario.
 *
 * @param name - what the user typed.
 * @returns The resolved city with a display name and a Chinese country label.
 */
export async function geocodeCity(name: string): Promise<City> {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('请输入城市名');

  const hasCjk = /[\u4e00-\u9fff]/.test(trimmed);
  const alias = CITY_ALIASES[trimmed];
  const attempts: Array<{ query: string; language: 'zh' | 'en' }> = [];
  if (alias !== undefined) {
    attempts.push({ query: alias, language: 'en' });
    attempts.push({ query: trimmed, language: 'zh' });
  } else if (hasCjk) {
    attempts.push({ query: trimmed, language: 'zh' });
  } else {
    attempts.push({ query: trimmed, language: 'en' });
    attempts.push({ query: trimmed, language: 'zh' });
  }

  for (const attempt of attempts) {
    const results = await searchCities(attempt.query, attempt.language);
    const best = pickBestCity(results, attempt.query);
    if (best === undefined) continue;
    return {
      // Keep what the user typed when it was Chinese, so 「纽约」 stays 纽约.
      name: hasCjk ? trimmed : best.name,
      latitude: best.latitude,
      longitude: best.longitude,
      ...(best.country === undefined
        ? {}
        : { country: COUNTRY_LABELS[best.country] ?? best.country }),
    };
  }
  throw new Error(`没有找到「${trimmed}」，可以试试英文名或更完整的写法`);
}

/** Fetch current conditions plus a 7-day forecast. */
export async function fetchWeather(city: City): Promise<WeatherBundle> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(city.latitude));
  url.searchParams.set('longitude', String(city.longitude));
  url.searchParams.set(
    'current',
    'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,' +
      'wind_speed_10m,wind_direction_10m,precipitation,pressure_msl,cloud_cover',
  );
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,' +
      'precipitation_probability_max,wind_speed_10m_max,sunrise,sunset,uv_index_max',
  );
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '7');

  const response = await fetch(url);
  if (!response.ok) throw new Error(`天气请求失败 (HTTP ${response.status})`);
  const payload = (await response.json()) as {
    utc_offset_seconds?: number;
    timezone_abbreviation?: string;
    current?: Record<string, unknown>;
    daily?: Record<string, unknown[]>;
  };

  const current = payload.current ?? {};
  const daily = payload.daily ?? {};
  const dates = (daily.time as string[] | undefined) ?? [];

  return {
    city,
    fetchedAt: new Date().toISOString(),
    utcOffsetSeconds: Number(payload.utc_offset_seconds ?? 0),
    timezoneAbbr: payload.timezone_abbreviation ?? '',
    current: {
      time: String(current.time ?? ''),
      temperature: Number(current.temperature_2m ?? 0),
      apparent: Number(current.apparent_temperature ?? 0),
      humidity: Number(current.relative_humidity_2m ?? 0),
      isDay: Number(current.is_day ?? 1) === 1,
      code: Number(current.weather_code ?? 0),
      windSpeed: Number(current.wind_speed_10m ?? 0),
      windDirection: Number(current.wind_direction_10m ?? 0),
      precipitation: Number(current.precipitation ?? 0),
      pressure: Number(current.pressure_msl ?? 0),
      cloudCover: Number(current.cloud_cover ?? 0),
    },
    daily: dates.map((date, index) => ({
      date,
      code: Number((daily.weather_code as number[])[index] ?? 0),
      max: Number((daily.temperature_2m_max as number[])[index] ?? 0),
      min: Number((daily.temperature_2m_min as number[])[index] ?? 0),
      precipitationSum: Number((daily.precipitation_sum as number[])[index] ?? 0),
      precipitationProbability: Number((daily.precipitation_probability_max as number[])[index] ?? 0),
      windMax: Number((daily.wind_speed_10m_max as number[])[index] ?? 0),
      sunrise: String((daily.sunrise as string[])[index] ?? ''),
      sunset: String((daily.sunset as string[])[index] ?? ''),
      uvMax: Number((daily.uv_index_max as number[])[index] ?? 0),
    })),
  };
}