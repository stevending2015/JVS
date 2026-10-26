/**
 * Person persistence plus the derived values the UI shows.
 *
 * Derived fields (Gregorian anchor, 星座, 生肖) are computed through the calendar
 * hub on write, so a Gregorian-anchored date always agrees with what the almanac
 * marks. Both create and update go through the same preparation step so an edit
 * can never leave stale derived values behind.
 *
 * This repository is also the only writer of the 中式著录 columns (世次/字辈/字/
 * 号/排行/籍贯/葬处/卒), which the family tree reads.
 */

import type { GregorianHub } from '../calendar/hub.js';
import type { CalendarFields } from '../calendar/types.js';
import { computeWuxing } from '../birthday/services/wuxing.js';
import { computeZodiac } from '../birthday/services/zodiac.js';
import { shengxiaoFromGregorian } from '../birthday/services/shengxiao.js';
import { db } from '../db/client.js';
import { newId } from '../util/id.js';
import { purgeStatements } from './purge.js';
import type { Person, PersonInput } from './types.js';

const COLUMNS =
  'id, name, gender, relation_label, note, calendar_system, date_fields_json, birth_timezone, ' +
  'shichen, gregorian_local_date, zodiac_sign, shengxiao, is_self, generation, generation_char, ' +
  'courtesy_name, art_name, ranking, native_place, burial_place, death_date, created_at, updated_at';

/** Everything derived from a Gregorian anchor date. */
export interface Derived {
  gregorianLocalDate: string;
  zodiacSign: string;
  wuxingSummary: string;
  shengxiao: string | undefined;
}

/**
 * Resolve a calendar date to its Gregorian anchor and the values derived from it.
 * @param hub - calendar hub.
 * @param calendarSystem - calendar id.
 * @param fields - date fields in that calendar.
 * @param timezone - birth timezone.
 * @returns The derived values.
 */
export function deriveFrom(
  hub: GregorianHub,
  calendarSystem: string,
  fields: CalendarFields,
  timezone: string,
): Derived {
  const result = hub.toGregorian(calendarSystem, fields, timezone);
  const month = Number(result.localDate.slice(5, 7));
  const day = Number(result.localDate.slice(8, 10));
  return {
    gregorianLocalDate: result.localDate,
    zodiacSign: computeZodiac(month, day).sign,
    wuxingSummary: computeWuxing(month).bars,
    shengxiao: shengxiaoFromGregorian(result.localDate, timezone, hub.timezone),
  };
}

/** Trim, and turn an empty string into null. */
function orNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The stored columns of a person, minus identity and timestamps. */
interface PreparedRow {
  name: string;
  gender: string;
  relation_label: string | null;
  note: string | null;
  calendar_system: string | null;
  date_fields_json: string | null;
  birth_timezone: string;
  shichen: string | null;
  gregorian_local_date: string | null;
  zodiac_sign: string | null;
  shengxiao: string | null;
  is_self: number;
  generation: number | null;
  generation_char: string | null;
  courtesy_name: string | null;
  art_name: string | null;
  ranking: string | null;
  native_place: string | null;
  burial_place: string | null;
  death_date: string | null;
}

export class PersonRepository {
  constructor(private readonly hub: GregorianHub) {}

  /**
   * Validate and derive every stored column from user input.
   * @param input - what the form submitted.
   * @returns The columns to write.
   */
  private prepare(input: PersonInput): PreparedRow {
    const name = input.name.trim();
    if (name === '') throw new Error('姓名不能为空');

    const fields = input.fields as CalendarFields;
    // A birth date is optional on purpose: ancestors in a family tree usually have
    // one recorded only for recent generations, and GEDCOM allows it to be absent.
    // A PARTIAL date is still an error — that is a typo, not missing information.
    const entered = Object.values(fields).some(
      (value) => value !== undefined && value !== null && value !== '' && value !== false,
    );

    const common = {
      name,
      gender: input.gender,
      relation_label: orNull(input.relationLabel),
      note: orNull(input.note),
      birth_timezone: input.birthTimezone,
      is_self: input.relationLabel.trim() === '本人' ? 1 : 0,
      generation:
        input.generation === undefined || input.generation === null || Number.isNaN(input.generation)
          ? null
          : Math.trunc(input.generation),
      generation_char: orNull(input.generationChar),
      courtesy_name: orNull(input.courtesyName),
      art_name: orNull(input.artName),
      ranking: orNull(input.ranking),
      native_place: orNull(input.nativePlace),
      burial_place: orNull(input.burialPlace),
      death_date: orNull(input.deathDate),
    };

    if (!entered) {
      return {
        ...common,
        calendar_system: null,
        date_fields_json: null,
        shichen: null,
        gregorian_local_date: null,
        zodiac_sign: null,
        shengxiao: null,
      };
    }

    const validation = this.hub.validate(input.calendarSystem, fields);
    if (!validation.valid) throw new Error(validation.errors.join('; '));

    const adjusted = validation.adjustedFields ?? fields;
    const derived = deriveFrom(this.hub, input.calendarSystem, adjusted, input.birthTimezone);

    return {
      ...common,
      calendar_system: input.calendarSystem,
      date_fields_json: JSON.stringify(adjusted),
      shichen: typeof adjusted.shichen === 'string' ? adjusted.shichen : null,
      gregorian_local_date: derived.gregorianLocalDate,
      zodiac_sign: derived.zodiacSign,
      shengxiao: derived.shengxiao ?? null,
    };
  }

