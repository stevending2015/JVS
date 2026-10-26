/** A person, as stored. Birthday cards, the almanac and the family tree all read this. */
export interface Person {
  id: string;
  name: string;
  gender: string;
  relation_label: string | null;
  note: string | null;
  calendar_system: string | null;
  date_fields_json: string | null;
  birth_timezone: string | null;
  shichen: string | null;
  gregorian_local_date: string | null;
  zodiac_sign: string | null;
  shengxiao: string | null;
  is_self: number;
  /** 世次，1 = 始祖/最高一代。 */
  generation: number | null;
  /** 字辈用字。 */
  generation_char: string | null;
  /** 字。 */
  courtesy_name: string | null;
  /** 号。 */
  art_name: string | null;
  /** 排行。 */
  ranking: string | null;
  /** 籍贯。 */
  native_place: string | null;
  /** 葬处。 */
  burial_place: string | null;
  /** 卒（ISO 日期或年份文本）。 */
  death_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface Countdown {
  id: string;
  title: string;
  target_date: string;
  timezone: string;
  all_day: number;
  color: string | null;
  pinned: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  title: string;
  body_md: string;
  pinned: number;
  tags_json: string | null;
  person_id: string | null;
  created_at: string;
  updated_at: string;
}

/** What a person form submits. The 中式著录 fields are optional. */
export interface PersonInput {
  name: string;
  gender: string;
  relationLabel: string;
  note: string;
  calendarSystem: string;
  fields: Record<string, unknown>;
  birthTimezone: string;
  generation?: number | null;
  generationChar?: string;
  courtesyName?: string;
  artName?: string;
  ranking?: string;
  nativePlace?: string;
  burialPlace?: string;
  deathDate?: string;
}