/**
 * 生日卡 module.
 *
 * A birthday card is a VIEW over `person`, not a separate entity — the same row
 * also feeds the almanac's day markers and the family tree.
 *
 * The page is a searchable, month-grouped list; adding and editing happen in a
 * dialog. Saving closes the dialog, so the form is never reset through an event
 * object React has already invalidated.
 */

import * as React from 'react';
import { Modal } from '../../app/Modal.js';
import { hub, USER_TIMEZONE } from '../../core/calendar/instance.js';
import { upcomingPersons, type UpcomingPerson } from '../../core/person/upcoming.js';
import { PersonRepository } from '../../core/person/repository.js';
import { useStore } from '../../core/store.js';
import type { Person, PersonInput } from '../../core/person/types.js';
import { timezoneGroups } from '../../core/util/timezones.js';
import { formatLunar } from './format.js';

const RELATIONS = ['本人', '配偶', '爸爸', '妈妈', '儿子', '女儿', '家人', '朋友', '同事', '其他'];

/**
 * Relations that carry a real family meaning.
 *
 * The label alone is just text; mapping it lets the family tree form a chain from
 * what the user already typed here, instead of demanding the same information twice.
 */
const RELATION_ROLES: Record<string, 'self' | 'father' | 'mother' | 'spouse' | 'child'> = {
  本人: 'self',
  配偶: 'spouse',
  爸爸: 'father',
  妈妈: 'mother',
  儿子: 'child',
  女儿: 'child',
};

interface MonthGroup {
  key: string;
  label: string;
  items: UpcomingPerson[];
}

/** Group entries by the month their NEXT birthday lands in, chronologically. */
function groupByMonth(entries: UpcomingPerson[]): MonthGroup[] {
  const buckets = new Map<string, UpcomingPerson[]>();
  for (const entry of entries) {
    const key = entry.nextLocalDate.slice(0, 7);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [entry]);
    else bucket.push(entry);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, items]) => ({
      key,
      label: `${Number(key.slice(0, 4))} 年 ${Number(key.slice(5, 7))} 月`,
      items,
    }));
}