  async list(): Promise<Person[]> {
    return db.all<Person>(
      `SELECT ${COLUMNS} FROM person WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
    );
  }

  async get(id: string): Promise<Person | null> {
    const found = await db.all<Person>(
      `SELECT ${COLUMNS} FROM person WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return found.length === 0 ? null : found[0];
  }

  async create(input: PersonInput): Promise<Person> {
    const row = this.prepare(input);
    const now = new Date().toISOString();
    const person: Person = { id: newId(), ...row, created_at: now, updated_at: now };
    await db.run(
      `INSERT INTO person (${COLUMNS}) VALUES (${Array.from({ length: 23 }, () => '?').join(',')})`,
      [
        person.id, person.name, person.gender, person.relation_label, person.note,
        person.calendar_system, person.date_fields_json, person.birth_timezone,
        person.shichen, person.gregorian_local_date, person.zodiac_sign, person.shengxiao,
        person.is_self, person.generation, person.generation_char, person.courtesy_name,
        person.art_name, person.ranking, person.native_place, person.burial_place,
        person.death_date, person.created_at, person.updated_at,
      ],
    );
    return person;
  }

  /**
   * Rewrite a person from the same input shape as create, recomputing every
   * derived column so an edited date cannot keep the old 星座/生肖.
   */
  async update(id: string, input: PersonInput): Promise<Person> {
    const row = this.prepare(input);
    const now = new Date().toISOString();
    await db.run(
      `UPDATE person SET name=?, gender=?, relation_label=?, note=?, calendar_system=?,
         date_fields_json=?, birth_timezone=?, shichen=?, gregorian_local_date=?,
         zodiac_sign=?, shengxiao=?, is_self=?, generation=?, generation_char=?,
         courtesy_name=?, art_name=?, ranking=?, native_place=?, burial_place=?,
         death_date=?, updated_at=?
       WHERE id=?`,
      [
        row.name, row.gender, row.relation_label, row.note, row.calendar_system,
        row.date_fields_json, row.birth_timezone, row.shichen, row.gregorian_local_date,
        row.zodiac_sign, row.shengxiao, row.is_self, row.generation, row.generation_char,
        row.courtesy_name, row.art_name, row.ranking, row.native_place, row.burial_place,
        row.death_date, now, id,
      ],
    );
    const updated = await this.get(id);
    if (updated === null) throw new Error('记录不存在');
    return updated;
  }

  /**
   * Mark the self record (本人), clearing any other. Passing null clears the mark.
   *
   * The family tree roots itself at 本人 and expands up (parents) and down
   * (spouses, children), so this single flag is what turns a pile of records into
   * a tree centred on the user.
   */
  async markSelf(id: string | null): Promise<void> {
    const now = new Date().toISOString();
    await db.run('UPDATE person SET is_self = 0, updated_at = ? WHERE is_self = 1', [now]);
    if (id !== null) {
      await db.run('UPDATE person SET is_self = 1, updated_at = ? WHERE id = ?', [now, id]);
    }
  }

  /**
   * Ids that take part in at least one family relation.
   *
   * The birthday module needs this: a person who is already a family member must
   * not be deleted from the friends list, because that would silently rip them out
   * of the tree (and take the relations with them).
   *
   * @returns Person ids that are somebody's partner, parent or child.
   */
  async linkedPersonIds(): Promise<string[]> {
    const rows = await db.all<{ id: string }>(
      `SELECT child_id AS id FROM family_child WHERE deleted_at IS NULL
        UNION
       SELECT husband_id AS id FROM family WHERE deleted_at IS NULL AND husband_id IS NOT NULL
        UNION
       SELECT wife_id AS id FROM family WHERE deleted_at IS NULL AND wife_id IS NOT NULL`,
    );
    return rows.map((row) => row.id);
  }

  async selfId(): Promise<string | null> {
    const rows = await db.all<{ id: string }>(
      'SELECT id FROM person WHERE is_self = 1 AND deleted_at IS NULL LIMIT 1',
    );
    return rows.length === 0 ? null : rows[0].id;
  }

  /**
   * Soft delete. The row stays with `deleted_at` set so a second device can learn
   * that the record was removed instead of re-importing it.
   */
  async remove(id: string): Promise<void> {
    // Hard delete: the row is gone, not tombstoned. Every reference is cleared
    // first (see purge.ts) so no part of the graph is left dangling. Shared with
    // the family module, which deletes through here too.
    for (const statement of purgeStatements(id)) {
      await db.run(statement.sql, statement.params);
    }
    try {
      // Reclaim the freed pages so "deleted" also means "gone from the file".
      await db.exec('VACUUM');
    } catch {
      // Compaction is best effort; the rows are already gone.
    }
  }

  /** Parse the stored calendar fields. */
  static fieldsOf(person: Person): CalendarFields {
    try {
      return JSON.parse(person.date_fields_json ?? '{}') as CalendarFields;
    } catch {
      return {} as CalendarFields;
    }
  }
}