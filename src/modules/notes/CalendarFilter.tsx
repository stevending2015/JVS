/**
 * Date filter popover with a calendar heat map.
 *
 * Each day carries a small bar whose opacity grows with that day's note count, so
 * the user can see at a glance where the writing happened before picking a range.
 * Selection is drafted inside the popover and only committed with 「应用」.
 */

import * as React from 'react';
import { dateFilterLabel, type DateFilter } from '../../core/note/types.js';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dayKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

/** 0 (none) … 3 (busy) — four steps keep the legend memorable. */
export function densityBucket(count: number): 0 | 1 | 2 | 3 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  return 3;
}

interface CalendarFilterProps {
  value: DateFilter;
  counts: Map<string, number>;
  onChange: (next: DateFilter) => void;
}

export function CalendarFilter({ value, counts, onChange }: CalendarFilterProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<'single' | 'range'>('single');
  const [pending, setPending] = React.useState<DateFilter>(value);
  const today = new Date();
  const [cursor, setCursor] = React.useState(() => ({
    year: today.getFullYear(),
    month: today.getMonth(),
  }));

  React.useEffect(() => {
    if (!open) return;
    setPending(value);
    setMode(value.kind === 'range' ? 'range' : 'single');
  }, [open, value]);

  const first = new Date(cursor.year, cursor.month, 1);
  const lead = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const cells: Array<string | null> = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_unused, index) =>
      dayKey(cursor.year, cursor.month, index + 1)),
  ];

  function pick(key: string): void {
    if (mode === 'single') {
      setPending(pending.kind === 'single' && pending.day === key ? { kind: 'none' } : { kind: 'single', day: key });
      return;
    }
    if (pending.kind !== 'range') {
      setPending({ kind: 'range', from: key, to: key });
      return;
    }
    if (key < pending.from) setPending({ kind: 'range', from: key, to: pending.from });
    else if (key > pending.to) setPending({ kind: 'range', from: pending.from, to: key });
    else setPending({ kind: 'none' });
  }

  function isActive(key: string): boolean {
    if (pending.kind === 'none') return false;
    if (pending.kind === 'single') return pending.day === key;
    return key >= pending.from && key <= pending.to;
  }

  function shiftMonth(delta: number): void {
    setCursor((prev) => {
      const next = new Date(prev.year, prev.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  }

  const active = value.kind !== 'none';

  return (
    <div className="cal-filter">
      <button
        type="button"
        className={`btn ${active ? 'btn--active' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        📅 {dateFilterLabel(value)}
      </button>

      {open && (
        <>
          <div className="cal-filter__backdrop" onClick={() => setOpen(false)} />
          <div className="cal-filter__panel" role="dialog" aria-label="按日期筛选笔记">
            <div className="cal-filter__head">
              <button type="button" className="link" onClick={() => shiftMonth(-1)} aria-label="上个月">‹</button>
              <strong>{cursor.year} 年 {cursor.month + 1} 月</strong>
              <button type="button" className="link" onClick={() => shiftMonth(1)} aria-label="下个月">›</button>
            </div>

            <div className="cal-filter__modes">
              <button
                type="button"
                className={mode === 'single' ? 'is-active' : ''}
                onClick={() => setMode('single')}
              >
                单日
              </button>
              <button
                type="button"
                className={mode === 'range' ? 'is-active' : ''}
                onClick={() => setMode('range')}
              >
                区间
              </button>
            </div>

            <div className="cal-grid">
              {WEEKDAYS.map((label) => (
                <span key={label} className="cal-grid__week">{label}</span>
              ))}
              {cells.map((key, index) => {
                if (key === null) return <span key={`blank-${index}`} className="cal-grid__blank" />;
                const count = counts.get(key) ?? 0;
                const bucket = densityBucket(count);
                const day = Number(key.slice(8));
                return (
                  <button
                    key={key}
                    type="button"
                    className={`cal-grid__day${isActive(key) ? ' is-selected' : ''}${count > 0 ? ' has-notes' : ''}`}
                    onClick={() => pick(key)}
                    title={count > 0 ? `${count} 篇笔记` : '无笔记'}
                  >
                    <span>{day}</span>
                    <i className={`cal-grid__bar cal-grid__bar--${bucket}`} />
                  </button>
                );
              })}
            </div>

            <div className="cal-filter__foot">
              <button
                type="button"
                className="link"
                onClick={() => { setPending({ kind: 'none' }); }}
              >
                清除
              </button>
              <span className="cal-filter__hint">
                {pending.kind === 'none' ? '未选择日期' : dateFilterLabel(pending)}
              </span>
              <button
                type="button"
                className="primary"
                onClick={() => { onChange(pending); setOpen(false); }}
              >
                应用
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
