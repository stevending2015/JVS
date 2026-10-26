/**
 * 万年历 module — the calendar window, with the person records marked on their days.
 *
 * Reuses the tested almanac builder and birthday index from the DSH plugin, so
 * lunar dates, 节气 and leap months behave exactly as they already do there.
 */

import * as React from 'react';
import { hub, USER_TIMEZONE } from '../../core/calendar/instance.js';
import type { Person } from '../../core/person/types.js';
import { useStore } from '../../core/store.js';
import {
  buildAlmanacMonth,
  buildBirthdayIndex,
  type AlmanacMonth,
} from '../../core/birthday/services/almanac.js';
import type { BirthdayRecord } from '../../core/birthday/models/birthday.js';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function asRecords(persons: Person[]): BirthdayRecord[] {
  return persons
    .filter((p) => p.calendar_system !== null && p.date_fields_json !== null)
    .map((p) => ({
      name: p.name,
      calendarSystem: p.calendar_system as string,
      fields: JSON.parse(p.date_fields_json as string),
      birthTimezone: p.birth_timezone ?? USER_TIMEZONE,
      gregorianLocalDate: p.gregorian_local_date ?? '',
    })) as unknown as BirthdayRecord[];
}

function monthOf(now: Date): { year: number; month: number } {
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function shift(view: { year: number; month: number }, delta: number): { year: number; month: number } {
  const zero = view.year * 12 + (view.month - 1) + delta;
  return { year: Math.floor(zero / 12), month: ((zero % 12) + 12) % 12 + 1 };
}

function build(view: { year: number; month: number }, persons: Person[]): AlmanacMonth {
  const now = new Date();
  const index = buildBirthdayIndex(asRecords(persons), view.year, hub);
  return buildAlmanacMonth(view.year, view.month, USER_TIMEZONE, hub.timezone, now, index);
}

export function AlmanacCard(): React.ReactElement {
  const { persons } = useStore();
  const [view] = React.useState(() => monthOf(new Date()));
  const month = build(view, persons);
  const today = month.days.find((d) => d.isToday);
  // 阳历几月几日：date 是 YYYY-MM-DD。
  const solarMonth = today === undefined ? 0 : Number(today.date.slice(5, 7));
  return (
    <div>
      <div className="mini-big">
        {today?.lunarMonthName}{today?.lunarDayName}
        {today !== undefined && (
          <span className="almanac-card__solar">
            {solarMonth}月{today.day}日 周{today.weekdayName}
          </span>
        )}
      </div>
      <div className="mini-list__meta">
        {today?.yearGanZhi ?? ''}年 · {today?.dayGanZhi ?? ''}日
        {today?.jieQi ? ` · ${today.jieQi}` : ''}
      </div>
    </div>
  );
}

export function AlmanacPage(): React.ReactElement {
  const { persons } = useStore();
  const [view, setView] = React.useState(() => monthOf(new Date()));
  const [selected, setSelected] = React.useState<string | null>(null);
  const month = build(view, persons);
  const selectedDay = month.days.find((d) => d.date === selected) ?? month.days.find((d) => d.isToday) ?? month.days[0];

  return (
    <div className="almanac">
      <div className="almanac__bar">
        <button type="button" onClick={() => setView((v) => shift(v, -12))}>«</button>
        <button type="button" onClick={() => setView((v) => shift(v, -1))}>‹</button>
        <strong>{view.year} 年 {view.month} 月</strong>
        <button type="button" onClick={() => setView((v) => shift(v, 1))}>›</button>
        <button type="button" onClick={() => setView((v) => shift(v, 12))}>»</button>
        <button type="button" onClick={() => setView(monthOf(new Date()))}>今天</button>
      </div>

      <div className="almanac__grid">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className={`almanac__weekday${i === 0 || i === 6 ? ' is-end' : ''}`}>{w}</div>
        ))}
        {Array.from({ length: month.firstWeekday }, (_, i) => (
          <div key={`blank-${i}`} className="almanac__cell almanac__cell--blank" />
        ))}
        {month.days.map((day) => {
          const label =
            day.birthdays.length > 0
              ? day.birthdays[0].name
              : day.jieQi !== ''
                ? day.jieQi
                : day.festivals.length > 0
                  ? day.festivals[0]
                  : day.lunarDayName;
          const kind =
            day.birthdays.length > 0 ? 'birthday' : day.jieQi !== '' ? 'jieqi' : day.festivals.length > 0 ? 'festival' : 'lunar';
          return (
            <button
              key={day.date}
              type="button"
              className={[
                'almanac__cell',
                day.isToday ? 'is-today' : '',
                selectedDay?.date === day.date ? 'is-selected' : '',
                day.birthdays.length > 0 ? 'is-birthday' : '',
              ].join(' ')}
              onClick={() => setSelected(day.date)}
            >
              <span className="almanac__num">{day.day}</span>
              <span className={`almanac__label almanac__label--${kind}`}>{label}</span>
              {day.birthdays.length > 0 && <span className="almanac__cake">🎂</span>}
            </button>
          );
        })}
      </div>

      {selectedDay !== undefined && (
        <div className="almanac__detail">
          <div className="almanac__detail-head">
            <strong>{selectedDay.date}</strong>
            <span>星期{selectedDay.weekdayName}</span>
            {selectedDay.isToday && <span className="tag">今天</span>}
          </div>
          {selectedDay.birthdays.length > 0 && (
            <div className="almanac__birthdays">
              🎂 {selectedDay.birthdays.map((b) => b.name).join('、')}
            </div>
          )}
          <dl className="facts">
            <dt>农历</dt><dd>{selectedDay.lunarText || '—'}</dd>
            <dt>干支</dt><dd>{selectedDay.yearGanZhi ? `${selectedDay.yearGanZhi}年 ${selectedDay.dayGanZhi}日` : '—'}</dd>
            <dt>节气</dt><dd>{selectedDay.jieQi || '—'}</dd>
            <dt>宜</dt><dd className="is-good">{selectedDay.yi.slice(0, 8).join(' ') || '—'}</dd>
            <dt>忌</dt><dd className="is-bad">{selectedDay.ji.slice(0, 8).join(' ') || '—'}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}