/**
 * Application data store.
 *
 * One context holds everything the dashboard and modules read, so a card never
 * fetches on its own and every view sees the same snapshot. All writes go through
 * here and then refresh, which keeps the dashboard honest without a subscription
 * layer.
 *
 * The weather slice lives here too, so the dashboard card and the weather page
 * share one fetch instead of racing each other.
 */

import * as React from 'react';
import { db } from './db/client.js';
import type { DbInfo } from './db/protocol.js';
import { PersonRepository } from './person/repository.js';
import { FamilyRepository } from './family/repository.js';
import type { Countdown, Person, PersonInput } from './person/types.js';
import { NoteRepository } from './note/repository.js';
import { FocusRepository } from './focus/repository.js';
import type { FocusSession } from './focus/repository.js';
import { localDayKey } from './focus/util.js';
import type { Note } from './note/types.js';
import { hub } from './calendar/instance.js';
import { newId } from './util/id.js';
import { FALLBACK_BIRTH_TIMEZONE, KEY_BIRTH_TIMEZONE, getSetting, setSetting } from './setting/repository.js';
import { readCachedWeather, writeCachedWeather } from './weather/cache.js';
import { listPinnedCities, savePinnedCities } from './weather/pinned.js';
import {
  defaultWeatherCities,
  cityKey,
  fetchWeather,
  geocodeCity,
  type City,
  type WeatherBundle,
} from './weather/openMeteo.js';

const repository = new PersonRepository(hub);

const KEY_WEATHER_SELECTED = 'weather.selected';
/** Match cyweather: refresh the selected city every 15 minutes. */
const WEATHER_REFRESH_MS = 15 * 60 * 1000;

export type WeatherStatus = 'idle' | 'loading' | 'ok' | 'stale' | 'error';

interface AppStore {
  ready: boolean;
  error: string | null;
  dbInfo: DbInfo | null;
  /** Birth timezone the form should preselect; the last one the user saved. */
  birthTimezone: string;
  setBirthTimezone: (timezone: string) => Promise<void>;
  persons: Person[];
  /**
   * Ids taking part in at least one family relation.
   *
   * The birthday module uses this to refuse deleting somebody who is already in the
   * family tree: that would silently tear them out of it, relations included.
   */
  familyLinked: Set<string>;
  countdowns: Countdown[];
  notes: Note[];
  /** The running timer, or null. Derived from start_time, so it survives reloads. */
  focusSession: FocusSession | null;
  focusTodaySeconds: number;
  focusGoal: number;
  setFocusGoal: (count: number) => Promise<void>;
  focusSoundOn: boolean;
  setFocusSoundOn: (enabled: boolean) => Promise<void>;
  refreshFocus: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Retry opening the database (e.g. after closing another tab). */
  retry: () => Promise<void>;
  addPerson: (input: PersonInput) => Promise<Person>;
  updatePerson: (id: string, input: PersonInput) => Promise<Person>;
  removePerson: (id: string) => Promise<void>;
  /** Mark 本人 (null clears). The family tree centres itself on this person. */
  markSelf: (id: string | null) => Promise<void>;
  /**
   * Attach a person to 本人 using a plain-language relation.
   *
   * A birthday record only carries a label ("爸爸"), which is not a relation; this
   * turns that label into a real family link so the tree actually forms a chain.
   * Resolves false when there is no 本人 yet (nothing to attach to).
   */
  linkRelative: (personId: string, role: 'father' | 'mother' | 'spouse' | 'child') => Promise<boolean>;
  addCountdown: (title: string, targetDate: string) => Promise<void>;
  removeCountdown: (id: string) => Promise<void>;

  weatherCities: City[];
  /** Cities the user pinned with the 📌; they survive a reload. */
  pinnedWeatherCities: City[];
  togglePinnedWeatherCity: (city: City) => Promise<void>;
  weatherCity: City | null;
  weather: WeatherBundle | null;
  weatherStatus: WeatherStatus;
  weatherError: string | null;
  refreshWeather: () => Promise<void>;
  selectWeatherCity: (city: City) => Promise<void>;
  addWeatherCity: (name: string) => Promise<void>;
}

