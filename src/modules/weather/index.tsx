/**
 * 天气 module — UI ported from the cyweather desktop app.
 *
 * The hero scene is the part worth keeping: the sky gradient comes from the
 * weather kind and day/night, the sun rides an arc from sunrise to sunset and
 * grows red for about ten minutes at either end, its midday height follows the
 * city's latitude and the season, and rain/snow are animated particles.
 *
 * Data comes from Open-Meteo (no API key). The last forecast is cached in SQLite
 * so the hero renders immediately and still reads sensibly offline.
 */

import * as React from 'react';
import { useStore } from '../../core/store.js';
import { moonGeometry, moonPhaseAt, type MoonPhase } from '../../core/weather/moon.js';
import {
  horizonProximity,
  isSunUp,
  moonPosition,
  skyFractionFromAltitude,
  skyFractionFromAzimuth,
  sunPosition,
} from '../../core/weather/celestial.js';
import {
  CLOUD_SPRITES,
  RAIN_DROPS,
  SKY_STYLE,
  SNOW_FLAKES,
  STARS,
  THEMES,
  cityWallClock,
  cityKey,
  descOf,
  emojiOf,
  kindOf,
  utcOffsetLabel,
  type WeatherBundle,
} from '../../core/weather/openMeteo.js';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** Ticking clock for the city time readout. */
function useTickingClock(intervalMs = 1000): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Blend two hex colours. */
function mix(from: string, to: string, t: number): string {
  const parse = (hex: string): [number, number, number] => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(from);
  const [r2, g2, b2] = parse(to);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r} ${g} ${b})`;
}

interface SkyLayout {
  kind: ReturnType<typeof kindOf>;
  skyTop: string;
  skyBottom: string;
  isDay: boolean;
  /** Sun/moon horizontal position, percent. */
  left: number;
  /** Vertical position from the bottom, percent. */
  discBottom: number;
  /** Disc size in px. */
  size: number;
  color: string;
  glow: number;
  clock: string;
  date: string;
  moonPhase: MoonPhase;
  moonPath: string;
  /** False when the moon is below the horizon — then it must not be drawn. */
  moonVisible: boolean;
  moonAltitude: number;
  /** Cloud sprites to draw (0 = cloudless). */
  cloudSprites: number;
  cloudTone: string;
  /** Opacity of one cloud sprite. */
  cloudOpacity: number;
  /** Flat wash over the whole panel (overcast, fog). */
  veil: number;
  /** Colour of that wash: dark states darken the panel, light ones lighten it. */
  veilTone: string;
  /** 0 hides the sun/moon behind the deck, 1 shows it fully. */
  bodyVisibility: number;
  /** Star visibility at night, 0..1. */
  starOpacity: number;
  /** Precipitation strength, 0..1.5. */
  rainIntensity: number;
  snowIntensity: number;
  /**
   * Strength of the text scrim behind the readout.
   *
   * It exists for legibility but washes the sky out — which is what made a clear
   * day look hazy. Clear skies therefore keep it low; only overcast leans on it.
   */
  scrimAlpha: number;
}

/** Work out the whole scene from one forecast snapshot. */
function layout(bundle: WeatherBundle, now: Date): SkyLayout {
  const kind = kindOf(bundle.current.code);
  const theme = THEMES[kind];
  const wall = cityWallClock(bundle.utcOffsetSeconds, now);
  const wallDate = wall.toISOString().slice(0, 10);
  const latitude = bundle.city.latitude;
  const longitude = bundle.city.longitude;

  // Real horizontal coordinates, not the old sunset->sunrise arc. That arc always
  // drew the moon somewhere during the night, even at 05:00 when it had already
  // set — which is exactly the bug that made the panel look wrong.
  const sun = sunPosition(now, latitude, longitude);
  const moon = moonPosition(now, latitude, longitude);
  const isDay = isSunUp(sun);
  const redness = horizonProximity(sun.altitude);

  const discSize = isDay ? 52 + redness * 18 : 38;
  const phase = moonPhaseAt(now);
  // Southern viewers see the lit limb mirrored.
  const geometry = moonGeometry(discSize / 2, phase.phase, latitude < 0);

  // Only draw the moon while it is genuinely above the horizon. In daylight the
  // sun takes the sky; at night with the moon set, the sky simply has no disc.
  const moonVisible = !isDay && moon.altitude > 0;
  const body = isDay ? sun : moon;

  // The real cloud cover, when the payload carries it; otherwise the kind preset.
  // This is what makes 晴朗 / 多云 / 阴天 visibly different: the number of cloud
  // sprites follows the actual sky instead of one coarse bucket per WMO code.
  const style = SKY_STYLE[kind];
  const reported = bundle.current.cloudCover;
  const coverage = reported > 0 ? Math.min(1, reported / 100) : style.coverage;
  const cloudSprites = Math.min(CLOUD_SPRITES, Math.round(coverage * CLOUD_SPRITES));

  // A solid deck hides the sun/moon; scattered cloud only softens it.
  const bodyVisibility = coverage > 0.88 ? 0 : Math.max(0, 1 - coverage * 0.55);
  const veil = Math.max(style.veil, coverage > 0.9 ? 0.3 : 0);
  const starOpacity = isDay || coverage > 0.7 ? 0 : (1 - coverage / 0.7) * (kind === 'fog' ? 0.35 : 1);
  const precipitationFactor = 0.75 + Math.min(bundle.current.precipitation, 4) / 4 * 0.5;
  const rainIntensity = style.rain === 0 ? 0 : Math.min(1.5, style.rain * precipitationFactor);
  const snowIntensity = style.snow;

  // Legibility scrim: day text is dark, so a light wash helps it — but on a clear
  // sky that wash reads as smog. Scale it with cloud cover instead of using one
  // fixed strength for every kind.
  const scrimAlpha = isDay ? 0.3 + coverage * 0.2 : 0.52 + coverage * 0.12;

  return {
    kind,
    skyTop: isDay ? theme.dayTop : theme.nightTop,
    skyBottom: isDay ? theme.dayBottom : theme.nightBottom,
    isDay,
    left: 8 + 84 * skyFractionFromAzimuth(body.azimuth, latitude),
    discBottom: 14 + 74 * skyFractionFromAltitude(body.altitude),
    size: discSize,
    color: isDay ? mix('#FFE9A8', '#FF5A3C', redness) : '#E8EEF5',
    glow: isDay ? 30 + redness * 40 : 18,
    clock: wall.toISOString().slice(11, 19),
    date: wallDate,
    moonPhase: phase,
    moonPath: geometry.path,
    moonVisible,
    moonAltitude: moon.altitude,
    cloudSprites,
    cloudTone: isDay ? style.cloudToneDay : style.cloudToneNight,
    cloudOpacity: 0.45 + coverage * 0.5,
    veil,
    veilTone: isDay ? style.veilToneDay : style.veilToneNight,
    bodyVisibility,
    starOpacity,
    rainIntensity,
    snowIntensity,
    scrimAlpha,
  };
}
export function WeatherCard(): React.ReactElement {
  const { weather, weatherCity, weatherStatus } = useStore();
  if (weather === null) {
    return (
      <p className="card__empty">
        {weatherStatus === 'loading' ? '正在获取天气…' : '暂无天气数据'}
      </p>
    );
  }
  return (
    <div>
      <div className="mini-big">
        {Math.round(weather.current.temperature)}° {emojiOf(weather.current.code)}
      </div>
      <div className="mini-list__meta">
        {weatherCity?.name ?? weather.city.name} · {descOf(weather.current.code)}
      </div>
    </div>
  );
}

/** One drifting cloud shape; only its size and position vary per instance. */
function CloudSprite(): React.ReactElement {
  return (
    <svg viewBox="0 0 120 56" aria-hidden="true">
      <path
        d="M20 47C10 47 3 41 3 33c0-7 6-13 13-13 2-10 11-17 21-17 9 0 17 6 20 14 2-1 4-2 7-2 9 0 16 7 16 16 0 9-7 16-16 16H20z"
        fill="currentColor"
      />
    </svg>
  );
}

function Sky({ bundle, now }: { bundle: WeatherBundle; now: Date }): React.ReactElement {
  const scene = layout(bundle, now);
  const cityKey = bundle.city.name;

  // A fixed pool of sprites; only `scene.cloudSprites` are shown. Positions are
  // memoised per city because re-randomising on every tick would make the sky
  // flicker once a second.
  const clouds = React.useMemo(
    () =>
      Array.from({ length: CLOUD_SPRITES }, (_unused, index) => ({
        left: (index / CLOUD_SPRITES) * 100 - 10 + Math.random() * 8,
        top: 3 + Math.random() * 47,
        width: 110 + Math.random() * 130,
        opacity: 0.5 + Math.random() * 0.5,
        duration: 90 + Math.random() * 90,
        delay: -Math.random() * 90,
      })),
    [cityKey],
  );

  const drops = React.useMemo(
    () =>
      Array.from({ length: RAIN_DROPS }, () => ({
        left: Math.random() * 100,
        delay: Math.random() * 1.6,
        duration: 0.55 + Math.random() * 0.55,
        opacity: 0.25 + Math.random() * 0.5,
      })),
    [cityKey],
  );
  const flakes = React.useMemo(
    () =>
      Array.from({ length: SNOW_FLAKES }, () => ({
        left: Math.random() * 100,
        delay: Math.random() * 3,
        duration: 3.5 + Math.random() * 3.5,
        drift: -20 + Math.random() * 40,
        size: 2 + Math.random() * 3.5,
      })),
    [cityKey],
  );
  const stars = React.useMemo(
    () =>
      Array.from({ length: STARS }, () => ({
        left: Math.random() * 100,
        top: Math.random() * 62,
        delay: Math.random() * 3,
        size: 1 + Math.random() * 1.8,
      })),
    [cityKey],
  );

  const current = bundle.current;
  const today = bundle.daily[0];
  const rainCount = Math.round(RAIN_DROPS * Math.min(1.4, scene.rainIntensity));
  const snowCount = Math.round(SNOW_FLAKES * scene.snowIntensity);
  const drizzle = scene.rainIntensity > 0 && scene.rainIntensity < 0.6;
  // Cloudy bodies are hazy rather than crisp.
  const bodyBlur = scene.bodyVisibility > 0 ? (1 - scene.bodyVisibility) * 2.4 : 0;
  // Overcast and precipitation states read as a continuous deck, not puffs.
  const deck = ['overcast', 'drizzle', 'rain', 'snow', 'thunder'].includes(scene.kind);

  return (
    <div
      className={`sky ${scene.isDay ? 'sky--day' : 'sky--night'} sky--${scene.kind}`}
      style={{
        background: `linear-gradient(180deg, ${scene.skyTop} 0%, ${scene.skyBottom} 100%)`,
        // A clear sky must not look hazy: the text scrim is what washes the panel
        // out, so its strength follows the weather.
        ['--sky-scrim-alpha' as string]: String(scene.scrimAlpha),
      }}
    >
      {!scene.isDay && scene.starOpacity > 0 && (
        <div className="sky__stars" aria-hidden="true" style={{ opacity: scene.starOpacity }}>
          {stars.map((star, index) => (
            <span
              key={index}
              style={{
                left: `${star.left}%`,
                top: `${star.top}%`,
                width: star.size,
                height: star.size,
                animationDelay: `${star.delay}s`,
              }}
            />
          ))}
        </div>
      )}

      {scene.isDay ? (
        <div
          className="sky__sun"
          aria-hidden="true"
          style={{
            left: `${scene.left}%`,
            bottom: `${scene.discBottom}%`,
            width: scene.size,
            height: scene.size,
            background: scene.color,
            boxShadow: `0 0 ${scene.glow}px ${scene.color}`,
            opacity: scene.bodyVisibility,
            filter: bodyBlur > 0 ? `blur(${bodyBlur}px)` : undefined,
          }}
        />
      ) : scene.moonVisible && scene.bodyVisibility > 0 ? (
        <div
          className="sky__moon"
          aria-hidden="true"
          style={{
            left: `${scene.left}%`,
            bottom: `${scene.discBottom}%`,
            width: scene.size,
            height: scene.size,
            opacity: scene.bodyVisibility,
            filter: bodyBlur > 0 ? `blur(${bodyBlur}px)` : undefined,
          }}
        >
          <svg
            viewBox={`${-scene.size / 2} ${-scene.size / 2} ${scene.size} ${scene.size}`}
            width="100%"
            height="100%"
          >
            <circle cx={0} cy={0} r={scene.size / 2 - 1} className="sky__moon-dark" />
            <path d={scene.moonPath} className="sky__moon-lit" />
          </svg>
        </div>
      ) : null}

      {scene.cloudSprites > 0 && (
        <div className="sky__clouds" aria-hidden="true" style={{ color: scene.cloudTone }}>
          {clouds.slice(0, scene.cloudSprites).map((cloud, index) => (
            <span
              key={index}
              className={`sky__cloud${scene.kind === 'overcast' ? ' sky__cloud--deck' : ''}`}
              style={{
                left: `${cloud.left}%`,
                top: `${cloud.top}%`,
                width: deck ? cloud.width * 2 : cloud.width,
                opacity: cloud.opacity * scene.cloudOpacity,
                animationDuration: `${cloud.duration}s`,
                animationDelay: `${cloud.delay}s`,
              }}
            >
              <CloudSprite />
            </span>
          ))}
        </div>
      )}

      {scene.veil > 0 && (
        <div
          className={`sky__veil${scene.kind === 'fog' ? ' sky__veil--fog' : ''}`}
          aria-hidden="true"
          style={{ opacity: scene.veil, background: scene.veilTone }}
        />
      )}

      {rainCount > 0 && (
        <div className={`sky__rain${drizzle ? ' sky__rain--light' : ''}`} aria-hidden="true">
          {drops.slice(0, rainCount).map((drop, index) => (
            <span
              key={index}
              style={{
                left: `${drop.left}%`,
                animationDelay: `${drop.delay}s`,
                animationDuration: `${drizzle ? drop.duration * 1.6 : drop.duration}s`,
                opacity: drizzle ? drop.opacity * 0.6 : drop.opacity,
              }}
            />
          ))}
        </div>
      )}

      {snowCount > 0 && (
        <div className="sky__snow" aria-hidden="true">
          {flakes.slice(0, snowCount).map((flake, index) => (
            <span
              key={index}
              style={{
                left: `${flake.left}%`,
                animationDelay: `${flake.delay}s`,
                animationDuration: `${flake.duration}s`,
                width: flake.size,
                height: flake.size,
                ['--drift' as string]: `${flake.drift}px`,
              }}
            />
          ))}
        </div>
      )}

      {scene.kind === 'thunder' && <div className="sky__flash" aria-hidden="true" />}

      <div className="sky__content">
        <div className="sky__city">
          {bundle.city.name}
          {bundle.city.country !== undefined && <span className="sky__country">{bundle.city.country}</span>}
        </div>
        <div className="sky__temp">{Math.round(current.temperature)}°</div>
        <div className="sky__desc">{emojiOf(current.code)} {descOf(current.code)}</div>
        <div className="sky__range">
          {today !== undefined && `最高 ${Math.round(today.max)}° · 最低 ${Math.round(today.min)}°`}
          {` · 体感 ${Math.round(current.apparent)}°`}
          {current.cloudCover > 0 && ` · 云量 ${Math.round(current.cloudCover)}%`}
        </div>
        {!scene.isDay && (
          <div className="sky__moonphase">
            🌙 {scene.moonPhase.name} {Math.round(scene.moonPhase.illumination * 100)}%
            {!scene.moonVisible && ` · 月亮未升起（地平线下 ${Math.abs(Math.round(scene.moonAltitude))}°）`}
          </div>
        )}
        <div className="sky__clock">
          {scene.clock} <span className="sky__offset">{utcOffsetLabel(bundle.utcOffsetSeconds)}</span>
        </div>
      </div>
    </div>
  );
}

export function WeatherPage(): React.ReactElement {
  const {
    weather, weatherCity, weatherCities, pinnedWeatherCities, weatherStatus, weatherError,
    refreshWeather, selectWeatherCity, addWeatherCity, togglePinnedWeatherCity,
  } = useStore();
  const now = useTickingClock(1000);
  const moon = moonPhaseAt(now);
  const [query, setQuery] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);

  async function search(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const name = query.trim();
    if (name === '') return;
    setBusy(true);
    setSearchError(null);
    try {
      await addWeatherCity(name);
      setQuery('');
    } catch (e) {
      setSearchError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const updated = weather === null
    ? null
    : new Date(weather.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="wx">
      <div className="wx-bar">
        <div className="wx-bar__cities">
          {weatherCities.map((city) => {
            const key = cityKey(city);
            const pinned = pinnedWeatherCities.some((item) => cityKey(item) === key);
            const isHome = weatherCities[0] !== undefined && cityKey(weatherCities[0]) === key;
            return (
              <div key={key} className={`wx-city${pinned ? ' is-pinned' : ''}`}>
                {/*
                  图钉在按钮左上角：点它把城市钉住（下次启动还在），
                  点城市名仍然只是切换当前显示的天气。
                */}
                {!isHome && (
                  <button
                    type="button"
                    className="wx-city__pin"
                    title={pinned ? '取消钉住（下次启动不再出现）' : '钉住（下次启动仍然显示）'}
                    aria-label={pinned ? `取消钉住 ${city.name}` : `钉住 ${city.name}`}
                    aria-pressed={pinned}
                    onClick={() => void togglePinnedWeatherCity(city)}
                  >
                    📌
                  </button>
                )}
                <button
                  type="button"
                  className={weatherCity !== null && city.name === weatherCity.name ? 'is-active' : ''}
                  title={city.country !== undefined ? `${city.name} · ${city.country}` : city.name}
                  onClick={() => void selectWeatherCity(city)}
                >
                  {city.name}
                  {city.country !== undefined && city.country !== '中国' && (
                    <span className="wx-bar__country">{city.country}</span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <form className="wx-bar__search" onSubmit={(e) => void search(e)}>
          <input
            type="search"
            placeholder="搜索城市…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索城市"
          />
          <button type="submit" disabled={busy}>{busy ? '…' : '搜索'}</button>
        </form>
        <button type="button" className="wx-bar__refresh" onClick={() => void refreshWeather()}>
          刷新
        </button>
        <span className="wx-bar__status">
          {weatherStatus === 'loading' && '更新中…'}
          {weatherStatus === 'ok' && updated !== null && `更新于 ${updated}`}
          {weatherStatus === 'stale' && updated !== null && `缓存 · ${updated}`}
          {weatherStatus === 'error' && '离线 · 无缓存'}
        </span>
      </div>

      {(searchError !== null || weatherError !== null) && (
        <div className="banner banner--bad">{searchError ?? weatherError}</div>
      )}

      {weather === null ? (
        <div className="banner">暂无天气数据{weatherStatus === 'loading' ? '，正在获取…' : '。'}</div>
      ) : (
        <>
          <Sky bundle={weather} now={now} />

          <div className="wx-facts">
            <div><span>体感</span><strong>{Math.round(weather.current.apparent)}°</strong></div>
            <div><span>湿度</span><strong>{Math.round(weather.current.humidity)}%</strong></div>
            <div><span>风</span><strong>{Math.round(weather.current.windSpeed)} km/h</strong></div>
            <div><span>气压</span><strong>{Math.round(weather.current.pressure)} hPa</strong></div>
            <div><span>降水</span><strong>{weather.current.precipitation} mm</strong></div>
            <div><span>紫外线</span><strong>{weather.daily[0]?.uvMax ?? 0}</strong></div>
            <div>
              <span>月相</span>
              <strong>{moon.name} {Math.round(moon.illumination * 100)}%</strong>
            </div>
            <div><span>日出</span><strong>{weather.daily[0]?.sunrise.slice(11, 16) ?? '—'}</strong></div>
            <div><span>日落</span><strong>{weather.daily[0]?.sunset.slice(11, 16) ?? '—'}</strong></div>
          </div>

          <ul className="wx-days">
            {weather.daily.map((day) => (
              <li key={day.date}>
                <span className="wx-days__day">
                  {WEEKDAYS[new Date(`${day.date}T00:00:00Z`).getUTCDay()]}
                  <em>{day.date.slice(5)}</em>
                </span>
                <span className="wx-days__icon" title={descOf(day.code)}>{emojiOf(day.code)}</span>
                <span className="wx-days__desc">{descOf(day.code)}</span>
                <span className="wx-days__pop">{day.precipitationProbability}%</span>
                <span className="wx-days__temp">
                  {Math.round(day.max)}° <em>{Math.round(day.min)}°</em>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}