/** Case-insensitive match over everything a user might type to find someone. */
function matches(person: Person, query: string): boolean {
  if (query === '') return true;
  const needle = query.trim().toLowerCase();
  const haystack = [
    person.name,
    person.relation_label ?? '',
    person.note ?? '',
    person.gregorian_local_date ?? '',
    person.zodiac_sign ?? '',
    person.shengxiao ?? '',
    formatLunar(person),
  ];
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

export function BirthdayCard(): React.ReactElement {
  const { persons } = useStore();
  const upcoming = upcomingPersons(persons, hub, USER_TIMEZONE).slice(0, 3);
  if (persons.length === 0) return <p className="card__empty">还没有记录，点进去添加第一位</p>;
  return (
    <ul className="mini-list">
      {upcoming.map((entry) => (
        <li key={entry.person.id}>
          <span className="mini-list__name">{entry.person.name}</span>
          <span className="mini-list__meta">
            {entry.daysUntil === 0 ? '今天 🎂' : `${entry.daysUntil} 天后`}
            {entry.turningAge !== undefined ? ` · 满 ${entry.turningAge}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function BirthdayPage(): React.ReactElement {
  const { persons, familyLinked, markSelf, linkRelative, addPerson, updatePerson, removePerson, birthTimezone, setBirthTimezone } = useStore();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState<Person | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<Person | null>(null);
  const [blockedDelete, setBlockedDelete] = React.useState<Person | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  // Memoised: hub.listCalendars() returns fresh objects each call, and using it
  // directly in the effect deps would wipe the fields while typing.
  const calendars = React.useMemo(() => hub.listCalendars(), []);
  const [calendarSystem, setCalendarSystem] = React.useState(calendars[0]?.id ?? 'gregorian');
  const [fields, setFields] = React.useState<Record<string, unknown>>({});
  const calendar = React.useMemo(
    () => calendars.find((c) => c.id === calendarSystem),
    [calendars, calendarSystem],
  );

  const timezoneGroupsMemo = React.useMemo(() => timezoneGroups(), []);
  const allZones = React.useMemo(() => timezoneGroupsMemo.flatMap((g) => g.options), [timezoneGroupsMemo]);
  const formTimezone = editing?.birth_timezone ?? birthTimezone;
  const timezoneMissing = !allZones.some((o) => o.value === formTimezone);

  // Seed the stored values when editing, else the calendar's defaults.
  React.useEffect(() => {
    if (editing !== null && calendarSystem === (editing.calendar_system ?? 'gregorian')) {
      setFields(PersonRepository.fieldsOf(editing));
      return;
    }
    const active = hub.listCalendars().find((c) => c.id === calendarSystem);
    const defaults: Record<string, unknown> = {};
    for (const field of active?.fields ?? []) {
      if (field.defaultValue !== undefined) defaults[field.key] = field.defaultValue;
    }
    setFields(defaults);
  }, [editing, calendarSystem]);

  // "Today" is the viewer's own date; the birth timezone belongs to the record.
  const upcoming = upcomingPersons(persons, hub, USER_TIMEZONE);
  const visible = upcoming.filter((entry) => matches(entry.person, query));
  const groups = groupByMonth(visible);
  // People who exist but have no birth date — typically created from the family
  // tree. They still belong to the friends list, so hiding them entirely (while
  // the header counts them in 「全部 N 位」) was simply wrong.
  const undated = persons.filter(
    (person) => person.gregorian_local_date === null && matches(person, query),
  );

  function openAdd(): void {
    setError(null);
    setEditing(null);
    setCalendarSystem(calendars[0]?.id ?? 'gregorian');
    setDialogOpen(true);
  }

  function openEdit(person: Person): void {
    setError(null);
    setCalendarSystem(person.calendar_system ?? calendars[0]?.id ?? 'gregorian');
    setEditing(person);
    setDialogOpen(true);
  }

  function closeDialog(): void {
    setDialogOpen(false);
    setEditing(null);
    setError(null);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // Read every value before awaiting; React nulls `currentTarget` on yield.
    const data = new FormData(event.currentTarget);
    const input: PersonInput = {
      name: String(data.get('name') ?? ''),
      gender: String(data.get('gender') ?? 'unspecified'),
      relationLabel: String(data.get('relation') ?? ''),
      note: String(data.get('note') ?? ''),
      calendarSystem,
      fields,
      birthTimezone: String(data.get('timezone') ?? birthTimezone),
    };
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // 「本人」is a property of the person list, not of one record's fields, so it
      // is applied after the save (the id only exists once the row is written).
      const isSelf = data.get('is_self') === 'on';
      const saved = editing !== null
        ? await updatePerson(editing.id, input)
        : await addPerson(input);
      const role = RELATION_ROLES[input.relationLabel];
      if (isSelf || role === 'self') {
        await markSelf(saved.id);
      } else if (role !== undefined) {
        // The record is already saved; a failed link must not undo that, it only
        // gets reported (e.g. 本人 already has a father recorded).
        try {
          const linked = await linkRelative(saved.id, role);
          if (!linked) {
            setNotice('已保存。尚未标记「本人」，因此没有自动建立族谱关系 —— 请勾选「这是我的信息」。');
          }
        } catch (e) {
          setNotice(`已保存，但未能建立族谱关系：${(e as Error).message}`);
        }
      } else if (editing !== null && editing.is_self === 1) {
        await markSelf(null);
      }
      await setBirthTimezone(input.birthTimezone);
      closeDialog();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Deleting somebody who is already in the family tree is refused on purpose.
   *
   * The person row is shared with the tree, so removing it here would silently tear
   * them out of it and take every relation with them. The user is told to handle it
   * in the tree instead, where the removal scope can be chosen.
   */
  function requestDelete(person: Person): void {
    setError(null);
    if (familyLinked.has(person.id)) {
      setBlockedDelete(person);
      return;
    }
    setPendingDelete(person);
  }

  return (
    <div className="panel">
      <div className="list-head">
        <h3>全部 {persons.length} 位</h3>
        <input
          type="search"
          className="search"
          placeholder="搜索姓名 / 关系 / 备注 / 日期…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索生日记录"
        />
        <span className="list-head__count">
          {query === ''
            ? `${groups.length} 个月份${undated.length > 0 ? ` · ${undated.length} 位未填生日` : ''}`
            : `匹配 ${visible.length + undated.length} 位`}
        </span>
        <button type="button" className="btn btn--add" onClick={openAdd}>＋ 添加生日</button>
      </div>

      {notice !== null && <div className="banner banner--info">{notice}</div>}

      {visible.length === 0 && undated.length === 0 && (
        <p className="card__empty">{persons.length === 0 ? '还没有记录，点右上角添加' : `没有匹配「${query}」的记录`}</p>
      )}

      {groups.map((group) => (
        <section key={group.key} className="month-group">
          <header className="month-group__head">
            <span>{group.label}</span>
            <span className="month-group__count">{group.items.length} 位</span>
          </header>
          <ul className="person-list">
            {group.items.map((entry) => (
              <li key={entry.person.id} className={editing?.id === entry.person.id ? 'is-editing' : ''}>
                <div>
                  <strong>{entry.person.name}</strong>
                  {entry.person.relation_label !== null && (
                    <span className="tag">{entry.person.relation_label}</span>
                  )}
                  {entry.person.is_self === 1 && <span className="tag tag--self">本人</span>}
                  {entry.degraded && <span className="tag tag--warn">按本月推算</span>}
                </div>
                <div className="person-list__meta">
                  {formatLunar(entry.person)}
                  {entry.person.gregorian_local_date !== null && ` · 公历 ${entry.person.gregorian_local_date}`}
                  {entry.person.zodiac_sign !== null && ` · ${entry.person.zodiac_sign}`}
                  {entry.person.shengxiao !== null && ` · 属${entry.person.shengxiao}`}
                </div>
                <div className="person-list__next">
                  {entry.daysUntil === 0 ? '今天生日 🎂' : `还有 ${entry.daysUntil} 天`}
                  {entry.turningAge !== undefined ? ` · 满 ${entry.turningAge} 岁` : ''}
                </div>
                <div className="person-list__actions">
                  <button type="button" className="link link--edit" onClick={() => openEdit(entry.person)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => requestDelete(entry.person)}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {undated.length > 0 && (
        <section className="month-group">
          <header className="month-group__head">
            <span>未填生日</span>
            <span className="month-group__count">{undated.length} 位</span>
          </header>
          <ul className="person-list">
            {undated.map((person) => (
              <li key={person.id} className={editing?.id === person.id ? 'is-editing' : ''}>
                <div>
                  <strong>{person.name}</strong>
                  {person.relation_label !== null && (
                    <span className="tag">{person.relation_label}</span>
                  )}
                  {person.is_self === 1 && <span className="tag tag--self">本人</span>}
                  {person.generation !== null && <span className="tag">第 {person.generation} 世</span>}
                </div>
                <div className="person-list__meta">还没有填写出生日期</div>
                <div className="person-list__next">—</div>
                <div className="person-list__actions">
                  <button type="button" className="link link--edit" onClick={() => openEdit(person)}>
                    补生日
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => requestDelete(person)}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Modal
        open={dialogOpen}
        title={editing !== null ? `编辑：${editing.name}` : '添加生日'}
        onClose={closeDialog}
        width={470}
      >
        <form className="form" onSubmit={(e) => void submit(e)}>
          <label>姓名<input name="name" required autoFocus defaultValue={editing?.name ?? ''} /></label>

          <div className="form__row">
            <label>
              关系
              <select name="relation" defaultValue={editing?.relation_label ?? '朋友'}>
                {RELATIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label>
              性别
              <select name="gender" defaultValue={editing?.gender ?? 'unspecified'}>
                <option value="male">男</option>
                <option value="female">女</option>
                <option value="unspecified">不填</option>
              </select>
            </label>
            <label>
              历法
              <select value={calendarSystem} onChange={(e) => setCalendarSystem(e.target.value)}>
                {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </div>

          <p className="form__hint">
            选择「配偶 / 爸爸 / 妈妈 / 儿子 / 女儿」时，保存后会自动与「本人」建立族谱关系；
            若还没有本人，请勾选下方的「这是我的信息」。
          </p>

          {/* 年 / 月 / 日 固定三列同一行；闰月与时辰另起一行 */}
          <div className="form__row form__row--date">
            {(calendar?.fields ?? []).map((field) => (
              <label key={field.key}>
                {field.label}
                {field.type === 'boolean' ? (
                  <input
                    type="checkbox"
                    name={'f_' + field.key}
                    checked={Boolean(fields[field.key])}
                    onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.checked }))}
                  />
                ) : field.type === 'number' ? (
                  <input
                    type="number"
                    name={'f_' + field.key}
                    min={field.min}
                    max={field.max}
                    inputMode="numeric"
                    value={fields[field.key] === undefined ? '' : String(fields[field.key])}
                    onChange={(e) =>
                      setFields((prev) => ({
                        ...prev,
                        [field.key]: e.target.value === '' ? undefined : Number(e.target.value),
                      }))
                    }
                  />
                ) : field.options !== undefined ? (
                  <select
                    name={'f_' + field.key}
                    value={String(fields[field.key] ?? field.defaultValue ?? '')}
                    onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  >
                    {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input
                    name={'f_' + field.key}
                    value={String(fields[field.key] ?? '')}
                    onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  />
                )}
              </label>
            ))}
          </div>

          <label>
            出生时区
            <select name="timezone" defaultValue={formTimezone}>
              {timezoneMissing && (
                <option value={formTimezone}>{formTimezone}（不在列表中）</option>
              )}
              {timezoneGroupsMemo.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <label>备注<input name="note" defaultValue={editing?.note ?? ''} /></label>

          <label className="check">
            <input type="checkbox" name="is_self" defaultChecked={editing?.is_self === 1} />
            这是我的信息 —— 家族树将以本人为中心，向上展开父母、向下展开配偶与子女
          </label>

          {error !== null && <div className="banner banner--bad">{error}</div>}

          <div className="form__actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? '保存中…' : editing !== null ? '保存修改' : '保存'}
            </button>
            <button type="button" onClick={closeDialog} disabled={busy}>取消</button>
          </div>
        </form>
      </Modal>

      <Modal
        open={pendingDelete !== null}
        title={pendingDelete === null ? '' : `删除：${pendingDelete.name}`}
        onClose={() => { setError(null); setPendingDelete(null); }}
        width={430}
      >
        <div className="form">
          <p className="ft-confirm">
            将从数据库中<b>彻底删除</b>「{pendingDelete?.name}」的生日记录，
            不保留副本，也不留可恢复的备份。族谱中的关系会一并清理。此操作不可恢复。
          </p>
          {error !== null && <div className="banner banner--bad">{error}</div>}
          <div className="form__actions">
            <button
              type="button"
              className="btn btn--danger"
              disabled={deleting}
              onClick={() => {
                const target = pendingDelete;
                if (target === null) return;
                setDeleting(true);
                setError(null);
                void removePerson(target.id)
                  .then(() => setPendingDelete(null))
                  .catch((e: Error) => setError(e.message))
                  .finally(() => setDeleting(false));
              }}
            >
              {deleting ? '删除中…' : '确认删除'}
            </button>
            <button type="button" onClick={() => { setError(null); setPendingDelete(null); }} disabled={deleting}>
              取消
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={blockedDelete !== null}
        title={blockedDelete === null ? '' : `无法删除：${blockedDelete.name}`}
        onClose={() => setBlockedDelete(null)}
        width={460}
      >
        <div className="form">
          <p className="ft-confirm">
            「{blockedDelete?.name}」已经是<b>族谱成员</b>，不能在这里直接删除 ——
            生日记录与族谱共用同一条成员数据，删掉会连带把 TA 从族谱中移除。
          </p>
          <p className="ft-confirm">
            请到<b>家族树</b>里处理，那里可以选择「仅移出族谱」或「彻底删除」。
          </p>
          <div className="form__actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                setBlockedDelete(null);
                location.hash = '#/m/family';
              }}
            >
              前往家族树
            </button>
            <button type="button" onClick={() => setBlockedDelete(null)}>知道了</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}