const Context = React.createContext<AppStore | null>(null);

export function useStore(): AppStore {
  const value = React.useContext(Context);
  if (value === null) throw new Error('useStore must be used inside AppStoreProvider');
  return value;
}


export function AppStoreProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [dbInfo, setDbInfo] = React.useState<DbInfo | null>(null);
  const [persons, setPersons] = React.useState<Person[]>([]);
  const [familyLinked, setFamilyLinked] = React.useState<Set<string>>(new Set());
  const [countdowns, setCountdowns] = React.useState<Countdown[]>([]);
  const [notes, setNotes] = React.useState<Note[]>([]);
  const [focusSession, setFocusSession] = React.useState<FocusSession | null>(null);
  const [focusTodaySeconds, setFocusTodaySeconds] = React.useState(0);
  const [focusGoal, setFocusGoalState] = React.useState(8);
  const [focusSoundOn, setFocusSoundOnState] = React.useState(true);
  const [birthTimezone, setBirthTimezoneState] = React.useState(FALLBACK_BIRTH_TIMEZONE);

  // Seeded from the browser zone; loadAll re-seeds it from the saved setting.
  const [weatherCities, setWeatherCities] = React.useState<City[]>(() =>
    defaultWeatherCities(Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
  const [pinnedWeatherCities, setPinnedWeatherCities] = React.useState<City[]>([]);
  const [weatherCity, setWeatherCityState] = React.useState<City | null>(null);
  const [weather, setWeather] = React.useState<WeatherBundle | null>(null);
  const [weatherStatus, setWeatherStatus] = React.useState<WeatherStatus>('idle');
  const [weatherError, setWeatherError] = React.useState<string | null>(null);
  /** Guards against an older request overwriting a newer city selection. */
  const weatherToken = React.useRef(0);
  const weatherCityRef = React.useRef<City | null>(null);

  /** Load the running timer plus today's total so cards stay in sync. */
  const refreshFocus = React.useCallback(async () => {
    const [running, today] = await Promise.all([
      FocusRepository.active(),
      FocusRepository.totalSecondsOn(localDayKey()),
    ]);
    setFocusSession(running);
    setFocusTodaySeconds(today);
  }, []);

  const refresh = React.useCallback(async () => {
    const [nextPersons, nextCountdowns, nextNotes, linkedIds] = await Promise.all([
      repository.list(),
      db.all<Countdown>('SELECT * FROM countdown WHERE deleted_at IS NULL ORDER BY target_date'),
      NoteRepository.list(),
      repository.linkedPersonIds(),
    ]);
    setPersons(nextPersons);
    setCountdowns(nextCountdowns);
    setNotes(nextNotes);
    setFamilyLinked(new Set(linkedIds));
  }, []);

  /** Load (cached first, then live) the forecast for one city. */
  const loadWeather = React.useCallback(async (city: City) => {
    const token = ++weatherToken.current;
    setWeatherStatus('loading');
    setWeatherError(null);

    const cached = await readCachedWeather(city).catch(() => null);
    if (token !== weatherToken.current) return;
    if (cached !== null) {
      setWeather(cached);
      setWeatherStatus('stale');
    }

    try {
      const fresh = await fetchWeather(city);
      if (token !== weatherToken.current) return;
      setWeather(fresh);
      setWeatherStatus('ok');
      await writeCachedWeather(city, fresh).catch(() => undefined);
    } catch (e) {
      if (token !== weatherToken.current) return;
      setWeatherError((e as Error).message);
      setWeatherStatus(cached !== null ? 'stale' : 'error');
    }
  }, []);

  /**
   * 城市行 = 本机时区城市（唯一一个默认）+ 用户钉住的城市。
   *
   * @param timezone - IANA time zone of this machine.
   * @param pinned - the cities the user pinned.
   * @returns The row, with the time-zone city first.
   */
  const buildCityRow = React.useCallback((timezone: string, pinned: City[]): City[] => {
    const home = defaultWeatherCities(timezone)[0];
    const row: City[] = home === undefined ? [] : [home];
    for (const city of pinned) {
      if (row.some((item) => cityKey(item) === cityKey(city))) continue;
      row.push(city);
    }
    return row;
  }, []);

  const selectWeatherCity = React.useCallback(
    async (city: City) => {
      setWeatherCityState(city);
      weatherCityRef.current = city;
      await setSetting(KEY_WEATHER_SELECTED, cityKey(city)).catch(() => undefined);
      await loadWeather(city);
    },
    [loadWeather],
  );

  /** Load preferences and the first snapshot after the database is reachable. */
  const loadAll = React.useCallback(
    async (info: DbInfo) => {
      setDbInfo(info);
      const savedFocusGoal = await getSetting('focus.goal');
      if (savedFocusGoal !== null && savedFocusGoal !== '') setFocusGoalState(Number(savedFocusGoal));
      const savedFocusSound = await getSetting('focus.sound');
      if (savedFocusSound !== null && savedFocusSound !== '') setFocusSoundOnState(savedFocusSound !== '0');
      await refreshFocus();
      const savedTimezone = await getSetting(KEY_BIRTH_TIMEZONE);
      if (savedTimezone !== null && savedTimezone !== '') setBirthTimezoneState(savedTimezone);
      await refresh();

      // 默认只有一个：本机时区所在的城市。钉住的城市从设置里读回来，跟它一起显示。
      const pinned = await listPinnedCities();
      setPinnedWeatherCities(pinned);
      const cities = buildCityRow(
        savedTimezone !== null && savedTimezone !== ''
          ? savedTimezone
          : Intl.DateTimeFormat().resolvedOptions().timeZone,
        pinned,
      );
      setWeatherCities(cities);
      const savedSelected = await getSetting(KEY_WEATHER_SELECTED);
      const selected = cities.find((c) => cityKey(c) === savedSelected) ?? cities[0];
      if (selected !== undefined) {
        setWeatherCityState(selected);
        weatherCityRef.current = selected;
        // Deliberately not awaited: the app is usable before the network answers.
        void loadWeather(selected);
      }

      setReady(true);
      setError(null);
    },
    [refresh, loadWeather, buildCityRow],
  );

  React.useEffect(() => {
    void (async () => {
      try {
        await loadAll(await db.open());
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [loadAll]);

  // Refresh the selected city periodically, like cyweather's 15-minute timer.
  React.useEffect(() => {
    const timer = setInterval(() => {
      const city = weatherCityRef.current;
      if (city !== null) void loadWeather(city);
    }, WEATHER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadWeather]);

  /**
   * Another tab may hold the database (OPFS access handles are exclusive). When
   * it goes away the client is granted the ownership lock and fires this, so the
   * error state clears by itself instead of asking the user to reload.
   */
  React.useEffect(() => {
    return db.onTakeover(() => {
      void (async () => {
        try {
          await loadAll(await db.open());
        } catch (e) {
          setError((e as Error).message);
        }
      })();
    });
  }, [loadAll]);

  const store = React.useMemo<AppStore>(
    () => ({
      ready,
      error,
      dbInfo,
      persons,
      familyLinked,
      countdowns,
      notes,
      focusSession,
      focusTodaySeconds,
      focusGoal,
      focusSoundOn,
      async setFocusGoal(count: number) {
        const safe = Math.max(1, Math.min(20, Math.round(count)));
        setFocusGoalState(safe);
        await setSetting('focus.goal', String(safe)).catch(() => undefined);
      },
      async setFocusSoundOn(enabled: boolean) {
        setFocusSoundOnState(enabled);
        await setSetting('focus.sound', enabled ? '1' : '0').catch(() => undefined);
      },
      refreshFocus,
      refresh,
      async retry() {
        setError(null);
        setReady(false);
        try {
          await loadAll(await db.retry());
        } catch (e) {
          setError((e as Error).message);
        }
      },
      birthTimezone,
      async setBirthTimezone(timezone) {
        await setSetting(KEY_BIRTH_TIMEZONE, timezone);
        setBirthTimezoneState(timezone);
      },
      async addPerson(input) {
        const person = await repository.create(input);
        await refresh();
        return person;
      },
      async updatePerson(id, input) {
        const person = await repository.update(id, input);
        await refresh();
        return person;
      },
      async removePerson(id) {
        await repository.remove(id);
        await refresh();
      },
      async markSelf(id) {
        await repository.markSelf(id);
        // 本人 is the seed the generation derivation walks from, so re-derive now
        // rather than waiting for the family page to be opened.
        await new FamilyRepository(repository).syncGenerations().catch(() => 0);
        await refresh();
      },
      async linkRelative(personId, role) {
        const self = persons.find((person) => person.is_self === 1);
        if (self === undefined || self.id === personId) return false;
        const family = new FamilyRepository(repository);
        if (role === 'father' || role === 'mother') await family.linkParent(self.id, personId, role);
        else if (role === 'spouse') await family.linkSpouse(self.id, personId);
        else await family.linkExistingChild(self.id, personId);
        // A new relation changes everyone's 世次; settle it immediately.
        await family.syncGenerations().catch(() => 0);
        await refresh();
        return true;
      },
      async addCountdown(title, targetDate) {
        const now = new Date().toISOString();
        await db.run(
          'INSERT INTO countdown (id, title, target_date, timezone, all_day, pinned, created_at, updated_at) VALUES (?,?,?,?,1,0,?,?)',
          [newId(), title, targetDate, 'Asia/Shanghai', now, now],
        );
        await refresh();
      },
      async removeCountdown(id) {
        const now = new Date().toISOString();
        await db.run('UPDATE countdown SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
        await refresh();
      },

      weatherCities,
      pinnedWeatherCities,
      weatherCity,
      weather,
      weatherStatus,
      weatherError,
      async refreshWeather() {
        const city = weatherCityRef.current;
        if (city !== null) await loadWeather(city);
      },
      selectWeatherCity,
      async togglePinnedWeatherCity(city) {
        const key = cityKey(city);
        const exists = pinnedWeatherCities.some((item) => cityKey(item) === key);
        const next = exists
          ? pinnedWeatherCities.filter((item) => cityKey(item) !== key)
          : [...pinnedWeatherCities, city];
        setPinnedWeatherCities(next);
        await savePinnedCities(next).catch(() => undefined);
        // 钉住的城市进城市行；取消钉住就从行里拿掉（时区城市除外，它总是第一个）。
        setWeatherCities((cities) => {
          const home = cities[0];
          const others = cities.slice(1).filter((item) => cityKey(item) !== key);
          if (!exists) others.push(city);
          return home === undefined ? others : [home, ...others];
        });
      },
      async addWeatherCity(name) {
        const city = await geocodeCity(name);
        const exists = weatherCities.some((c) => cityKey(c) === cityKey(city));
        // 搜索到的城市先临时显示；用图钉钉住才会留到下次启动。
        if (!exists) setWeatherCities([...weatherCities, city]);
        await selectWeatherCity(city);
      },
    }),
    [
      ready, error, dbInfo, birthTimezone,
      persons, familyLinked, countdowns, notes,
      focusSession, focusTodaySeconds, focusGoal, focusSoundOn,
      refreshFocus, refresh, weatherCities, pinnedWeatherCities, weatherCity,
      weather, weatherStatus, weatherError, loadWeather,
      selectWeatherCity,
    ],
  );

  return <Context.Provider value={store}>{children}</Context.Provider>;
}